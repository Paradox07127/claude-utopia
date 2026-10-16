import type { BoardStatus } from '../../types'
import type { Line } from '../board'
import { TONE_KEYS } from '../desktop-svg'
import type { IconName, Tone } from '../desktop-svg'
import { t } from '../i18n'
import { attention, bar, iconOf, kv } from './kit'
import type { El } from './kit'
import { segmentsSvg } from './progress'

/**
 * One row of the band, as register.tsx lays it out for both surfaces: the idle line; a line as bandLines gave it, `tone` its status;
 * a running agent, `frac` its elapsed time on the shared scale; a session waiting on the person; a new result that can be marked read; a notice;
 * this session's current request, a status per piece.
 */
export type BandRow =
  | { kind: 'idle'; line: Line }
  | { kind: 'line'; line: Line; tone: Tone }
  | { kind: 'running'; title: string; step: string; time: string; frac: number; alt: string; tail: Line }
  | { kind: 'ask'; id: string; head: string; waited: string; task: string; request: string }
  | { kind: 'result'; line: Line; tone: Tone; agentId: string }
  | { kind: 'notice'; text: string }
  | { kind: 'plan'; title: string; statuses: BoardStatus[]; done: number; total: number; alt: string }

export type BandActions = { onOpen: () => void; onAsk: () => void; onDismiss: (agentId: string) => void }

const ICON_SIZE = 16
// A running row's title box and bar box, in layout columns; the bar's px fill its box.
const TITLE_COLUMNS = 24
const BAR_COLUMNS = 13
const BAR_PX = 120
const ICONS: Record<Tone, IconName> = { running: 'running', done: 'check', failed: 'warning', stale: 'warning', idle: 'clock' }

/** The line without its leading status glyph, which the row's icon stands for. */
function withoutGlyph(line: Line): Line {
  const [first, next, ...rest] = line

  if (first === undefined || first.color === undefined || [...first.text.trim()].length !== 1) {
    return line
  }

  return next === undefined ? [] : [{ ...next, text: next.text.trimStart() }, ...rest]
}

/** The band: a row per BandRow, each led by its status icon; a session waiting on the person as a warning card; the first other row carries 工作台. */
export function drawDesktopBand(el: El, rows: readonly BandRow[], actions: BandActions, needsYou = false) {
  const { Box, Button, Svg, Text } = el
  const segs = (line: Line, color?: string) =>
    line.map(seg => (
      <Text
        {...((seg.color ?? color) !== undefined && { color: seg.color ?? color })}
        {...(seg.bold === true && { bold: true })}
        {...(seg.dim === true && { dimColor: true })}
      >
        {seg.text.replace(/ {3,}/g, '  ')}
      </Text>
    ))
  const draw = (line: Line) => <Text wrap="truncate">{segs(line)}</Text>
  const isPrimary =
    needsYou ||
    rows.some(row => (row.kind === 'line' || row.kind === 'result') && row.line.some(s => s.color === 'error' || (s.color === 'warning' && s.text.includes('!'))))
  const opener = rows.findIndex(row => row.kind !== 'ask' && row.kind !== 'notice')

  const rowOf = (row: Exclude<BandRow, { kind: 'ask' | 'notice' }>, index: number) => {
    const open = index === opener ? <Button key="dash-open" label={t().workbench} variant={isPrimary ? 'primary' : 'secondary'} onPress={actions.onOpen} /> : null

    if (row.kind === 'idle') {
      const [word, ...rest] = row.line

      return (
        <Box flexDirection="row" columnGap={1} alignItems="center">
          {iconOf(el, 'check', 'done', t().idleBand, ICON_SIZE)}
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text wrap="truncate">
              <Text color={TONE_KEYS.done} bold>
                {word?.text ?? t().idleBand}
              </Text>
              {segs(rest.map(seg => ({ text: seg.text, ...(seg.color !== undefined && { color: seg.color }) })), 'subtle')}
            </Text>
          </Box>
          {open}
        </Box>
      )
    }

    if (row.kind === 'plan') {
      const tone: Tone = row.statuses.includes('doing') ? 'running' : 'idle'

      return (
        <Box flexDirection="row" columnGap={1} alignItems="center">
          {iconOf(el, ICONS[tone], tone, row.alt, ICON_SIZE)}
          <Box width={TITLE_COLUMNS} flexShrink={1} minWidth={0}>
            <Text bold wrap="truncate-end">
              {row.title}
            </Text>
          </Box>
          <Box width={BAR_COLUMNS} flexShrink={0}>
            <Svg source={segmentsSvg(row.statuses, BAR_PX, 8)} alt={row.alt} width={BAR_PX} height={8} />
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color="subtle" wrap="truncate">{`${row.done}/${row.total}`}</Text>
          </Box>
          {open}
        </Box>
      )
    }

    if (row.kind === 'running') {
      return (
        <Box flexDirection="row" columnGap={1} alignItems="center">
          {iconOf(el, 'running', 'running', row.alt, ICON_SIZE)}
          <Box width={TITLE_COLUMNS} flexShrink={1} minWidth={0}>
            <Text bold wrap="truncate-end">
              {row.title}
            </Text>
          </Box>
          <Box width={BAR_COLUMNS} flexShrink={0}>
            {bar(el, row.frac, 'running', BAR_PX, row.alt, true)}
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text wrap="truncate">
              {row.step === '' ? null : <Text bold>{`${row.step} `}</Text>}
              <Text color="subtle">{row.time}</Text>
              {segs(row.tail)}
            </Text>
          </Box>
          {open}
        </Box>
      )
    }

    return (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {iconOf(el, ICONS[row.tone], row.tone, row.line.map(seg => seg.text).join(''), ICON_SIZE)}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {draw(withoutGlyph(row.line))}
        </Box>
        {row.kind === 'result' ? (
          <Button key={`dismiss-${row.agentId}`} label="✕" variant="secondary" onPress={() => actions.onDismiss(row.agentId)} />
        ) : null}
        {open}
      </Box>
    )
  }

  // With no other row, the card carries 工作台.
  const askOf = (row: Extract<BandRow, { kind: 'ask' }>) =>
    attention(el, 'warning', [
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {iconOf(el, 'warning', 'stale', t().needsYou, ICON_SIZE)}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text color="warning" bold wrap="truncate-end">{`${t().needsYou} · ${row.head}`}</Text>
        </Box>
        <Text color="subtle">{row.waited}</Text>
      </Box>,
      kv(el, t().askTask, row.task),
      kv(el, t().askRequest, row.request),
      <Box flexDirection="row" columnGap={1}>
        <Button key={`ask-${row.id}`} label={t().askHandle} variant="primary" onPress={actions.onAsk} />
        {opener < 0 ? <Button key="dash-open" label={t().workbench} variant="secondary" onPress={actions.onOpen} /> : null}
      </Box>,
    ])

  return (
    <Box flexDirection="column" width="100%">
      {rows.map((row, index) =>
        row.kind === 'ask' ? (
          askOf(row)
        ) : row.kind === 'notice' ? (
          <Text color="subtle" wrap="truncate">
            {row.text}
          </Text>
        ) : (
          rowOf(row, index)
        ),
      )}
    </Box>
  )
}
