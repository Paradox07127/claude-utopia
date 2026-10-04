import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, HookFailure, On } from 'claude-code'

import type { AgentRun, MmRun, MmSnapshot } from '../types'
import { fmtDuration } from './agent-model'
import { card, chip, MODEL_GLYPHS, modelTone } from './desktop'
import { BAR, elapsedBar, scaleOf, TONE_KEYS } from './desktop-svg'
import type { Tone } from './desktop-svg'
import { failureLine } from './failures'
import { t } from './i18n'
import { elapsedSecs, fmtRunTokens, fmtSecs } from './runs'
import { SHAPE } from './shapes'
import { summarizeTests } from './summarize-tests'
import type { TestSummary } from './summarize-tests'
import { summarizeXcodebuild } from './xcodebuild'
import type { XcodeError, XcodeSummary } from './xcodebuild'

const expandedTask = { plugin: 'dashboard', key: 'expandedTask' } as const
const expandedTests = { plugin: 'dashboard', key: 'expandedTests' } as const
const runs = atom({ plugin: 'dashboard', key: 'runs' } as const, null as MmSnapshot | null, { shape: SHAPE })
const agents = atom({ plugin: 'dashboard', key: 'agents' } as const, [] as AgentRun[], { shape: SHAPE })

const MAX_FAILURES = 5
// A Markdown or Code leaf holds at most 10000 characters; a margin under it.
const LEAF_CHARS = 8000

const leaf = (text: string) => (text.length <= LEAF_CHARS ? text : `${text.slice(0, LEAF_CHARS - 1)}…`)

// An mmrun call at the start of the command, bare or path-qualified (`~/.claude/bin/mmrun wait …`).
const MMRUN = /^\s*(?:[^\s;&|]*\/)?mmrun\s+(.*)$/s
const RUNID_IN = /\b\d{8}-\d{6}-[0-9a-f]+\b/
// A foreground review/start/run/ask prints `RUN <rid>  models=…` as its first stdout line.
const RUN_LINE = /^RUN\s+(\d{8}-\d{6}-[0-9a-f]+)\b/m
// Rows that stand for a whole run; the rest (status, result, apply…) only look at it once.
const CARD_SUBS = ['review', 'start', 'run', 'ask', 'wait']
const START_SUBS = ['review', 'start', 'run', 'ask']
// Slash commands whose output carries mmrun's RUN line.
const MM_COMMANDS = ['mm:review', 'mm:run']

// The opening words of each guard's deny text; the sentence after the one the marker opens is the legal next step.
const GUARDS = [
  { marker: 'Blocked on the shared main worktree: `', title: () => t().guardGit, blocked: (op: string) => t().guardGitBlocked(op) },
  { marker: 'mm: *.raw is the full event stream', title: () => t().guardRaw, blocked: () => t().guardRawBlocked },
]

type AgentInput = { description?: unknown; prompt?: unknown; subagent_type?: unknown; run_in_background?: unknown; isolation?: unknown; model?: unknown }
type AgentOutput = {
  status?: unknown
  agentType?: unknown
  totalDurationMs?: unknown
  totalToolUseCount?: unknown
  toolStats?: { linesAdded?: unknown; linesRemoved?: unknown }
  worktreeBranch?: unknown
}

const asObject = <T,>(value: unknown): T | null => (typeof value === 'object' && value !== null ? (value as T) : null)

// An errored call's output is the text the model read; otherwise Bash's `{ stdout, stderr }`.
export const bashText = (output: unknown): string | null => {
  if (typeof output === 'string') return output
  const out = asObject<{ stdout?: unknown; stderr?: unknown }>(output)
  if (out === null || typeof out.stdout !== 'string') return null
  return typeof out.stderr === 'string' ? `${out.stdout}\n${out.stderr}` : out.stdout
}

const flagValue = (command: string, flag: string) => new RegExp(`(?:^|\\s)${flag}(?:=|\\s+)(\\S+)`).exec(command)?.[1]

const endHint = (run: MmRun) => t().ended(run.runid)
const isEnded = (run: MmRun) => run.models.length > 0 && run.models.every(model => model.status !== 'RUNNING')

/** The desktop card of one run: a row and an elapsed bar per model, every bar on the run's shared scale. */
function desktopRunCard(el: ElementTable<'desktop'>, run: MmRun, now: number) {
  const { Svg, Text } = el
  const known = run.models.map(model => elapsedSecs(model, now))
  const scale = scaleOf(Math.max(0, ...known.filter((secs): secs is number => secs !== undefined)))

  return card(el, [
    ...run.models.flatMap((model, i) => {
      const secs = known[i]
      const tone = modelTone(model)
      const time = secs === undefined ? '' : fmtSecs(secs)

      return [
        <Text wrap="truncate">
          <Text bold>{model.name}</Text> {chip(el, tone, `${MODEL_GLYPHS[tone]} ${model.status}`)}
          {time === '' ? '' : `  ${time}`}
          {'  '}
          <Text dimColor>{fmtRunTokens(model.outputTokens)}</Text>
        </Text>,
        secs === undefined ? (
          <Text dimColor>{t().elapsedUnknown}</Text>
        ) : (
          <Svg
            source={elapsedBar(secs, scale.secs, tone, model.status === 'RUNNING')}
            alt={t().barAlt(`${model.name} ${model.status}`, time, scale.label)}
            width={BAR.width}
            height={BAR.height}
          />
        ),
      ]
    }),
    isEnded(run) ? <Text dimColor>{endHint(run)}</Text> : null,
  ])
}

/** The live card of one run: the desktop card, or one line of models in the terminal. */
function runCard(surface: string, el: ElementTable, run: MmRun, now: number) {
  if (surface === 'desktop') return desktopRunCard(el as ElementTable<'desktop'>, run, now)
  const { Text } = el

  return (
    <Text wrap="truncate">
      {run.models.map((model, i) => {
        const tone = modelTone(model)
        const secs = elapsedSecs(model, now)
        const tail = [secs === undefined ? '' : ` ${fmtSecs(secs)}`, ` ${fmtRunTokens(model.outputTokens)}`].join('')

        return (
          <Text>
            {i === 0 ? '' : ' · '}
            <Text color={TONE_KEYS[tone]}>{`${model.name} ${MODEL_GLYPHS[tone]}`}</Text>
            {tail}
          </Text>
        )
      })}
      {isEnded(run) ? <Text dimColor>{`  ${endHint(run)}`}</Text> : null}
    </Text>
  )
}

const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const errorText = (error: XcodeError) => (error.loc === null ? error.message : `${error.loc}  ${error.message}`)
const errorLine = (error: XcodeError) => `  ${errorText(error)}`

/** Any failure sign fails a test run, whatever its counts say: the summary's, an errored call, a build that did not end ok. */
const isFailedRun = (summary: TestSummary, build: XcodeSummary | null, isErrored: boolean) =>
  summary.failed || (summary.fail ?? 0) > 0 || isErrored || (build !== null && build.verdict !== 'ok')

/** A failed run's failures; build errors stand in when no test is named. */
const failureLines = (summary: TestSummary, build: XcodeSummary | null, isFailed: boolean) =>
  !isFailed ? [] : summary.failures.length > 0 ? summary.failures : (build?.errors ?? []).map(errorText)

/** The head of a test run and, when it failed, its failures. */
function testCard(el: ElementTable, summary: TestSummary, build: XcodeSummary | null, isFailed: boolean) {
  const { Text } = el
  const lines = failureLines(summary, build, isFailed).map(line => `  ${line}`)
  const what = summary.unit === 'packages' ? t().packagesUnit : 'tests'
  const head = [`${isFailed ? '✗' : '✓'} ${what}`, `${summary.pass ?? '—'} pass`, summary.fail === null ? t().gateFailed : `${summary.fail} fail`, ...(build?.markers ?? [])].join(' · ')

  return [<Text color={TONE_KEYS[isFailed ? 'failed' : 'done']}>{head}</Text>, ...lines.slice(0, MAX_FAILURES).map(line => <Text wrap="truncate-end">{line}</Text>)]
}

/** The desktop head of a test run: verdict and counts on one row, and when it failed its first failures in a Code beneath. */
function desktopTestCard(el: ElementTable, summary: TestSummary, build: XcodeSummary | null, isFailed: boolean) {
  const { Box, Code, Text } = el
  const what = summary.unit === 'packages' ? t().packagesUnit : t().testsUnit
  const lines = failureLines(summary, build, isFailed)
  const markers = build?.markers ?? []

  return [
    <Box columnGap={1} flexWrap="wrap">
      <Text color={TONE_KEYS[isFailed ? 'failed' : 'done']} bold>
        {isFailed ? t().testsFailed(what) : t().testsPassed(what)}
      </Text>
      <Text color="text" bold>{`${summary.pass ?? '—'} pass`}</Text>
      <Text color={(summary.fail ?? 0) > 0 ? TONE_KEYS.failed : 'text'}>{`${summary.fail ?? '—'} fail`}</Text>
      {markers.length === 0 ? null : <Text color="subtle">{markers.join(' · ')}</Text>}
    </Box>,
    lines.length === 0 ? null : <Code source={leaf(lines.slice(0, MAX_FAILURES).join('\n'))} />,
  ]
}

/** A build that is not a test summary: ✓ only when a SUCCEEDED marker stands and nothing failed. */
function buildCard(el: ElementTable, build: XcodeSummary) {
  const { Text } = el
  const warnings = build.warnings > 0 ? [counted(build.warnings, 'warning')] : []
  const counts = [
    ...(build.errorCount > 0 ? [counted(build.errorCount, 'error')] : []),
    ...(build.failedCommands === null ? [] : [counted(build.failedCommands, 'failed command')]),
    ...warnings,
  ]
  const rest = build.errorCount - MAX_FAILURES
  const truncation = build.truncation === 'preview' ? t().previewOnly : build.truncation === 'partial' ? t().partialOutput : null
  const head =
    build.verdict === 'ok' ? (
      <Text>
        <Text color={TONE_KEYS.done}>{[`✓ ${build.tool}`, ...build.markers].join(' · ')}</Text>
        {warnings.length === 0 ? null : <Text dimColor>{` · ${warnings[0]}`}</Text>}
      </Text>
    ) : (
      <Text color={TONE_KEYS.failed}>{[`✗ ${build.tool}`, ...build.markers, ...counts].join(' · ')}</Text>
    )

  return [
    head,
    ...build.errors.slice(0, MAX_FAILURES).map(error => <Text wrap="truncate-end">{errorLine(error)}</Text>),
    rest > 0 ? <Text dimColor>{`  ${t().moreLines(rest)}`}</Text> : null,
    truncation === null ? null : <Text dimColor>{truncation}</Text>,
  ]
}

/** An Agent call's state on the desktop in words, and its theme key. */
function callState(tone: Tone, isDispatched: boolean, isInterrupted: boolean): { text: string; color: string } {
  if (isDispatched) return { text: `▸ ${t().dispatched}`, color: 'inactive' }
  if (isInterrupted) return { text: t().modelStatusCancelled, color: TONE_KEYS.stale }
  if (tone === 'running') return { text: `● ${t().runWord}`, color: TONE_KEYS.running }

  return tone === 'done' ? { text: `✓ ${t().returned}`, color: TONE_KEYS.done } : { text: `✗ ${t().agentStates.error}`, color: TONE_KEYS.failed }
}

/** A hook's `.catch`: its failure to the debug log, once per hook this load. Declared per file: validate follows $ into this file's functions only. */
function hookFailed($: EngineInterface, name: string, error: HookFailure): void {
  const line = failureLine(name, error)

  if (line !== undefined) {
    $.ui.log(line, { to: 'debug' })
  }
}

export function registerTranscript(on: On): void {
  on('ui.render', { component: 'ToolUse', props: { tool: 'Agent' } }, async ($, e, next) => {
    const input = asObject<AgentInput>(e.props.input)
    if (input === null || typeof input.description !== 'string') return next(e)

    const id = e.props.tool_use_id
    const isOpen = (await read($, { ...expandedTask, id })) === true
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const tone: Tone = e.props.isRunning ? 'running' : e.props.isErrored || e.props.isInterrupted ? 'failed' : 'done'
    // A background call returns as soon as the agent starts: done here means dispatched, not finished.
    const isDispatched = input.run_in_background === true && tone === 'done'
    const glyph = isDispatched ? '▸' : tone === 'running' ? '●' : tone === 'done' ? '✓' : '✗'
    const kind = typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose'
    const tags = [
      input.run_in_background === true ? t().background : '',
      input.isolation === 'worktree' ? 'worktree' : '',
      typeof input.model === 'string' ? `model ${input.model}` : '',
    ].filter(tag => tag !== '')
    const prompt = typeof input.prompt === 'string' ? input.prompt : ''
    const onTask = () => update($, { ...expandedTask, id }, v => v !== true)

    if (e.surface === 'desktop') {
      const state = callState(tone, isDispatched, e.props.isInterrupted)
      const meta = [
        input.run_in_background === true ? t().background : '',
        input.isolation === 'worktree' ? 'worktree' : '',
        typeof input.model === 'string' ? input.model : '',
      ].filter(tag => tag !== '')

      return (
        <Box flexDirection="column" gap={1}>
          <Text bold wrap="wrap">{`${kind} · ${input.description}`}</Text>
          <Box columnGap={1} flexWrap="wrap">
            <Text color={state.color}>{state.text}</Text>
            {meta.length === 0 ? null : <Text color="subtle">{meta.join(' · ')}</Text>}
          </Box>
          {prompt === '' ? null : <Button key="task" label={isOpen ? t().hideTask : t().showTask} variant="secondary" onPress={onTask} />}
          {isOpen && prompt !== '' ? <Markdown text={leaf(prompt)} /> : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box columnGap={1}>
          <Text wrap="truncate">
            <Text color={isDispatched ? 'inactive' : TONE_KEYS[tone]}>{glyph}</Text> <Text bold>{`${kind} · ${input.description}`}</Text>
            {tags.length === 0 ? null : <Text dimColor>{`  ${tags.join(' · ')}`}</Text>}
          </Text>
          {prompt === '' ? null : <Button key="task" label={t().task} onPress={onTask} />}
        </Box>
        {isOpen && prompt !== '' ? <Markdown text={prompt} /> : null}
      </Box>
    )
  }).catch(($, e, next) => {
    hookFailed($, 'ui.render ToolUse Agent', next.error)

    return next(e)
  })

  on('ui.render', { component: 'ToolResult', props: { tool: 'Agent' } }, async ($, e, next) => {
    const out = asObject<AgentOutput>(e.props.output)
    const duration = out?.totalDurationMs
    const tools = out?.totalToolUseCount
    const isLaunched = out?.status === 'async_launched' || out?.status === 'remote_launched'
    // Older transcripts carry no status: the two totals alone mark a completed call.
    const isCompleted = (out?.status === 'completed' || out?.status === undefined) && typeof duration === 'number' && typeof tools === 'number'
    if (out === null || (!isLaunched && !isCompleted)) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    // Reading the agents atom subscribes this row, so a later denial redraws it.
    const run = (await read($, agents))?.find(one => one.toolUseId === e.props.tool_use_id)
    const name = typeof out.agentType === 'string' ? out.agentType : (run?.subagentType ?? t().agentFallback)

    if (isLaunched) {
      return e.surface === 'desktop' ? (
        <Box flexDirection="column" gap={1}>
          <Box columnGap={1} flexWrap="wrap">
            <Text color="inactive">{`▸ ${t().dispatched}`}</Text>
            <Text color="subtle">{name}</Text>
          </Box>
          {await next(e)}
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color="inactive" wrap="truncate">{`▸ ${name} ${t().dispatched}`}</Text>
          {await next(e)}
        </Box>
      )
    }

    if (!isCompleted) return next(e)

    const stats = out.toolStats
    const lines = typeof stats?.linesAdded === 'number' && typeof stats.linesRemoved === 'number' ? [`+${stats.linesAdded} −${stats.linesRemoved}`] : []
    const metrics = [fmtDuration(duration), `${tools} tools`, ...lines]
    const head = e.props.isErrored ? t().agentErrored(name) : [t().agentReturned(name), ...metrics].join(' · ')
    const branch = typeof out.worktreeBranch === 'string' ? out.worktreeBranch : ''
    const denied = run?.denied ?? 0

    if (e.surface === 'desktop') {
      return (
        <Box flexDirection="column" gap={1}>
          {e.props.isErrored ? (
            <Text color={TONE_KEYS.failed} bold>
              {head}
            </Text>
          ) : (
            [
              <Box columnGap={1} flexWrap="wrap">
                <Text color={TONE_KEYS.done} bold>{`✓ ${t().returned}`}</Text>
                <Text color={TONE_KEYS.stale}>{t().unverified}</Text>
                <Text color="subtle">{name}</Text>
              </Box>,
              <Text color="text">{metrics.join(' · ')}</Text>,
            ]
          )}
          {branch === '' ? null : <Text color="subtle">{branch}</Text>}
          {denied > 0 ? (
            <Text color={TONE_KEYS.failed} bold>
              {t().denied(denied)}
            </Text>
          ) : null}
          {await next(e)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text color={TONE_KEYS[e.props.isErrored ? 'failed' : 'done']}>{head}</Text>
          {denied > 0 ? <Text color={TONE_KEYS.failed}>{` · ${t().denied(denied)}`}</Text> : null}
          {branch === '' ? null : <Text dimColor>{` · ${branch}`}</Text>}
        </Text>
        {await next(e)}
      </Box>
    )
  }).catch(($, e, next) => {
    hookFailed($, 'ui.render ToolResult Agent', next.error)

    return next(e)
  })

  on('ui.render', { component: 'ToolUse', props: { tool: 'Bash', input: { command: MMRUN } } }, async ($, e, next) => {
    const input = asObject<{ command?: unknown; run_in_background?: unknown }>(e.props.input)
    const command = typeof input?.command === 'string' ? input.command : ''
    const rest = MMRUN.exec(command)?.[1] ?? ''
    const sub = /^([a-z][a-z-]*)(?:\s|$)/.exec(rest)?.[1]
    if (sub === undefined) return next(e)

    // A heading over the engine's own row, which keeps the command and its output.
    const { Box, Text } = $.ui.resolve(e)
    const models = flagValue(rest, '--models')
    const model = flagValue(rest, '--model')
    const points = [RUNID_IN.exec(rest)?.[0], models === undefined ? undefined : `models ${models}`, model === undefined ? undefined : `model ${model}`].filter(
      (part): part is string => part !== undefined,
    )
    const isWaiting = sub === 'wait' && input?.run_in_background === true

    // Reading the runs atom subscribes this row, so each poll redraws the card.
    const runid = CARD_SUBS.includes(sub) ? (RUNID_IN.exec(rest)?.[0] ?? RUN_LINE.exec(bashText(e.props.output) ?? '')?.[1]) : undefined
    const snap = runid === undefined ? null : ((await read($, runs)) ?? null)
    const run = snap?.runs.find(one => one.runid === runid)
    let status = null

    if (snap !== null && run !== undefined) {
      status = runCard(e.surface, $.ui.resolve(e), run, snap.polledAt)
    } else if (runid !== undefined && START_SUBS.includes(sub) && !e.props.isRunning) {
      status = <Text dimColor>{t().waitingStatus}</Text>
    }

    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text bold>{`mmrun ${sub}`}</Text>
          {points.length === 0 ? null : <Text>{`  ${points.join(' · ')}`}</Text>}
          {isWaiting ? <Text dimColor>{`  ${t().waitingInBackground}`}</Text> : null}
        </Text>
        {status}
        {await next(e)}
      </Box>
    )
  }).catch(($, e, next) => {
    hookFailed($, 'ui.render ToolUse Bash mmrun', next.error)

    return next(e)
  })

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const runid = MM_COMMANDS.includes(e.props.command) ? RUN_LINE.exec(e.props.text)?.[1] : undefined
    if (runid === undefined) return next(e)

    const el = $.ui.resolve(e)
    const { Box, Text } = el
    const output = await next(e)
    // Reading the runs atom subscribes this row, so each poll redraws the card.
    const snap = (await read($, runs)) ?? null
    const run = snap?.runs.find(one => one.runid === runid)

    return (
      <Box flexDirection="column">
        {output}
        {snap !== null && run !== undefined ? runCard(e.surface, el, run, snap.polledAt) : <Text dimColor>{t().waitingMmrun}</Text>}
      </Box>
    )
  }).catch(($, e, next) => {
    hookFailed($, 'ui.render CommandOutput', next.error)

    return next(e)
  })

  on('ui.render', { component: 'ToolResult', props: { tool: 'Bash', isErrored: true } }, async ($, e, next) => {
    const text = bashText(e.props.output)
    const guard = text === null ? undefined : GUARDS.find(one => text.includes(one.marker))
    if (text === null || guard === undefined) return next(e)

    const from = text.slice(text.indexOf(guard.marker))
    const step = from.split('. ')[1]?.trim() ?? ''
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)

    if (e.surface === 'desktop') {
      const id = e.props.tool_use_id
      const isOpen = (await read($, { ...expandedTests, id })) === true
      // The command runs from the backtick that ends the marker to the next one.
      const op = guard.marker.endsWith('`') ? (from.slice(guard.marker.length).split('`')[0] ?? '') : ''
      const cut = from.indexOf('. ')
      const explanation = cut < 0 ? '' : from.slice(cut + 2).trim()

      return (
        <Box flexDirection="column" gap={1}>
          <Text color={TONE_KEYS.failed} bold wrap="wrap">
            {guard.blocked(op)}
          </Text>
          {explanation === '' ? null : <Text bold>{t().allowedNextStep}</Text>}
          {explanation === '' ? null : explanation.includes('\n\n') ? <Markdown text={leaf(explanation)} /> : <Text wrap="wrap">{leaf(explanation)}</Text>}
          <Button key="raw" label={isOpen ? t().hideRawResult : t().showRawResult} variant="secondary" onPress={() => update($, { ...expandedTests, id }, v => v !== true)} />
          {isOpen ? await next(e) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text color={TONE_KEYS.failed} wrap="truncate">{`✗ ${guard.title()}`}</Text>
        {step === '' ? null : <Text dimColor>{step}</Text>}
        {await next(e)}
      </Box>
    )
  }).catch(($, e, next) => {
    hookFailed($, 'ui.render ToolResult Bash errored', next.error)

    return next(e)
  })

  // Registered after the guard hook so a guard denial keeps its own head.
  on('ui.render', { component: 'ToolResult', props: { tool: 'Bash' } }, async ($, e, next) => {
    const text = bashText(e.props.output)
    const summary = text === null ? null : summarizeTests(text)
    const build = text === null ? null : summarizeXcodebuild(text)
    if (summary === null && build === null) return next(e)

    const id = e.props.tool_use_id
    const isOpen = (await read($, { ...expandedTests, id })) === true
    const el = $.ui.resolve(e)
    const { Box, Button } = el
    const isFailed = summary !== null && isFailedRun(summary, build, e.props.isErrored)
    const onFull = () => update($, { ...expandedTests, id }, v => v !== true)

    if (e.surface === 'desktop' && summary !== null) {
      return (
        <Box flexDirection="column" gap={1}>
          {desktopTestCard(el, summary, build, isFailed)}
          <Button key="full" label={isOpen ? t().hideOutput : t().showOutput} variant="secondary" onPress={onFull} />
          {isOpen ? await next(e) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {summary === null ? buildCard(el, build!) : testCard(el, summary, build, isFailed)}
        <Button key="full" label={t().fullOutput} onPress={onFull} />
        {isOpen ? await next(e) : null}
      </Box>
    )
  }).catch(($, e, next) => {
    hookFailed($, 'ui.render ToolResult Bash', next.error)

    return next(e)
  })
}
