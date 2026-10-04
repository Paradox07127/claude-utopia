import type { ElementTable, RenderChildren, RenderNode } from 'claude-code'

import type { AgentRun, TimelineCompaction, TimelineFork, TimelineStep, TimelineTool, TimelineToolOutcome, TimelineTurn, TimelineUsage } from '../types'
import { fit, fmtDuration, fmtTokens, widthOf } from './agent-model'
import { alignRight, fitLine } from './board'
import type { Line, Seg } from './board'
import { chip, PIXELS_PER_COLUMN, widthTierOf } from './desktop'
import { endMarker, FILL, HATCH, LANE, svg, TRACK } from './desktop-svg'
import type { Tone } from './desktop-svg'
import { t } from './i18n'
import { criticalPathMs, hotspotsOf } from './timeline'
import type { Hotspots } from './timeline'

type El = ElementTable<'desktop'>

// Below this many columns the terminal view drops the bars for one summary line per step.
const NARROW_COLUMNS = 60
// Columns the labels take at least, so a fork's description has room before the bars.
const MIN_LABEL_COLUMNS = 30
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const NONE = '—'
// The desktop's wide tier puts the lane labels in a column this wide, in px, left of the lanes.
const LABEL_PX = 280
// A shorter span is drawn this wide, in px, so it stays visible.
const MIN_MARK_PX = 2
const STEPS_PER_PAGE = { narrow: 5, standard: 10, wide: 10 } as const

type StepState = 'done' | 'running' | 'failed' | 'noResult'

type BadOutcome = Exclude<TimelineToolOutcome, 'ok'>

/** What a fork needs of the agents atom: whether its child still runs, and when it ended. */
export type AgentEnd = Pick<AgentRun, 'agentId' | 'state' | 'endedAt'>

/** Ms since the turn started. */
type Span = { from: number; to: number }

/** `runningMs`: since the earliest of its calls still running was requested; `outcome`: the worst of its calls that did not end ok. */
type ToolRow = { kind: 'tool'; name: string; count: number; ms?: number; runningMs?: number; span?: Span; outcome?: BadOutcome; isCritical: boolean }
/** `at`: its start, ms since the turn started; no `span` when nothing tells its end. */
type ForkRow = { kind: 'fork'; fork: TimelineFork; at: number; span?: Span; isOpen: boolean; isCritical: boolean }
type Child = ToolRow | ForkRow
type StepRow = { kind: 'step'; step: TimelineStep; state: StepState; span?: Span; waitMs: number; children: Child[] }
/** `at`: ms since the turn started. */
type CompactRow = { kind: 'compact'; marker: TimelineCompaction; at: number }
type Row = StepRow | CompactRow

/** `input` and `output` absent when no step reported its usage. */
type Totals = { input?: number; cacheRead: number; output?: number; tools: number; forks: number }

/** `turnMs` absent while the turn is open, `pathMs` while one of its steps is. */
type View = { turn: TimelineTurn; turnMs?: number; pathMs?: number; totals: Totals; rows: Row[]; totalMs: number; now: number }

/** The main loop's latest turn; undefined before its first. */
export function latestMainTurnId(turns: readonly TimelineTurn[]): string | undefined {
  return turns.findLast(one => one.agentId === undefined)?.turnId
}

/** `opus-5-5` of `claude-opus-5-5-20260101`. */
const shortModel = (model: string) => model.replace(/^claude-/, '').replace(/-\d{8}$/, '')

/** `0.2s` and `41.2s` under a minute, then `3m12s`. */
const fmtMs = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : fmtDuration(ms))

const inOf = (usage: TimelineUsage) => usage.input + usage.cacheRead + usage.cacheWrite

const pad = (text: string, columns: number) => text + ' '.repeat(Math.max(0, columns - widthOf(text)))

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n))

const num = (n: number) => String(Number(n.toFixed(2)))

const OUTCOME_RANK: Record<TimelineToolOutcome, number> = { ok: 0, interrupted: 1, denied: 2, error: 3 }

/**
 * A step that ended without a result (its stream or result rejected) has no result to call done; running only as the
 * last step of a turn still open; a step that lost its end otherwise is just unknown.
 */
function stateOf(step: TimelineStep, turn: TimelineTurn): StepState {
  if (step.stopReason === null) {
    return 'failed'
  }

  if (step.stopReason === undefined && (step.stepMs !== undefined || step.endedAt !== undefined)) {
    return 'noResult'
  }

  return step.stepMs === undefined && turn.endedAt === undefined && turn.steps.at(-1) === step ? 'running' : 'done'
}

/** Per step, its longest foreground tool with a duration: what `criticalPathMs` adds for that step. */
function criticalTools(turn: TimelineTurn): Set<string> {
  const background = new Set(turn.forks.filter(one => one.background).map(one => one.toolUseId))
  const out = new Set<string>()

  for (const step of turn.steps) {
    const timed = turn.tools.filter(one => step.toolUseIds.includes(one.toolUseId) && !background.has(one.toolUseId) && (one.durationMs ?? 0) > 0)
    const longest = timed.reduce<TimelineTool | undefined>((best, one) => (best === undefined || one.durationMs! > best.durationMs! ? one : best), undefined)

    if (longest !== undefined) {
      out.add(longest.toolUseId)
    }
  }

  return out
}

/** Adjacent calls of one tool as one row: the longest time, the span from the first start to the last end, or to now while one runs. */
function toolRow(tools: TimelineTool[], turn: TimelineTurn, now: number, critical: Set<string>): ToolRow {
  const known = tools.filter(one => one.durationMs !== undefined)
  const timed = known.filter(one => one.endedAt !== undefined)
  // Only an open turn runs anything: a call of an ended turn that lost its end is just unknown.
  const running = turn.endedAt === undefined ? tools.filter(one => one.requestedAt !== undefined && one.endedAt === undefined) : []
  const runningFrom = Math.min(...running.map(one => one.requestedAt!))
  const starts = [...timed.map(one => one.endedAt! - one.durationMs!), ...(running.length > 0 ? [runningFrom] : [])]
  const worst = tools.reduce<TimelineToolOutcome>((was, one) => (OUTCOME_RANK[one.outcome ?? 'ok'] > OUTCOME_RANK[was] ? one.outcome! : was), 'ok')

  return {
    kind: 'tool',
    name: tools[0]!.name,
    count: tools.length,
    ...(known.length > 0 && { ms: Math.max(...known.map(one => one.durationMs!)) }),
    ...(running.length > 0 && { runningMs: now - runningFrom }),
    ...(starts.length > 0 && {
      span: {
        from: Math.min(...starts) - turn.startedAt,
        to: (running.length > 0 ? now : Math.max(...timed.map(one => one.endedAt!))) - turn.startedAt,
      },
    }),
    ...(worst !== 'ok' && { outcome: worst }),
    isCritical: tools.some(one => critical.has(one.toolUseId)),
  }
}

/**
 * The fork ends with the first turn its child started at or after it; while that has no end, with its agent once the
 * agents atom says it no longer runs. Only an agent still running keeps it open; with neither, its end is unknown.
 */
function forkRow(fork: TimelineFork, turn: TimelineTurn, turns: readonly TimelineTurn[], agents: readonly AgentEnd[], now: number, critical: Set<string>): ForkRow {
  const first = turns.find(one => one.agentId === fork.childAgentId && one.startedAt >= fork.at)
  const run = agents.find(one => one.agentId === fork.childAgentId)
  const isOpen = first?.endedAt === undefined && run?.state === 'running'
  const end = first?.endedAt ?? (isOpen ? now : run?.endedAt)
  const at = fork.at - turn.startedAt

  return {
    kind: 'fork',
    fork,
    at,
    ...(end !== undefined && { span: { from: at, to: end - turn.startedAt } }),
    isOpen,
    isCritical: fork.toolUseId !== undefined && critical.has(fork.toolUseId),
  }
}

function childrenOf(
  step: TimelineStep,
  turn: TimelineTurn,
  turns: readonly TimelineTurn[],
  agents: readonly AgentEnd[],
  now: number,
  critical: Set<string>,
  loose: TimelineFork[],
): Child[] {
  const groups: (TimelineTool[] | TimelineFork)[] = []

  for (const id of step.toolUseIds) {
    const fork = turn.forks.find(one => one.toolUseId === id)
    const tool = turn.tools.find(one => one.toolUseId === id)
    const last = groups.at(-1)

    if (fork !== undefined) {
      groups.push(fork)
    } else if (tool !== undefined && Array.isArray(last) && last[0]!.name === tool.name) {
      last.push(tool)
    } else if (tool !== undefined) {
      groups.push([tool])
    }
  }

  return [...groups, ...loose].map(group => (Array.isArray(group) ? toolRow(group, turn, now, critical) : forkRow(group, turn, turns, agents, now, critical)))
}

function stepRow(step: TimelineStep, turn: TimelineTurn, now: number, children: Child[]): StepRow {
  const state = stateOf(step, turn)
  const from = step.sentAt - turn.startedAt
  const to = step.stepMs !== undefined ? from + step.stepMs : state === 'running' ? now - turn.startedAt : undefined

  if (to === undefined) {
    return { kind: 'step', step, state, waitMs: 0, children }
  }

  // No first token yet on a running step: all of it so far is the wait.
  const waitMs = step.ttftMs ?? (state === 'running' ? to - from : 0)

  return { kind: 'step', step, state, span: { from, to }, waitMs: Math.min(waitMs, to - from), children }
}

const compactText = (marker: TimelineCompaction) =>
  marker.tokensBefore !== undefined && marker.tokensAfter !== undefined
    ? `── ⤺ compact ${fmtTokens(marker.tokensBefore)}→${fmtTokens(marker.tokensAfter)} ──`
    : '── ⤺ compact ──'

function totalsOf(turn: TimelineTurn): Totals {
  const used = turn.steps.map(one => one.usage).filter((usage): usage is TimelineUsage => usage !== undefined && usage !== null)
  const forkTools = new Set(turn.forks.map(one => one.toolUseId))

  return {
    ...(used.length > 0 && { input: used.reduce((sum, one) => sum + inOf(one), 0), output: used.reduce((sum, one) => sum + one.output, 0) }),
    cacheRead: used.reduce((sum, one) => sum + one.cacheRead, 0),
    tools: turn.tools.filter(one => !forkTools.has(one.toolUseId)).length,
    forks: turn.forks.length,
  }
}

/** Whole percent of the input read from the cache; undefined without input. */
const cacheShare = (totals: Totals) => (totals.input !== undefined && totals.input > 0 ? Math.round((totals.cacheRead * 100) / totals.input) : undefined)

function statsText(totals: Totals): string {
  const share = cacheShare(totals)

  return [
    `in ${totals.input === undefined ? NONE : `${fmtTokens(totals.input)}${share === undefined ? '' : t().cacheReadShare(share)}`}`,
    `out ${totals.output === undefined ? NONE : fmtTokens(totals.output)}`,
    t().toolsN(totals.tools),
    t().subagentsN(totals.forks),
  ].join(' · ')
}

function viewOf(turns: readonly TimelineTurn[], turnId: string, now: number, agents: readonly AgentEnd[]): View | undefined {
  const turn = turns.find(one => one.turnId === turnId)

  if (turn === undefined || turn.steps.length === 0) {
    return undefined
  }

  const critical = criticalTools(turn)
  const placed = new Set(turn.steps.flatMap(one => one.toolUseIds))
  const loose = turn.forks.filter(one => one.toolUseId === undefined || !placed.has(one.toolUseId))
  // A fork no step's tool call names goes under the step running when it started.
  const ownerOf = (fork: TimelineFork) => turn.steps.findLast(one => one.sentAt <= fork.at) ?? turn.steps.at(-1)
  const markers = [...(turn.compactions ?? [])].sort((a, b) => a.at - b.at)
  const compactRow = (marker: TimelineCompaction): CompactRow => ({ kind: 'compact', marker, at: marker.at - turn.startedAt })
  const rows: Row[] = []

  for (const step of turn.steps) {
    while (markers.length > 0 && markers[0]!.at < step.sentAt) {
      rows.push(compactRow(markers.shift()!))
    }

    rows.push(stepRow(step, turn, now, childrenOf(step, turn, turns, agents, now, critical, loose.filter(one => ownerOf(one) === step))))
  }

  rows.push(...markers.map(compactRow))

  const spans = rows.flatMap(row => (row.kind === 'step' ? [row.span, ...row.children.map(child => child.span)] : []))
  const turnMs = turn.durationMs ?? (turn.endedAt === undefined ? undefined : turn.endedAt - turn.startedAt)
  const pathMs = criticalPathMs(turn)

  return {
    turn,
    ...(turnMs !== undefined && { turnMs }),
    ...(pathMs !== undefined && { pathMs }),
    totals: totalsOf(turn),
    rows,
    totalMs: Math.max(1, (turn.endedAt ?? now) - turn.startedAt, ...spans.map(span => span?.to ?? 0)),
    now,
  }
}

/** The turn's time, or its time so far with `…` while it is open. */
const turnTime = (view: View) => (view.turnMs === undefined ? `${fmtDuration(view.now - view.turn.startedAt)}…` : fmtDuration(view.turnMs))

const GLYPHS: Record<StepState, Seg> = {
  running: { text: '●', color: 'permission' },
  failed: { text: '✗', color: 'error' },
  noResult: { text: '~', color: 'warning' },
  done: { text: ' ' },
}

const STEP_COLORS: Record<StepState, string> = { running: 'permission', failed: 'error', noResult: 'warning', done: 'text' }

const OUTCOME_COLORS: Record<BadOutcome, string> = { error: 'error', denied: 'error', interrupted: 'warning' }

const OUTCOME_GLYPHS: Record<BadOutcome, string> = { error: '✗', denied: '✗', interrupted: '⊘' }

/** `✗ failed`: the glyph and the word of an outcome. */
const outcomeText = (outcome: BadOutcome) => `${OUTCOME_GLYPHS[outcome]} ${t().laneStates[outcome]}`

const timeOf = (row: StepRow, now: number) =>
  row.state === 'running' ? `${fmtDuration(now - row.step.sentAt)}…` : row.step.stepMs === undefined ? NONE : fmtMs(row.step.stepMs)

const ioOf = (step: TimelineStep) =>
  step.usage === undefined || step.usage === null ? `${NONE}/${NONE}` : `${fmtTokens(inOf(step.usage))}/${fmtTokens(step.usage.output)}`

const toolLabel = (row: ToolRow) => (row.count > 1 ? `${row.name} ×${row.count}` : row.name)

/** `12s…` while it runs, its longest time once known, else `—`. */
const toolTime = (row: ToolRow) => (row.runningMs !== undefined ? `${fmtDuration(row.runningMs)}…` : row.ms === undefined ? NONE : fmtMs(row.ms))

const isOpenChild = (child: Child) => (child.kind === 'fork' ? child.isOpen : child.runningMs !== undefined)

const childColor = (child: Child) =>
  child.kind === 'tool' && child.outcome !== undefined ? OUTCOME_COLORS[child.outcome] : isOpenChild(child) ? 'permission' : child.isCritical ? 'text' : 'subtle'

/** One span on the shared scale: a whole-cell start, eighth-cell ends; `┄` in whole cells. */
function barSegs(span: Span, waitMs: number, perMs: number, cells: number, color: string, char: '█' | '┄', isOpen: boolean): Seg[] {
  const start = Math.min(cells - 1, Math.round(span.from * perMs))
  const length = Math.max(0, span.to * perMs - start)
  const out: Seg[] = [{ text: ' '.repeat(start) }]

  if (char === '┄') {
    out.push({ text: '┄'.repeat(clamp(Math.round(length), 1, cells - start)), color })
  } else {
    const eighths = Math.min((cells - start) * 8, Math.max(1, Math.round(length * 8)))
    const wait = waitMs > 0 && waitMs * perMs >= length ? Math.ceil(eighths / 8) : Math.min(Math.floor(eighths / 8), Math.round(waitMs * perMs))
    const rest = Math.max(0, eighths - wait * 8)

    out.push({ text: '░'.repeat(wait), color: 'subtle' }, { text: '█'.repeat(Math.floor(rest / 8)) + EIGHTHS[rest % 8], color })
  }

  if (isOpen) {
    out.push({ text: '▶', color })
  }

  return out.filter(seg => seg.text !== '')
}

function wideLines(view: View, width: number): Line[] {
  const steps = view.rows.filter((row): row is StepRow => row.kind === 'step')
  const cols = {
    index: Math.max(...steps.map(row => widthOf(`#${row.step.index}`))),
    model: Math.max(...steps.map(row => widthOf(shortModel(row.step.model)))),
    time: Math.max(...steps.map(row => widthOf(timeOf(row, view.now)))),
  }
  const stepLeft = (row: StepRow): Line => [
    { text: `${pad(`#${row.step.index}`, cols.index)} ${pad(shortModel(row.step.model), cols.model)} ` },
    GLYPHS[row.state],
    { text: ` ${pad(timeOf(row, view.now), cols.time)} ${ioOf(row.step)}` },
    ...(row.state === 'noResult' ? [{ text: ` ${t().laneStates.noResult}`, color: 'warning' }] : []),
  ]
  const label = Math.max(MIN_LABEL_COLUMNS, ...steps.map(row => widthOf(stepLeft(row).map(seg => seg.text).join(''))))
  // One column after the labels, one at the end for a running bar's `▶`.
  const cells = Math.max(1, width - label - 2)
  const perMs = cells / view.totalMs

  const childLeft = (child: Child, branch: string): Line => {
    const head = ` ${branch} `

    if (child.kind === 'tool') {
      const time: Seg =
        child.outcome !== undefined
          ? { text: `${outcomeText(child.outcome)} ${toolTime(child)}`, color: OUTCOME_COLORS[child.outcome] }
          : child.runningMs === undefined
            ? { text: toolTime(child) }
            : { text: `● ${toolTime(child)}`, color: 'permission' }
      const room = label - widthOf(head) - 1 - widthOf(time.text) - 2

      return [{ text: `${head}${pad(fit(toolLabel(child), room), room)} ` }, time, { text: child.isCritical ? ' ◆' : '  ' }]
    }

    const fork = `${head}▸ ${child.fork.subagentType} · `
    const tail = `${child.fork.background ? ` ${t().background}` : ''}${child.isCritical ? ' ◆' : ''}`
    const room = label - widthOf(fork) - widthOf(tail)

    return [{ text: pad(room > 0 ? `${fork}${fit(child.fork.description, room)}${tail}` : fit(`${fork}${child.fork.description}${tail}`, label), label) }]
  }

  return view.rows.flatMap(row => {
    if (row.kind === 'compact') {
      return [[{ text: fit(compactText(row.marker), width), dim: true }]]
    }

    const left = stepLeft(row)
    const used = widthOf(left.map(seg => seg.text).join(''))
    const head: Line = [...left, { text: ' '.repeat(label - used + 1) }]
    const children = row.children.map((child, i): Line => {
      const text = childLeft(child, i === row.children.length - 1 ? '└' : '├')
      const bar = child.span === undefined ? [] : barSegs(child.span, 0, perMs, cells, childColor(child), child.kind === 'fork' ? '┄' : '█', isOpenChild(child))

      return [...text, { text: ' ' }, ...bar]
    })

    return [row.span === undefined ? head : [...head, ...barSegs(row.span, row.waitMs, perMs, cells, STEP_COLORS[row.state], '█', row.state === 'running')], ...children]
  })
}

function narrowLines(view: View, width: number): Line[] {
  return view.rows.map(row => {
    if (row.kind === 'compact') {
      return [{ text: fit(compactText(row.marker), width), dim: true }]
    }

    const children = row.children.map((child): Line =>
      child.kind === 'tool'
        ? child.outcome === undefined
          ? [{ text: `${toolLabel(child)} ${toolTime(child)}${child.isCritical ? ' ◆' : ''}` }]
          : [{ text: `${toolLabel(child)} ` }, { text: outcomeText(child.outcome), color: OUTCOME_COLORS[child.outcome] }, { text: ` ${toolTime(child)}${child.isCritical ? ' ◆' : ''}` }]
        : [{ text: `${child.fork.subagentType}${child.fork.background ? `(${t().background})` : ''}${child.isCritical ? ' ◆' : ''}` }],
    )
    const glyph = GLYPHS[row.state]
    const line: Line = [
      { text: `#${row.step.index} ${shortModel(row.step.model)} ` },
      ...(row.state === 'done' ? [] : [glyph, { text: ' ' }]),
      ...(row.state === 'noResult' ? [{ text: `${t().laneStates.noResult} `, color: 'warning' }] : []),
      { text: `${timeOf(row, view.now)} ${ioOf(row.step)}` },
      ...children.flatMap((segs, i) => [{ text: i === 0 ? ' → ' : ' · ' }, ...segs]),
    ]

    return fitLine(line, width)
  })
}

/**
 * The turn as a waterfall on one time scale for `width` columns; below 60 columns one summary line per step.
 * `agents`: the agents atom, which tells a fork whose child left no turn end whether that child still runs.
 */
export function timelineLines(turns: readonly TimelineTurn[], turnId: string, now: number, width: number, agents: readonly AgentEnd[] = []): Line[] {
  const view = viewOf(turns, turnId, now, agents)

  if (view === undefined) {
    return [[{ text: t().timelineEmpty, dim: true }]]
  }

  const title = [
    t().timeline,
    t().timelineSteps(view.turn.steps.length),
    turnTime(view),
    t().criticalPath(view.pathMs === undefined ? NONE : fmtDuration(view.pathMs)),
  ].join(' · ')
  const apiError = view.turn.apiError
  const head: Line = [{ text: title, bold: true }, ...(apiError === undefined ? [] : [{ text: ' · ' }, { text: `✗ ${apiError.error}`, color: 'error' }])]

  return [fitLine(head, width), [{ text: fit(statsText(view.totals), width) }], ...(width < NARROW_COLUMNS ? narrowLines(view, width) : wideLines(view, width))]
}

const GAP = '  '

/** Whole percent of `whole`; `—` when there is no whole to take it of. */
const pctOf = (part: number, whole: number) => (whole > 0 ? `${Math.round((part * 100) / whole)}%` : NONE)

const slowText = (one: Hotspots['slowest'][number]) => (one.slowStep === undefined ? NONE : `#${one.slowStep.index} ${fmtMs(one.slowStep.ms)}`)

const isEmpty = (hot: Hotspots) => hot.tools.length === 0 && hot.model === undefined && hot.slowest.length === 0

/** Rows of cells as aligned columns: the first left-aligned and cut to the room the others leave, the rest right-aligned. */
function table(rows: string[][], width: number): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(row => widthOf(row[i]!))))
  const first = Math.max(1, Math.min(widths[0]!, width - widths.slice(1).reduce((sum, one) => sum + GAP.length + one, 0)))

  return rows.map(row => fit([pad(fit(row[0]!, first), first), ...row.slice(1).map((cell, i) => alignRight(cell, widths[i + 1]!))].join(GAP), width))
}

/** The main loop's hotspots as tables; below 60 columns each keeps the name and the total time alone. */
export function hotspotLines(turns: readonly TimelineTurn[], width: number): Line[] {
  const hot = hotspotsOf(turns)

  if (isEmpty(hot)) {
    return [[{ text: t().hotspotsEmpty, dim: true }]]
  }

  const isWide = width >= NARROW_COLUMNS
  const heads = t().hotspotColumns
  const heading = (text: string): Line => [{ text: fit(text, width), bold: true }]
  const section = (title: string, head: string[] | undefined, rows: string[][]): Line[] => {
    const lines = table(head === undefined ? rows : [head, ...rows], width)

    return [heading(title), ...lines.map((text, i): Line => [{ text, ...(head !== undefined && i === 0 && { dim: true }) }])]
  }
  const model = hot.model
  const modelMs = model === undefined ? 0 : model.waitMs + model.genMs
  const modelRow = (label: string, ms: number) => [label, fmtMs(ms), ...(isWide ? [pctOf(ms, modelMs)] : [])]

  return [
    heading(t().hotspotsTitle(hot.turns)),
    ...(hot.tools.length === 0
      ? []
      : section(
          t().hotspotsByTool,
          isWide ? [heads.tool, heads.count, heads.total, heads.max] : [heads.tool, heads.total],
          hot.tools.map(one => (isWide ? [one.name, String(one.count), fmtMs(one.totalMs), fmtMs(one.maxMs)] : [one.name, fmtMs(one.totalMs)])),
        )),
    ...(model === undefined
      ? []
      : section(t().modelTime, undefined, [modelRow(t().modelWait, model.waitMs), modelRow(t().modelGen, model.genMs)])),
    ...(hot.slowest.length === 0
      ? []
      : section(
          t().slowestTurns,
          isWide ? [heads.turn, heads.total, heads.slowStep] : [heads.turn, heads.total],
          hot.slowest.map(one => [t().turnN(one.ordinal), fmtMs(one.durationMs), ...(isWide ? [slowText(one)] : [])]),
        )),
  ]
}

const STEP_TONES: Record<StepState, Tone> = { running: 'running', failed: 'failed', noResult: 'stale', done: 'done' }

const OUTCOME_TONES: Record<BadOutcome, Tone> = { error: 'failed', denied: 'failed', interrupted: 'stale' }

/** Where `ms` since the turn started falls on a lane `px` wide that holds `totalMs`. */
const xOf = (ms: number, totalMs: number, px: number) => clamp(ms / totalMs, 0, 1) * px

/** A span as a rect `h` tall at `y`, at least MIN_MARK_PX wide. */
function spanRect(span: Span, totalMs: number, px: number, y: number, h: number, fill: string, more = ''): string {
  const width = Math.max(MIN_MARK_PX, xOf(span.to, totalMs, px) - xOf(span.from, totalMs, px))

  return `<rect x="${num(Math.min(xOf(span.from, totalMs, px), px - width))}" y="${y}" width="${num(width)}" height="${h}" fill="${fill}"${more}/>`
}

/** A request, 8 px tall: the first-token wait hatched, then the generation solid in its state's color; an open arrow while it runs. */
function stepLane(row: StepRow, totalMs: number, px: number, height: number): string {
  if (row.span === undefined) {
    return svg(px, height, '')
  }

  const y = height / 2 - 4
  const turnAt = row.span.from + row.waitMs
  const parts = [
    ...(row.waitMs > 0 ? [HATCH.defs, spanRect({ from: row.span.from, to: turnAt }, totalMs, px, y, 8, HATCH.fill, ` stroke="${TRACK}"`)] : []),
    ...(row.span.to > turnAt ? [spanRect({ from: turnAt, to: row.span.to }, totalMs, px, y, 8, FILL[STEP_TONES[row.state]])] : []),
    ...(row.state === 'running' ? [endMarker(xOf(row.span.to, totalMs, px), y, 8, px, FILL.running, true)] : []),
  ]

  return svg(px, height, parts.join(''))
}

/** A tool group, 6 px tall in its outcome's color; a critical one outlined, a running one ending in an open arrow. */
function toolLane(child: ToolRow, totalMs: number, px: number, height: number): string {
  if (child.span === undefined) {
    return svg(px, height, '')
  }

  const y = height / 2 - 3
  const color = FILL[child.outcome !== undefined ? OUTCOME_TONES[child.outcome] : child.runningMs !== undefined ? 'running' : 'done']
  const bar = spanRect(child.span, totalMs, px, y, 6, color, child.isCritical ? ` stroke="${TRACK}" stroke-width="2"` : '')

  return svg(px, height, child.runningMs === undefined ? bar : bar + endMarker(xOf(child.span.to, totalMs, px), y, 6, px, color, true))
}

/** A fork as a dashed line: an open arrow while its child runs, a square once it ended; a tick at its start when its end is unknown. */
function forkLane(child: ForkRow, totalMs: number, px: number, height: number): string {
  const mid = height / 2

  if (child.span === undefined) {
    const x = num(xOf(child.at, totalMs, px))

    return svg(px, height, `<line x1="${x}" y1="${mid - 4}" x2="${x}" y2="${mid + 4}" stroke="${TRACK}" stroke-width="2"/>`)
  }

  const end = xOf(child.span.to, totalMs, px)

  return svg(
    px,
    height,
    `<line x1="${num(xOf(child.span.from, totalMs, px))}" y1="${mid}" x2="${num(end)}" y2="${mid}" stroke="${TRACK}" stroke-width="2" stroke-dasharray="3 2"/>` +
      endMarker(end, mid - 3, 6, px, child.isOpen ? FILL.running : TRACK, child.isOpen),
  )
}

/** A compaction as a vertical line at its time. */
function compactLane(at: number, totalMs: number, px: number, height: number): string {
  const x = num(clamp(xOf(at, totalMs, px), 1, px - 1))

  return svg(px, height, `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${TRACK}" stroke-width="2"/>`)
}

/** The lanes' time axis: a base line with ticks at the start, the middle and the end. */
function axisSvg(px: number, height: number): string {
  const ticks = [1, px / 2, px - 1].map(x => `<line x1="${num(x)}" y1="${height / 2}" x2="${num(x)}" y2="${height}" stroke="${TRACK}" stroke-width="2"/>`)

  return svg(px, height, `<line x1="0" y1="${height - 0.5}" x2="${px}" y2="${height - 0.5}" stroke="${TRACK}"/>${ticks.join('')}`)
}

/** `12s…` while it runs; once known its time, a group's longest call; else `—`. */
const laneTime = (row: ToolRow) =>
  row.runningMs !== undefined ? `${fmtDuration(row.runningMs)}…` : row.ms === undefined ? NONE : row.count > 1 ? t().longestCall(fmtMs(row.ms)) : fmtMs(row.ms)

/** Shown without asking: every fork and what is critical, open or failed; the other tools wait behind `Show tools`. */
const isShownChild = (child: Child) => child.kind === 'fork' || child.isCritical || isOpenChild(child) || child.outcome !== undefined

function totalsText(totals: Totals): string {
  const share = cacheShare(totals)

  return [
    t().inputTokens(totals.input === undefined ? NONE : fmtTokens(totals.input)),
    ...(share === undefined ? [] : [t().cacheReadPct(share)]),
    t().outputTokens(totals.output === undefined ? NONE : fmtTokens(totals.output)),
    t().toolsCount(totals.tools),
    t().subagentsCount(totals.forks),
  ].join(' · ')
}

/** The desktop waterfall's state: `back`, pages before the newest; the open disclosures; and what changes them. */
export type WaterfallUi = {
  back?: number
  onPage?: (back: number) => void
  disclosures?: ReadonlySet<string>
  onToggleDisclosure?: (key: string) => void
}

/**
 * The turn's head, a legend and a time axis, then a page of its steps: per request, tool group, fork and compaction a
 * label above (beside, on the wide tier) one lane. Every lane has the axis's width and scale; only the labels indent.
 */
export function drawTimelineDesktop(
  el: El,
  turns: readonly TimelineTurn[],
  turnId: string,
  now: number,
  columns: number,
  agents: readonly AgentEnd[] = [],
  ui: WaterfallUi = {},
): RenderNode[] {
  const { Box, Button, Svg, Text } = el
  const view = viewOf(turns, turnId, now, agents)

  if (view === undefined) {
    return [<Text dimColor>{t().timelineEmpty}</Text>]
  }

  const tier = widthTierOf(columns)
  const { height } = LANE[tier]
  // The wide tier starts at 760 px, narrower than the label column, its 16 px gap and a 572 px lane.
  const px = tier === 'wide' ? Math.min(LANE.wide.width, columns * PIXELS_PER_COLUMN - LABEL_PX - 16) : LANE[tier].width
  const perPage = STEPS_PER_PAGE[tier]
  const stepAt = view.rows.flatMap((row, i) => (row.kind === 'step' ? [i] : []))
  const pages = Math.ceil(stepAt.length / perPage)
  const back = clamp(ui.back ?? 0, 0, pages - 1)
  const last = stepAt.length - back * perPage
  const first = Math.max(0, last - perPage)
  // A page holds its steps and the compactions before each; the newest page also those after its last step.
  const rows = view.rows.slice(first === 0 ? 0 : stepAt[first - 1]! + 1, last === stepAt.length ? view.rows.length : stepAt[last]!)
  const scale = `0—${fmtMs(view.totalMs)}`
  const spanText = (span: Span | undefined) => (span === undefined ? t().laneUnknown : t().laneSpan(fmtMs(span.from), fmtMs(span.to)))
  const beside = (label: RenderChildren, chart: RenderNode, isChild = false) =>
    tier === 'wide' ? (
      <Box columnGap={2} alignItems="center">
        <Box flexDirection="column" width={Math.round(LABEL_PX / PIXELS_PER_COLUMN)} {...(isChild && { paddingLeft: 2 })}>
          {label}
        </Box>
        {chart}
      </Box>
    ) : (
      <Box flexDirection="column">
        <Box flexDirection="column" {...(isChild && { paddingLeft: 2 })}>
          {label}
        </Box>
        {chart}
      </Box>
    )
  const lane = (label: RenderChildren, source: string, alt: string, isChild = false) =>
    beside(label, <Svg source={source} alt={alt} width={px} height={height} />, isChild)
  const labelRow = (left: RenderChildren, right: RenderChildren) => (
    <Box justifyContent="space-between" columnGap={1}>
      <Text wrap="truncate">{left}</Text>
      <Box columnGap={1} flexShrink={0}>
        {right}
      </Box>
    </Box>
  )
  const critical = (isCritical: boolean) => (isCritical ? [<Text bold>{` ${t().critical}`}</Text>] : [])
  const running = (isRunning: boolean) => (isRunning ? [chip(el, 'running', `● ${t().runWord}`)] : [])

  const toolNode = (child: ToolRow) => {
    const state =
      child.outcome !== undefined
        ? t().laneStates[child.outcome]
        : child.runningMs !== undefined
          ? t().laneStates.running
          : child.ms === undefined
            ? t().laneUnknown
            : t().laneStates.done
    const what = [toolLabel(child), laneTime(child), ...(child.isCritical ? [t().critical] : [])].join(' · ')
    const marks = [...(child.outcome === undefined ? [] : [chip(el, OUTCOME_TONES[child.outcome], outcomeText(child.outcome))]), ...critical(child.isCritical)]

    return lane(
      labelRow([toolLabel(child), ...marks], <Text {...(child.runningMs !== undefined && { color: 'permission' })}>{laneTime(child)}</Text>),
      toolLane(child, view.totalMs, px, height),
      t().laneAlt(what, state, spanText(child.span), scale),
      true,
    )
  }

  const forkNode = (child: ForkRow) => {
    const name = `▸ ${child.fork.subagentType} · ${child.fork.description}`
    const what = [name, ...(child.fork.background ? [t().background] : []), ...(child.isCritical ? [t().critical] : [])].join(' · ')
    const ms = child.span === undefined ? undefined : child.span.to - child.span.from
    const time = ms === undefined ? NONE : child.isOpen ? `${fmtDuration(ms)}…` : fmtMs(ms)
    const background = child.fork.background ? [<Text color="subtle">{` ${t().background}`}</Text>] : []

    return lane(
      labelRow([name, ...background, ...running(child.isOpen), ...critical(child.isCritical)], <Text {...(child.isOpen && { color: 'permission' })}>{time}</Text>),
      forkLane(child, view.totalMs, px, height),
      t().laneAlt(what, child.isOpen ? t().laneStates.running : t().laneStates.ended, child.span === undefined ? t().laneFrom(fmtMs(child.at)) : spanText(child.span), scale),
      true,
    )
  }

  const stepNode = (row: StepRow) => {
    const head = `#${row.step.index} · ${shortModel(row.step.model)}`
    const wait = row.step.ttftMs === undefined && row.state !== 'running' ? NONE : fmtMs(row.waitMs)
    const chips =
      row.state === 'done'
        ? []
        : [chip(el, STEP_TONES[row.state], row.state === 'running' ? `● ${t().runWord}` : row.state === 'failed' ? t().stepFailed : `~ ${t().laneStates.noResult}`)]
    const key = `timeline-tools:${view.turn.turnId}:${row.step.index}`
    const isOpen = ui.disclosures?.has(key) === true
    const hidden = row.children.filter(child => !isShownChild(child)).length

    return (
      <Box flexDirection="column">
        {lane(
          labelRow([<Text bold>{head}</Text>, ...chips], [<Text color="subtle">{ioOf(row.step)}</Text>, <Text>{timeOf(row, now)}</Text>]),
          stepLane(row, view.totalMs, px, height),
          t().stepAlt(head, t().laneStates[row.state], spanText(row.span), wait, scale),
        )}
        {row.children.filter(child => isOpen || isShownChild(child)).map(child => (child.kind === 'tool' ? toolNode(child) : forkNode(child)))}
        {hidden === 0 ? null : (
          <Box paddingLeft={2}>
            <Button key={`timeline-tools-${row.step.index}`} label={isOpen ? t().hideTools : t().showTools(hidden)} variant="secondary" onPress={() => ui.onToggleDisclosure?.(key)} />
          </Box>
        )}
      </Box>
    )
  }

  const compactNode = (row: CompactRow) => {
    const { tokensBefore, tokensAfter } = row.marker
    const text = tokensBefore !== undefined && tokensAfter !== undefined ? t().compacted(fmtTokens(tokensBefore), fmtTokens(tokensAfter)) : t().compactedBare

    return lane(<Text color="subtle">{text}</Text>, compactLane(row.at, view.totalMs, px, height), t().compactAlt(text, fmtMs(row.at)))
  }

  const apiError = view.turn.apiError
  const ticks = [fmtDuration(0), fmtMs(view.totalMs / 2), fmtMs(view.totalMs)] as const
  const isTimingOpen = ui.disclosures?.has('timeline-timing') === true

  return [
    <Box flexDirection="column">
      <Text wrap="wrap">
        <Text bold>{`${t().timelineSteps(view.turn.steps.length)} · ${turnTime(view)}`}</Text>
        {apiError === undefined ? [] : [' ', chip(el, 'failed', `✗ ${apiError.error}`)]}
      </Text>
      <Text>{t().criticalPathEstimate(view.pathMs === undefined ? NONE : fmtDuration(view.pathMs))}</Text>
      <Text color="subtle" wrap="wrap">
        {totalsText(view.totals)}
      </Text>
    </Box>,
    <Box flexDirection="column">
      <Text color="subtle" wrap="wrap">
        {t().timelineLegend}
      </Text>
      {beside(
        [],
        <Box flexDirection="column">
          <Box justifyContent="space-between" width={Math.round(px / PIXELS_PER_COLUMN)}>
            {ticks.map(one => (
              <Text color="subtle">{one}</Text>
            ))}
          </Box>
          <Svg source={axisSvg(px, height)} alt={t().axisAlt(...ticks)} width={px} height={height} />
        </Box>,
      )}
    </Box>,
    <Box flexDirection="column" rowGap={1}>
      {rows.map(row => (row.kind === 'compact' ? compactNode(row) : stepNode(row)))}
    </Box>,
    ...(pages > 1
      ? [
          <Box columnGap={1} alignItems="center" flexWrap="wrap">
            <Text color="subtle">{t().stepsRange(first + 1, last, stepAt.length)}</Text>
            {back < pages - 1 ? <Button key="timeline-earlier" label={t().earlierSteps} variant="secondary" onPress={() => ui.onPage?.(back + 1)} /> : null}
            {back > 0 ? <Button key="timeline-newer" label={t().newerSteps} variant="secondary" onPress={() => ui.onPage?.(back - 1)} /> : null}
          </Box>,
        ]
      : []),
    <Box flexDirection="column" alignItems="flex-start">
      <Button key="timeline-timing" label={t().timingTitle} variant="secondary" onPress={() => ui.onToggleDisclosure?.('timeline-timing')} />
      {isTimingOpen ? (
        <Text color="subtle" wrap="wrap">
          {t().timingNote}
        </Text>
      ) : null}
    </Box>,
  ]
}

/** Spans laid end to end along one bar, `ms` each on a scale of `totalMs`, over a faint TRACK. */
function spansSvg(spans: { ms: number; fill: string; more?: string }[], totalMs: number, px: number, height: number): string {
  const parts = [...(spans.some(one => one.fill === HATCH.fill) ? [HATCH.defs] : []), `<rect x="0" y="1" width="${px}" height="${height - 2}" fill="${TRACK}" fill-opacity="0.2"/>`]
  let at = 0

  for (const span of spans) {
    const width = clamp(span.ms / Math.max(1, totalMs), 0, 1) * px

    parts.push(`<rect x="${num(at)}" y="1" width="${num(Math.max(1, width))}" height="${height - 2}" fill="${span.fill}"${span.more ?? ''}/>`)
    at += width
  }

  return svg(px, height, parts.join(''))
}

/**
 * The main loop's hotspots in three sections, each on its own scale: tool execution time per tool, the model request
 * time as one bar of the hatched wait and the solid generation, and the slowest turns, each with a button that opens it.
 * The wide tier puts the first two side by side.
 */
export function drawHotspotsDesktop(el: El, turns: readonly TimelineTurn[], columns: number, onOpenTurn?: (turnId: string) => void): RenderNode[] {
  const { Box, Button, Svg, Text } = el
  const hot = hotspotsOf(turns)

  if (isEmpty(hot)) {
    return [<Text dimColor>{t().hotspotsEmpty}</Text>]
  }

  const tier = widthTierOf(columns)
  const model = hot.model
  const isSideBySide = tier === 'wide' && hot.tools.length > 0 && model !== undefined
  const { width: px, height } = LANE[tier]
  const sidePx = isSideBySide ? LANE.narrow.width : px
  const toolScale = Math.max(0, ...hot.tools.map(one => one.totalMs))
  const turnScale = Math.max(0, ...hot.slowest.map(one => one.durationMs))
  const modelMs = model === undefined ? 0 : model.waitMs + model.genMs
  const modelLines = model === undefined ? [] : [[t().modelWait, model.waitMs] as const, [t().modelGen, model.genMs] as const].map(([label, ms]) => `${label} ${fmtMs(ms)} · ${pctOf(ms, modelMs)}`)

  const tools =
    hot.tools.length === 0
      ? []
      : [
          <Box flexDirection="column" rowGap={1}>
            <Text bold>{t().toolExecTime}</Text>
            {hot.tools.map(one => {
              const meta = [t().callsN(one.count), t().totalTime(fmtMs(one.totalMs)), t().longest(fmtMs(one.maxMs))].join(' · ')

              return (
                <Box flexDirection="column">
                  <Text bold wrap="wrap">
                    {one.name}
                  </Text>
                  <Text color="subtle" wrap="wrap">
                    {meta}
                  </Text>
                  <Svg source={spansSvg([{ ms: one.totalMs, fill: FILL.done }], toolScale, sidePx, height)} alt={t().stepBarAlt(`${one.name} ${meta}`, `0—${fmtMs(toolScale)}`)} width={sidePx} height={height} />
                </Box>
              )
            })}
            <Text color="subtle">{t().sharedScale(`0—${fmtMs(toolScale)}`)}</Text>
          </Box>,
        ]
  const modelSection =
    model === undefined
      ? []
      : [
          <Box flexDirection="column">
            <Text bold>{t().modelRequestTime}</Text>
            <Svg
              source={spansSvg([{ ms: model.waitMs, fill: HATCH.fill, more: ` stroke="${TRACK}"` }, { ms: model.genMs, fill: FILL.done }], modelMs, sidePx, height)}
              alt={modelLines.join(t().altSeparator)}
              width={sidePx}
              height={height}
            />
            {modelLines.map(line => (
              <Text>{line}</Text>
            ))}
          </Box>,
        ]
  const slowest =
    hot.slowest.length === 0
      ? []
      : [
          <Box flexDirection="column" rowGap={1}>
            <Text bold>{t().slowestTurns}</Text>
            {hot.slowest.map(one => {
              const label = `${t().turnN(one.ordinal)} · ${fmtMs(one.durationMs)}`

              return (
                <Box flexDirection="column">
                  <Box justifyContent="space-between" columnGap={1} alignItems="center">
                    <Text wrap="truncate">{label}</Text>
                    <Button key={`timeline-open-${one.turnId}`} label={t().openTurn} variant="secondary" onPress={() => onOpenTurn?.(one.turnId)} />
                  </Box>
                  {one.slowStep === undefined ? null : <Text color="subtle">{t().slowStep(slowText(one))}</Text>}
                  <Svg source={spansSvg([{ ms: one.durationMs, fill: FILL.done }], turnScale, px, height)} alt={t().stepBarAlt(label, `0—${fmtMs(turnScale)}`)} width={px} height={height} />
                </Box>
              )
            })}
          </Box>,
        ]

  return [
    <Text bold>{t().hotspotsTitle(hot.turns)}</Text>,
    ...(isSideBySide
      ? [
          <Box columnGap={3}>
            <Box flexDirection="column" flexGrow={1}>
              {tools}
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              {modelSection}
            </Box>
          </Box>,
        ]
      : [...tools, ...modelSection]),
    ...slowest,
  ]
}
