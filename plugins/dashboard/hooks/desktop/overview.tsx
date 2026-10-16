import type { RenderChildren } from 'claude-code'

import type { GateRun } from '../../types'
import { elapsedOf, fit, fmtDuration, widthOf } from '../agent-model'
import { commandHead, endedHead, fitLine, gateCounts, gateOutcome, isFailedGate, isStalled, itemTail, itemTitle, overviewOf, PEER_WORDS, peerTitle, recentGates } from '../board'
import type { Line, OverviewItem, Seg, ShownPeer } from '../board'
import { scaleOf, TONE_KEYS } from '../desktop-svg'
import type { Tone } from '../desktop-svg'
import { t } from '../i18n'
import { elapsedSecs, fmtRunTokens, fmtSecs } from '../runs'
import type { Flight } from '../timeline'
import { GUARD_COLORS, guardHead, treeMarks } from '../workspace'
import type { Mark } from '../workspace'
import {
  agentTone,
  agentWord,
  attention,
  bar,
  BUTTON_CELLS,
  capped,
  disclosure,
  EDGE_CELLS,
  frame,
  FRAME_CELLS,
  GLYPH_COLUMNS,
  headerOf,
  iconOf,
  itemOf,
  joinParts,
  kpis,
  kv,
  KV_LABEL_COLUMNS,
  lineText,
  listRow,
  liveSegs,
  modelTone,
  modelWord,
  posixQuote,
  pxWidth,
  textCells,
  widthTierOf,
} from './kit'
import type { El, PaneData } from './kit'

const PEER_TONES: Record<ShownPeer['state'], Tone> = { permission: 'stale', failed: 'failed', replied: 'stale', working: 'running' }

// Text cells a kv row's label and its gap take; a list row's glyph column and its gap.
const KV_CELLS = textCells(KV_LABEL_COLUMNS) + 1
const ROW_CELLS = textCells(GLYPH_COLUMNS) + 1

const itemKey = (item: OverviewItem) => (item.kind === 'agent' ? item.run.agentId : `${item.run.runid}/${item.model.name}`)

const chipSeg = (tone: Tone, text: string): Seg => ({ text: ` ${text} `, color: TONE_KEYS[tone], bold: true })

const counted = (title: string, count: number) => `${title} · ${count}`

const boldLine = (line: Line): Line => line.map(seg => ({ ...seg, bold: true }))

function itemChip(item: OverviewItem, now: number, flights: ReadonlyMap<string, Flight> | undefined): Line {
  if (item.kind === 'model') {
    return [chipSeg(modelTone(item.model), modelWord(item.model))]
  }

  return isStalled(item.run, now, flights?.get(item.run.agentId)) ? quietSegs(item, now) : [chipSeg(agentTone(item.run), agentWord(item.run))]
}

const quietSegs = (item: OverviewItem & { kind: 'agent' }, now: number): Line =>
  liveSegs(time => ` ◐ ${t().quiet(time)} `, `quiet-${item.run.agentId}`, item.run.lastActivityAt, now, 'duration').map(seg => ({ ...seg, color: TONE_KEYS.stale, bold: true }))

/** A running agent's time, moving by itself. */
function elapsedSeg(item: OverviewItem & { kind: 'agent' }, now: number): Seg {
  // While it runs, elapsedOf(run, now) is now - from.
  const from = (item.run.turnAt ?? item.run.startedAt) - (item.run.activeMs ?? 0)

  return { text: fmtDuration(elapsedOf(item.run, now)), live: { key: `elapsed-${item.run.agentId}`, from, now, format: 'duration' } }
}

/** `4 tools · 3m12s`, or a model's tokens and time; then how long ago it ended. A running agent's time and every age move by themselves. */
function itemMeta(item: OverviewItem, now: number, polledAt: number): Line {
  const endedAt = item.kind === 'agent' ? item.run.endedAt : item.model.endedAt
  const parts = itemTail(item, now, polledAt)
    .split('  ')
    .filter(part => part !== '')
    .map((text): Line => [{ text }])

  if (item.kind === 'agent' && item.run.durationMs === undefined) {
    parts[parts.length - 1] = [elapsedSeg(item, now)]
  }

  return joinParts([...parts, ...(endedAt === undefined ? [] : [liveSegs(t().gateAgo, `ended-${itemKey(item)}`, endedAt, now, 'age')])])
}

/** `agent-x · 2 fail · 3m ago`, `main · 24 pass · 1h05m ago`; a stale run says stale before its age. */
function gateMeta(gate: GateRun, key: string, now: number): Line {
  const outcome = isFailedGate(gate) ? gateOutcome(gate) : `${gate.unit === 'packages' ? `${t().packagesUnit} · ` : ''}${t().passCount(gate.pass ?? '—')}`
  const words = [whereOf(gate), outcome, ...(gate.stale === true ? [t().gateStale] : [])]

  return joinParts([...words.map((text): Line => [{ text }]), liveSegs(t().gateAgo, key, gate.at, now, 'age')])
}

const whereOf = (gate: GateRun) => (gate.where === 'main' ? t().mainTree : gate.where)

/** A worktree mark inside the subtle metadata line: `plain` at full strength, `dim` left subtle, the rest a chip's color. */
const markSeg = (mark: Mark): Seg =>
  mark.tone === 'plain' ? { text: mark.text, color: 'text' } : mark.tone === 'dim' ? { text: mark.text } : { text: mark.text, color: TONE_KEYS[mark.tone], bold: true }

/** The latest gate as the KPI tile shows it: its word in its theme key, `—` when none ran. */
function gateKpi(gate: GateRun | undefined) {
  if (gate === undefined) {
    return { label: t().kpiGate, value: t().kpiNoGate, color: 'inactive', isZero: true }
  }

  const word = isFailedGate(gate) ? t().gateFailedChip : t().gatePassed

  return { label: t().kpiGate, value: word, color: gate.stale === true ? 'inactive' : isFailedGate(gate) ? 'error' : 'success', isZero: false }
}

export function overview(el: El, data: PaneData) {
  const { Box, Button, Text } = el
  const now = data.now
  const polledAt = data.snap?.polledAt ?? now
  const view = overviewOf(data.agents, data.snap, data.seen, now, data.peers, data.gates, data.trees)
  const tier = widthTierOf(data.columns)
  const width = textCells(data.columns - FRAME_CELLS)

  const done = [
    view.returned > 0 ? t().returnedCount(view.returned) : '',
    view.aborted > 0 ? `⊘ ${t().agentStates.aborted} ${view.aborted}` : '',
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

  const openButton = (item: OverviewItem, label: string) => <Button label={label} variant="secondary" onPress={() => data.onOpenItem(item)} />

  const deniedSegs = (item: OverviewItem): Line => (item.kind === 'agent' && (item.run.denied ?? 0) > 0 ? [{ text: ' ' }, chipSeg('failed', t().denied(item.run.denied ?? 0))] : [])

  /** A needs-you head: the chips left, the Button right. */
  const needHead = (status: Line, button: RenderChildren) => (
    <Box flexDirection="row" columnGap={1} alignItems="center">
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        {lineText(el, fitLine(status, width - BUTTON_CELLS))}
      </Box>
      <Box flexShrink={0}>{button}</Box>
    </Box>
  )

  const kvRoom = width - KV_CELLS - EDGE_CELLS

  const needItem = (item: OverviewItem) => (
    <Box flexDirection="column">
      {needHead([...itemChip(item, now, data.flights), ...deniedSegs(item)], openButton(item, item.kind === 'agent' && item.run.state === 'running' ? t().open : t().read))}
      {kv(el, t().kvTask, fit(itemTitle(item), kvRoom))}
      {kv(el, t().kvProgress, lineText(el, boldLine(fitLine(itemMeta(item, now, polledAt), kvRoom))))}
    </Box>
  )

  const needGate = (gate: GateRun, index: number) => {
    const shown = disclosure(el, data, `gate:pending:${gate.where}:${gate.at}`, `gate-pending-${gate.where}-${gate.at}`, gate.key ?? gate.command)

    return (
      <Box flexDirection="column">
        {needHead([chipSeg('failed', `✗ ${t().gateWord}`)], shown.button)}
        {kv(el, t().command, fit(commandHead(gate.key ?? gate.command), kvRoom))}
        {kv(el, t().kvWhere, lineText(el, boldLine(fitLine(gateMeta(gate, `gate-pending-${index}`, now), kvRoom))))}
        {shown.disclosed ?? null}
      </Box>
    )
  }

  const kpiRow = [
    kpis(el, [
      { label: t().needsYou, value: String(needsYou), color: 'warning', isZero: needsYou === 0 },
      { label: t().runWord, value: String(view.running.length), color: 'permission', isZero: view.running.length === 0 },
      { label: t().kpiUnread, value: String(unread), color: 'text', isZero: unread === 0 },
      gateKpi(gates[0]),
    ]),
  ]

  const isFailing = view.gates.length > 0 || view.pending.some(item => (item.kind === 'agent' ? agentTone(item.run) : modelTone(item.model)) === 'failed')
  const needsYouCard =
    needsYou === 0
      ? []
      : [
          attention(el, isFailing ? 'error' : 'warning', [
            <Box flexDirection="row" columnGap={1} alignItems="center" justifyContent="space-between">
              <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={1} minWidth={0}>
                {iconOf(el, 'warning', isFailing ? 'failed' : 'stale', t().needsYou)}
                <Text color={isFailing ? 'error' : 'warning'} bold wrap="truncate-end">
                  {counted(t().needsYou, needsYou)}
                </Text>
              </Box>
              {view.gates.length === 0 ? allLink(view.pending) : null}
            </Box>,
            ...capped(el, data, 'needsYou', [...view.pending.map(needItem), ...view.gates.map(needGate)]),
          ]),
        ]

  const sessionsSection =
    view.sessions.length === 0
      ? []
      : [
          headerOf(el, counted(t().otherSessions, view.sessions.length)),
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

  const secsOf = (item: OverviewItem) => (item.kind === 'agent' ? elapsedOf(item.run, now) / 1000 : (elapsedSecs(item.model, polledAt) ?? null))
  const scale = scaleOf(Math.max(0, ...view.running.map(item => secsOf(item) ?? 0)))
  const barPx = pxWidth(data.columns - FRAME_CELLS - GLYPH_COLUMNS - 1, 120, 720)

  /** A running row: the glyph, the title bold, its time and Button right; the model and tools under it, then its bar. */
  const runRow = (item: OverviewItem) => {
    const secs = secsOf(item)
    const time: Line = item.kind === 'agent' ? [elapsedSeg(item, now)] : [{ text: secs === null ? '' : fmtSecs(secs) }]
    const isQuiet = item.kind === 'agent' && isStalled(item.run, now, data.flights?.get(item.run.agentId))
    const meta: Line =
      item.kind === 'agent'
        ? [{ text: `${item.run.model.replace(/^claude-/, '')} · ${item.run.tools} tools` }, ...(isQuiet ? [{ text: ' ' }, ...quietSegs(item, now)] : []), ...deniedSegs(item)]
        : [{ text: ['mmrun', ...(item.model.outputTokens === undefined ? [] : [fmtRunTokens(item.model.outputTokens)])].join(' · ') }]
    const room = width - ROW_CELLS - BUTTON_CELLS - widthOf(time.map(seg => seg.text).join('')) - 1

    return listRow(el, {
      glyph: isQuiet ? '◐' : '●',
      glyphColor: isQuiet ? TONE_KEYS.stale : TONE_KEYS.running,
      title: (
        <Text color="text" bold wrap="truncate-end">
          {fit(itemTitle(item), room)}
        </Text>
      ),
      right: [lineText(el, time), openButton(item, t().open)],
      meta: lineText(el, fitLine(meta, width - ROW_CELLS - EDGE_CELLS), 'subtle'),
      bar: bar(el, secs === null ? null : secs / scale.secs, 'running', barPx, t().elapsedAlt(time.map(seg => seg.text).join(''), scale.label), true),
    })
  }

  const doneN = view.returned + view.aborted + view.reviewed
  const foldRow =
    done === ''
      ? []
      : [
          <Box columnGap={1} alignItems="center" flexWrap="wrap">
            {lineText(el, fitLine([{ text: `▸ ${counted(t().doneTitle, doneN)} · `, color: 'subtle' }, { text: done }], width - EDGE_CELLS))}
            {view.returned + view.aborted > 0 ? <Button key="overview-agents" label={t().seeAgents} variant="secondary" onPress={() => data.onPage('agents')} /> : null}
            {view.reviewed > 0 ? <Button key="overview-mmrun" label={t().seeReviews} variant="secondary" onPress={() => data.onPage('mmrun')} /> : null}
          </Box>,
        ]

  const listSection =
    view.running.length === 0 && foldRow.length === 0
      ? []
      : [
          ...(view.running.length === 0
            ? []
            : [
                headerOf(
                  el,
                  counted(t().runningHeading, view.running.length),
                  undefined,
                  <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
                    <Text color="subtle">{t().sharedScale(scale.label)}</Text>
                    {allLink(view.running)}
                  </Box>,
                ),
                ...capped(el, data, 'running', view.running.map(runRow)),
              ]),
          ...foldRow,
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

  /** Two lines whatever the width: the outcome left and its age and Button right; the command and the tree subtle under it. */
  const gateRow = (gate: GateRun, index: number) => {
    const isFailed = isFailedGate(gate)
    const isStale = gate.stale === true
    const color = isStale ? 'inactive' : isFailed ? 'error' : 'success'
    const word = `${isFailed ? t().gateFailed : t().gatePassWord}${isStale ? ` · ${t().gateStale}` : ''}`
    const counts = gate.fail === null ? `${gate.unit === 'packages' ? `${t().packagesUnit} · ` : ''}${gate.pass ?? '—'} pass` : gateCounts(gate)
    const age = liveSegs(t().gateAgo, `gate-recent-${index}`, gate.at, now, 'age').map(seg => ({ ...seg, color: isStale ? 'inactive' : 'subtle' }))
    const shown = disclosure(el, data, `gate:recent:${gate.where}:${gate.at}`, `gate-recent-${gate.where}-${gate.at}`, gate.key ?? gate.command)
    const where = ` · ${whereOf(gate)}`
    const ageCells = widthOf(age.map(seg => seg.text).join(''))
    // The counts come first: when they do not fit beside the age and the Button, the Button moves down beside the command.
    const isButtonDown = widthOf(`${word}  ${counts}`) > columnWidth - ROW_CELLS - BUTTON_CELLS - ageCells - 1
    const metaRoom = columnWidth - ROW_CELLS - EDGE_CELLS - (isButtonDown ? BUTTON_CELLS : 0)
    const room = columnWidth - ROW_CELLS - (isButtonDown ? 0 : BUTTON_CELLS) - ageCells - 1
    const meta = lineText(el, fitLine([{ text: fit(commandHead(gate.key ?? gate.command), Math.max(8, metaRoom - widthOf(where))) }, { text: where }], metaRoom), 'subtle')

    return (
      <Box flexDirection="column">
        {listRow(el, {
          glyph: isFailed ? '✗' : '✓',
          glyphColor: color,
          title: lineText(el, fitLine([{ text: word, color, bold: true }, { text: '  ' }, { text: counts, bold: true, ...(isStale && { color }) }], room)),
          right: isButtonDown ? [lineText(el, age)] : [lineText(el, age), shown.button],
          meta: isButtonDown ? (
            <Box flexDirection="row" columnGap={1} alignItems="center">
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                {meta}
              </Box>
              <Box flexShrink={0}>{shown.button}</Box>
            </Box>
          ) : (
            meta
          ),
        })}
        {shown.disclosed ?? null}
      </Box>
    )
  }

  const gatesSection = gates.length === 0 ? [] : [headerOf(el, counted(t().recentGates, gates.length)), ...capped(el, data, 'gates', gates.map(gateRow))]

  const trees = data.trees
  const treesSection =
    trees === null
      ? [headerOf(el, t().worktrees), <Text color="subtle">{t().loading}</Text>]
      : trees.length === 0
        ? []
        : [
            headerOf(el, counted(t().worktrees, trees.length)),
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
          headerOf(el, counted(t().recentBlocks, data.guards.length)),
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
          <Box flexDirection="row" columnGap={3}>
            {gatesSection.length > 0 ? <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>{frame(el, gatesSection)}</Box> : null}
            {treesSection.length > 0 ? <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>{frame(el, treesSection)}</Box> : null}
          </Box>,
        ]
      : [gatesSection, treesSection].filter(rows => rows.length > 0).map(rows => frame(el, rows))

  const framed = (rows: RenderChildren[]) => (rows.length === 0 ? [] : [frame(el, rows)])

  return [
    <Box flexDirection="column" gap={1}>
      {[...kpiRow, ...needsYouCard, ...framed(sessionsSection), ...framed(listSection), ...framed(idleSection), ...gatesAndTrees, ...framed(guardsSection)]}
    </Box>,
  ]
}
