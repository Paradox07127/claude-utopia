import type { RenderChildren } from 'claude-code'

import type { BoardNode, BoardRequest, BoardStatus } from '../../types'
import { fit, widthOf } from '../agent-model'
import { clockOf, fitLine, legacyNodes, PIECE_GLYPHS, progressAge, progressColor, progressDoneWhen, progressGroups, progressMeta, requestGlyph, requestPieces, staleHours } from '../board'
import type { Line } from '../board'
import { FILL, HATCH, svg, TRACK } from '../desktop-svg'
import { t } from '../i18n'
import { titlePattern } from '../progress'
import { BUTTON_CELLS, capped, EDGE_CELLS, frame, FRAME_CELLS, GLYPH_COLUMNS, headerOf, joinParts, lineText, listRow, pxWidth, textCells } from './kit'
import type { El, PaneData } from './kit'

// The progress page: cells a request row keeps for its age (`30d!`); requests that make a series.
const AGE_CELLS = 4
const CHAIN_MIN = 3
// A list row's glyph column and its gap, in text cells.
const ROW_CELLS = textCells(GLYPH_COLUMNS) + 1
// A piece's segment: the gap between two, their corner radius.
const SEGMENT_GAP = 3
const SEGMENT_RX = 3

/** Each piece status's paint in an Svg: done and doing their fills, blocked hatched, to do the faint track. */
const SEGMENT_PAINT: Record<BoardStatus, string> = {
  done: `fill="${FILL.done}"`,
  doing: `fill="${FILL.running}"`,
  blocked: `fill="${HATCH.fill}"`,
  todo: `fill="${TRACK}" fill-opacity="0.22"`,
  dropped: `fill="${TRACK}" fill-opacity="0.22"`,
}

/** One rounded segment per piece across `width`, as savvy-progress's rowSvg cuts its row; the kit has no segmented bar. */
export function segmentsSvg(statuses: readonly BoardStatus[], width: number, height = 8): string {
  const w = (width - SEGMENT_GAP * (statuses.length - 1)) / Math.max(1, statuses.length)
  const rects = statuses.map((status, i) => `<rect data-part="segment" x="${Number((i * (w + SEGMENT_GAP)).toFixed(2))}" y="0" width="${Number(w.toFixed(2))}" height="${height}" rx="${SEGMENT_RX}" ${SEGMENT_PAINT[status]}/>`)

  return svg(width, height, `${statuses.includes('blocked') ? HATCH.defs : ''}${rects.join('')}`)
}
// The version in a title, as titlePattern folds it to `<ver>`.
const VERSION = /\bv?\d+(?:\.\d+)+/i
const DAY_MS = 86_400_000

/**
 * The progress board: a 现在 frame with this session's request, every ready one and every stale one; a section per active line with a
 * request on the page, newest activity first, then one for requests of no line; last the nodes recorded before requests, a frame per
 * status group as before, three nodes each before `N more`.
 */
export function progressBody(el: El, data: PaneData) {
  const { Box, Button, Svg, Text } = el
  const board = data.progress ?? null
  const nodes = board?.nodes ?? []
  const requests = (board?.requests ?? []).filter(one => one.state !== 'dropped').sort((a, b) => b.updatedAt - a.updatedAt)

  if (nodes.length === 0 && requests.length === 0) {
    return [<Text color="subtle" wrap="wrap">{t().progressEmpty(data.progress?.dir ?? null)}</Text>]
  }

  const now = data.now
  const width = textCells(data.columns - FRAME_CELLS - EDGE_CELLS)
  const barPx = pxWidth(data.columns - FRAME_CELLS - GLYPH_COLUMNS - 1, 120, 720)
  // What each segment's paint means, once at the top.
  const legend = (
    <Box flexDirection="row" columnGap={2} flexWrap="wrap">
      {(['done', 'doing', 'blocked', 'todo'] as const).map(status => (
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Svg source={segmentsSvg([status], 10, 10)} alt="" width={10} height={10} />
          <Text color="subtle">{t().progressStatuses[status]}</Text>
        </Box>
      ))}
    </Box>
  )
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
  /** savvy-progress's row: the glyph, the title bold, `done / total` and the age right; the follow-ups under it; a segment per piece. */
  const requestCard = (one: BoardRequest) => {
    const pieces = requestPieces(one, nodes)
    const glyph = requestGlyph(one, nodes)
    const count = one.total === 0 ? '' : `${one.done} / ${one.total}`
    const facts = joinParts([
      ...(one.followUps > 0 ? [[{ text: t().progressFollowUps(one.followUps) }]] : []),
      ...(one.state === 'ready' ? [[{ text: t().progressAwaiting, color: 'warning' }]] : []),
    ])
    const room = width - ROW_CELLS - widthOf(count) - AGE_CELLS - 2

    return (
      <Box flexDirection="column" rowGap={1}>
        {listRow(el, {
          glyph: glyph.text,
          glyphColor: glyph.color ?? 'text',
          title: (
            <Text color="text" bold wrap="truncate-end">
              {fit(one.title, room)}
            </Text>
          ),
          right: [...(count === '' ? [] : [<Text color="text">{count}</Text>]), lineText(el, ageLine(one), 'subtle')],
          meta: facts.length === 0 ? null : lineText(el, fitLine(facts, width - ROW_CELLS - EDGE_CELLS), 'subtle'),
          ...(pieces.length > 0 && { bar: <Svg source={segmentsSvg(pieces.map(piece => piece.status), barPx)} alt={`${one.done}/${one.total}`} width={barPx} height={8} /> }),
        })}
        {pieces.map(pieceRow)}
        <Box flexDirection="row" columnGap={1}>
          {button(`progress-accept-${one.id}`, t().progressAccept, () => data.onAcceptRequest?.(one.id))}
          {button(`progress-dropreq-${one.id}`, t().progressDropRequest, () => data.onDropRequest?.(one.id))}
        </Box>
      </Box>
    )
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
  /** A fold header: `▾ 进行中 · 3` open, `▸ 已完成 · 5` folded. */
  const foldButton = (key: string, label: string, count: number, isOpen: boolean, toggle: string) => (
    <Box flexDirection="row">
      <Button key={key} label={`${isOpen ? '▾' : '▸'} ${label} · ${count}`} variant="secondary" onPress={() => data.onToggleDisclosure?.(toggle)} />
    </Box>
  )
  const section = (id: string, name: string, list: readonly BoardRequest[]) => {
    const chains = chainsOf(list)
    // A series member still open keeps its card, so its pieces can be closed; a closed one shows only in the chain.
    const rest = list.filter(one => one.state !== 'closed' || !chains.some(chain => chain.includes(one)))
    const active = rest.filter(one => one.state !== 'closed')
    const closed = rest.filter(one => one.state === 'closed')
    const open = list.filter(one => one.status === 'open').length
    const head = `${name}${chains.length === 0 ? '' : ` (${t().progressSeries})`}`
    // The active group shows until folded; the closed one stays folded until opened.
    const isActiveOpen = !(data.disclosures?.has(`fold:progress:${id}:active`) ?? false)
    const isClosedOpen = data.disclosures?.has(`fold:progress:${id}:closed`) ?? false

    return (
      <Box flexDirection="column" gap={1}>
        {lineText(el, fitLine([{ text: head, bold: true }, { text: ` · ${t().progressOpenClosed(open, list.length - open)}`, color: 'subtle' }], width))}
        {chains.map(chain => lineText(el, fitLine(chainLine(chain), width)))}
        {active.length === 0
          ? null
          : frame(el, [
              foldButton(`progress-fold-active-${id}`, t().progressStatuses.doing, active.length, isActiveOpen, `fold:progress:${id}:active`),
              ...(isActiveOpen ? active.map(requestCard) : []),
            ])}
        {closed.length === 0
          ? null
          : frame(el, [foldButton(`progress-fold-closed-${id}`, t().progressStatuses.done, closed.length, isClosedOpen, `fold:progress:${id}:closed`), ...(isClosedOpen ? closed.map(closedRow) : [])])}
      </Box>
    )
  }
  const lines = (board?.lines ?? []).filter(line => line.status === 'active' && requests.some(one => one.line === line.id)).sort((a, b) => b.updatedAt - a.updatedAt)
  const loose = requests.filter(one => !lines.some(line => line.id === one.line))
  const legacy = legacyNodes(nodes)

  return [
    <Box flexDirection="column" gap={2}>
      {requests.length === 0 ? null : legend}
      {nowFrame}
      {lines.map(line => section(line.id, line.name.toUpperCase(), requests.filter(one => one.line === line.id)))}
      {loose.length === 0 ? null : section('loose', `${t().progressNoLine} · ${loose.length}`, loose)}
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
