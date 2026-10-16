import type { ElementTable, RenderChildren, RenderNode } from 'claude-code'

import type { AgentRun, TimelineCompaction, TimelineFork, TimelineStep, TimelineTool, TimelineToolOutcome, TimelineTurn, TimelineUsage } from '../types'
import { fit, fmtDuration, fmtTokens, widthOf } from './agent-model'
import { alignRight, clockOf, fitLine } from './board'
import type { Line, Seg } from './board'
import { card, chip, GLYPH_COLUMNS, kpis, pxWidth, widthTierOf } from './desktop/kit'
import type { Kpi } from './desktop/kit'
import { endMarker, FILL, HATCH, LANE, svg, TRACK } from './desktop-svg'
import type { Tone } from './desktop-svg'
import type { EventsRead, LedgerRecord } from './events'
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

// Layout columns a step's label takes left of its lane, fewer on the narrow tier.
const LABEL_COLUMNS = { narrow: 14, wide: 22 } as const
// Columns left free beside the label and the lane: their gap, the pane's padding and its scroll bar. The desktop wraps a lane that does not fit.
const SLACK_COLUMNS = 5
const LANE_MIN_PX = 160
const LANE_MAX_PX = 720
// The height of a lane, and of the axis above the lanes, in px.
const ROW_PX = 16
const AXIS_PX = 14
const TICK_STEPS_MS = [1, 2, 5, 10, 15, 30].flatMap(n => [n * 1000, n * 60_000]).concat([1, 2, 3, 6, 12].map(n => n * 3_600_000)).sort((a, b) => a - b)
const MAX_TICKS = 8

/** Where `ms` since the turn started falls on a lane `px` wide that holds `totalMs`. */
const xOf = (ms: number, totalMs: number, px: number) => clamp(ms / totalMs, 0, 1) * px

/** `0`, then whole seconds, minutes or hours. */
const tickText = (ms: number) => (ms === 0 ? '0' : ms < 60_000 ? `${ms / 1000}s` : ms < 3_600_000 ? `${ms / 60_000}m` : `${ms / 3_600_000}h`)

/** The scale's ticks from 0 up to `totalMs`, at the first round step that keeps them to MAX_TICKS. */
function ticksOf(totalMs: number): number[] {
  const step = TICK_STEPS_MS.find(one => totalMs / one <= MAX_TICKS) ?? TICK_STEPS_MS.at(-1)!

  return Array.from({ length: Math.floor(totalMs / step) + 1 }, (_, i) => i * step)
}

const tickX = (ms: number, totalMs: number, px: number) => Math.min(px - 1, xOf(ms, totalMs, px))

/** The ticks after 0 as faint full-height lines behind a lane. */
const gridOf = (ticks: readonly number[], totalMs: number, px: number) =>
  ticks
    .slice(1)
    .map(ms => `<rect x="${num(tickX(ms, totalMs, px))}" y="0" width="1" height="${ROW_PX}" fill="${TRACK}" fill-opacity=".14"/>`)
    .join('')

/** A span as a rounded rect `h` tall at `y`, at least MIN_MARK_PX wide. */
function spanRect(span: Span, totalMs: number, px: number, y: number, h: number, fill: string, more = ''): string {
  const width = Math.max(MIN_MARK_PX, xOf(span.to, totalMs, px) - xOf(span.from, totalMs, px))

  return `<rect x="${num(Math.min(xOf(span.from, totalMs, px), px - width))}" y="${y}" width="${num(width)}" height="${h}" rx="${num(Math.min(h, width) / 2)}" fill="${fill}"${more}/>`
}

/** A request 8 px tall: the first-token wait hatched, then the generation on the critical path, or in its state's color when it went wrong; an open arrow while it runs. */
function stepLane(row: StepRow, totalMs: number, px: number, grid: string): string {
  if (row.span === undefined) {
    return svg(px, ROW_PX, grid)
  }

  const turnAt = row.span.from + row.waitMs
  const wait = { from: row.span.from, to: turnAt }
  const fill = row.state === 'failed' || row.state === 'noResult' ? FILL[STEP_TONES[row.state]] : FILL.running
  const parts = [
    grid,
    ...(row.waitMs > 0 ? [HATCH.defs, spanRect(wait, totalMs, px, 4, 8, TRACK, ' fill-opacity=".16"'), spanRect(wait, totalMs, px, 4, 8, HATCH.fill)] : []),
    ...(row.span.to > turnAt ? [spanRect({ from: turnAt, to: row.span.to }, totalMs, px, 4, 8, fill)] : []),
    ...(row.state === 'running' ? [endMarker(xOf(row.span.to, totalMs, px), 4, 8, px, FILL.running, true)] : []),
  ]

  return svg(px, ROW_PX, parts.join(''))
}

/** A tool group 4 px tall: in its outcome's color when it went wrong, else on the critical path or running, else parallel. */
function toolLane(child: ToolRow, totalMs: number, px: number, grid: string): string {
  if (child.span === undefined) {
    return svg(px, ROW_PX, grid)
  }

  const fill = child.outcome !== undefined ? FILL[OUTCOME_TONES[child.outcome]] : child.runningMs !== undefined || child.isCritical ? FILL.running : TRACK
  const end = child.runningMs === undefined ? '' : endMarker(xOf(child.span.to, totalMs, px), 4, 8, px, fill, true)

  return svg(px, ROW_PX, grid + spanRect(child.span, totalMs, px, 6, 4, fill) + end)
}

/** A fork 4 px tall, running or critical on the critical path's color, else parallel; a tick at its start when its end is unknown. */
function forkLane(child: ForkRow, totalMs: number, px: number, grid: string): string {
  if (child.span === undefined) {
    return svg(px, ROW_PX, `${grid}<rect x="${num(Math.min(px - 2, xOf(child.at, totalMs, px)))}" y="4" width="2" height="8" fill="${TRACK}"/>`)
  }

  const fill = child.isOpen || child.isCritical ? FILL.running : TRACK
  const end = child.isOpen ? endMarker(xOf(child.span.to, totalMs, px), 4, 8, px, fill, true) : ''

  return svg(px, ROW_PX, grid + spanRect(child.span, totalMs, px, 6, 4, fill) + end)
}

/** A compaction as a vertical line at its time. */
function compactLane(at: number, totalMs: number, px: number, grid: string): string {
  return svg(px, ROW_PX, `${grid}<rect x="${num(clamp(xOf(at, totalMs, px), 0, px - 2))}" y="0" width="2" height="${ROW_PX}" fill="${TRACK}"/>`)
}

/** The lanes' time axis: a base line, and a tick with its time at each of `ticks`. */
function axisSvg(ticks: readonly number[], totalMs: number, px: number): string {
  const marks = ticks.map(ms => {
    const x = tickX(ms, totalMs, px)
    const anchor = ms === 0 ? 'start' : x > px - 12 ? 'end' : 'middle'

    return `<rect x="${num(x)}" y="8" width="1" height="4" fill="${TRACK}"/><text x="${num(x)}" y="7" font-size="9" fill="${TRACK}" text-anchor="${anchor}">${tickText(ms)}</text>`
  })

  return svg(px, AXIS_PX, `<rect x="0" y="11" width="${px}" height="1" fill="${TRACK}" fill-opacity=".5"/>${marks.join('')}`)
}

/** The legend's swatches, drawn as the lanes draw what they stand for. */
const LEGEND = [
  ['critical', `<rect width="10" height="10" rx="2.5" fill="${FILL.running}"/>`],
  ['parallel', `<rect width="10" height="10" rx="2.5" fill="${TRACK}"/>`],
  ['wait', `${HATCH.defs}<rect width="10" height="10" rx="2.5" fill="${TRACK}" fill-opacity=".16"/><rect width="10" height="10" rx="2.5" fill="${HATCH.fill}"/>`],
] as const

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
 * The turn's KPI tiles, a legend and a time axis, then a page of its steps: per request, tool group, fork and compaction
 * a fixed-width label left of one lane. Every lane has the axis's width and scale; the steps off the page fold into one line each side.
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
  const labelColumns = tier === 'narrow' ? LABEL_COLUMNS.narrow : LABEL_COLUMNS.wide
  const px = pxWidth(columns - labelColumns - SLACK_COLUMNS, LANE_MIN_PX, LANE_MAX_PX)
  const perPage = STEPS_PER_PAGE[tier]
  const stepAt = view.rows.flatMap((row, i) => (row.kind === 'step' ? [i] : []))
  const pages = Math.ceil(stepAt.length / perPage)
  const back = clamp(ui.back ?? 0, 0, pages - 1)
  const last = stepAt.length - back * perPage
  const first = Math.max(0, last - perPage)
  // A page holds its steps and the compactions before each; the newest page also those after its last step.
  const rows = view.rows.slice(first === 0 ? 0 : stepAt[first - 1]! + 1, last === stepAt.length ? view.rows.length : stepAt[last]!)
  const steps = view.rows.filter((row): row is StepRow => row.kind === 'step')
  const ticks = ticksOf(view.totalMs)
  const grid = gridOf(ticks, view.totalMs, px)
  const scale = `0—${fmtMs(view.totalMs)}`
  const spanText = (span: Span | undefined) => (span === undefined ? t().laneUnknown : t().laneSpan(fmtMs(span.from), fmtMs(span.to)))
  const lane = (label: RenderChildren, source: string, alt: string, height = ROW_PX) => (
    <Box flexDirection="row" columnGap={1} alignItems="center">
      <Box width={labelColumns} flexShrink={0}>
        <Text wrap="truncate-end">{label}</Text>
      </Box>
      <Svg source={source} alt={alt} width={px} height={height} />
    </Box>
  )

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
    const label = [
      <Text color="subtle">{`└ ${toolLabel(child)} `}</Text>,
      ...(child.outcome === undefined ? [] : [chip(el, OUTCOME_TONES[child.outcome], outcomeText(child.outcome))]),
      <Text color={child.runningMs !== undefined ? 'permission' : 'subtle'}>{laneTime(child)}</Text>,
    ]

    return lane(label, toolLane(child, view.totalMs, px, grid), t().laneAlt(what, state, spanText(child.span), scale))
  }

  const forkNode = (child: ForkRow) => {
    const name = `▸ ${child.fork.subagentType} · ${child.fork.description}`
    const what = [name, ...(child.fork.background ? [t().background] : []), ...(child.isCritical ? [t().critical] : [])].join(' · ')
    const ms = child.span === undefined ? undefined : child.span.to - child.span.from
    const time = ms === undefined ? NONE : child.isOpen ? `${fmtDuration(ms)}…` : fmtMs(ms)
    const label = [
      <Text color="subtle">{`└ ${name} `}</Text>,
      ...(child.fork.background ? [<Text color="subtle">{`${t().background} `}</Text>] : []),
      ...(child.isOpen ? [chip(el, 'running', `● ${t().runWord}`)] : []),
      <Text color={child.isOpen ? 'permission' : 'subtle'}>{time}</Text>,
    ]

    return lane(
      label,
      forkLane(child, view.totalMs, px, grid),
      t().laneAlt(what, child.isOpen ? t().laneStates.running : t().laneStates.ended, child.span === undefined ? t().laneFrom(fmtMs(child.at)) : spanText(child.span), scale),
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
    const label = [<Text bold>{`#${row.step.index}`}</Text>, <Text color="subtle">{` ${shortModel(row.step.model)} ${timeOf(row, now)}`}</Text>, ...chips]

    return (
      <Box flexDirection="column">
        {lane(label, stepLane(row, view.totalMs, px, grid), t().stepAlt(head, t().laneStates[row.state], spanText(row.span), wait, scale))}
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

    return lane(<Text color="subtle">{text}</Text>, compactLane(row.at, view.totalMs, px, grid), t().compactAlt(text, fmtMs(row.at)))
  }

  /** Steps off the page as one line: their indexes, count and the time from the first one's start to `toMs`. */
  const folded = (stretch: StepRow[], toMs: number) => {
    if (stretch.length === 0) {
      return []
    }

    const fromMs = stretch[0]!.step.sentAt - view.turn.startedAt

    return [<Text color="subtle">{t().stepsFolded(stretch[0]!.step.index, stretch.at(-1)!.step.index, stretch.length, fmtMs(Math.max(0, toMs - fromMs)))}</Text>]
  }

  const apiError = view.turn.apiError
  const share = cacheShare(view.totals)
  const isTimingOpen = ui.disclosures?.has('timeline-timing') === true
  const axisAlt = t().axisAlt(fmtDuration(0), fmtMs(view.totalMs / 2), fmtMs(view.totalMs))
  const kpi = t().timelineKpis

  return [
    kpis(el, [
      { label: kpi.total, value: turnTime(view), color: 'text', isZero: false },
      { label: kpi.critical, value: view.pathMs === undefined ? NONE : fmtDuration(view.pathMs), color: 'permission', isZero: view.pathMs === undefined },
      { label: kpi.tools, value: String(view.totals.tools), color: 'text', isZero: view.totals.tools === 0 },
      { label: kpi.cacheRead, value: share === undefined ? NONE : `${share}%`, color: 'success', isZero: share === undefined },
    ]),
    <Box flexDirection="column">
      <Text wrap="wrap">
        <Text bold>{t().timelineSteps(view.turn.steps.length)}</Text>
        {apiError === undefined ? [] : [' ', chip(el, 'failed', `✗ ${apiError.error}`)]}
      </Text>
      <Text color="subtle" wrap="wrap">
        {totalsText(view.totals)}
      </Text>
    </Box>,
    <Box flexDirection="row" columnGap={2} flexWrap="wrap">
      {LEGEND.map(([key, body]) => (
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Svg source={svg(10, 10, body)} alt={t().timelineLegend[key]} width={10} height={10} />
          <Text color="subtle">{t().timelineLegend[key]}</Text>
        </Box>
      ))}
    </Box>,
    <Box flexDirection="column">
      {lane([], axisSvg(ticks, view.totalMs, px), axisAlt, AXIS_PX)}
      {folded(steps.slice(0, first), steps[first] === undefined ? view.totalMs : steps[first]!.step.sentAt - view.turn.startedAt)}
      {rows.map(row => (row.kind === 'compact' ? compactNode(row) : stepNode(row)))}
      {folded(steps.slice(last), view.totalMs)}
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

/** The disclosure that shows the timeline page's events view instead of its steps. */
export const EVENTS_VIEW = 'timeline-events'
/** The disclosure that shows every event of this session, not only the newest EVENTS_SHOWN. */
const EVENTS_ALL = 'timeline-events-all'
const EVENTS_SHOWN = 8

/** One event as a row: its glyph in its theme key, what happened, the stored attributes that say more, and a duration if it has one. */
type EventRow = { at: number; glyph: string; color: string; kind: string; detail: string; time?: string }

/** A stored attribute as one line of text; '' when absent or not text or a number. */
function attrText(event: LedgerRecord, key: string): string {
  const value = event.attributes[key]

  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : typeof value === 'number' ? String(value) : ''
}

function attrNumber(event: LedgerRecord, key: string): number | undefined {
  const value = event.attributes[key]

  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const joinTexts = (...texts: string[]) => texts.filter(one => one !== '').join(' · ')

/** `9c1e…` of a session id. */
const shortId = (id: string) => (id.length > 4 ? `${id.slice(0, 4)}…` : id)

/** The row of `event`, `all` its session's events; a session's start and end are its bounds, not rows. */
function eventRow(event: LedgerRecord, all: readonly LedgerRecord[]): EventRow | undefined {
  const kinds = t().eventKinds
  const row = (glyph: string, color: string, kind: string, detail: string, ms?: number): EventRow => ({
    at: event.at,
    glyph,
    color,
    kind,
    detail,
    ...(ms !== undefined && { time: fmtDuration(ms) }),
  })

  switch (event.name) {
    case 'session.start':
    case 'session.end':
      return undefined
    case 'gate.result': {
      const isPass = event.attributes.outcome === 'pass'
      const pass = attrNumber(event, 'pass')
      const fail = attrNumber(event, 'fail')

      return row(isPass ? '✓' : '✗', isPass ? 'success' : 'error', isPass ? kinds.gatePass : kinds.gateFail, joinTexts(pass === undefined ? '' : `${pass} pass`, `${fail ?? '?'} fail`, attrText(event, 'command')))
    }
    case 'guard.block':
      return row('⊘', 'warning', kinds.guardBlock, joinTexts(attrText(event, 'rule.id'), attrText(event, 'target')))
    case 'agent.end': {
      const state = attrText(event, 'state')
      const [color, kind] = state === 'done' ? ['success', kinds.agentReturned] : state === 'aborted' ? ['warning', kinds.agentAborted] : ['error', kinds.agentError]

      return row('↩', color, kind, joinTexts(attrText(event, 'agent.type'), attrText(event, 'agent.id').slice(0, 8)), attrNumber(event, 'duration_ms'))
    }
    case 'agent.denied':
      return row('✗', 'error', kinds.agentDenied, joinTexts(attrText(event, 'agent.type'), attrText(event, 'tool')))
    case 'mmrun.start':
      return row('▶', 'permission', kinds.mmrunStart, joinTexts(attrText(event, 'label'), attrText(event, 'models')))
    case 'mmrun.end': {
      const id = attrText(event, 'run.id')
      const start = id === '' ? undefined : all.find(one => one.name === 'mmrun.start' && attrText(one, 'run.id') === id && one.at <= event.at)

      return row('■', event.severity === 'INFO' ? 'success' : 'warning', kinds.mmrunEnd, joinTexts(attrText(event, 'label'), attrText(event, 'status')), start === undefined ? undefined : event.at - start.at)
    }
    case 'session.compact': {
      const before = attrNumber(event, 'tokens_before')
      const after = attrNumber(event, 'tokens_after')

      return row('◇', 'subtle', kinds.compact, before !== undefined && after !== undefined ? `${fmtTokens(before)} → ${fmtTokens(after)}` : attrText(event, 'trigger'))
    }
    case 'rule.hint':
      return row('!', 'warning', kinds.ruleHint, joinTexts(attrText(event, 'rule.id'), attrText(event, 'target')))
    default:
      return row('·', 'subtle', event.name, '')
  }
}

const rowsOf = (events: readonly LedgerRecord[]) => events.flatMap(one => eventRow(one, events) ?? [])

/** This session's rows oldest first and its KPI tiles; per other session its id, first event and row count. */
function eventsViewOf(read: EventsRead | undefined) {
  const own = read?.own ?? []
  const rows = rowsOf(own)
  const count = (name: string) => own.filter(one => one.name === name).length
  const gates = own.filter(one => one.name === 'gate.result')
  const agents = new Set(own.filter(one => one.name.startsWith('agent.')).map(one => attrText(one, 'agent.id')).filter(id => id !== '')).size
  const kpi = t().eventKpis
  const tiles: Kpi[] = [
    { label: kpi.events, value: String(rows.length), color: 'text', isZero: rows.length === 0 },
    { label: kpi.blocks, value: String(count('guard.block')), color: 'warning', isZero: count('guard.block') === 0 },
    { label: kpi.gates, value: String(gates.length), color: gates.some(one => one.attributes.outcome !== 'pass') ? 'error' : 'success', isZero: gates.length === 0 },
    { label: kpi.subagents, value: String(agents), color: 'permission', isZero: agents === 0 },
  ]
  const others = (read?.others ?? []).map(one => ({ id: one.session, from: one.events[0]!.at, count: rowsOf(one.events).length }))

  return { rows, tiles, others, since: own[0]?.at }
}

/** The events view on the desktop: KPI tiles, this session's newest events newest last, then a folded line per other session of today. */
export function drawEventsDesktop(el: El, read: EventsRead | undefined, ui: Pick<WaterfallUi, 'disclosures' | 'onToggleDisclosure'> = {}): RenderNode[] {
  const { Box, Button, Text } = el
  const view = eventsViewOf(read)
  const isAll = ui.disclosures?.has(EVENTS_ALL) === true
  const hidden = isAll ? 0 : Math.max(0, view.rows.length - EVENTS_SHOWN)
  const row = (one: EventRow) => (
    <Box flexDirection="row" columnGap={1}>
      <Box width={5} flexShrink={0}>
        <Text color="subtle">{clockOf(one.at)}</Text>
      </Box>
      <Box width={GLYPH_COLUMNS} flexShrink={0}>
        <Text color={one.color} bold>
          {one.glyph}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">
          <Text bold>{one.kind}</Text>
          {one.detail === '' ? null : <Text color="subtle">{`  ${one.detail}`}</Text>}
        </Text>
      </Box>
      {one.time === undefined ? null : (
        <Box flexShrink={0}>
          <Text color="subtle">{one.time}</Text>
        </Box>
      )}
    </Box>
  )
  const own =
    view.rows.length === 0 || read === undefined
      ? [<Text dimColor>{t().eventsEmpty}</Text>]
      : [
          <Box flexDirection="row" columnGap={1}>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text bold wrap="truncate-end">
                {t().eventsOwn(shortId(read.session))}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text color="subtle">{t().eventsSince(clockOf(view.since ?? view.rows[0]!.at), view.rows.length)}</Text>
            </Box>
          </Box>,
          ...(view.rows.length > EVENTS_SHOWN
            ? [
                <Box flexDirection="row">
                  <Button key="timeline-events-all" label={isAll ? t().collapse : t().eventsMore(hidden)} variant="secondary" onPress={() => ui.onToggleDisclosure?.(EVENTS_ALL)} />
                </Box>,
              ]
            : []),
          ...view.rows.slice(hidden).map(row),
        ]

  return [
    kpis(el, view.tiles),
    card(el, own),
    ...(view.others.length === 0
      ? []
      : [
          card(
            el,
            view.others.map(one => (
              <Text color="subtle" wrap="truncate-end">
                {t().eventsSession(shortId(one.id), clockOf(one.from), one.count)}
              </Text>
            )),
          ),
        ]),
  ]
}

/** The events view on the terminal for `width` columns: the tiles in one line, then the rows aligned, the older ones and the other sessions folded. */
export function eventLines(read: EventsRead | undefined, width: number): Line[] {
  const view = eventsViewOf(read)
  const tiles: Line = view.tiles.flatMap((tile, i): Seg[] => [
    ...(i === 0 ? [] : [{ text: ' · ', color: 'subtle' }]),
    { text: `${tile.label} `, color: 'subtle' },
    tile.isZero ? { text: tile.value, color: 'inactive' } : { text: tile.value, color: tile.color, bold: true },
  ])
  const others = view.others.map((one): Line => [{ text: t().eventsSession(shortId(one.id), clockOf(one.from), one.count), dim: true }])

  if (view.rows.length === 0 || read === undefined) {
    return [tiles, [{ text: t().eventsEmpty, dim: true }], ...others].map(line => fitLine(line, width))
  }

  const hidden = Math.max(0, view.rows.length - EVENTS_SHOWN)
  const shown = view.rows.slice(hidden)
  const kindW = Math.max(...shown.map(one => widthOf(one.kind)))
  const timeW = Math.max(0, ...shown.map(one => widthOf(one.time ?? '')))
  // `HH:MM`, the glyph and the kind, two spaces after each, and the time with two spaces before it.
  const room = width - 7 - 3 - kindW - 2 - (timeW > 0 ? timeW + 2 : 0)
  const row = (one: EventRow): Line => [
    { text: `${clockOf(one.at)}  `, color: 'subtle' },
    { text: one.glyph, color: one.color, bold: true },
    { text: `  ${pad(one.kind, kindW)}`, bold: true },
    { text: `  ${room > 0 ? pad(fit(one.detail, room), room) : ''}`, color: 'subtle' },
    ...(timeW > 0 ? [{ text: `  ${alignRight(one.time ?? '', timeW)}`, color: 'subtle' }] : []),
  ]
  const head: Line = [
    { text: t().eventsOwn(shortId(read.session)), bold: true },
    { text: ` · ${t().eventsSince(clockOf(view.since ?? shown[0]!.at), view.rows.length)}`, color: 'subtle' },
  ]

  return [tiles, head, ...(hidden > 0 ? [[{ text: t().eventsMore(hidden), dim: true }]] : []), ...shown.map(row), ...others].map(line => fitLine(line, width))
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
