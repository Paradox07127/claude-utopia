import type { RenderChildren } from 'claude-code'

import type { AgentRun } from '../../types'
import { elapsedOf, fit, fmtDuration, glyphOf, widthOf } from '../agent-model'
import { agentFold, flightText, isStalled, tokensText } from '../board'
import { scaleOf, TONE_KEYS } from '../desktop-svg'
import { t } from '../i18n'
import { taskOfAgent } from '../tasks'
import { agentTone, bar, BUTTON_CELLS, dots, EDGE_CELLS, frame, FRAME_CELLS, GLYPH_COLUMNS, headerOf, kpis, listRow, pxWidth, textCells, widthTierOf } from './kit'
import type { El, PaneData } from './kit'

// A list row's glyph column and its gap, in text cells.
const ROW_CELLS = textCells(GLYPH_COLUMNS) + 1

/** An ended agent's word and its theme key; a running one has none, its glyph says it. */
function stateWord(run: AgentRun): { text: string; color: string } | null {
  if (run.state === 'running') {
    return null
  }

  return run.state === 'done' ? { text: t().returnedUnverified, color: 'success' } : { text: t().agentStates[run.state], color: glyphOf(run.state).color }
}

export function agentCards(el: El, data: PaneData) {
  const { Box, Button, Text } = el
  const list = [...data.agents].reverse()

  if (list.length === 0) {
    return [<Text color="subtle">{t().noAgents}</Text>]
  }

  const { listed, folded } = agentFold(list, data.agentsSeenBefore ?? data.seen.agents)
  const isFoldOpen = data.isFoldOpen === true
  const shown = isFoldOpen ? [...listed, ...folded] : listed
  const scale = scaleOf(Math.max(0, ...shown.map(run => elapsedOf(run, data.now) / 1000)))
  const width = textCells(data.columns - FRAME_CELLS)
  const barPx = pxWidth(data.columns - FRAME_CELLS - GLYPH_COLUMNS - 1, 120, 720)

  /** savvy-progress's row: the glyph, the task bold, its time and Button right; its state and metadata under it; a 4 px bar. */
  const rowOf = (run: AgentRun) => {
    const task = taskOfAgent(run)
    const ms = elapsedOf(run, data.now)
    const time = fmtDuration(ms)
    const flight = run.state === 'running' ? data.flights?.get(run.agentId) : undefined
    const word = stateWord(run)
    const quiet = isStalled(run, data.now, flight) ? `◐ ${t().quiet(fmtDuration(data.now - run.lastActivityAt))}` : ''
    const denied = (run.denied ?? 0) > 0 ? t().denied(run.denied ?? 0) : ''
    const meta = [
      task.kind,
      task.model.replace(/^claude-/, ''),
      `${task.tools ?? 0} tools`,
      ...(run.usage === undefined ? [] : [`${tokensText(run.usage)} tokens`]),
      ...(flight === undefined ? [] : [flightText(flight, data.now)]),
    ].join(' · ')
    const metaRoom = width - ROW_CELLS - EDGE_CELLS - [word?.text ?? '', quiet, denied].reduce((sum, part) => sum + (part === '' ? 0 : widthOf(part) + 1), 0)
    const alt = t().agentBarAlt(task.kind, task.title, run.state === 'done' ? t().returned : t().agentStates[run.state] || t().runWord, time, scale.label)

    return listRow(el, {
      glyph: glyphOf(run.state).glyph,
      glyphColor: glyphOf(run.state).color,
      title: (
        <Text color="text" bold wrap="truncate-end">
          {fit(task.title, width - ROW_CELLS - BUTTON_CELLS - widthOf(time) - 1)}
        </Text>
      ),
      right: [
        <Text color="text">{time}</Text>,
        <Button key={`read-agent-${run.agentId}`} label={run.state === 'running' ? t().open : t().read} variant="secondary" onPress={() => data.onReadAgent(run.agentId)} />,
      ],
      meta: (
        <Box flexDirection="row" columnGap={1}>
          {word === null ? null : (
            <Text color={word.color} bold>
              {word.text}
            </Text>
          )}
          {quiet === '' ? null : <Text color="warning">{quiet}</Text>}
          {denied === '' ? null : (
            <Text color="error" bold>
              {denied}
            </Text>
          )}
          <Text color="subtle" wrap="truncate-end">
            {fit(meta, metaRoom)}
          </Text>
        </Box>
      ),
      bar: bar(el, ms / 1000 / scale.secs, agentTone(run), barPx, alt, run.state === 'running'),
    })
  }

  const isActive = (run: AgentRun) => run.state === 'running' || run.state === 'idle'
  const active = listed.filter(isActive)
  const ended = listed.filter(run => !isActive(run))
  const caption = <Text color="subtle">{t().sharedScale(scale.label)}</Text>
  const aborted = folded.filter(run => run.state === 'aborted').length
  const foldLabel = `${isFoldOpen ? '▾' : '▸'} ${t().doneTitle} · ${folded.length}${aborted > 0 ? ` · ⊘${aborted} ${t().agentStates.aborted}` : ''}`
  const fold: RenderChildren[] =
    folded.length === 0
      ? []
      : [
          <Box flexDirection="row">
            <Button key="agents-fold" label={foldLabel} variant="secondary" onPress={() => data.onToggleFold?.()} />
          </Box>,
          ...(isFoldOpen ? folded.map(rowOf) : []),
        ]

  const activeCard = active.length === 0 ? [] : [frame(el, [headerOf(el, `${t().activeHeading} · ${active.length}`, undefined, caption), ...active.map(rowOf)])]
  const endedCard =
    ended.length === 0 && fold.length === 0
      ? []
      : [frame(el, [...(ended.length === 0 ? [] : [headerOf(el, `${t().endedHeading} · ${ended.length}`, undefined, active.length === 0 ? caption : null)]), ...ended.map(rowOf), ...fold])]

  const running = list.filter(run => run.state === 'running').length
  const finished = list.filter(run => run.state !== 'running' && run.state !== 'idle').length
  const returned = list.filter(run => run.state === 'done').length
  // Returned and not read yet: what still waits for you to verify it.
  const awaiting = listed.filter(run => run.state === 'done').length
  const kpiRow = kpis(el, [
    { label: t().runWord, value: String(running), color: 'permission', isZero: running === 0 },
    { label: t().returned, value: String(returned), color: 'text', isZero: returned === 0 },
    { label: t().kpiAwaiting, value: String(awaiting), color: 'warning', isZero: awaiting === 0 },
    { label: t().kpiAborted, value: String(list.filter(run => run.state === 'aborted').length), color: 'text', isZero: !list.some(run => run.state === 'aborted') },
  ])
  // Narrow: every agent a dot above the list, as many as fit beside the summary.
  const compact =
    widthTierOf(data.columns) === 'narrow'
      ? [
          frame(
            el,
            dots(
              el,
              [...list.filter(run => run.state === 'running'), ...list.filter(run => run.state !== 'running')].map(agentTone),
              Math.floor((pxWidth(data.columns - FRAME_CELLS, 0, 720) - 120) / 20),
              t().agentDotsAlt(running, finished),
              <Text>
                <Text color={TONE_KEYS.running} bold>{`${running}`}</Text>
                <Text color="subtle">{` ${t().runWord} · `}</Text>
                <Text bold>{`${finished}`}</Text>
                <Text color="subtle">{` ${t().doneWord}`}</Text>
              </Text>,
            ),
          ),
        ]
      : []

  return [kpiRow, ...compact, ...activeCard, ...endedCard]
}
