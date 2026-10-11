import type { ElementTable, RenderChildren, RenderSurface } from 'claude-code'

import type { AgentPeek, AgentRun, BoardNode, BoardRead, BoardRequest, DashDetail, DashPage, DashReport, DashSeen, DashTimelinePage, DashTimelineView, GateRun, GpuWatch, GuardBlock, MmModel, MmSnapshot, SessionPresence, TimelineTurn, UsageCounts, WorktreeInfo } from '../types'
import { elapsedOf, fit, fmtAge, fmtDuration, fmtTokens, glyphOf, widthOf } from './agent-model'
import {
  agentFold,
  askLines,
  clockOf,
  commandHead,
  endedHead,
  fitLine,
  flightText,
  foldText,
  GATE_COMMAND_COLUMNS,
  gateOutcome,
  isFailedGate,
  isStalled,
  itemTail,
  itemTitle,
  legacyNodes,
  overviewOf,
  PEER_WORDS,
  peerTitle,
  PIECE_GLYPHS,
  progressAge,
  progressColor,
  progressDoneWhen,
  progressGroups,
  progressMeta,
  recentGates,
  requestGlyph,
  requestPieces,
  rollupText,
  staleHours,
  tokensText,
  usageText,
} from './board'
import type { Line, Live, OverviewItem, Seg, ShownPeer } from './board'
import { BAR, BAR_SIZES, elapsedBar, GAUGE, horizontalGauge, MEMORY, scaleOf, TONE_KEYS, FILL } from './desktop-svg'
import type { Tone } from './desktop-svg'
import { t } from './i18n'
import { titlePattern } from './progress'
import { capLeaf, elapsedSecs, fmtRunTokens, fmtSecs, listOf, runLabel, SEVERITIES } from './runs'
import type { Flight } from './timeline'
import { drawHotspotsDesktop, drawTimelineDesktop, latestMainTurnId } from './timeline-view'
import { isEmptyWeek } from './usage'
import type { UsageWeek } from './usage'
import { GUARD_COLORS, guardHead, treeMarks } from './workspace'
import type { Mark } from './workspace'

type El = ElementTable<'desktop'>

// Measured on the desktop app: a pane of 54 bodyColumns is about 515px wide, and one gap or padding unit is about 10px.
export const PIXELS_PER_COLUMN = 9.5
// Text cells (widthOf) that fit in one column: the desktop draws an ASCII cell about 7–8px wide, a CJK character two of them.
const TEXT_CELLS_PER_COLUMN = 1.25
/** The text cells, as fit counts them, that `columns` layout columns hold. */
export const textCells = (columns: number) => Math.floor(columns * TEXT_CELLS_PER_COLUMN)
export const TIER_NARROW_MAX_PX = 439
export const TIER_STANDARD_MIN_PX = 440
export const TIER_WIDE_MIN_PX = 760

export type WidthTier = 'narrow' | 'standard' | 'wide'

export function widthTierOf(columns: number): WidthTier {
  const px = columns * PIXELS_PER_COLUMN
  if (px <= TIER_NARROW_MAX_PX) return 'narrow'
  if (px < TIER_WIDE_MIN_PX) return 'standard'
  return 'wide'
}

/** POSIX single-quote escaping for clipboard / command disclosures. */
export const posixQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

export type PaneData = {
  page: DashPage
  pages: readonly { page: DashPage; label: string }[]
  now: number
  columns: number
  agents: readonly AgentRun[]
  snap: MmSnapshot | null
  seen: DashSeen
  gpu: GpuWatch | null
  gpuHosts?: readonly string[]
  onConnectGpu?: (host: string) => void
  /** Forgets the watched host, so the GPU page shows its host picker again. */
  onChangeGpuHost?: () => void
  disclosures?: ReadonlySet<string>
  onToggleDisclosure?: (key: string) => void
  gates: readonly GateRun[]
  /** null before the first collection. */
  trees: readonly WorktreeInfo[] | null
  /** guard.jsonl's newest blocks, newest first; none draws no card. */
  guards: readonly GuardBlock[]
  /** Other sessions. */
  peers: readonly SessionPresence[]
  /** Runs the mmrun page shows, newest first. */
  paneRuns: number
  detail: DashDetail | null
  reports: Record<string, DashReport>
  /** The timeline page's turns, oldest first. */
  timeline?: readonly TimelineTurn[]
  /** The turn the timeline page shows; undefined follows the main loop's latest. */
  timelineTurnId?: string
  /** Picks the turn to show; undefined goes back to following the latest. */
  onTimelineTurn?: (turnId: string | undefined) => void
  /** Absent, the single turn. */
  timelineView?: DashTimelineView
  /** Switches between the single turn and the hotspots. */
  onTimelineView?: () => void
  /** The waterfall's step page as picked; another turn than the shown one shows its newest steps. */
  timelinePage?: DashTimelinePage
  onTimelinePage?: (page: DashTimelinePage) => void
  /** Per agent, its call still running; a quiet agent with one is not marked quiet. */
  flights?: ReadonlyMap<string, Flight>
  /** What ended after this is unread on the Agents page; absent, `seen.agents`. */
  agentsSeenBefore?: number
  /** Whether the Agents page shows the ended agents it folds. */
  isFoldOpen?: boolean
  onToggleFold?: () => void
  /** The open running agent's transcript as last read. */
  peek?: AgentPeek | null
  /** The usage page's last 7 days; absent, nothing recorded. */
  usage?: UsageWeek
  /** The progress board as last read; absent or null, not read yet. */
  progress?: BoardRead | null
  /** Closes a progress node (done or dropped) and reads the board again. */
  onCloseNode?: (id: string, status: 'done' | 'dropped') => void
  /** Closes a request as accepted by the person and reads the board again. */
  onAcceptRequest?: (id: string) => void
  /** Drops a request, its pieces left as they are, and reads the board again. */
  onDropRequest?: (id: string) => void
  onPage: (to: DashPage) => void
  onReadAgent: (agentId: string) => void
  onReadRun: (runid: string) => void
  /** Opens an overview item on its own page: Agents or Reviews, then its detail. */
  onOpenItem: (item: OverviewItem) => void
  onBack: () => void
  onToggleSeverity: () => void
  /** Shows that model's report in the reader. */
  onPickModel?: (name: string) => void
  /** Shows the reader's finding at this index of the shown ones. */
  onFinding?: (index: number) => void
  /** Copies `claude --resume '<sessionId>'` on the surface pressed. */
  onCopyResume: (sessionId: string, surface: RenderSurface) => void
  /** Copies `cd '<path>'` on the surface pressed. */
  onCopyCd: (path: string, surface: RenderSurface) => void
  onClose: () => void
}

const gib = (mib: number) => (mib / 1024).toFixed(1)
const shortName = (name: string) => name.replace(/^NVIDIA /, '').replace(/^GeForce /, '')
const pct = (n: number | null) => (n === null ? 'N/A' : `${n}%`)

const PEER_TONES: Record<ShownPeer['state'], Tone> = { permission: 'stale', failed: 'failed', replied: 'stale', working: 'running' }

const AGENT_TONES: Record<AgentRun['state'], Tone> = { running: 'running', done: 'done', aborted: 'stale', error: 'failed', refusal: 'failed' }

const agentTone = (run: AgentRun): Tone => AGENT_TONES[run.state]

function agentWord(run: AgentRun): string {
  if (run.state === 'running') {
    return `● ${t().runWord}`
  }

  return run.state === 'done' ? t().chipReturned : `${glyphOf(run.state).glyph} ${t().agentStates[run.state]}`
}

export function modelTone(model: Pick<MmModel, 'status'>): Tone {
  if (model.status === 'RUNNING') {
    return 'running'
  }

  // As modelStatusOf words it: only FAIL is an error; CANCELLED, SKIP and STALE are warnings.
  return model.status === 'DONE' ? 'done' : model.status.startsWith('FAIL') ? 'failed' : 'stale'
}

export const MODEL_GLYPHS: Record<Tone, string> = { running: '●', done: '✓', failed: '✗', stale: '~' }

function modelWord(model: MmModel): string {
  if (model.status === 'RUNNING') {
    return `● ${t().runWord}`
  }

  return `${MODEL_GLYPHS[modelTone(model)]} ${model.status}`
}

/** A model's status in words and its theme key; STALE and FAIL keep the raw status beside the word. */
function modelStatusOf(model: Pick<MmModel, 'status'>): { text: string; color: string } {
  if (model.status === 'RUNNING') {
    return { text: `● ${t().runWord}`, color: 'permission' }
  }

  if (model.status === 'DONE') {
    return { text: t().modelStatusDone, color: 'success' }
  }

  if (model.status === 'CANCELLED') {
    return { text: t().modelStatusCancelled, color: 'warning' }
  }

  if (model.status === 'STALE') {
    return { text: t().modelStatusStale(model.status), color: 'warning' }
  }

  return model.status.startsWith('FAIL') ? { text: t().modelStatusFailed(model.status), color: 'error' } : { text: `~ ${model.status}`, color: 'warning' }
}

export function chip(el: El, tone: Tone, text: string) {
  const { Text } = el

  return (
    <Text color={TONE_KEYS[tone]} bold>
      {` ${text} `}
    </Text>
  )
}

export function card(el: El, children: RenderChildren) {
  const { Box } = el

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1}>
      {children}
    </Box>
  )
}

/** The band, frameless single line: attention uses primary workbench button, else secondary. */
export function drawDesktopBand(el: El, lines: readonly Line[], onOpen: () => void, needsYou = false) {
  const { Box, Button, Text } = el
  const draw = (line: Line) => (
    <Text wrap="truncate">
      {line.map(seg => (
        <Text
          {...(seg.color !== undefined && { color: seg.color })}
          {...(seg.bold === true && { bold: true })}
          {...(seg.dim === true && { dimColor: true })}
        >
          {seg.text.replace(/ {3,}/g, '  ')}
        </Text>
      ))}
    </Text>
  )

  const isPrimary =
    needsYou ||
    lines.some(l => l.some(s => s.color === 'error' || (s.color === 'warning' && s.text.includes('!'))))

  return (
    <Box flexDirection="column" width="100%">
      <Box justifyContent="space-between" columnGap={1} alignItems="center">
        {draw(lines[0] ?? [])}
        <Button key="dash-open" label={t().workbench} variant={isPrimary ? 'primary' : 'secondary'} onPress={onOpen} />
      </Box>
      {lines.slice(1).map(draw)}
    </Box>
  )
}

function tabs(el: El, data: Pick<PaneData, 'page' | 'pages' | 'onPage'>) {
  const { Box, Button } = el
  const buttonOf = (one: { page: DashPage; label: string }) => (
    <Button
      key={`page-${one.page}`}
      label={one.label}
      variant={one.page === data.page ? 'primary' : 'secondary'}
      onPress={() => data.onPage(one.page)}
    />
  )

  return (
    <Box flexDirection="row" columnGap={1} rowGap={1} flexWrap="wrap">
      {data.pages.map(buttonOf)}
    </Box>
  )
}

// Overview lines are cut in code to these budgets: a title line leaves its Button BUTTON_CELLS, any other line EDGE_CELLS.
const BUTTON_CELLS = 12
const EDGE_CELLS = 2
// A section frame's border and padding, one cell each side.
const FRAME_CELLS = 4
/** Rows an overview section shows before its `N more` Button. */
const SECTION_CAP = 3
/** Characters of a command a disclosure's Code shows. */
const COMMAND_CHARS = 8000
// The progress page: cells a request card keeps for its age (`30d!`); closed requests a section lists; requests that make a series.
const AGE_CELLS = 4
const LISTED_CLOSED = 3
const CHAIN_MIN = 3
// The version in a title, as titlePattern folds it to `<ver>`.
const VERSION = /\bv?\d+(?:\.\d+)+/i
const DAY_MS = 86_400_000

/** `time` as `template` words it, the time a Live segment keyed `key`. */
function liveSegs(template: (time: string) => string, key: string, from: number, now: number, format: Live['format']): Line {
  const [before = '', after = ''] = template('\u0000').split('\u0000')
  const time: Seg = { text: (format === 'age' ? fmtAge : fmtDuration)(now - from), live: { key, from, now, format } }

  return [...(before === '' ? [] : [{ text: before }]), time, ...(after === '' ? [] : [{ text: after }])]
}

const isPlain = (seg: Seg) => seg.color === undefined && seg.bold !== true && seg.dim !== true && seg.live === undefined

/** The parts with ` · ` between them, neighboring plain segments as one. */
function joinParts(parts: readonly Line[]): Line {
  const out: Seg[] = []

  for (const seg of parts.flatMap((part, index) => (index === 0 ? part : [{ text: ' · ' }, ...part]))) {
    const last = out.at(-1)

    if (last !== undefined && isPlain(last) && isPlain(seg)) {
      out[out.length - 1] = { text: last.text + seg.text }
    } else {
      out.push(seg)
    }
  }

  return out
}

const itemKey = (item: OverviewItem) => (item.kind === 'agent' ? item.run.agentId : `${item.run.runid}/${item.model.name}`)

const chipSeg = (tone: Tone, text: string): Seg => ({ text: ` ${text} `, color: TONE_KEYS[tone], bold: true })

const segsWidth = (line: Line) => widthOf(line.map(seg => seg.text).join(''))

function itemChip(item: OverviewItem, now: number, flights: ReadonlyMap<string, Flight> | undefined): Line {
  if (item.kind === 'model') {
    return [chipSeg(modelTone(item.model), modelWord(item.model))]
  }

  return isStalled(item.run, now, flights?.get(item.run.agentId))
    ? liveSegs(time => ` ◐ ${t().quiet(time)} `, `quiet-${item.run.agentId}`, item.run.lastActivityAt, now, 'duration').map(seg => ({ ...seg, color: TONE_KEYS.stale, bold: true }))
    : [chipSeg(agentTone(item.run), agentWord(item.run))]
}

/** `4 tools · 3m12s`, or a model's tokens and time; then how long ago it ended. A running agent's time and every age move by themselves. */
function itemMeta(item: OverviewItem, now: number, polledAt: number): Line {
  const endedAt = item.kind === 'agent' ? item.run.endedAt : item.model.endedAt
  const parts = itemTail(item, now, polledAt)
    .split('  ')
    .filter(part => part !== '')
    .map((text): Line => [{ text }])

  if (item.kind === 'agent' && item.run.durationMs === undefined) {
    // While it runs, elapsedOf(run, now) is now - from.
    const from = (item.run.turnAt ?? item.run.startedAt) - (item.run.activeMs ?? 0)

    parts[parts.length - 1] = [{ text: fmtDuration(elapsedOf(item.run, now)), live: { key: `elapsed-${item.run.agentId}`, from, now, format: 'duration' } }]
  }

  return joinParts([...parts, ...(endedAt === undefined ? [] : [liveSegs(t().gateAgo, `ended-${itemKey(item)}`, endedAt, now, 'age')])])
}

/** `agent-x · 2 fail · 3m ago`, `main · 24 pass · 1h05m ago`; a stale run says stale before its age. */
function gateMeta(gate: GateRun, key: string, now: number): Line {
  const outcome = isFailedGate(gate) ? gateOutcome(gate) : `${gate.unit === 'packages' ? `${t().packagesUnit} · ` : ''}${t().passCount(gate.pass ?? '—')}`
  const words = [gate.where === 'main' ? t().mainTree : gate.where, outcome, ...(gate.stale === true ? [t().gateStale] : [])]

  return joinParts([...words.map((text): Line => [{ text }]), liveSegs(t().gateAgo, key, gate.at, now, 'age')])
}

/** A worktree mark inside the subtle metadata line: `plain` at full strength, `dim` left subtle, the rest a chip's color. */
const markSeg = (mark: Mark): Seg =>
  mark.tone === 'plain' ? { text: mark.text, color: 'text' } : mark.tone === 'dim' ? { text: mark.text } : { text: mark.text, color: TONE_KEYS[mark.tone], bold: true }

/** One Text of segments, each Live one a clock-client Client between Texts; the desktop ignores truncation in practice, so callers cut the line first. */
function lineText(el: El, line: Line, color?: string) {
  const { Box, Client, Text } = el
  const textOf = (segs: Line) => (
    <Text wrap="truncate-end" {...(color !== undefined && { color })}>
      {segs.map(seg => (
        <Text {...(seg.color !== undefined && { color: seg.color })} {...(seg.bold === true && { bold: true })}>
          {seg.text}
        </Text>
      ))}
    </Text>
  )

  if (!line.some(seg => seg.live !== undefined)) {
    return textOf(line)
  }

  const parts: RenderChildren[] = []
  let plain: Seg[] = []

  for (const seg of line) {
    if (seg.live === undefined) {
      plain.push(seg)
      continue
    }

    if (plain.length > 0) {
      parts.push(textOf(plain))
      plain = []
    }

    const { key, from, now, format } = seg.live

    parts.push(<Client key={key} module="./clock-client.tsx" props={{ from, now, format, color: seg.color ?? color ?? 'text', bold: seg.bold === true }} />)
  }

  if (plain.length > 0) {
    parts.push(textOf(plain))
  }

  return <Box flexDirection="row">{parts}</Box>
}

/** An overview item: its status before the title and chips after it, its metadata, the Button right of the title and what the Button shows. */
type Item = { status: Line; title: string; after?: Line; meta: Line; button: RenderChildren; disclosed?: RenderChildren }

/** Two lines at most: the status and the title, cut to leave the Button its cells; the metadata, subtle; then what the Button shows. */
function itemOf(el: El, width: number, item: Item) {
  const { Box } = el
  const before: Line = item.status.length === 0 ? [] : [...item.status, { text: ' ' }]
  const after = item.after ?? []
  const room = width - BUTTON_CELLS - segsWidth(before) - segsWidth(after)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {lineText(el, fitLine([...before, { text: fit(item.title, room) }, ...after], width - BUTTON_CELLS))}
        </Box>
        <Box flexShrink={0}>{item.button}</Box>
      </Box>
      {lineText(el, fitLine(item.meta, width - EDGE_CELLS), 'subtle')}
      {item.disclosed ?? null}
    </Box>
  )
}

/** The `Command` Button that shows `source` in a Code under its item, and the Code while shown. */
function disclosure(el: El, data: PaneData, key: string, buttonKey: string, source: string): Pick<Item, 'button' | 'disclosed'> {
  const { Button, Code } = el
  const isOpen = data.disclosures?.has(key) ?? false

  return {
    button: <Button key={buttonKey} label={isOpen ? t().collapse : t().command} variant="secondary" onPress={() => data.onToggleDisclosure?.(key)} />,
    disclosed: isOpen ? <Code source={source.slice(0, COMMAND_CHARS)} /> : null,
  }
}

/** A section's head: its title bold, the count after it subtle, a link to its page on the right. */
function headerOf(el: El, title: string, count?: number, link: RenderChildren = null) {
  const { Box, Text } = el

  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center">
      <Text wrap="truncate-end">
        <Text color="text" bold>
          {title}
        </Text>
        {count === undefined ? null : <Text color="subtle">{`  ${count}`}</Text>}
      </Text>
      {link}
    </Box>
  )
}

/** The first SECTION_CAP rows, then `N more` showing the rest in place; shown, `Collapse`. */
function capped(el: El, data: PaneData, section: string, rows: RenderChildren[]): RenderChildren[] {
  const { Box, Button } = el
  const key = `more:${section}`
  const isOpen = data.disclosures?.has(key) ?? false

  if (rows.length <= SECTION_CAP) {
    return rows
  }

  return [
    ...(isOpen ? rows : rows.slice(0, SECTION_CAP)),
    <Box flexDirection="row">
      <Button key={`more-${section}`} label={isOpen ? t().collapse : t().moreItems(rows.length - SECTION_CAP)} variant="secondary" onPress={() => data.onToggleDisclosure?.(key)} />
    </Box>,
  ]
}

function overview(el: El, data: PaneData) {
  const { Box, Button, Text } = el
  const now = data.now
  const polledAt = data.snap?.polledAt ?? now
  const view = overviewOf(data.agents, data.snap, data.seen, now, data.peers, data.gates, data.trees)
  const tier = widthTierOf(data.columns)
  const width = textCells(data.columns - FRAME_CELLS)

  const done = [
    view.returned > 0 ? t().returnedCount(view.returned) : '',
    view.aborted > 0 ? `\u2298 ${t().agentStates.aborted} ${view.aborted}` : '',
    view.reviewed > 0 ? t().reviewedCount(view.reviewed) : '',
  ]
    .filter(part => part !== '')
    .join(' · ')
  const needsYou = view.pending.length + view.gates.length
  const unread = view.returned + view.reviewed
  const isIdle = needsYou === 0 && view.running.length === 0 && done === ''
  const gates = recentGates(data.gates)

  // `All` to the page listing every one of `items`: all agents or all models, and that page among the tabs.
  const allLink = (items: readonly OverviewItem[]) => {
    const page = items.every(item => item.kind === 'agent') ? 'agents' : items.every(item => item.kind === 'model') ? 'mmrun' : null

    return page === null || !data.pages.some(one => one.page === page) ? null : <Button key={`overview-all-${page}`} label={t().seeAll} plain onPress={() => data.onPage(page)} />
  }

  const workItem = (item: OverviewItem, label: string): Item => ({
    status: itemChip(item, now, data.flights),
    title: itemTitle(item),
    after: item.kind === 'agent' && (item.run.denied ?? 0) > 0 ? [{ text: ' ' }, chipSeg('failed', t().denied(item.run.denied ?? 0))] : [],
    meta: itemMeta(item, now, polledAt),
    button: <Button label={label} variant="secondary" onPress={() => data.onOpenItem(item)} />,
  })

  const gateItem = (gate: GateRun, section: string, index: number, status: Seg): Item => ({
    status: [status],
    title: commandHead(gate.key ?? gate.command),
    meta: gateMeta(gate, `gate-${section}-${index}`, now),
    ...disclosure(el, data, `gate:${section}:${gate.where}:${gate.at}`, `gate-${section}-${gate.where}-${gate.at}`, gate.key ?? gate.command),
  })

  const counts =
    needsYou + view.running.length + unread + view.aborted === 0
      ? []
      : [
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            {needsYou > 0 ? chip(el, 'stale', `! ${t().needsYou} ${needsYou}`) : []}
            {view.running.length > 0 ? chip(el, 'running', `● ${t().runWord} ${view.running.length}`) : []}
            {unread > 0 ? <Text color="inactive" bold>{` ${t().unreadCount(unread)} `}</Text> : []}
            {view.aborted > 0 ? chip(el, 'stale', `\u2298 ${t().agentStates.aborted} ${view.aborted}`) : []}
          </Box>,
        ]

  const needsYouSection =
    needsYou === 0
      ? []
      : [
          headerOf(el, t().needsYou, needsYou, view.gates.length === 0 ? allLink(view.pending) : null),
          ...capped(el, data, 'needsYou', [
            ...view.pending.map(item => itemOf(el, width, workItem(item, item.kind === 'agent' && item.run.state === 'running' ? t().open : t().read))),
            ...view.gates.map((gate, index) => itemOf(el, width, gateItem(gate, 'pending', index, chipSeg('failed', `✗ ${t().gateWord}`)))),
          ]),
        ]

  const sessionsSection =
    view.sessions.length === 0
      ? []
      : [
          headerOf(el, t().otherSessions, view.sessions.length),
          ...capped(
            el,
            data,
            'sessions',
            view.sessions.map(peer =>
              itemOf(el, width, {
                status: [chipSeg(PEER_TONES[peer.state], `${PEER_WORDS[peer.state].glyph} ${t().peerWords[peer.state]}`)],
                title: peerTitle(peer),
                meta: liveSegs(t().gateAgo, `peer-${peer.id}`, peer.since, now, 'age'),
                ...disclosure(el, data, `peer:${peer.id}`, `copy-resume-${peer.id}`, `claude --resume ${posixQuote(peer.id)}`),
              }),
            ),
          ),
        ]

  const runningSection =
    view.running.length === 0
      ? []
      : [headerOf(el, t().runningHeading, view.running.length, allLink(view.running)), ...capped(el, data, 'running', view.running.map(item => itemOf(el, width, workItem(item, t().open))))]

  const doneSection =
    done === ''
      ? []
      : [
          headerOf(el, t().doneTitle),
          <Box columnGap={1} alignItems="center" flexWrap="wrap">
            <Text wrap="truncate-end">{fit(done, width - EDGE_CELLS)}</Text>
            {view.returned + view.aborted > 0 ? <Button key="overview-agents" label={t().seeAgents} variant="secondary" onPress={() => data.onPage('agents')} /> : null}
            {view.reviewed > 0 ? <Button key="overview-mmrun" label={t().seeReviews} variant="secondary" onPress={() => data.onPage('mmrun')} /> : null}
          </Box>,
        ]

  const idleSection = isIdle
    ? [
        <Text color="subtle" wrap="truncate-end">
          {fit(t().nothingPending, width - EDGE_CELLS)}
        </Text>,
        ...view.recent.map(item =>
          lineText(el, fitLine([{ text: `${endedHead(item)} · ` }, ...liveSegs(t().ago, `idle-${itemKey(item)}`, (item.kind === 'agent' ? item.run.endedAt : item.model.endedAt) ?? now, now, 'duration')], width - EDGE_CELLS), 'subtle'),
        ),
      ]
    : []

  const isSideBySide = tier === 'wide'
  // Side by side, each column takes half the row past its gap, and frames itself.
  const columnWidth = isSideBySide ? textCells(Math.floor((data.columns - 3) / 2) - FRAME_CELLS) : width

  const gatesSection =
    gates.length === 0
      ? []
      : [
          headerOf(el, t().recentGates, gates.length),
          ...capped(
            el,
            data,
            'gates',
            gates.map((gate, index) => {
              const word = isFailedGate(gate) ? t().gateFailedChip : t().gatePassed
              const status: Seg = gate.stale === true ? { text: ` ${word} `, color: 'inactive', bold: true } : chipSeg(isFailedGate(gate) ? 'failed' : 'done', word)

              return itemOf(el, columnWidth, gateItem(gate, 'recent', index, status))
            }),
          ),
        ]

  const trees = data.trees
  const treesSection =
    trees === null
      ? [headerOf(el, t().worktrees), <Text color="subtle">{t().loading}</Text>]
      : trees.length === 0
        ? []
        : [
            headerOf(el, t().worktrees, trees.length),
            ...capped(
              el,
              data,
              'trees',
              trees.map(tree =>
                itemOf(el, columnWidth, {
                  status: [],
                  title: tree.name,
                  meta: [{ text: tree.branch }, ...treeMarks(tree).flatMap(mark => [{ text: ' · ' }, markSeg(mark)])],
                  ...disclosure(el, data, `tree:${tree.path}`, `copy-cd-${tree.path}`, `cd ${posixQuote(tree.path)}`),
                }),
              ),
            ),
          ]

  const guardsSection =
    data.guards.length === 0
      ? []
      : [
          headerOf(el, t().recentBlocks, data.guards.length),
          ...capped(
            el,
            data,
            'guards',
            data.guards.map((block, index) =>
              lineText(el, fitLine([{ text: `${guardHead(block)} · ` }, ...liveSegs(t().gateAgo, `guard-${index}-${block.at}`, block.at, now, 'duration')], width - EDGE_CELLS), GUARD_COLORS[block.decision]),
            ),
          ),
        ]

  // The side-by-side row frames its two columns itself.
  const gatesAndTrees =
    isSideBySide && (gatesSection.length > 0 || treesSection.length > 0)
      ? [
          [
            <Box flexDirection="row" columnGap={3}>
              {gatesSection.length > 0 ? <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>{frame(el, gatesSection)}</Box> : null}
              {treesSection.length > 0 ? <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>{frame(el, treesSection)}</Box> : null}
            </Box>,
          ],
        ]
      : [gatesSection, treesSection]

  const sections = [counts, needsYouSection, sessionsSection, runningSection, doneSection, idleSection, ...gatesAndTrees, guardsSection].filter(rows => rows.length > 0)

  return [
    <Box flexDirection="column" gap={2}>
      {sections.map(rows => (rows === counts || rows === gatesAndTrees[0] && isSideBySide ? <Box flexDirection="column" gap={1}>{rows}</Box> : frame(el, rows)))}
    </Box>,
  ]
}

/** One overview section in a rounded border, so sections read apart. */
function frame(el: El, rows: RenderChildren) {
  const { Box } = el

  return (
    <Box flexDirection="column" gap={1} borderStyle="round" borderColor="promptBorder" paddingX={1} paddingY={1}>
      {rows}
    </Box>
  )
}

function agentCards(el: El, data: PaneData) {
  const { Box, Button, Svg, Text } = el
  const list = [...data.agents].reverse()

  if (list.length === 0) {
    return [<Text color="subtle">{t().noAgents}</Text>]
  }

  const { listed, folded } = agentFold(list, data.agentsSeenBefore ?? data.seen.agents)
  const shown = data.isFoldOpen === true ? [...listed, ...folded] : listed
  const scale = scaleOf(Math.max(0, ...shown.map(run => elapsedOf(run, data.now) / 1000)))
  const tier = widthTierOf(data.columns)
  const barW = tier === 'narrow' ? BAR_SIZES.narrow.width : tier === 'wide' ? BAR_SIZES.wide.width : BAR_SIZES.standard.width

  const cardOf = (run: AgentRun) => {
    const ms = elapsedOf(run, data.now)
    const time = fmtDuration(ms)
    const flight = run.state === 'running' ? data.flights?.get(run.agentId) : undefined
    const meta = [
      run.subagentType,
      run.model.replace(/^claude-/, ''),
      `${run.tools} tools`,
      ...(run.usage === undefined ? [] : [`${tokensText(run.usage)} tokens`]),
      ...(flight === undefined ? [] : [flightText(flight, data.now)]),
    ]

    let statusNodes: RenderChildren
    if (run.state === 'running') {
      statusNodes = <Text color="permission" bold>● {t().runWord}</Text>
    } else if (run.state === 'done') {
      statusNodes = <Text color="success" bold>{t().chipReturned}</Text>
    } else if (run.state === 'aborted') {
      statusNodes = <Text color="warning" bold>⊘ {t().agentStates.aborted}</Text>
    } else {
      statusNodes = <Text color="error" bold>✗ {t().agentStates[run.state]}</Text>
    }

    const statusRow = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Box flexDirection="row" columnGap={1} flexWrap="wrap" alignItems="center">
          {statusNodes}
          {isStalled(run, data.now, flight) && <Text color="warning">◐ {t().quiet(fmtDuration(data.now - run.lastActivityAt))}</Text>}
          {(run.denied ?? 0) > 0 && <Text color="error" bold>{t().denied(run.denied ?? 0)}</Text>}
        </Box>
        <Button
          key={`read-agent-${run.agentId}`}
          label={run.state === 'running' ? t().open : t().read}
          variant="secondary"
          onPress={() => data.onReadAgent(run.agentId)}
        />
      </Box>
    )

    const alt = t().agentBarAlt(
      run.subagentType,
      run.description,
      run.state === 'done' ? t().returned : t().agentStates[run.state] || t().runWord,
      time,
      scale.label,
    )

    return card(el, [
      <Text color="text" bold wrap="wrap">{run.description}</Text>,
      statusRow,
      <Text color="subtle" wrap="wrap">{meta.join(' · ')}</Text>,
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Svg
          source={elapsedBar(ms / 1000, scale.secs, agentTone(run), run.state === 'running', barW, 10)}
          alt={alt}
          width={barW}
          height={10}
        />
        <Text color="text">{time}</Text>
      </Box>,
    ])
  }

  const fold =
    folded.length === 0 ? [] : [<Button key="agents-fold" label={foldText(folded)} variant="secondary" onPress={() => data.onToggleFold?.()} />]

  return [
    <Text color="subtle">{t().elapsedCompare(scale.label)}</Text>,
    ...listed.map(cardOf),
    ...fold,
    ...(data.isFoldOpen === true ? folded.map(cardOf) : []),
  ]
}

function runCards(el: El, data: PaneData) {
  const { Box, Button, Svg, Text } = el
  const snap = data.snap
  const unreadable = snap?.error === undefined ? [] : [<Text color="warning" wrap="truncate">{t().runsUnreadable(snap.error)}</Text>]

  if (snap === null || snap.runs.length === 0) {
    return unreadable.length > 0 ? unreadable : [<Text color="subtle">{snap === null ? t().loading : t().noRuns}</Text>]
  }

  const shownRuns = snap.runs.slice(0, data.paneRuns)
  const allKnown = shownRuns.flatMap(run => run.models.map(m => elapsedSecs(m, snap.polledAt)).filter((s): s is number => s !== undefined))
  const scale = scaleOf(Math.max(0, ...allKnown))
  const tier = widthTierOf(data.columns)
  const barW = tier === 'wide' ? BAR_SIZES.wide.width : BAR_SIZES.standard.width

  const cards = shownRuns.map(run => {
    return card(el, [
      <Text color="text" bold wrap="wrap">{runLabel(run)}</Text>,
      <Text color="subtle" wrap="wrap">{`${run.mode || 'review'} · ${run.tag || run.workdir} · ${run.runid}`}</Text>,
      ...run.models.map(model => {
        const secs = elapsedSecs(model, snap.polledAt)
        const tone = modelTone(model)
        const time = secs === undefined ? '' : fmtSecs(secs)
        const { text: statusText, color: statusColor } = modelStatusOf(model)
        const alt = t().modelBarAlt(model.name, statusText, time, scale.label)

        return (
          <Box flexDirection="column" rowGap={1}>
            <Box flexDirection="row" columnGap={1} flexWrap="wrap" alignItems="center">
              <Text color="text" bold>{model.name}</Text>
              <Text color={statusColor} bold>{statusText}</Text>
              {time !== '' && <Text color="text">{time}</Text>}
              <Text color="subtle">{fmtRunTokens(model.outputTokens)}</Text>
            </Box>
            {tier !== 'narrow' &&
              (secs === undefined ? (
                <Text color="subtle">{t().elapsedUnknown}</Text>
              ) : (
                <Svg
                  source={elapsedBar(secs, scale.secs, tone, model.status === 'RUNNING', barW, 10)}
                  alt={alt}
                  width={barW}
                  height={10}
                />
              ))}
          </Box>
        )
      }),
      <Button key={`read-run-${run.runid}`} label={t().readReport} variant="secondary" onPress={() => data.onReadRun(run.runid)} />,
    ])
  })

  return [
    ...unreadable,
    <Text color="subtle">{t().elapsedCompare(scale.label)}</Text>,
    ...cards,
  ]
}

/** The view buttons, the current one `primary`, and stepping between main turns; then the waterfall's page or the hotspots. */
function timelineBody(el: El, data: PaneData) {
  const { Box, Button } = el
  const turns = data.timeline ?? []
  const isHotspots = data.timelineView === 'hotspots'
  const views = [
    <Button
      key="timeline-waterfall"
      label={t().timelineViewWaterfall}
      variant={isHotspots ? 'secondary' : 'primary'}
      onPress={() => {
        if (isHotspots) {
          data.onTimelineView?.()
        }
      }}
    />,
    <Button
      key="timeline-hotspots"
      label={t().timelineViewHotspots}
      variant={isHotspots ? 'primary' : 'secondary'}
      onPress={() => {
        if (!isHotspots) {
          data.onTimelineView?.()
        }
      }}
    />,
  ]

  if (isHotspots) {
    const openTurn = (turnId: string) => {
      data.onTimelineTurn?.(turnId)
      data.onTimelineView?.()
    }

    return [<Box columnGap={1} flexWrap="wrap">{views}</Box>, ...drawHotspotsDesktop(el, turns, data.columns, openTurn)]
  }

  const id = data.timelineTurnId ?? latestMainTurnId(turns)
  const main = turns.filter(one => one.agentId === undefined).map(one => one.turnId)
  const at = id === undefined ? -1 : main.indexOf(id)
  const pick = (turnId: string | undefined) => data.onTimelineTurn?.(turnId)
  const buttons = [
    ...views,
    ...(at > 0 ? [<Button key="timeline-prev" label={t().timelinePrev} variant="secondary" onPress={() => pick(main[at - 1])} />] : []),
    ...(at >= 0 && at < main.length - 1 ? [<Button key="timeline-next" label={t().timelineNext} variant="secondary" onPress={() => pick(main[at + 1])} />] : []),
    ...(data.timelineTurnId === undefined ? [] : [<Button key="timeline-latest" label={t().timelineLatest} variant="secondary" onPress={() => pick(undefined)} />]),
  ]
  const back = id !== undefined && data.timelinePage?.turnId === id ? data.timelinePage.back : 0
  const ui = {
    back,
    onPage: (to: number) => data.onTimelinePage?.({ turnId: id ?? '', back: to }),
    disclosures: data.disclosures,
    onToggleDisclosure: data.onToggleDisclosure,
  }

  return [<Box columnGap={1} flexWrap="wrap">{buttons}</Box>, ...drawTimelineDesktop(el, turns, id ?? '', data.now, data.columns, data.agents, ui)]
}

/** The last 7 days' equivalent newest first on one scale with their token counts, the main thread against the subagents, the question dialogs, the skills by calls; a frame each. */
function usageBody(el: El, data: PaneData) {
  const { Box, Svg, Text } = el
  const week = data.usage

  if (week === undefined || isEmptyWeek(week)) {
    return [<Text color="subtle" wrap="truncate-end">{fit(t().usageEmpty, textCells(data.columns - EDGE_CELLS))}</Text>]
  }

  const width = data.columns - FRAME_CELLS - EDGE_CELLS
  const px = Math.min(GAUGE.standard.width, Math.max(0, Math.floor(width * PIXELS_PER_COLUMN)))
  const top = Math.max(0, ...week.days.map(one => one.equivalent))
  const scale = `0—${fmtTokens(top)}`
  const total = week.threads.reduce((sum, one) => sum + one.equivalent, 0)
  const line = (text: string, color: 'text' | 'subtle') => (
    <Text color={color} wrap="truncate-end">
      {fit(text, textCells(width))}
    </Text>
  )
  const note = (text: string) => (
    <Text color="subtle" wrap="wrap">
      {text}
    </Text>
  )
  // A day without a request recorded is unknown, not 0.
  const figure = (one: UsageCounts, n: number) => (one.requests === 0 ? '—' : fmtTokens(n))
  const countsText = (one: UsageCounts) => t().usageCounts(figure(one, one.input), figure(one, one.cacheRead), figure(one, one.cacheWrite), figure(one, one.output))

  const days = [
    headerOf(el, t().usageWeekTitle),
    ...t().usageWeights.map(note),
    note(t().sharedScale(scale)),
    ...week.days.map(one => {
      const counts = countsText(one.counts)
      const equivalent = figure(one.counts, one.equivalent)

      return (
        <Box flexDirection="column">
          {line(`${one.day.slice(5)} · ${t().usageEquivalent(equivalent)}`, 'text')}
          <Svg
            source={horizontalGauge(top > 0 ? one.equivalent / top : 0, FILL.running, false, px, GAUGE.standard.height)}
            alt={t().usageDayAlt(one.day, equivalent, counts, scale)}
            width={px}
            height={GAUGE.standard.height}
          />
          {line(counts, 'subtle')}
        </Box>
      )
    }),
  ]
  const threads = [
    headerOf(el, t().usageThreadsTitle),
    ...week.threads.map(one => (
      <Box flexDirection="column">
        {line(`${t().usageThreads[one.thread]} · ${t().usageEquivalent(fmtTokens(one.equivalent))} · ${t().usageShare(total > 0 ? `${Math.round((one.equivalent * 100) / total)}%` : '—')}`, 'text')}
        {line(`${t().usageRequests(one.counts.requests)} · ${countsText(one.counts)}`, 'subtle')}
      </Box>
    )),
  ]
  const asks = week.asks.dialogs === 0 ? [] : [headerOf(el, t().usageAsksTitle), ...askLines(week.asks).map((text, i) => line(text, i === 0 ? 'text' : 'subtle'))]
  const skills =
    week.skills.length === 0
      ? []
      : [
          headerOf(el, t().usageSkillsTitle, week.skills.length),
          ...capped(
            el,
            data,
            'skills',
            week.skills.map(one => (
              <Box flexDirection="column">
                {line(one.name, 'text')}
                {line(t().usageSkillCounts(one.invocations, one.inline, one.forked, one.errors), 'subtle')}
              </Box>
            )),
          ),
        ]

  return [
    <Box flexDirection="column" gap={2}>
      {[days, threads, asks, skills].filter(rows => rows.length > 0).map(rows => frame(el, rows))}
      <Box flexDirection="column">{t().usageCoverage.map(note)}</Box>
    </Box>,
  ]
}

/**
 * The progress board: a 现在 frame with this session's request, every ready one and every stale one; a section per active line with a
 * request on the page, newest activity first, then one for requests of no line; last the nodes recorded before requests, a frame per
 * status group as before, three nodes each before `N more`.
 */
function progressBody(el: El, data: PaneData) {
  const { Box, Button, Text } = el
  const board = data.progress ?? null
  const nodes = board?.nodes ?? []
  const requests = (board?.requests ?? []).filter(one => one.state !== 'dropped').sort((a, b) => b.updatedAt - a.updatedAt)

  if (nodes.length === 0 && requests.length === 0) {
    return [<Text color="subtle" wrap="wrap">{t().progressEmpty(data.progress?.dir ?? null)}</Text>]
  }

  const now = data.now
  const width = textCells(data.columns - FRAME_CELLS - EDGE_CELLS)
  // A line, then its Buttons on the right; the line cut to leave each Button its cells.
  const withButtons = (line: Line, buttons: RenderChildren[], room = width) =>
    buttons.length === 0 ? (
      lineText(el, fitLine(line, room))
    ) : (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {lineText(el, fitLine(line, room - buttons.length * BUTTON_CELLS))}
        </Box>
        {buttons}
      </Box>
    )
  const button = (key: string, label: string, onPress: () => void) => <Button key={key} label={label} variant="secondary" onPress={onPress} />
  const ageLine = (one: BoardRequest): Line => [{ text: progressAge(now - one.updatedAt) }, ...(one.state === 'stale' ? [{ text: '!', color: 'warning' }] : [])]

  const current = requests.find(one => one.id === board?.current)
  const asking = [...(current === undefined ? [] : [current]), ...requests.filter(one => one !== current && (one.state === 'ready' || one.state === 'stale'))]
  const nowRows = asking.map(one =>
    withButtons(
      [
        one.state === 'stale' ? { text: '!', color: 'warning' } : requestGlyph(one, nodes),
        { text: ` ${one.title}` },
        ...(one === current ? [{ text: `  ${one.done}/${one.total}  ` }, { text: t().progressThisSession, color: 'subtle' }] : []),
        ...(one.state === 'ready' ? [{ text: '  ' }, { text: t().progressAwaiting, color: 'warning' }] : []),
        ...(one.state === 'stale' ? [{ text: '  ' }, { text: t().progressQuietDays(Math.floor((now - one.updatedAt) / DAY_MS)), color: 'warning' }] : []),
      ],
      one.state === 'ready' ? [button(`progress-now-accept-${one.id}`, t().progressAccept, () => data.onAcceptRequest?.(one.id))] : [],
    ),
  )
  const nowFrame = asking.length === 0 ? [] : [frame(el, [headerOf(el, t().progressNow, undefined, <Text color="subtle">{clockOf(now)}</Text>), ...nowRows])]

  const pieceRow = (node: BoardNode) =>
    withButtons(
      [
        PIECE_GLYPHS[node.status],
        { text: ` ${node.status === 'todo' ? ' '.repeat(5) : clockOf(node.updatedAt)} ${node.title}` },
        ...(node.commit === null ? [] : [{ text: `  ${node.commit}`, color: 'subtle' }]),
      ],
      node.status === 'done'
        ? []
        : [
            button(`progress-done-${node.id}`, t().progressDone, () => data.onCloseNode?.(node.id, 'done')),
            button(`progress-drop-${node.id}`, t().progressDrop, () => data.onCloseNode?.(node.id, 'dropped')),
          ],
      width - EDGE_CELLS,
    )
  const requestCard = (one: BoardRequest) => {
    const rollup = rollupText(one)
    const facts = joinParts([
      ...(rollup === '' ? [] : [[{ text: rollup }]]),
      ...(one.followUps > 0 ? [[{ text: t().progressFollowUps(one.followUps) }]] : []),
      ...(one.state === 'ready' ? [[{ text: t().progressAwaiting, color: 'warning' }]] : []),
    ])

    return card(el, [
      <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Box flexShrink={1} minWidth={0}>
          {lineText(el, fitLine([requestGlyph(one, nodes), { text: ` ${one.title}` }], width - AGE_CELLS))}
        </Box>
        {lineText(el, ageLine(one), 'subtle')}
      </Box>,
      ...(facts.length === 0 ? [] : [lineText(el, fitLine(facts, width - EDGE_CELLS), 'subtle')]),
      ...requestPieces(one, nodes).map(pieceRow),
      <Box flexDirection="row" columnGap={1}>
        {button(`progress-accept-${one.id}`, t().progressAccept, () => data.onAcceptRequest?.(one.id))}
        {button(`progress-dropreq-${one.id}`, t().progressDropRequest, () => data.onDropRequest?.(one.id))}
      </Box>,
    ])
  }
  const closedRow = (one: BoardRequest) =>
    lineText(el, fitLine([PIECE_GLYPHS.done, { text: ` ${one.title}  ${one.total === 0 ? '' : `${one.done}/${one.total}  `}${progressAge(now - one.updatedAt)}` }], width))
  // Requests of one title pattern holding a version, CHAIN_MIN or more of them, oldest first.
  const chainsOf = (list: readonly BoardRequest[]) =>
    [...new Set(list.map(one => titlePattern(one.title)))]
      .filter(pattern => pattern.includes('<ver>'))
      .map(pattern => list.filter(one => titlePattern(one.title) === pattern).sort((a, b) => a.at - b.at))
      .filter(chain => chain.length >= CHAIN_MIN)
  const chainLine = (chain: readonly BoardRequest[]): Line =>
    chain.flatMap((one, i): Line => [
      ...(i === 0 ? [] : [{ text: ' ─ ' }]),
      { text: `${VERSION.exec(one.title)?.[0] ?? one.title} ` },
      requestGlyph(one, nodes),
      ...(one.status === 'open' ? [{ text: `${one.done}/${one.total}` }] : []),
    ])
  const section = (name: string, list: readonly BoardRequest[]) => {
    const chains = chainsOf(list)
    // A series member still open keeps its card, so its pieces can be closed; a closed one shows only in the chain.
    const rest = list.filter(one => one.state !== 'closed' || !chains.some(chain => chain.includes(one)))
    const closed = rest.filter(one => one.state === 'closed')
    const open = list.filter(one => one.status === 'open').length
    const head = `${name}${chains.length === 0 ? '' : ` (${t().progressSeries})`}`

    return (
      <Box flexDirection="column" gap={1}>
        {lineText(el, fitLine([{ text: head, bold: true }, { text: ` · ${t().progressOpenClosed(open, list.length - open)}`, color: 'subtle' }], width))}
        {chains.map(chain => lineText(el, fitLine(chainLine(chain), width)))}
        {rest.filter(one => one.state !== 'closed').map(requestCard)}
        {closed.slice(0, LISTED_CLOSED).map(closedRow)}
        {closed.length > LISTED_CLOSED ? <Text color="subtle">{fit(t().progressMoreClosed(closed.length - LISTED_CLOSED), width)}</Text> : null}
      </Box>
    )
  }
  const lines = (board?.lines ?? []).filter(line => line.status === 'active' && requests.some(one => one.line === line.id)).sort((a, b) => b.updatedAt - a.updatedAt)
  const loose = requests.filter(one => !lines.some(line => line.id === one.line))
  const legacy = legacyNodes(nodes)

  return [
    <Box flexDirection="column" gap={2}>
      {nowFrame}
      {lines.map(line => section(line.name.toUpperCase(), requests.filter(one => one.line === line.id)))}
      {loose.length === 0 ? null : section(`${t().progressNoLine} · ${loose.length}`, loose)}
      {legacy.length === 0 ? null : headerOf(el, `${t().progressNoRequest} · ${legacy.length}`)}
      {progressGroups(legacy).map(group =>
        frame(el, [
          headerOf(el, t().progressStatuses[group.status], group.nodes.length),
          ...capped(
            el,
            data,
            `progress-${group.status}`,
            group.nodes.map(node => {
              const head: Line = [
                { text: ` ${t().progressStatuses[node.status]} `, color: progressColor(node, data.now), bold: true },
                { text: ` ${node.title}`, ...(staleHours(node, data.now) !== null && { color: 'inactive' }) },
              ]
              const doneWhen = progressDoneWhen(node)

              return (
                <Box flexDirection="column">
                  {node.status === 'done' ? (
                    lineText(el, fitLine(head, width))
                  ) : (
                    <Box flexDirection="row" columnGap={1} alignItems="center">
                      <Box flexGrow={1} flexShrink={1} minWidth={0}>
                        {lineText(el, fitLine(head, width - 2 * BUTTON_CELLS))}
                      </Box>
                      <Button key={`progress-done-${node.id}`} label={t().progressDone} variant="secondary" onPress={() => data.onCloseNode?.(node.id, 'done')} />
                      <Button key={`progress-drop-${node.id}`} label={t().progressDrop} variant="secondary" onPress={() => data.onCloseNode?.(node.id, 'dropped')} />
                    </Box>
                  )}
                  {lineText(el, [{ text: fit(progressMeta(node, nodes, data.now), width) }], 'subtle')}
                  {doneWhen === null ? null : lineText(el, [{ text: fit(doneWhen, width) }], 'subtle')}
                </Box>
              )
            }),
          ),
        ]),
      )}
    </Box>,
  ]
}

function backRow(el: El, data: PaneData, title: string) {
  const { Box, Button, Text } = el

  return card(
    el,
    <Box columnGap={1} alignItems="center">
      <Button key="dash-back" label={t().back} variant="secondary" onPress={data.onBack} />
      <Text bold wrap="truncate">
        {title}
      </Text>
    </Box>,
  )
}

function detailBody(el: El, data: PaneData) {
  const { Box, Button, Code, Markdown, Text } = el
  const open = data.detail

  if (open === null || open.page !== data.page) {
    return null
  }

  if (open.page === 'agents') {
    const run = data.agents.find(one => one.agentId === open.agentId)

    if (run === undefined) {
      return null
    }

    const time = fmtDuration(elapsedOf(run, data.now))
    const peek = run.state === 'running' && data.peek?.agentId === run.agentId ? data.peek : undefined

    let statusNodes: RenderChildren
    if (run.state === 'running') {
      statusNodes = <Text color="permission" bold>● {t().stillRunning}</Text>
    } else if (run.state === 'done') {
      statusNodes = <Text color="success" bold>{t().returnedUnverified}</Text>
    } else if (run.state === 'aborted') {
      statusNodes = <Text color="warning" bold>⊘ {t().agentStates.aborted}</Text>
    } else {
      statusNodes = <Text color="error" bold>✗ {t().agentStates[run.state]}</Text>
    }

    const statusRow = (
      <Box flexDirection="row" columnGap={1} flexWrap="wrap" alignItems="center">
        {statusNodes}
        {(run.denied ?? 0) > 0 && <Text color="error" bold>{t().denied(run.denied ?? 0)}</Text>}
      </Box>
    )

    const metricsRow = (
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        <Text color="text">{t().elapsedTime(time)}</Text>
        <Text color="text">{`${run.tools} tools`}</Text>
        <Text color="subtle">{`${run.subagentType} · ${run.model.replace(/^claude-/, '')}`}</Text>
      </Box>
    )

    const tokenUsage = (
      <Box flexDirection="column" gap={1}>
        <Text color="text" bold>{t().tokenUsageTitle}</Text>
        <Text color="subtle">{run.usage === undefined ? '—' : usageText(run.usage)}</Text>
      </Box>
    )

    let content: RenderChildren
    if (run.state === 'running') {
      if (peek?.failed === true) {
        content = <Text color="warning">{t().peekUnreadable}</Text>
      } else {
        content = (
          <Box flexDirection="column" gap={1}>
            <Text color="text" bold>{t().peekTask}</Text>
            <Text color="text" wrap="wrap">{peek?.task || run.description}</Text>
            <Text color="text" bold>{t().peekCalls}</Text>
            <Code source={(peek?.calls ?? []).join('  ') || '—'} />
            <Text color="text" bold>{t().peekText}</Text>
            <Text color="text" wrap="wrap">{peek?.text || '—'}</Text>
            <Text color="subtle">{t().ago(fmtDuration(data.now - run.lastActivityAt))}</Text>
          </Box>
        )
      }
    } else {
      content = (
        <Box flexDirection="column" gap={1}>
          <Text color="text" bold>{t().answerHead}</Text>
          <Markdown text={(run.answer ?? '').slice(0, 4000)} />
        </Box>
      )
    }

    return [
      <Button key="dash-back" label={t().back} variant="secondary" onPress={data.onBack} />,
      <Text color="text" bold wrap="wrap">{`${run.subagentType} · ${run.description}`}</Text>,
      statusRow,
      metricsRow,
      tokenUsage,
      content,
    ]
  }

  return reportReader(el, data, open)
}

/** One model's report at a time; a review one finding at a time, every Markdown and Code leaf cut to fit. */
function reportReader(el: El, data: PaneData, open: Extract<DashDetail, { page: 'mmrun' }>) {
  const { Box, Button, Code, Markdown, Select, Text } = el
  const run = data.snap?.runs.find(one => one.runid === open.runid)
  const report = data.reports[open.runid]

  if (run === undefined || report === undefined) {
    return null
  }

  const head = [backRow(el, data, `${runLabel(run)} · ${run.runid}`), <Text>{chip(el, 'stale', t().modelReport)}</Text>]
  const model = report.models.find(one => one.name === open.model) ?? report.models[0]

  if (model === undefined) {
    return head
  }

  const review = model.review
  const status = modelStatusOf(model)
  const pickSeverity = (value: string) => {
    if ((value === 'all') !== open.showAll) {
      data.onToggleSeverity()
    }
  }
  const top = [
    ...head,
    <Box flexDirection={widthTierOf(data.columns) === 'narrow' ? 'column' : 'row'} columnGap={1} rowGap={1}>
      <Select key="dash-model" label={t().reportModel} options={report.models.map(one => ({ value: one.name }))} value={model.name} onSelect={name => data.onPickModel?.(name)} />
      {review === undefined ? null : (
        <Select
          key="dash-severity"
          label={t().reportSeverity}
          options={[
            { value: 'major', label: t().onlyMajor },
            { value: 'all', label: t().allSeverities },
          ]}
          value={open.showAll ? 'all' : 'major'}
          onSelect={pickSeverity}
        />
      )}
    </Box>,
    <Text wrap="truncate">
      <Text color="text" bold>
        {model.name}
      </Text>{' '}
      <Text color={status.color} bold>
        {status.text}
      </Text>
    </Text>,
  ]

  if (review === undefined) {
    return [...top, <Markdown text={model.markdown} />]
  }

  const cap = (text: string) => capLeaf(text, review.outPath)
  const shown = open.showAll ? review.findings : review.findings.filter(one => SEVERITIES.slice(0, 2).includes(one.severity))
  const at = Math.min(open.finding ?? 0, Math.max(0, shown.length - 1))
  const finding = shown[at]
  const summary = [review.verdict === '' ? '' : `**${review.verdict}**`, review.summary].filter(part => part !== '').join(' · ')
  let findingRows: RenderChildren[]

  if (finding === undefined) {
    findingRows = [<Text color="subtle">{t().noFindings}</Text>]
  } else {
    const why = [finding.failureScenario === '' ? '' : t().failureScenario(finding.failureScenario), finding.suggestion === '' ? '' : t().fix(finding.suggestion)]
      .filter(part => part !== '')
      .join('\n\n')

    findingRows = [
      card(el, [
        <Text color="subtle">{[finding.severity.toUpperCase(), finding.basis].filter(part => part !== '').join(' · ')}</Text>,
        <Text color="text" bold wrap="wrap">
          {cap(finding.claim)}
        </Text>,
        <Code source={cap(`${finding.file}:${finding.line}`)} />,
        ...(finding.quote === '' ? [] : [<Code source={cap(finding.quote)} />]),
        ...(why === '' ? [] : [<Markdown text={cap(why)} />]),
      ]),
      <Box columnGap={1} alignItems="center">
        <Text color="text">{t().findingOf(at + 1, shown.length)}</Text>
        {at + 1 < shown.length && <Button key="dash-next-finding" label={t().nextFinding} variant="secondary" onPress={() => data.onFinding?.(at + 1)} />}
      </Box>,
    ]
  }

  return [
    ...top,
    ...(summary === '' ? [] : [<Markdown text={cap(summary)} />]),
    ...findingRows,
    <Text color="text" bold>
      {t().reportScope}
    </Text>,
    <Markdown text={cap([...listOf(t().notChecked, review.notChecked), t().notExpanded(review.notExpanded)].join('\n\n'))} />,
  ]
}

function gpuBody(el: El, data: PaneData) {
  const { Box, Button, Code, Input, Select, Svg, Text } = el
  const watch = data.gpu
  const now = data.now
  const tier = widthTierOf(data.columns)
  const isNarrow = tier === 'narrow'
  const gaugeW = isNarrow ? GAUGE.narrow.width : GAUGE.standard.width

  if (watch === null) {
    const hosts = data.gpuHosts ?? []
    return [
      <Box flexDirection="column" gap={1}>
        <Text color="text" bold>{t().watchGpu}</Text>
        <Text color="subtle">{t().noHost}</Text>
        {hosts.length > 0 && (
          <Select
            key="gpu-select-host"
            label={t().gpuConfiguredHost}
            options={hosts.map(h => ({ value: h, label: h }))}
            onSelect={host => data.onConnectGpu?.(host)}
          />
        )}
        <Input
          key="gpu-input-host"
          label={t().gpuSshHost}
          placeholder="host"
          submitLabel={t().connect}
          onSubmit={host => data.onConnectGpu?.(host)}
        />
        <Code source="/gpu <host>" />
      </Box>,
    ]
  }

  const isStale = watch.error !== null
  const head = [
    <Box justifyContent="space-between" columnGap={1} alignItems="center">
      <Text color="text" bold wrap="truncate">{watch.host}</Text>
      <Text color="subtle">{watch.okAt === null ? '' : t().updatedAgo(fmtDuration(now - watch.okAt))}</Text>
    </Box>,
    <Box flexDirection="row" columnGap={1}>
      <Button key="gpu-change-host" label={t().changeHost} variant="secondary" onPress={() => data.onChangeGpuHost?.()} />
      <Button key="gpu-refresh" label={t().refresh} variant="secondary" onPress={() => data.onConnectGpu?.(watch.host)} />
    </Box>,
    ...(watch.error === null
      ? []
      : [
          <Text color="error" wrap="truncate">{`✗ ${watch.error}`}</Text>,
          <Text color="warning">{watch.okAt === null ? t().noSampleYet : t().staleSince(fmtDuration(now - watch.okAt))}</Text>,
        ]),
  ]
  const top = <Box flexDirection="column" gap={1}>{head}</Box>
  const sample = watch.sample

  if (sample === null) {
    return isStale ? [top] : [top, <Text color="subtle">{t().gpuConnecting(watch.host)}</Text>]
  }

  if (sample.kind === 'none' || sample.kind === 'error') {
    return [top, <Text color="subtle">{sample.kind === 'none' ? t().gpuNone : sample.message}</Text>]
  }

  if (sample.kind === 'tegra') {
    const ramFrac =
      sample.ramUsed !== null && sample.ramTotal !== null && sample.ramTotal > 0 ? sample.ramUsed / sample.ramTotal : null
    const ramText =
      sample.ramUsed !== null && sample.ramTotal !== null ? `${gib(sample.ramUsed)} / ${gib(sample.ramTotal)} GiB` : 'N/A'

    const tegraCard = card(el, [
      <Text color="text" bold {...(isStale && { dimColor: true })}>Tegra</Text>,
      <Box flexDirection="column" gap={1}>
        <Text color="text">{t().util(pct(sample.util))}</Text>
        <Svg
          source={horizontalGauge(sample.util === null ? null : sample.util / 100, FILL.done, isStale, gaugeW, 12)}
          alt={t().tegraUtilAlt(pct(sample.util), isStale)}
          width={gaugeW}
          height={12}
        />
      </Box>,
      <Box flexDirection="column" gap={1}>
        <Text color="text">{t().vram(ramText)}</Text>
        <Svg
          source={horizontalGauge(ramFrac, MEMORY, isStale, gaugeW, 12)}
          alt={t().tegraRamAlt(gib(sample.ramUsed ?? 0), gib(sample.ramTotal ?? 1), Math.round((ramFrac ?? 0) * 100), isStale)}
          width={gaugeW}
          height={12}
        />
      </Box>,
      ...(sample.temp === null ? [] : [<Text color="subtle">{`${Math.round(sample.temp)}°C`}</Text>]),
    ])

    return [top, tegraCard]
  }

  const cards = sample.gpus.map(one => {
    const memFrac =
      one.memUsed !== null && one.memTotal !== null && one.memTotal > 0 ? one.memUsed / one.memTotal : null
    const memText =
      one.memUsed !== null && one.memTotal !== null ? `${gib(one.memUsed)} / ${gib(one.memTotal)} GiB` : 'N/A'
    const extra = [one.temp === null ? '' : `${one.temp}°C`, one.power === null ? '' : `${Math.round(one.power)}W`]
      .filter(p => p !== '')
      .join(' · ')

    return card(el, [
      <Text color="text" bold {...(isStale && { dimColor: true })}>{`GPU ${one.index} · ${shortName(one.name)}`}</Text>,
      <Box flexDirection="column" gap={1}>
        <Text color="text">{t().util(pct(one.util))}</Text>
        <Svg
          source={horizontalGauge(one.util === null ? null : one.util / 100, FILL.done, isStale, gaugeW, 12)}
          alt={t().gpuUtilAlt(one.index, pct(one.util), isStale)}
          width={gaugeW}
          height={12}
        />
      </Box>,
      <Box flexDirection="column" gap={1}>
        <Text color="text">{t().vram(memText)}</Text>
        <Svg
          source={horizontalGauge(memFrac, MEMORY, isStale, gaugeW, 12)}
          alt={t().gpuMemAlt(one.index, gib(one.memUsed ?? 0), gib(one.memTotal ?? 1), Math.round((memFrac ?? 0) * 100), isStale)}
          width={gaugeW}
          height={12}
        />
      </Box>,
      ...(extra === '' ? [] : [<Text color="subtle">{extra}</Text>]),
    ])
  })

  const procs = [...sample.procs].sort((a, b) => (b.memMiB ?? 0) - (a.memMiB ?? 0)).slice(0, 5)
  const top5 =
    procs.length === 0
      ? []
      : [
          <Box flexDirection="column" gap={1}>
            <Text color="text" bold {...(isStale && { dimColor: true })}>
              {t().topProcs}
            </Text>
            {procs.map(one => (
              <Box flexDirection="column">
                <Text color="text">{one.name}</Text>
                <Text color="subtle">{`PID ${one.pid} · ${one.memMiB === null ? 'N/A' : `${gib(one.memMiB)} GiB`}`}</Text>
              </Box>
            ))}
          </Box>,
        ]

  return [top, ...cards, ...top5]
}

export function drawDesktopPaneError(el: El, data: Pick<PaneData, 'page' | 'pages' | 'onPage' | 'onClose'> & { message: string }) {
  const { Box, Text } = el

  return (
    <Box flexDirection="column" rowGap={1}>
      {tabs(el, data)}
      <Text color="error" wrap="truncate">{`✗ ${data.message}`}</Text>
    </Box>
  )
}

export function drawDesktopPane(el: El, data: PaneData) {
  const { Box } = el
  const body =
    detailBody(el, data) ??
    (data.page === 'overview'
      ? overview(el, data)
      : data.page === 'agents'
        ? agentCards(el, data)
        : data.page === 'mmrun'
          ? runCards(el, data)
          : data.page === 'timeline'
            ? timelineBody(el, data)
            : data.page === 'usage'
              ? usageBody(el, data)
              : data.page === 'progress'
                ? progressBody(el, data)
                : gpuBody(el, data))

  return (
    <Box flexDirection="column" rowGap={1}>
      {tabs(el, data)}
      {body}
    </Box>
  )
}
