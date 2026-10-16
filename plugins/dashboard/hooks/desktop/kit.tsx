import type { ElementTable, RenderChildren, RenderSurface } from 'claude-code'

import type { AgentPeek, AgentRun, BoardRead, DashConversation, DashDetail, DashPage, DashReport, DashSeen, DashTimelinePage, DashTimelineView, GateRun, GpuWatch, GuardBlock, MmModel, MmSnapshot, SessionPresence, TimelineTurn, WorktreeInfo } from '../../types'
import { fit, fmtAge, fmtDuration, glyphOf, widthOf } from '../agent-model'
import { fitLine } from '../board'
import type { Line, Live, OverviewItem, Seg } from '../board'
import { dotsSvg, FILL, icon, ring, roundedBar, sparkBars, sparkText, stackedBar, TONE_KEYS } from '../desktop-svg'
import type { IconName, Tone } from '../desktop-svg'
import { t } from '../i18n'
import type { Flight } from '../timeline'
import type { UsageWeek } from '../usage'

export type El = ElementTable<'desktop'>

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
  /** This session's id, to tell the runs it started; null or absent when it could not be read. */
  sessionId?: string | null
  /** Whether the mmrun page shows the runs other sessions started. */
  isRunsFoldOpen?: boolean
  onToggleRunsFold?: () => void
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
  /** The reader's conversation view as last read; absent or null, not read yet. */
  conversation?: DashConversation | null
  /** Shows the reader's model's report, or its own transcript. */
  onPickView?: (view: 'report' | 'conversation') => void
  /** Copies `claude --resume '<sessionId>'` on the surface pressed. */
  onCopyResume: (sessionId: string, surface: RenderSurface) => void
  /** Copies `cd '<path>'` on the surface pressed. */
  onCopyCd: (path: string, surface: RenderSurface) => void
  onClose: () => void
}

const AGENT_TONES: Record<AgentRun['state'], Tone> = { running: 'running', idle: 'idle', done: 'done', aborted: 'stale', error: 'failed', refusal: 'failed' }

export const agentTone = (run: AgentRun): Tone => AGENT_TONES[run.state]

export function agentWord(run: AgentRun): string {
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

export const MODEL_GLYPHS: Record<Tone, string> = { running: '●', idle: '○', done: '✓', failed: '✗', stale: '~' }

export function modelWord(model: MmModel): string {
  if (model.status === 'RUNNING') {
    return `● ${t().runWord}`
  }

  return `${MODEL_GLYPHS[modelTone(model)]} ${model.status}`
}

/** A model's status in words and its theme key; STALE and FAIL keep the raw status beside the word. */
export function modelStatusOf(model: Pick<MmModel, 'status'>): { text: string; color: string } {
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

export function tabs(el: El, data: Pick<PaneData, 'page' | 'pages' | 'onPage'>) {
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
export const BUTTON_CELLS = 12
export const EDGE_CELLS = 2
// A section frame's border and padding, one cell each side.
export const FRAME_CELLS = 4
/** Rows an overview section shows before its `N more` Button. */
const SECTION_CAP = 3
/** Characters of a command a disclosure's Code shows. */
const COMMAND_CHARS = 8000

/** `time` as `template` words it, the time a Live segment keyed `key`. */
export function liveSegs(template: (time: string) => string, key: string, from: number, now: number, format: Live['format']): Line {
  const [before = '', after = ''] = template('\u0000').split('\u0000')
  const time: Seg = { text: (format === 'age' ? fmtAge : fmtDuration)(now - from), live: { key, from, now, format } }

  return [...(before === '' ? [] : [{ text: before }]), time, ...(after === '' ? [] : [{ text: after }])]
}

const isPlain = (seg: Seg) => seg.color === undefined && seg.bold !== true && seg.dim !== true && seg.live === undefined

/** The parts with ` · ` between them, neighboring plain segments as one. */
export function joinParts(parts: readonly Line[]): Line {
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

const segsWidth = (line: Line) => widthOf(line.map(seg => seg.text).join(''))

/** One Text of segments, each Live one a clock-client Client between Texts; the desktop ignores truncation in practice, so callers cut the line first. */
export function lineText(el: El, line: Line, color?: string) {
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

    parts.push(<Client key={key} module="../clock-client.tsx" props={{ from, now, format, color: seg.color ?? color ?? 'text', bold: seg.bold === true }} />)
  }

  if (plain.length > 0) {
    parts.push(textOf(plain))
  }

  return <Box flexDirection="row">{parts}</Box>
}

/** An overview item: its status before the title and chips after it, its metadata, the Button right of the title and what the Button shows. */
export type Item = { status: Line; title: string; after?: Line; meta: Line; button: RenderChildren; disclosed?: RenderChildren }

/** Two lines at most: the status and the title, cut to leave the Button its cells; the metadata, subtle; then what the Button shows. */
export function itemOf(el: El, width: number, item: Item) {
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
export function disclosure(el: El, data: PaneData, key: string, buttonKey: string, source: string): Pick<Item, 'button' | 'disclosed'> {
  const { Button, Code } = el
  const isOpen = data.disclosures?.has(key) ?? false

  return {
    button: <Button key={buttonKey} label={isOpen ? t().collapse : t().command} variant="secondary" onPress={() => data.onToggleDisclosure?.(key)} />,
    disclosed: isOpen ? <Code source={source.slice(0, COMMAND_CHARS)} /> : null,
  }
}

/** A section's head: its title bold, the count after it subtle, a link to its page on the right. */
export function headerOf(el: El, title: string, count?: number, link: RenderChildren = null) {
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
export function capped(el: El, data: PaneData, section: string, rows: RenderChildren[]): RenderChildren[] {
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

/** One overview section in a rounded border, so sections read apart. */
export function frame(el: El, rows: RenderChildren) {
  const { Box } = el

  return (
    <Box flexDirection="column" gap={1} borderStyle="round" borderColor="promptBorder" paddingX={1} paddingY={1}>
      {rows}
    </Box>
  )
}

/** Any surface's elements: Box and Text everywhere, Svg only where the surface draws it. */
export type AnyEl = Pick<ElementTable, 'Box' | 'Text'> & { Svg?: El['Svg'] }

const svgOf = (ui: AnyEl) => ('Svg' in ui ? ui.Svg : undefined)

/** K8: `columns` layout columns in px, kept within `min` and `max`. */
export const pxWidth = (columns: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, columns * PIXELS_PER_COLUMN)))

/** K1: a 4 px rounded bar, a dot at its head while `isRunning`; without Svg, a line of `━` cells. */
export function bar(ui: AnyEl, frac: number | null, tone: Tone, px: number, alt: string, isRunning = false) {
  const { Text } = ui
  const Svg = svgOf(ui)

  if (Svg !== undefined) {
    const height = isRunning ? 8 : 4

    return <Svg source={roundedBar(frac, FILL[tone], px, { head: isRunning })} alt={alt} width={px} height={height} />
  }

  const cells = Math.max(1, Math.round(px / PIXELS_PER_COLUMN))
  const done = Math.round(Math.min(1, Math.max(0, frac ?? 0)) * cells)

  return (
    <Text>
      <Text color={TONE_KEYS[tone]}>{'━'.repeat(done)}</Text>
      <Text color="inactive">{'─'.repeat(cells - done)}</Text>
    </Text>
  )
}

/** K2: a ring gauge `size` px square; without Svg, the percent. */
export function gauge(ui: AnyEl, frac: number | null, tone: Tone, alt: string, size = 24, isStale = false) {
  const { Text } = ui
  const Svg = svgOf(ui)

  return Svg !== undefined ? (
    <Svg source={ring(frac, FILL[tone], size, isStale)} alt={alt} width={size} height={size} />
  ) : (
    <Text color={TONE_KEYS[tone]}>{frac === null ? '—' : `${Math.round(frac * 100)}%`}</Text>
  )
}

/** K3: a column per value; without Svg, `▁▂▃▄▅▆▇█` in the tone's theme key. */
export function sparkline(ui: AnyEl, values: readonly number[], tone: Tone, alt: string, px: number, height = 16) {
  const { Text } = ui
  const Svg = svgOf(ui)

  return Svg !== undefined ? (
    <Svg source={sparkBars(values, FILL[tone], px, height)} alt={alt} width={px} height={height} />
  ) : (
    <Text color={TONE_KEYS[tone]}>{sparkText(values)}</Text>
  )
}

export type Part = { label: string; value: number; text: string; tone: Tone }

/** K4: the parts as one stacked bar, then a `■ label value` legend whose squares take the tones' theme keys; without Svg, the legend alone. */
export function stacked(ui: AnyEl, parts: readonly Part[], alt: string, px: number) {
  const { Box, Text } = ui
  const Svg = svgOf(ui)

  return (
    <Box flexDirection="column" rowGap={1}>
      {Svg !== undefined ? <Svg source={stackedBar(parts, px)} alt={alt} width={px} height={8} /> : null}
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        {parts.map(part => (
          <Text>
            <Text color={TONE_KEYS[part.tone]}>■</Text>
            <Text color="subtle">{` ${part.label} `}</Text>
            <Text bold>{part.text}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  )
}

/** K5 without Svg: each icon's one-cell stand-in. */
export const ICON_GLYPHS: Record<IconName, string> = { check: '✓', warning: '!', running: '●', agent: '◆', terminal: '$', shield: '◈', gpu: '▣', clock: '◷' }

/** K5: a line icon in the tone's mid-tone; without Svg, its glyph in the tone's theme key. */
export function iconOf(ui: AnyEl, name: IconName, tone: Tone, alt: string, size = 16) {
  const { Text } = ui
  const Svg = svgOf(ui)

  return Svg !== undefined ? <Svg source={icon(name, FILL[tone], size)} alt={alt} width={size} height={size} /> : <Text color={TONE_KEYS[tone]}>{ICON_GLYPHS[name]}</Text>
}

/** Layout columns a kv row's label takes. */
export const KV_LABEL_COLUMNS = 7

/** K6: a fixed-width subtle label, then the value bold; a value that is not a string is drawn as given. */
export function kv(ui: AnyEl, label: string, value: RenderChildren, labelColumns = KV_LABEL_COLUMNS) {
  const { Box, Text } = ui

  return (
    <Box flexDirection="row" columnGap={1}>
      <Box width={labelColumns} flexShrink={0}>
        <Text color="subtle" wrap="truncate-end">
          {label}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        {typeof value === 'string' ? (
          <Text bold wrap="truncate-end">
            {value}
          </Text>
        ) : (
          value
        )}
      </Box>
    </Box>
  )
}

/** K7: a card that wants you, framed in `warning`, or `error` when something failed. */
export function attention(ui: AnyEl, tone: 'warning' | 'error', children: RenderChildren) {
  const { Box } = ui

  return (
    <Box flexDirection="column" rowGap={1} borderStyle="round" borderColor={tone} paddingX={1} paddingY={1}>
      {children}
    </Box>
  )
}

export type Kpi = { label: string; value: string; color: string; isZero: boolean }

/** A row of KPI tiles: the label subtle, the value bold in its theme key; a zero tile all `inactive`. */
export function kpis(ui: AnyEl, tiles: readonly Kpi[]) {
  const { Box, Text } = ui

  return (
    <Box flexDirection="row" columnGap={1}>
      {tiles.map(tile => (
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} borderStyle="round" borderColor="promptBorder" paddingX={1}>
          <Text color={tile.isZero ? 'inactive' : 'subtle'} wrap="truncate-end">
            {tile.label}
          </Text>
          <Text color={tile.isZero ? 'inactive' : tile.color} bold={!tile.isZero} wrap="truncate-end">
            {tile.value}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

/** Layout columns a list row's status glyph takes, and what its lower lines indent by. */
export const GLYPH_COLUMNS = 2

/** A list row: a fixed-width glyph, the title, `right` at the right edge; the subtle metadata under it; then a bar, if any. */
export type Row = { glyph: string; glyphColor: string; title: RenderChildren; right: RenderChildren; meta: RenderChildren; bar?: RenderChildren }

/** A list row as savvy-progress lays it: the title row, the metadata and the bar indented past the glyph. */
export function listRow(ui: AnyEl, row: Row) {
  const { Box, Text } = ui

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Box width={GLYPH_COLUMNS} flexShrink={0}>
          <Text color={row.glyphColor} bold>
            {row.glyph}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {row.title}
        </Box>
        <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
          {row.right}
        </Box>
      </Box>
      <Box flexDirection="column" paddingLeft={GLYPH_COLUMNS + 1}>
        {row.meta}
        {row.bar ?? null}
      </Box>
    </Box>
  )
}

/** One dot per agent in its tone, those past `max` as `+N`, then `summary`; without Svg, `●` per agent in its theme key. */
export function dots(ui: AnyEl, tones: readonly Tone[], max: number, alt: string, summary: RenderChildren) {
  const { Box, Text } = ui
  const Svg = svgOf(ui)
  const shown = tones.slice(0, Math.max(1, max))
  const more = tones.length - shown.length

  return (
    <Box flexDirection="row" columnGap={1} alignItems="center">
      {Svg !== undefined ? (
        <Svg source={dotsSvg(shown)} alt={alt} width={Math.max(16, shown.length * 20 - 4)} height={16} />
      ) : (
        <Text>
          {shown.map(tone => (
            <Text color={TONE_KEYS[tone]}>●</Text>
          ))}
        </Text>
      )}
      {more > 0 ? <Text color="subtle">{`+${more}`}</Text> : null}
      <Box flexGrow={1} />
      {summary}
    </Box>
  )
}

export function backRow(el: El, data: PaneData, title: string) {
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
