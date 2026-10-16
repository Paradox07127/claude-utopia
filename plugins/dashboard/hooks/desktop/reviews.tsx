import type { RenderChildren } from 'claude-code'

import type { DashConversation, DashDetail, MmModel, MmRun } from '../../types'
import { scaleOf } from '../desktop-svg'
import { t } from '../i18n'
import { capLeaf, elapsedSecs, fmtRunTokens, fmtSecs, listOf, runLabel, SEVERITIES } from '../runs'
import { activityText, runSession, taskOfModel } from '../tasks'
import { backRow, bar, card, chip, FRAME_CELLS, modelStatusOf, modelTone, pxWidth, widthTierOf } from './kit'
import type { El, PaneData } from './kit'

// A model row's columns, in layout columns: the name, the status, the time, the tokens; the bar takes the rest.
const NAME_COLUMNS = 8
const STATUS_COLUMNS = 10
const TIME_COLUMNS = 7
const TOKEN_COLUMNS = 9
const ROW_GAPS = 4
/** Runs shown before the older ones fold. */
const RUNS_SHOWN = 3
const FOLD_KEY = 'fold:runs'

/** The legend's severities, each square in its theme key. */
const LEGEND = [
  ['critical', 'error'],
  ['major', 'warning'],
  ['minor', 'subtle'],
] as const

export function runCards(el: El, data: PaneData) {
  const { Box, Button, Text } = el
  const snap = data.snap
  const unreadable = snap?.error === undefined ? [] : [<Text color="warning" wrap="truncate">{t().runsUnreadable(snap.error)}</Text>]

  if (snap === null || snap.runs.length === 0) {
    return unreadable.length > 0 ? unreadable : [<Text color="subtle">{snap === null ? t().loading : t().noRuns}</Text>]
  }

  const shownRuns = snap.runs.slice(0, data.paneRuns)
  const allKnown = shownRuns.flatMap(run => run.models.map(m => elapsedSecs(m, snap.polledAt)).filter((s): s is number => s !== undefined))
  const scale = scaleOf(Math.max(0, ...allKnown))
  const tier = widthTierOf(data.columns)
  const barPx = pxWidth(data.columns - FRAME_CELLS - NAME_COLUMNS - STATUS_COLUMNS - TIME_COLUMNS - TOKEN_COLUMNS - ROW_GAPS, 0, 360)
  const sessionId = data.sessionId ?? null
  const cell = (columns: number, child: RenderChildren) => (
    <Box width={columns} flexShrink={0}>
      {child}
    </Box>
  )

  const modelRow = (run: MmRun, model: MmModel) => {
    const task = taskOfModel(run, model, sessionId)
    const secs = elapsedSecs(model, snap.polledAt)
    const time = secs === undefined ? '' : fmtSecs(secs)
    const { text: statusText, color: statusColor } = modelStatusOf(model)
    const alt = t().modelBarAlt(task.provider, statusText, time, scale.label)
    const activity = activityText(task)

    const row = (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {cell(NAME_COLUMNS, <Text color="text" bold wrap="truncate-end">{task.provider}</Text>)}
        {cell(STATUS_COLUMNS, <Text color={statusColor} bold wrap="truncate-end">{statusText}</Text>)}
        {cell(TIME_COLUMNS, <Text color="text">{time}</Text>)}
        {cell(TOKEN_COLUMNS, <Text color="subtle">{fmtRunTokens(task.outputTokens)}</Text>)}
        {tier === 'narrow' ? null : secs === undefined ? (
          <Text color="subtle" wrap="truncate-end">{t().elapsedUnknown}</Text>
        ) : (
          // The desktop body can be a few columns narrower than `columns` says: what overruns the card is cut off.
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            {bar(el, secs / scale.secs, modelTone(model), barPx, alt, model.status === 'RUNNING')}
          </Box>
        )}
      </Box>
    )

    // The bar takes the row's rest at every width, so a running model's activity goes on a line of its own under the name.
    return activity === '' ? (
      row
    ) : (
      <Box flexDirection="column">
        {row}
        <Box paddingLeft={NAME_COLUMNS + 1}>
          <Text color="subtle" wrap="truncate-end">
            {activity}
          </Text>
        </Box>
      </Box>
    )
  }

  /** `■ Critical 0  ■ Major 2  ■ Minor 5` over the models' reviews, once the run's report is read. */
  const legend = (runid: string) => {
    const reviews = (data.reports[runid]?.models ?? []).flatMap(one => (one.review === undefined ? [] : [one.review]))

    if (reviews.length === 0) {
      return []
    }

    const count = (severity: string) => reviews.reduce((sum, review) => sum + review.findings.filter(one => one.severity === severity).length, 0)

    return [
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        {LEGEND.map(([severity, color]) => (
          <Text>
            <Text color={color}>■</Text>
            <Text color="subtle">{` ${t().severityLegend[severity]} `}</Text>
            <Text bold>{String(count(severity))}</Text>
          </Text>
        ))}
      </Box>,
    ]
  }

  const runCard = (run: MmRun) =>
    card(el, [
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Box flexDirection="row" columnGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
          <Box flexShrink={0}>
            <Text color="text" bold wrap="truncate-end">
              {runLabel(run)}
            </Text>
          </Box>
          <Text color="subtle" wrap="truncate-end">{`${run.mode || 'review'} · ${run.runid}`}</Text>
        </Box>
        <Button key={`read-run-${run.runid}`} label={t().read} variant="secondary" onPress={() => data.onReadRun(run.runid)} />
      </Box>,
      ...run.models.map(model => modelRow(run, model)),
      ...legend(run.runid),
    ])

  // Runs another session started fold under their own row, after the older ones; the rest keep their order.
  const ownRuns = shownRuns.filter(run => runSession(run, sessionId) !== false)
  const otherRuns = shownRuns.filter(run => runSession(run, sessionId) === false)
  const older = ownRuns.slice(RUNS_SHOWN)
  const isOlderOpen = data.disclosures?.has(FOLD_KEY) ?? false
  const fold =
    older.length === 0
      ? []
      : [
          <Box flexDirection="row">
            <Button key="runs-older" label={`${isOlderOpen ? '▾' : '▸'} ${t().runsOlder(older.length)}`} variant="secondary" onPress={() => data.onToggleDisclosure?.(FOLD_KEY)} />
          </Box>,
          ...(isOlderOpen ? older.map(runCard) : []),
        ]
  const isOthersOpen = data.isRunsFoldOpen === true
  const othersFold =
    otherRuns.length === 0
      ? []
      : [
          <Box flexDirection="row">
            <Button key="runs-fold" label={`${isOthersOpen ? '▾' : '▸'} ${t().otherSessionRuns(otherRuns.length)}`} variant="secondary" onPress={() => data.onToggleRunsFold?.()} />
          </Box>,
          ...(isOthersOpen ? otherRuns.map(runCard) : []),
        ]

  return [
    ...unreadable,
    <Text color="subtle">{t().elapsedCompare(scale.label)}</Text>,
    ...ownRuns.slice(0, RUNS_SHOWN).map(runCard),
    ...fold,
    ...othersFold,
  ]
}

/** The model's own transcript, oldest first: each entry's kind, a call's tool beside it, then its text; a call or result as code. */
function conversationRows(el: El, read: DashConversation | null): RenderChildren[] {
  const { Box, Code, Markdown, Text } = el

  if (read === null) {
    return [<Text color="subtle">{t().loading}</Text>]
  }

  if (read.items === null) {
    return [<Text color="warning">{t().conversationUnreadable}</Text>]
  }

  return [
    ...(read.dropped > 0 ? [<Text color="subtle">{t().conversationDropped(read.dropped)}</Text>] : []),
    ...read.items.map(item => (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text color="subtle">{t().conversationKinds[item.kind]}</Text>
          {item.tool === undefined ? null : ' '}
          {item.tool === undefined ? null : (
            <Text color="text" bold>
              {item.tool}
            </Text>
          )}
        </Text>
        {item.kind === 'call' || item.kind === 'result' ? <Code source={item.text} /> : <Markdown text={item.text} />}
      </Box>
    )),
  ]
}

/** One model's report at a time; a review one finding at a time, every Markdown and Code leaf cut to fit. */
export function reportReader(el: El, data: PaneData, open: Extract<DashDetail, { page: 'mmrun' }>) {
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
  const hasTranscript = run.models.find(one => one.name === model.name)?.transcriptPath !== undefined
  const view = hasTranscript ? (open.view ?? 'report') : 'report'
  const pickSeverity = (value: string) => {
    if ((value === 'all') !== open.showAll) {
      data.onToggleSeverity()
    }
  }
  const top = [
    ...head,
    <Box flexDirection={widthTierOf(data.columns) === 'narrow' ? 'column' : 'row'} columnGap={1} rowGap={1}>
      <Select key="dash-model" label={t().reportModel} options={report.models.map(one => ({ value: one.name }))} value={model.name} onSelect={name => data.onPickModel?.(name)} />
      {hasTranscript ? (
        <Select
          key="dash-view"
          label={t().reportView}
          options={[
            { value: 'report', label: t().viewReport },
            { value: 'conversation', label: t().viewConversation },
          ]}
          value={view}
          onSelect={value => data.onPickView?.(value === 'conversation' ? 'conversation' : 'report')}
        />
      ) : null}
      {review === undefined || view === 'conversation' ? null : (
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

  if (view === 'conversation') {
    const read = data.conversation?.runid === open.runid && data.conversation.model === model.name ? data.conversation : null

    return [...top, ...conversationRows(el, read)]
  }

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
