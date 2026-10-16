import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { FsEntry, On, RenderInput, SessionStartInput } from 'claude-code'

import { progressLines, usageLines } from '../hooks/board'
import type { Line } from '../hooks/board'
import { drawDesktopPane } from '../hooks/desktop'
import type { PaneData } from '../hooks/desktop'
import { setLang } from '../hooks/i18n'
import { reportOf, reviewOf } from '../hooks/runs'
import { drawHotspotsDesktop, drawTimelineDesktop, hotspotLines, timelineLines } from '../hooks/timeline-view'
import { drawEventsDesktop, eventLines } from '../hooks/timeline-view'
import { timelineBody } from '../hooks/desktop/timeline'
import { groupEvents, parseLedger } from '../hooks/events'
import { foldBoard, foldLines, foldRequests } from '../hooks/progress'
import { emptyDay, lastDays, requestNoted, skillNoted, weekOf } from '../hooks/usage'
import type { GpuFill } from '../hooks/desktop/gpu'
import { FILL, MEMORY, TRACK } from '../hooks/desktop-svg'
import type { AgentRun, BoardEvent, BoardNode, BoardRead, ConversationItem, DashReport, GateRun, GpuWatch, RequestFields, TimelineTurn, UsageDay, WorktreeInfo } from '../types'
import { withClocks } from './clocks'
import { widthOf } from '../hooks/agent-model'
import { colorsOf, linesOf, textOf } from './hooks-kit'

// Theme keys follow the host's light or dark theme; a color name or a hex is fixed and vanishes on one of them.
const THEME_KEYS = ['text', 'inverseText', 'inactive', 'subtle', 'promptBorder', 'success', 'error', 'warning', 'permission', 'suggestion', 'claude']
const COLOR_PROPS = ['color', 'backgroundColor', 'borderColor']
const WHITE = /#f{3,4}(?![0-9a-f])|#f{6}(?:f{2})?(?![0-9a-f])|white/i

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const LANGS = ['zh-CN', 'en'] as const
type Lang = (typeof LANGS)[number]
const HAN = /\p{Script=Han}/u
// `${surface}/${where}` drawn by board.ts or desktop.tsx, whose strings are not in i18n.ts yet: no Han check under en.
const PENDING_EN = new Set<string>()

const PLUGIN = 'dashboard'
const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const BOTTOM = { type: 'Text', props: {}, children: ['engine band'] }
const NOW = 1_790_922_800_000
const ROOT = '/h/.claude/mmruns'
const R1 = '20261002-010000-aaaa'
const R3 = '20261002-005000-cccc'

const BAND: RenderInput<'AbovePrompt'> = {
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 19 }, view: {} },
}

const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: 'dashboard',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: { title: '工作台', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}

const command = (name: string, args = '') => ({
  command: name,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 180 },
})

const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'do it',
  description: 'Build mm plugin',
  subagentType: 'worker',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
}

const USAGE_IN = { input_tokens: 2_000, output_tokens: 300, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 1_000, model: 'claude-opus-5-5' }
const complete = (agentId: string, reason: string) => ({ answer: 'report', durationMs: 1_000, isAborted: false, turnId: 't', agentId, reason, usage: USAGE_IN }) as never
/** A running subagent's transcript as `$.session.messages({ agentId })` gives it. */
const AGENT_ROWS = [
  { role: 'user', text: 'Fix the band', toolUses: [] },
  { role: 'assistant', text: 'Found it.', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: '/w/board.ts' } }] },
]

/** Runs a turn.step stream to its end. */
async function drain(stream: AsyncGenerator<unknown, unknown>): Promise<void> {
  while ((await stream.next()).done !== true) {}
}

const NVIDIA_RUN = ['@@NVSMI', '0, NVIDIA GeForce RTX 4090, 52, 18636, 24564, 67, 280.45', '@@APPS', '4242, /usr/bin/python3, 10240'].join('\n')
const BUN_FAIL = ['(pass) a [1ms]', '(fail) b > breaks [2ms]', '', ' 22 pass', ' 2 fail'].join('\n')
const BUN_OK = ['(pass) a [1ms]', '', ' 24 pass', ' 0 fail'].join('\n')
// Swift Testing failure lines with no total line: the pass count is unknown.
const ST_FAILED_ONLY = 'Test "x" failed after 0.010 seconds with 1 issue.'
const BUILD_FAILED = [1, 2, 3, 4, 5, 6].map(n => `/work/App/A.swift:${n}:5: error: cannot find x${n} in scope`).join('\n') + '\n** BUILD FAILED **'
const GUARD_RAW ='mm: *.raw is the full event stream (tens of thousands of tokens); do not read it. Use `mmrun status <RUNID>` for status and `mmrun result <model> <RUNID>` for findings.'
const GUARD_GIT =
  'Blocked on the shared main worktree: `git checkout` would take away uncommitted changes from other sessions or the user. Undo your own edit with a reverse Edit; for a clean baseline open a temporary worktree. Linked worktrees are exempt.'
// go test without -v: only packages are counted.
const GO_OK = ['ok  \texample.com/a\t0.01s', 'ok  \texample.com/b\t(cached)'].join('\n')

type Files = Record<string, { text: string; mtimeMs?: number }>

const runMeta = (runid: string, tag: string, models: string) =>
  `runid=${runid}\nworkdir=/work/proj\ntag=${tag}\nmodels=${models}\nmode=review\nschema=\nwt=\nsession=x\n`

/** R1: codex RUNNING (pid 111), grok DONE; R3: agy FAIL:1, kimi STALE. */
function mmruns(): Files {
  return {
    [`${R1}/run.meta`]: { text: runMeta(R1, 'design', 'codex,grok'), mtimeMs: NOW - 300_000 },
    [`${R1}/codex.status`]: { text: 'RUNNING\n' },
    [`${R1}/codex.started`]: { text: `${(NOW - 252_000) / 1000}\n` },
    [`${R1}/codex.pid`]: { text: '111\n' },
    [`${R1}/grok.status`]: { text: 'DONE\n', mtimeMs: NOW - 120_000 },
    [`${R1}/grok.started`]: { text: `${(NOW - 422_000) / 1000}\n` },
    [`${R1}/grok.meta`]: { text: 'session_id=s\nsecs=302\nexit=0\nattempts=1\nusage={"input_tokens":1,"output_tokens":25835}\n' },
    [`${R3}/run.meta`]: { text: runMeta(R3, '', 'agy,kimi'), mtimeMs: NOW - 4_000_000 },
    [`${R3}/agy.status`]: { text: 'FAIL:1\n', mtimeMs: NOW - 3_600_000 },
    [`${R3}/agy.started`]: { text: `${(NOW - 3_700_000) / 1000}\n` },
    [`${R3}/agy.meta`]: { text: 'secs=100\nexit=1\n' },
    [`${R3}/kimi.status`]: { text: 'STALE\n', mtimeMs: NOW - 3_500_000 },
    [`${R3}/kimi.started`]: { text: `${(NOW - 3_800_000) / 1000}\n` },
  }
}

/**
 * What the engine refuses once set: listing ~/.claude/mmruns, the GPU probe, and a subagent's transcript;
 * `replies`, stdout by argv for the commands not the default empty; `guardMtimeMs`, ~/.claude/harness/guard.jsonl's mtime, null for none.
 */
type Faults = { list: string | null; probe: string | null; messages: string | null; replies: Record<string, string>; guardMtimeMs: number | null }

const GUARD = '/h/.claude/harness/guard.jsonl'
/** <model>.events.jsonl's first line, naming the session that ran mmrun. */
const taskStarted = (session: string) => JSON.stringify({ type: 'task_started', ts: NOW, task_id: 'x', provider: 'codex', mode: 'review', description: 'design', claude_session: session })
const TASK_PROGRESS = JSON.stringify({ type: 'task_progress', ts: NOW, task_id: 'x', usage: { tool_uses: 3 }, last_tool_name: 'Read board.ts', summary: 'reading' })
const WT = '/r/.claude/worktrees/agent-a'
const blocked = (decision: string, op: string, cwd: string | null, agentId: string | null) =>
  JSON.stringify({ at: NOW - 90_000, guard: 'shared-tree-git', decision, op, cwd, agent_id: agentId })
/** One linked worktree with a change and two commits ahead; two deny blocks in guard.jsonl. */
const BLOCKS_AND_TREES = {
  [`tail -c 65536 ${GUARD}`]: [blocked('deny', 'git stash', '/r', null), blocked('deny', 'git checkout', WT, 'abcdef0123456789')].join('\n'),
  'git -C /r worktree list --porcelain': `worktree /r\nHEAD ${'1'.repeat(40)}\nbranch refs/heads/main\n\nworktree ${WT}\nHEAD ${'2'.repeat(40)}\nbranch refs/heads/worktree-agent-a\n`,
  [`git -C ${WT} status --porcelain`]: ' M a.ts\n',
  [`git -C ${WT} rev-list --left-right --count main...HEAD`]: '0\t2\n',
}

const SESSIONS = '/h/.claude/dashboard/sessions'
const peerFile = (id: string, name: string, state: string, more: Record<string, unknown> = {}) =>
  JSON.stringify({ id, name, title: 'fix the band', state, since: NOW - 65_000, turnStartedAt: NOW - 200_000, updatedAt: NOW, ...more })
/** Other sessions in each state the overview lists: failed, asking a permission, replied, working. */
const PEER_FILES = {
  'p1.json': peerFile('p1', 'mm', 'failed'),
  'p2.json': peerFile('p2', 'ui', 'permission', { detail: 'Bash' }),
  'p3.json': peerFile('p3', 'web', 'replied', { detail: 'done' }),
  'p4.json': peerFile('p4', 'api', 'working'),
}

/** The engine beneath the plugin, in memory: mmruns under ~/.claude/mmruns, pid 111 alive, an nvidia host sending a pass every 3 s on `clock`; `sessions` under ~/.claude/dashboard/sessions. */
function seat(on: On, files: Files, sessions: Record<string, string> = {}, clock?: MockClock): Faults {
  const faults: Faults = { list: null, probe: null, messages: null, replies: {}, guardMtimeMs: null }
  const panes = new Set<string>()
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  let spawned = 0

  mock.env(on, { HOME: '/h' })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    panes.add(e.id)

    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', ($, e) => (e.argv[0] === 'kill' ? { value: { ...ok('').value, exitCode: e.argv[2] === '111' ? 0 : 1 } } : ok(faults.replies[e.argv.join(' ')] ?? '')))
  // The GPU ssh: a pass every 3 s until the probe fault is set, then that line on stderr and exit 255.
  on('process.spawn', async function* ($, e, next) {
    const isEnded = new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))

    while (!next.signal.aborted) {
      if (faults.probe !== null) {
        yield { stream: 'stderr' as const, text: `${faults.probe}\n` }

        return { value: { code: 255, signal: null } } as never
      }

      yield { stream: 'stdout' as const, text: `${NVIDIA_RUN}\n@@END\n` }
      await Promise.race([clock?.sleep(3_000) ?? isEnded, isEnded])
    }

    return { value: { code: null, signal: 'SIGTERM' } } as never
  })
  on('fs.list', ($, e) => {
    if (e.path === ROOT && faults.list !== null) {
      return { deny: faults.list }
    }

    if (e.path === SESSIONS) {
      return { value: Object.entries(sessions).map(([name, text]) => ({ name, kind: 'file', size: text.length, mtimeMs: NOW, isLink: false }) as FsEntry) }
    }

    const rel = e.path === ROOT ? '' : e.path.slice(ROOT.length + 1)
    const names = new Map<string, FsEntry>()

    for (const [path, file] of Object.entries(files)) {
      const [dir, name] = path.split('/') as [string, string]

      if (rel === '') {
        names.set(dir, { name: dir, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
      } else if (dir === rel) {
        names.set(name, { name, kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs ?? NOW - 1000, isLink: false })
      }
    }

    return names.size > 0 ? { value: [...names.values()] } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', ($, e) => {
    if (e.path === GUARD && faults.guardMtimeMs !== null) {
      return { value: { kind: 'file', size: 1, mtimeMs: faults.guardMtimeMs, isLink: false } }
    }

    const file = files[e.path.slice(ROOT.length + 1)]

    return file ? { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs ?? NOW - 1000, isLink: false } } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.read', ($, e) => {
    const peer = sessions[e.path.slice(SESSIONS.length + 1)]

    if (e.path.startsWith(`${SESSIONS}/`) && peer !== undefined) {
      return { value: peer }
    }

    const file = files[e.path.slice(ROOT.length + 1)]

    return file ? { value: file.text } : { deny: `ENOENT ${e.path}` }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('settings.read', () => ({ value: {} }))
  on('agent.spawn', () => {
    spawned += 1

    return { model: 'claude-opus-5-5', agentId: `a${spawned}` }
  })
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  // A request that asks for one Bash call: the turn goes on with the tool running.
  on('turn.step', async function* ($, e) {
    yield { kind: 'tool', index: 0, id: 'toolu_tl', name: 'Bash' }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Bash', input: {} }], stopReason: 'tool_use', usage: USAGE_IN }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('session.messages', () => ({ value: faults.messages === null ? AGENT_ROWS : { deny: faults.messages } }) as never)
  // AskUserQuestion is drawn by exactly one engine node: core's own dialog.
  on('ui.render', { component: 'AskUserQuestion' }, () => ({ type: 'engine', ref: 0 }) as never)
  on('ui.render', () => BOTTOM as never)

  return faults
}

/**
 * a1 failed, a2 returned, a3 running a Bash call, a4 aborted; the mmruns polled; two failed gates, one with no pass count,
 * from a worktree the root lists; GPUs on `lab-box` sampled; a main turn running a Bash call.
 */
async function busy($: Engine, on: On) {
  const clock = mock.clock(on, { now: NOW })
  const faults = seat(on, mmruns(), {}, clock)

  // A gate from a worktree needs you only while the root still lists that worktree.
  on('session.root', () => ({ value: '/r' }))
  faults.replies = { 'git -C /r worktree list --porcelain': `worktree /r\nHEAD ${'1'.repeat(40)}\nbranch refs/heads/main\n\nworktree /r/.claude/worktrees/agent-wt\nHEAD ${'2'.repeat(40)}\nbranch refs/heads/worktree-agent-wt\n` }
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 'm1' })
  await drain($.turn.step({ turnId: 'm1', index: 0, model: 'claude-opus-5-5', messageCount: 2 }))
  await clock.advance(3_000)

  for (let i = 0; i < 4; i += 1) {
    await $.agent.spawn(SPAWN as never)
  }

  await drain($.turn.step({ turnId: 'c3', index: 0, agentId: 'a3', model: 'claude-opus-5-5', messageCount: 2 } as never))

  await $.turn.complete(complete('a1', 'error'))
  await $.turn.complete(complete('a2', 'answer'))
  await $.turn.complete(complete('a4', 'aborted'))
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_response: { stdout: BUN_FAIL, stderr: '', interrupted: false }, tool_use_id: 'toolu_g', cwd: '/work' } as never)
  await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'swift test' }, tool_use_id: 'toolu_s', error: `Exit code 1\n${ST_FAILED_ONLY}`, cwd: '/r/.claude/worktrees/agent-wt' } as never)
  await $.command.run(command('gpu', 'lab-box'))
  await clock.settle()

  /** ~/.claude/mmruns and the GPU host stop answering: the pages keep the last data, marked stale. */
  const fail = async () => {
    faults.list = 'EACCES: permission denied'
    faults.probe = 'ssh: connect to host lab-box port 22: Connection refused'
    await clock.advance(3_000)
  }

  return Object.assign(fail, { faults })
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

/** Every color outside the theme keys, every interactive Svg and every white in an Svg of a drawn tree. */
function offenders(node: unknown, where: string, out: string[] = []): string[] {
  if (node === null || typeof node !== 'object') {
    return out
  }

  const el = node as Node
  const props = el.props ?? {}

  for (const name of COLOR_PROPS) {
    const value = props[name]

    if (value !== undefined && !THEME_KEYS.includes(String(value))) {
      out.push(`${where}: ${el.type}.${name}=${String(value)}`)
    }
  }

  if (el.type === 'Svg') {
    if (props.isInteractive !== undefined) {
      out.push(`${where}: Svg.isInteractive`)
    }

    if (WHITE.test(String(props.source))) {
      out.push(`${where}: Svg.source has white`)
    }
  }

  for (const child of el.children ?? []) {
    offenders(child, where, out)
  }

  return out
}

/** offenders, plus under en any Han anywhere in the tree outside PENDING_EN. */
function check(node: unknown, where: string, surface: Surface, lang: Lang, out: string[] = []): string[] {
  offenders(node, where, out)

  if (lang === 'en' && !PENDING_EN.has(`${surface}/${where}`) && HAN.test(JSON.stringify(node))) {
    out.push(`${where}: Han under en`)
  }

  return out
}

const useRow = (id: string, tool: string, input: unknown, state: { isRunning?: boolean; isErrored?: boolean } = {}) => ({
  component: 'ToolUse' as const,
  requestId: id,
  props: { tool_use_id: id, tool, input, isRunning: state.isRunning ?? false, isErrored: state.isErrored ?? false, isInterrupted: false },
})

const resultRow = (id: string, tool: string, output: unknown, isErrored = false) => ({
  component: 'ToolResult' as const,
  requestId: id,
  props: { tool_use_id: id, tool, output, isErrored },
})

const AGENT_INPUT = { subagent_type: 'worker', description: 'Fix X', prompt: 'do it', run_in_background: true }
const AGENT_OUTPUT = { agentType: 'worker', totalDurationMs: 245_000, totalToolUseCount: 30, toolStats: { linesAdded: 1, linesRemoved: 2 }, worktreeBranch: 'wt' }

const ROWS = [
  useRow('agent_running', 'Agent', AGENT_INPUT, { isRunning: true }),
  useRow('agent_failed', 'Agent', AGENT_INPUT, { isErrored: true }),
  useRow('agent_done', 'Agent', AGENT_INPUT),
  resultRow('agent_returned', 'Agent', AGENT_OUTPUT),
  resultRow('agent_errored', 'Agent', AGENT_OUTPUT, true),
  useRow('mmrun_wait', 'Bash', { command: `mmrun wait ${R1}` }, { isRunning: true }),
  useRow('mmrun_ended', 'Bash', { command: `mmrun wait ${R3}` }),
  resultRow('tests_failed', 'Bash', { stdout: BUN_FAIL, stderr: '', interrupted: false }),
  resultRow('tests_passed', 'Bash', { stdout: BUN_OK, stderr: '', interrupted: false }),
  resultRow('guard', 'Bash', GUARD_RAW, true),
  resultRow('build_failed', 'Bash', { stdout: BUILD_FAILED, stderr: '', interrupted: false }),
  resultRow('build_ok', 'Bash', { stdout: '/work/App/A.swift:3:5: warning: unused\n** BUILD SUCCEEDED **', stderr: '', interrupted: false }),
  resultRow('build_failed_commands', 'Bash', { stdout: 'The following build commands failed:\n\tCodeSign /work/App.app\n(1 failure)', stderr: '', interrupted: false }),
  resultRow('build_preview', 'Bash', `<persisted-output>\nPreview (first 2KB):\n${BUILD_FAILED}\n...\n</persisted-output>`),
  resultRow('tests_unknown_pass', 'Bash', { stdout: ST_FAILED_ONLY, stderr: '', interrupted: false }),
  resultRow('tests_marker', 'Bash', { stdout: 'Test run with 4 tests in 1 suite passed after 0.1 seconds.\n** TEST FAILED **', stderr: '', interrupted: false }),
  resultRow('open_progress', 'mcp__dashboard__open_progress', [{ type: 'text', text: 'opened' }]),
]

const T0 = NOW - 96_000
const USAGE = { input: 2_000, output: 1_200, cacheRead: 170_000, cacheWrite: 10_000 }
const STEP = { turnId: 't1', model: 'claude-opus-5-5', messageCount: 3, toolUseIds: [] }

/** Every state a timeline row takes: done with tools and a running background fork, a compaction, failed, running; an API error. */
const TIMELINE: TimelineTurn[] = [
  {
    turnId: 't1',
    startedAt: T0,
    steps: [
      { ...STEP, index: 0, sentAt: T0, ttftMs: 3_000, stepMs: 12_000, endedAt: T0 + 12_000, stopReason: 'tool_use', usage: USAGE, toolUseIds: ['r1', 'r2', 'b1', 'ag'] },
      { ...STEP, index: 1, sentAt: T0 + 60_000, stepMs: 4_000, endedAt: T0 + 64_000, stopReason: null, usage: null },
      { ...STEP, index: 2, sentAt: T0 + 70_000 },
    ],
    tools: [
      { toolUseId: 'r1', name: 'Read', endedAt: T0 + 12_200, durationMs: 100, outcome: 'ok' },
      { toolUseId: 'r2', name: 'Read', endedAt: T0 + 12_300, durationMs: 200, outcome: 'ok' },
      { toolUseId: 'b1', name: 'Bash', endedAt: T0 + 55_000, durationMs: 42_000, outcome: 'ok' },
      { toolUseId: 'ag', name: 'Agent', requestedAt: T0 + 12_000 },
    ],
    forks: [{ toolUseId: 'ag', childAgentId: 'c1', background: true, at: T0 + 12_500, subagentType: 'worker', description: 'Fix X' }],
    compactions: [{ at: T0 + 58_000, trigger: 'auto', tokensBefore: 182_000, tokensAfter: 41_000 }],
    apiError: { error: 'overloaded' },
  },
]

/** An ended turn: a request that ended without a result, a Bash call that failed, an Edit interrupted. */
const ENDED_FAILED: TimelineTurn[] = [
  {
    turnId: 't1',
    startedAt: T0,
    endedAt: T0 + 30_000,
    durationMs: 30_000,
    steps: [
      { ...STEP, index: 0, sentAt: T0, ttftMs: 2_000, stepMs: 6_000, endedAt: T0 + 6_000, stopReason: 'tool_use', usage: USAGE, toolUseIds: ['b1', 'e1'] },
      { ...STEP, index: 1, sentAt: T0 + 20_000, ttftMs: 1_000, stepMs: 5_000, endedAt: T0 + 25_000 },
    ],
    tools: [
      { toolUseId: 'b1', name: 'Bash', endedAt: T0 + 18_000, durationMs: 12_000, outcome: 'error' },
      { toolUseId: 'e1', name: 'Edit', endedAt: T0 + 7_000, durationMs: 300, outcome: 'interrupted' },
    ],
    forks: [],
  },
]

/** An ended turn of 23 steps, 4 s apart. */
const LONG_TURN: TimelineTurn[] = [
  {
    turnId: 't1',
    startedAt: T0,
    endedAt: T0 + 92_000,
    durationMs: 92_000,
    steps: Array.from({ length: 23 }, (_, index) => ({ ...STEP, index, sentAt: T0 + index * 4_000, ttftMs: 500, stepMs: 3_000, endedAt: T0 + index * 4_000 + 3_000, stopReason: 'end_turn', usage: USAGE })),
    tools: [],
    forks: [],
  },
]

const DAYS = lastDays(NOW)
const request = (n: number) => ({ input_tokens: 1_000 * n, output_tokens: 300 * n, cache_read_input_tokens: 90_000 * n, cache_creation_input_tokens: 4_000 * n })
/** Day `n` of the ledger: a main request n times the size of its subagent's, and a Skill call of each outcome. */
function usedDay(n: number): UsageDay {
  const requests = requestNoted(requestNoted(emptyDay(), 'claude-opus-5-5', 'main', request(n)), 'claude-haiku-5', 'subagent', request(1))

  return skillNoted(skillNoted(skillNoted(requests, 'review', 'inline'), 'swarm', 'forked'), `ship-${n}`, 'error')
}
const ASKS = { dialogs: 11, questions: 16, recommended: 8, option: 4, typed: 3, declined: 1, under1m: 6, under2m: 2, under5m: 1, under10m: 0, over10m: 2 }
/** The usage page with nothing recorded, one day recorded, all seven, and two days holding question dialogs. */
const USAGE_WEEKS = [
  ['usage-empty', weekOf({}, DAYS)],
  ['usage-one-day', weekOf({ [DAYS[0]!]: usedDay(1) }, DAYS)],
  ['usage-seven-days', weekOf(Object.fromEntries(DAYS.map((day, i) => [day, usedDay(i + 1)])), DAYS)],
  ['usage-asks', weekOf({ [DAYS[0]!]: { ...usedDay(1), asks: ASKS }, [DAYS[2]!]: { ...usedDay(2), asks: { ...ASKS, dialogs: 1, questions: 4, recommended: 0, option: 0, typed: 0, declined: 4, under1m: 0, over10m: 1, under2m: 0, under5m: 0 } } }, DAYS)],
] as const

const boardNode = (id: string, title: string, status: BoardNode['status'], hoursAgo: number, builds_on: string[] = []): BoardNode => ({
  id,
  title,
  summary: 'what changed and why',
  status,
  kind: 'feature',
  done_when: 'a commit on main',
  builds_on,
  depends_on: [],
  request: '',
  discovered_from: '',
  at: NOW - hoursAgo * 3_600_000,
  updatedAt: NOW - hoursAgo * 3_600_000,
  commit: null,
})
const HOURS = 3_600_000
const lineEvent = (id: string, name: string, hoursAgo: number): BoardEvent => ({
  type: 'line',
  line: id,
  at: NOW - hoursAgo * HOURS,
  session: 'other',
  commit: null,
  fields: { name, definition: `${name} work`, status: 'active', keys: { paths: [], scopes: [], patterns: [] } },
})
const askEvent = (id: string, title: string, hoursAgo: number, fields: RequestFields = {}): BoardEvent => ({
  type: 'request',
  request: id,
  at: NOW - hoursAgo * HOURS,
  session: 'other',
  commit: null,
  fields: { title, acceptance: ['it works'], status: 'open', ...fields },
})
const pieceEvent = (id: string, title: string, status: BoardNode['status'], request: string, hoursAgo: number, commit: string | null = null, discovered_from = ''): BoardEvent => ({
  type: 'add',
  node: id,
  at: NOW - hoursAgo * HOURS,
  session: 'other',
  commit,
  fields: { title, summary: 's', status, kind: 'feature', done_when: 'a commit on main', builds_on: [], depends_on: [], request, discovered_from },
})
const CLOSED: RequestFields = { status: 'closed', resolution: { by: 'person', evidence: 'accepted' } }
/** A board as collectProgress folds it from `events`. */
const boardRead = (events: BoardEvent[], current: string | null = null): BoardRead => ({
  storage: 'local',
  dir: '/h/.claude/progress/-r/events',
  name: 'harness',
  nodes: foldBoard(events),
  requests: foldRequests(events, NOW),
  lines: foldLines(events),
  current,
})
const NO_REQUESTS = { name: 'harness', requests: [], lines: [], current: null }
const mine = (event: BoardEvent): BoardEvent => ({ ...event, session: 'me' })
/** This session's open request: a piece done, one doing, one to do, one dropped. */
const PLAN_EVENTS = [
  mine(askEvent('q1', 'Ship the plan row', 3)),
  mine(pieceEvent('q1a', 'Export the segments', 'done', 'q1', 3)),
  mine(pieceEvent('q1b', 'Draw the row', 'doing', 'q1', 2)),
  mine(pieceEvent('q1c', 'Test it', 'todo', 'q1', 1)),
  mine(pieceEvent('q1d', 'Old idea', 'dropped', 'q1', 1)),
]

/** Session `me` in /r with a local board whose one events file holds `events`. */
function planBoard(on: On, events: BoardEvent[]) {
  const dir = '/h/.claude/progress/-r/events'
  const text = JSON.stringify(events)

  on('session.id', () => ({ value: 'me' }))
  on('session.root', () => ({ value: '/r' }))
  on('fs.read', { path: '/h/.claude/progress/-r/config.json' }, () => ({ value: JSON.stringify({ storage: 'local' }) }))
  on('fs.read', { path: `${dir}/me.json` }, () => ({ value: text }))
  on('fs.list', { path: dir }, () => ({ value: [{ name: 'me.json', kind: 'file', size: text.length, mtimeMs: NOW, isLink: false } as FsEntry] }))
}

/**
 * The progress page with no storage chosen, an empty git board, and nodes in all four statuses: four done, so one waits behind a button;
 * then a doing node 25h without an update beside one 23h, a todo 48h old, an open node without done_when and a done one. Then requests
 * on two lines: this session's open one with a follow-up, a ready one, a stale one, a closed one, one closed 9 days ago, one of no line,
 * and an old node; a line whose three releases make a series beside another request; twelve nodes recorded before requests alone.
 */
const PROGRESS_READS: [string, BoardRead][] = [
  ['progress-unchosen', { storage: null, dir: null, nodes: [], ...NO_REQUESTS }],
  ['progress-empty-git', { storage: 'git', dir: '/r/.notes/board/events', nodes: [], ...NO_REQUESTS }],
  [
    'progress-all',
    {
      storage: 'local',
      dir: '/h/.claude/dashboard/board/-r/events',
      ...NO_REQUESTS,
      nodes: [
        boardNode('n1', 'Usage ledger', 'done', 50),
        boardNode('n2', 'Usage page', 'done', 40),
        boardNode('n3', 'Ask outcomes', 'done', 30, ['n2']),
        boardNode('n4', 'Ask reminder', 'done', 20, ['n3']),
        boardNode('n5', 'Progress tool', 'doing', 2, ['n2', 'n4']),
        boardNode('n6', 'Progress canvas', 'todo', 1, ['n5']),
        boardNode('n7', 'Codex sessions page', 'blocked', 3),
      ],
    },
  ],
  [
    'progress-stale',
    {
      storage: 'local',
      dir: '/h/.claude/dashboard/board/-r/events',
      ...NO_REQUESTS,
      nodes: [
        boardNode('s1', 'Stale work', 'doing', 25),
        boardNode('s2', 'Fresh work', 'doing', 23),
        boardNode('s3', 'Old plan', 'todo', 48),
        { ...boardNode('s4', 'Open ended', 'blocked', 4), done_when: '' },
        boardNode('s5', 'Shipped', 'done', 30),
      ],
    },
  ],
  [
    'progress-requests',
    boardRead(
      [
        lineEvent('l1', 'dashboard', 300),
        lineEvent('l2', 'release', 300),
        askEvent('r1', 'Track the board by request', 5, { line: 'l1' }),
        pieceEvent('p1', 'Write request events', 'done', 'r1', 3, '9c8d7e6'),
        pieceEvent('p2', 'Score candidate lines', 'doing', 'r1', 0.05),
        pieceEvent('p3', 'Daily tidy', 'todo', 'r1', 0.05),
        pieceEvent('p4', 'Fix a found bug', 'todo', 'r1', 0.04, null, 'p2'),
        askEvent('r2', 'README sync', 4, { line: 'l1' }),
        pieceEvent('p5', 'Sync the English README', 'done', 'r2', 1, 'abc1234'),
        pieceEvent('p6', 'Sync the Chinese README', 'done', 'r2', 1),
        askEvent('r3', 'Release 0.8.6 cleanup', 100, { line: 'l2' }),
        pieceEvent('p7', 'Drop old flags', 'todo', 'r3', 100),
        askEvent('r4', 'Clock ticks each second', 30, { line: 'l1', ...CLOSED }),
        pieceEvent('p8', 'Tick the clock', 'done', 'r4', 30),
        askEvent('r5', 'Old closed work', 216, { line: 'l1', ...CLOSED }),
        askEvent('r6', 'Loose request', 2),
        pieceEvent('n0', 'Old node', 'done', '', 200),
      ],
      'r1',
    ),
  ],
  [
    'progress-series',
    boardRead([
      lineEvent('l1', 'release', 300),
      askEvent('r1', 'Release 0.8.3', 72, { line: 'l1', ...CLOSED }),
      askEvent('r2', 'Release 0.8.4', 48, { line: 'l1', ...CLOSED }),
      askEvent('r3', 'Release 0.8.5', 3, { line: 'l1' }),
      pieceEvent('p1', 'Tag', 'done', 'r3', 3, 'def5678'),
      pieceEvent('p2', 'Notes', 'doing', 'r3', 1),
      pieceEvent('p3', 'Upload', 'todo', 'r3', 1),
      askEvent('r4', 'Fix the release notes', 2, { line: 'l1' }),
    ]),
  ],
  [
    'progress-legacy',
    {
      storage: 'local',
      dir: '/h/.claude/progress/-r/events',
      ...NO_REQUESTS,
      nodes: Array.from({ length: 12 }, (_, i) => boardNode(`g${i}`, `Legacy work ${i}`, (['doing', 'blocked', 'todo', 'done'] as const)[i % 4]!, i + 1)),
    },
  ],
]

const lineTree = (lines: Line[]) =>
  lines.map(line => ({ type: 'Text', props: {}, children: line.map(seg => ({ type: 'Text', props: { ...(seg.color !== undefined && { color: seg.color }) }, children: [seg.text] })) }))

// Host types, so a drawn tree is plain data to walk.
const EL = { Box: 'Box', Client: 'Client', Text: 'Text', Button: 'Button', Svg: 'Svg', Markdown: 'Markdown' } as never
const READER_EL = { Box: 'Box', Client: 'Client', Text: 'Text', Button: 'Button', Svg: 'Svg', Markdown: 'Markdown', Code: 'Code', Select: 'Select', Input: 'Input' } as never

const READER_OUT = '/h/.claude/mmruns/r1/grok.out'
const READER_REVIEW = {
  verdict: 'needs_changes',
  summary: 'Two problems',
  findings: [
    { severity: 'critical', file: 'a.ts', line: 3, claim: 'Crashes on empty input', quote: 'x = list[0]', failure_scenario: 'an empty list', basis: 'read', suggestion: 'check the length' },
    { severity: 'major', file: 'b.ts', line: 7, claim: 'Wrong total', quote: 'sum - 1', failure_scenario: 'any input' },
    { severity: 'minor', file: 'c.ts', line: 9, claim: 'Hard to read', quote: 'z', failure_scenario: 'none' },
  ],
  not_expanded: 2,
  not_checked: ['tests/'],
}
const READER_RUN = { status: 'done', summary: 'All green', checks_run: [{ cmd: 'bun test', exit_code: 0, result_line: '41 pass' }], not_verified: ['desktop'] }
const reviewed = (status: string, json: object): DashReport['models'][number] => {
  const review = reviewOf(json, 'review', READER_OUT)

  return { name: 'grok', status, markdown: reportOf(json, '', 'review', false, READER_OUT), ...(review !== null && { review }) }
}
const READER_ITEMS: ConversationItem[] = [
  { kind: 'user', text: 'Review the diff' },
  { kind: 'thinking', text: 'Need **a.ts** first' },
  { kind: 'call', tool: 'read_file', text: '{"path":"a.ts"}' },
  { kind: 'result', text: 'const a = list[0]' },
  { kind: 'assistant', text: 'Crashes on an empty list' },
]
const conversing = (items: ConversationItem[] | null): Partial<PaneData> => ({ conversation: { runid: 'r1', model: 'grok', readAt: NOW, items, dropped: items === null ? 0 : 12 } })
/** The reader at each of its states: a review's first finding and the next, a review without findings, a run report, a bare .out; a running model's conversation, then one unreadable. */
const READER_SCENES: [string, DashReport['models'][number], number, Partial<PaneData>?][] = [
  ['reader-review', reviewed('DONE', READER_REVIEW), 0],
  ['reader-review-next', reviewed('STALE', READER_REVIEW), 1],
  ['reader-review-empty', reviewed('DONE', { ...READER_REVIEW, verdict: 'approve', findings: [] }), 0],
  ['reader-run', { name: 'grok', status: 'FAIL:1', markdown: reportOf(READER_RUN, '', 'run', false, READER_OUT) }, 0],
  ['reader-out', { name: 'grok', status: 'RUNNING', markdown: reportOf(null, 'plain answer', 'review', false, READER_OUT) }, 0],
  ['reader-conversation', { name: 'grok', status: 'RUNNING', markdown: '' }, 0, conversing(READER_ITEMS)],
  ['reader-conversation-unreadable', { name: 'grok', status: 'RUNNING', markdown: '' }, 0, conversing(null)],
]
const noop = () => {}
const readerPane = (model: DashReport['models'][number], finding: number, over: Partial<PaneData> = {}): PaneData => ({
  page: 'mmrun',
  pages: [{ page: 'mmrun', label: 'Reviews' }],
  now: NOW,
  columns: 80,
  agents: [],
  snap: {
    polledAt: NOW,
    runs: [
      {
        runid: 'r1',
        tag: 'design',
        workdir: '/work',
        mode: 'review',
        createdAt: NOW - 400_000,
        models: [{ name: 'grok', status: model.status, startedAt: NOW - 300_000, ...(over.conversation !== undefined && { transcriptPath: '/h/.grok/sessions/w/s/chat_history.jsonl' }) }],
      },
    ],
  },
  seen: { agents: 0, runs: 0 },
  gpu: null,
  gates: [],
  trees: [],
  guards: [],
  peers: [],
  paneRuns: 5,
  detail: { page: 'mmrun', runid: 'r1', showAll: false, finding, ...(over.conversation !== undefined && { view: 'conversation' as const }) },
  reports: { r1: { loadedAt: NOW, models: [model] } },
  ...over,
  onPage: noop,
  onReadAgent: noop,
  onReadRun: noop,
  onOpenItem: noop,
  onBack: noop,
  onToggleSeverity: noop,
  onCopyResume: noop,
  onCopyCd: noop,
  onClose: noop,
})

describe('every color follows the theme', () => {
  for (const surface of SURFACES) {
    for (const lang of LANGS) {
      const options = { options: { language: lang } }

      test(`the band on ${surface} in ${lang}`, options, async ($, on) => {
        await busy($, on)

        const band = await $.ui.mount({ plugin: PLUGIN, ...BAND, surface } as never)
        const drawn = await band.drawn()
        const text = JSON.stringify(drawn)

        expect(check(drawn, 'band', surface, lang)).toEqual([])

        if (surface === 'desktop') {
          expect((await band.find({ key: 'dash-open' }))?.props.variant, 'something needs you').toBe('primary')
        }

        expect(text, 'the aborted agent counts apart').toContain('"⊘"')
        expect(text, 'the gate from a worktree names it').toMatch(/swift test · 1 fail · agent-wt/)
        await band.unmount()
      })

      test(`the running band, then the idle band, on ${surface} in ${lang}`, options, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })

        seat(on, {})
        await $.session.start(SESSION)
        await $.agent.spawn(SPAWN as never)

        const running = await $.ui.mount({ plugin: PLUGIN, ...BAND, surface } as never)

        expect(check(await running.drawn(), 'running-band', surface, lang)).toEqual([])

        if (surface === 'desktop') {
          expect((await running.find({ key: 'dash-open' }))?.props.variant, 'running needs nobody').toBe('secondary')
        }

        await running.unmount()
        await $.turn.complete(complete('a1', 'answer'))
        await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_response: { stdout: BUN_OK, stderr: '', interrupted: false }, tool_use_id: 'toolu_g', cwd: '/r/.claude/worktrees/agent-wt' } as never)
        await clock.advance(21_000)

        const band = await $.ui.mount({ plugin: PLUGIN, ...BAND, surface } as never)
        const drawn = await band.drawn()

        expect(check(drawn, 'idle-band', surface, lang)).toEqual([])

        if (surface === 'desktop') {
          expect((await band.find({ key: 'dash-open' }))?.props.variant).toBe('secondary')
        }

        expect(JSON.stringify(drawn)).toContain('24 pass')
        await band.unmount()
      })

      test(`the plan row on the band on ${surface} in ${lang}`, options, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })

        planBoard(on, PLAN_EVENTS)
        seat(on, {})
        await $.session.start(SESSION)

        const band = await $.ui.mount({ plugin: PLUGIN, ...BAND, surface } as never)

        await clock.settle()

        const drawn = await band.drawn()
        const text = JSON.stringify(drawn)

        expect(check(drawn, 'plan-band', surface, lang)).toEqual([])
        expect(text, 'the request first, then its count').toMatch(/Ship the plan row.*1\/3/)

        if (surface === 'desktop') {
          const bar = (await band.findAll({ type: 'Svg' })).find(one => String(one.props.source).includes('data-part="segment"'))

          expect(bar?.props.alt).toBe(lang === 'en' ? 'Progress 1 of 3: Ship the plan row' : '进度 1/3：Ship the plan row')
          expect(String(bar?.props.source).match(/data-part="segment"/g), 'a segment per piece not dropped').toHaveLength(3)
        } else {
          expect(text, 'a text bar of the done pieces').toContain('"▰▰▰"')
        }

        await band.unmount()
      })

      test(`no plan row when every piece is done, on ${surface} in ${lang}`, options, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })

        planBoard(on, PLAN_EVENTS.map(one => (one.type === 'add' && one.fields.status !== 'dropped' ? { ...one, fields: { ...one.fields, status: 'done' } } : one)))
        seat(on, {})
        await $.session.start(SESSION)

        const band = await $.ui.mount({ plugin: PLUGIN, ...BAND, surface } as never)

        await clock.settle()
        expect(JSON.stringify(await band.drawn())).not.toContain('Ship the plan row')
        await band.unmount()
      })

      test(`an agent the engine lists idle, on the Agents page on ${surface} in ${lang}`, options, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })

        seat(on, {})
        on('agent.list', () => ({ value: [{ id: 'a1', description: SPAWN.description, type: 'worker', status: 'idle' }] }))
        await $.session.start(SESSION)
        await $.agent.spawn(SPAWN as never)
        await clock.advance(121_000)

        const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

        await pane.press({ key: 'page-agents' })

        const drawn = await pane.drawn()
        const text = JSON.stringify(drawn)

        expect(check(drawn, 'agents-idle', surface, lang)).toEqual([])
        expect(text, 'shown as idle').toContain(lang === 'en' ? 'idle' : '空闲')
        // The 运行 KPI tile aside: no running glyph or word on its row.
        expect(text, 'neither running nor quiet').not.toMatch(lang === 'en' ? /quiet|● running/ : /静默|● 运行/)
        expect(text, 'an idle glyph, not a failure').toContain('○')
        expect(text, 'an idle glyph, not a failure').not.toContain('✗')
        await pane.unmount()
      })

      test(`the workbench pages on ${surface} in ${lang}`, options, async ($, on) => {
        // The project's board config, so the Progress tab shows.
        on('fs.read', { path: '/h/.claude/progress/-r/config.json' }, () => ({ value: JSON.stringify({ storage: 'local' }) }))

        const fail = await busy($, on)

        const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)
        const found: string[] = []

        // The terminal toggles the timeline view with one button; the desktop has a button per view.
        const [hotspots, waterfall] = surface === 'terminal' ? ['timeline-view', 'timeline-view'] : ['timeline-hotspots', 'timeline-waterfall']

        for (const key of ['page-overview', 'page-agents', 'page-mmrun', 'page-gpu', 'page-usage', 'page-progress', 'page-timeline', hotspots]) {
          await pane.press({ key })
          check(await pane.drawn(), key, surface, lang, found)
        }

        await pane.press({ key: waterfall })

        if (surface === 'terminal') {
          expect(JSON.stringify(await pane.drawn()), 'the timeline page shows the running Bash call').toMatch(/● \d+s…/)
        }

        // The overview placed inline above the prompt, and the tables narrowed to where their columns go.
        for (const [key, props] of [['page-overview', { placement: 'inline' }], ['page-agents', { bodyColumns: 60 }], ['page-gpu', { bodyColumns: 60 }]] as const) {
          await pane.press({ key })
          check(await $.ui.render({ ...PANE, surface, props: { ...PANE.props, ...props } } as never), `${key}-${Object.values(props).join('')}`, surface, lang, found)
        }

        await fail()

        for (const key of ['page-mmrun', 'page-gpu']) {
          await pane.press({ key })
          check(await pane.drawn(), `${key}-stale`, surface, lang, found)
        }

        const gpuPage = JSON.stringify(await pane.drawn())

        expect(gpuPage, 'the stale GPU page still holds the numbers').toContain('52%')
        expect(gpuPage).toContain('ssh: connect to host lab-box')
        await pane.press({ key: 'page-mmrun' })

        const runsPage = JSON.stringify(await pane.drawn())

        expect(runsPage, 'the runs read before stay').toContain('codex')
        expect(runsPage).toContain('~/.claude/mmruns')
        expect(runsPage).toContain('EACCES')
        await pane.press({ key: 'page-overview' })
        expect(JSON.stringify(await pane.drawn()), 'the failing gate needs you').toContain('agent-wt · 1 fail')

        await pane.press({ key: 'page-agents' })
        expect(JSON.stringify(await pane.drawn()), 'a3’s Bash call is in flight').toMatch(/Bash \d+s…/)
        await pane.press({ key: 'agents-fold' })
        check(await pane.drawn(), 'agents-fold-open', surface, lang, found)
        await pane.press({ key: 'read-agent-a2' })
        check(await pane.drawn(), 'read-agent', surface, lang, found)
        expect(JSON.stringify(await pane.drawn()), 'its usage').toContain('in 93k')
        await pane.press({ key: 'dash-back' })
        await pane.press({ key: 'read-agent-a3' })
        check(await pane.drawn(), 'read-agent-running', surface, lang, found)
        expect(JSON.stringify(await pane.drawn()), 'its task').toContain('Fix the band')
        fail.faults.messages = 'gone'
        await $.classic.PostToolUse({ tool_name: 'Read', tool_input: { file_path: '/w/x' }, tool_response: 'ok', tool_use_id: 'toolu_r', agent_id: 'a3', cwd: '/work' } as never)
        check(await pane.drawn(), 'read-agent-unreadable', surface, lang, found)
        if (surface === 'desktop') {
          await pane.press({ key: 'page-gpu' })
          await pane.press({ key: 'gpu-change-host' })
          expect(await pane.find({ key: 'gpu-input-host' }), '换主机 shows the host picker').toBeDefined()
          check(await pane.drawn(), 'page-gpu-empty', surface, lang, found)
        }
        expect(found).toEqual([])
        await pane.unmount()
      })

      test(`the mmrun page's fold of other sessions' runs and a running model's activity on ${surface} in ${lang}`, options, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })
        const files = mmruns()

        files[`${R1}/codex.events.jsonl`] = { text: '' }
        files[`${R3}/agy.events.jsonl`] = { text: '' }
        on('session.id', () => ({ value: 'me' }))
        on('session.root', () => ({ value: '/r' }))

        const faults = seat(on, files, {}, clock)

        // R1's codex runs for this session; R3 another session started.
        faults.replies = {
          [`head -n 1 ${ROOT}/${R1}/codex.events.jsonl`]: taskStarted('me'),
          [`tail -c 4096 ${ROOT}/${R1}/codex.events.jsonl`]: TASK_PROGRESS,
          [`head -n 1 ${ROOT}/${R3}/agy.events.jsonl`]: taskStarted('other'),
        }
        await $.session.start(SESSION)
        await clock.advance(3_000)

        const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface, props: { ...PANE.props, bodyColumns: 120 } } as never)
        const found: string[] = []

        await pane.press({ key: 'page-mmrun' })
        check(await pane.drawn(), 'runs-fold', surface, lang, found)
        expect(JSON.stringify(await pane.drawn()), 'the running codex’s activity').toContain('3 tools · Read board.ts')
        expect(JSON.stringify(await pane.drawn()), 'R3 folded').not.toContain(`read-run-${R3}`)
        await pane.press({ key: 'runs-fold' })
        check(await pane.drawn(), 'runs-fold-open', surface, lang, found)
        expect(JSON.stringify(await pane.drawn()), 'R3 under the fold').toContain(`read-run-${R3}`)
        expect(found).toEqual([])
        await pane.unmount()
      })

      test(`other sessions on the band and the overview on ${surface} in ${lang}`, options, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })

        on('session.id', () => ({ value: 'me' }))
        on('session.root', () => ({ value: '/work/harness' }))
        on('fs.write', () => ({ value: undefined }))
        seat(on, {}, PEER_FILES)
        await $.session.start(SESSION)
        await clock.advance(5_000)
        await $.command.run(command('dashboard'))

        const found: string[] = []
        const band = await $.ui.mount({ plugin: PLUGIN, ...BAND, surface } as never)

        check(await band.drawn(), 'band-sessions', surface, lang, found)
        // The desktop draws a row's status as its icon: red is FILL.failed there.
        const reds =
          surface === 'terminal'
            ? (await band.findAll({ type: 'Text', text: /✗/ })).map(one => one.props.color)
            : (await band.findAll({ type: 'Svg' })).filter(one => /✗/.test(String(one.props.alt))).map(one => (String(one.props.source).includes('#DC2626') ? 'error' : one.props.source))

        expect(reds, 'a failed session is red on the band').toContain('error')
        await band.unmount()

        const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

        check(await pane.drawn(), 'overview-sessions', surface, lang, found)
        expect((await pane.findAll({ type: 'Text', text: /✗/ })).map(one => one.props.color), 'a failed session is red on the overview').toContain('error')
        expect((await pane.find({ key: 'copy-resume-p1' }))?.props.hotkey).toBeUndefined()

        // The desktop lists three sessions, the fourth behind 另有 1 项.
        if (surface === 'desktop') {
          await pane.press({ key: 'more-sessions' })
          check(await pane.drawn(), 'overview-sessions-more', surface, lang, found)
        }

        expect(await pane.find({ key: 'copy-resume-p4' })).toBeDefined()
        expect(found).toEqual([])
        await pane.unmount()
      })

      test(`the prompt hint and a gate an edit made stale on ${surface} in ${lang}`, options, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })
        const hints: unknown[] = []
        const modes: unknown[] = []
        const limit = (percentUsed: number) => ({ kind: 'five_hour', percentUsed, resetsAt: new Date(NOW + 7_800_000).toISOString() })
        const week = { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() }
        const measure = (percentUsed: number) =>
          $.session.measure({ context: { tokens: 85_000, window: 200_000, percent: 43 }, rateLimits: [limit(percentUsed), week], cost: { usd: 3.41 }, changed: ['context', 'rateLimits', 'cost'] })

        on('session.root', () => ({ value: '/work' }))
        on('session.measure', ($, e) => ({ changed: e.changed }))
        on('ui.render', { component: 'PromptHint' }, ($, e) => {
          hints.push(e.props)

          return BOTTOM as never
        })
        on('ui.render', { component: 'SessionMode' }, ($, e) => {
          modes.push(e.props)

          return BOTTOM as never
        })
        seat(on, {})
        await $.session.start(SESSION)
        await measure(86)
        await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_response: { stdout: BUN_OK, stderr: '', interrupted: false }, tool_use_id: 'toolu_w', cwd: '/r/.claude/worktrees/agent-wt' } as never)
        await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_response: { stdout: BUN_FAIL, stderr: '', interrupted: false }, tool_use_id: 'toolu_g', cwd: '/work' } as never)
        await clock.advance(60_000)
        await $.classic.PostToolUse({ tool_name: 'Edit', tool_input: { file_path: '/work/hooks/board.ts' }, tool_response: 'ok', tool_use_id: 'toolu_e', cwd: '/work' } as never)

        const found: string[] = []
        const band = await $.ui.mount({ plugin: PLUGIN, ...BAND, surface } as never)

        await measure(40)
        check(await band.drawn(), 'band-stale-gate', surface, lang, found)
        expect((await band.findAll({ type: 'Text', text: /^✗$/ })).map(one => one.props.color), 'a stale failure is not red').toEqual(['inactive'])
        await band.unmount()

        await $.command.run(command('dashboard'))

        const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)
        const overview = await pane.drawn()

        check(overview, 'overview-stale-gate', surface, lang, found)
        expect(JSON.stringify(overview), 'red is for failures only').not.toContain('"color":"error"')
        await pane.unmount()

        await $.ui.render({ component: 'PromptHint', surface, requestId: 'hint', viewport: { columns: 120, rows: 40, isFullscreen: true }, props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
        expect(JSON.stringify(hints.at(-1))).toMatch(/85k\/200k · 43% · 5h 40% · /)
        check(hints.at(-1), 'prompt-hint', surface, lang, found)
        const sessionMode = await $.ui.render({ component: 'SessionMode', surface, requestId: 'session-mode', viewport: { columns: 120, rows: 40, isFullscreen: true }, props: { modes: ['plan'] } } as never)
        expect(JSON.stringify(surface === 'desktop' ? sessionMode : modes.at(-1))).toMatch(surface === 'desktop' ? /"plan".*"5h 40% · .*"7d 12% · / : /^\{"modes":\["plan"\]\}$/)
        check(sessionMode, 'session-mode', surface, lang, found)
        expect(found).toEqual([])
      })

      test(`the status line with the workbench closed on ${surface} in ${lang}`, options, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })
        const statuses: (string | undefined)[] = []

        on('session.id', () => ({ value: 'me' }))
        on('session.root', () => ({ value: '/work/harness' }))
        on('fs.write', () => ({ value: undefined }))
        on('ui.status', ($, e) => {
          statuses.push(e.text)

          return { value: undefined }
        })
        seat(on, {}, PEER_FILES)
        await $.session.start({ ...SESSION, surface })
        await $.agent.spawn(SPAWN as never)
        await clock.advance(5_000)

        const line = statuses.at(-1) ?? ''

        expect(line).toMatch(/^● 1 \S.* · ! 2 \S/)
        expect(lang === 'en' && HAN.test(line), 'Han under en').toBe(false)
      })

      test(`recent blocks and the worktree rows on the overview on ${surface} in ${lang}`, options, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })

        on('session.root', () => ({ value: '/r' }))

        const faults = seat(on, {})

        faults.replies = BLOCKS_AND_TREES
        faults.guardMtimeMs = NOW - 90_000
        await $.session.start(SESSION)
        await $.command.run(command('dashboard'))
        await clock.settle()

        const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)
        const drawn = await pane.drawn()

        expect(JSON.stringify(drawn)).toContain(lang === 'en' ? 'Recent blocks' : '最近拦截')
        expect(await pane.find({ key: `copy-cd-${WT}` })).toBeDefined()
        expect(JSON.stringify(drawn), 'a block is the guard working, not a failure: no red').not.toContain('"error"')
        expect(check(drawn, 'overview-blocks', surface, lang)).toEqual([])
        await pane.unmount()
      })

      test(`the overview's KPI tiles and 需要你 card, the Agents rows, their fold and the narrow dots, then an idle overview, on ${surface} in ${lang}`, options, async ($, on) => {
        await busy($, on)

        const isEn = lang === 'en'
        const found: string[] = []
        const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

        await pane.press({ key: 'page-overview' })
        check(await pane.drawn(), 'overview-kpi', surface, lang, found)

        if (surface === 'desktop') {
          expect((await pane.find({ type: 'Text', text: isEn ? '✗ failed' : '✗ 失败' }))?.props.color, 'the latest gate failed: its tile is red').toBe('error')
          expect((await pane.findAll({ type: 'Box' })).filter(box => box.props.borderColor === 'error'), 'an errored agent and failed gates: the attention card is framed in error').toHaveLength(1)
        }

        // The second visit folds what ended before the first.
        await pane.press({ key: 'page-agents' })
        check(await pane.drawn(), 'agents-rows', surface, lang, found)
        await pane.press({ key: 'page-overview' })
        await pane.press({ key: 'page-agents' })
        await pane.press({ key: 'agents-fold' })
        check(await pane.drawn(), 'agents-rows-open', surface, lang, found)

        const narrow = await $.ui.render({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 40 } } as never)
        const dots = JSON.stringify(narrow)

        check(narrow, 'agents-narrow', surface, lang, found)
        expect(dots.includes(isEn ? '1 running, 3 ended' : '1 个运行，3 个已结束'), 'a dot per agent where Svg is drawn, none on the terminal').toBe(surface === 'desktop')
        await pane.unmount()
        expect(found).toEqual([])
      })

      test(`an idle overview: four dim KPI tiles and the idle line, on ${surface} in ${lang}`, options, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })

        seat(on, {})
        await $.session.start(SESSION)
        await clock.settle()

        const drawn = await $.ui.render({ ...PANE, surface } as never)

        expect(check(drawn, 'overview-idle-kpi', surface, lang)).toEqual([])
        expect(JSON.stringify(drawn), 'nothing needs you: no warning or error anywhere').not.toMatch(/"(warning|error)"/)
      })

      test(`a workbench page that failed to draw on ${surface} in ${lang}`, options, async ($, on) => {
        let isBroken = false

        on('state.get', ($, e, next) => (isBroken && (e as { key: string }).key === 'timeline' ? ({ deny: 'timeline unreadable' } as never) : next(e)))
        await busy($, on)

        const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

        await pane.press({ key: 'page-timeline' })
        isBroken = true
        await pane.redraw()

        const drawn = await pane.drawn()

        expect(JSON.stringify(drawn)).toContain('✗ ')
        expect(check(drawn, 'pane-failed', surface, lang)).toEqual([])
        isBroken = false
        await pane.unmount()
      })

      test(`the timeline on ${surface} in ${lang}`, () => {
        setLang(lang)

        const found: string[] = []

        for (const [where, turns] of [['timeline', TIMELINE], ['timeline-empty', []]] as const) {
          for (const width of [100, 50]) {
            const drawn = surface === 'terminal' ? lineTree(timelineLines(turns, 't1', NOW, width)) : drawTimelineDesktop(EL, turns, 't1', NOW, width)

            check(drawn, `${where}-${width}`, surface, lang, found)
          }
        }

        // Hotspots over an ended copy of the turn and the open one; and with nothing ended.
        const ended = { ...TIMELINE[0]!, turnId: 't0', endedAt: T0 + 90_000, durationMs: 90_000 }

        for (const [where, turns] of [['hotspots', [ended, ...TIMELINE]], ['hotspots-empty', []]] as const) {
          for (const width of [100, 50]) {
            const drawn = surface === 'terminal' ? lineTree(hotspotLines(turns, width)) : drawHotspotsDesktop(EL, turns, width)

            check(drawn, `${where}-${width}`, surface, lang, found)
          }
        }

        expect(found).toEqual([])
      })

      test(`the usage page with 0, 1 and 7 days on ${surface} in ${lang}`, () => {
        setLang(lang)

        const isEn = lang === 'en'
        const found: string[] = []
        const scenes: [string, unknown][] = []

        for (const [where, week] of USAGE_WEEKS) {
          for (const columns of surface === 'terminal' ? [100, 50] : [50, 80, 120]) {
            const usagePane: PaneData = { ...readerPane(READER_SCENES[0]![1], 0), page: 'usage', detail: null, columns, usage: week }

            scenes.push([`${where}-${columns}`, surface === 'terminal' ? lineTree(usageLines(week, columns)) : drawDesktopPane(READER_EL, usagePane)])
          }
        }

        for (const [where, tree] of scenes) {
          check(tree, where, surface, lang, found)
        }

        expect(found).toEqual([])

        const text = (where: string) => JSON.stringify(scenes.find(([name]) => name === where)![1])
        const wide = surface === 'terminal' ? 100 : 80

        expect(text(`usage-empty-${wide}`)).toContain(isEn ? 'Recording usage starts now' : '从现在开始记录用量')
        expect(text(`usage-one-day-${wide}`)).toContain(isEn ? 'not money' : '不是钱')
        expect(text(`usage-one-day-${wide}`)).toContain(isEn ? 'background helper calls' : '后台辅助调用')
        // The terminal lists the newest day first; the desktop's columns run oldest to today.
        expect(text(`usage-seven-days-${wide}`), 'the days in order').toMatch(
          surface === 'terminal' ? new RegExp(`${DAYS[0]!.slice(5)}.*${DAYS[6]!.slice(5)}`) : new RegExp(`${DAYS[6]!.slice(5)}.*${DAYS[0]!.slice(5)}`),
        )
        expect(text(`usage-seven-days-${wide}`), 'review: 7 calls, most first').toMatch(/review.*swarm/)
        expect(text(`usage-seven-days-${wide}`), 'no dialog, no questions section').not.toContain(isEn ? '"Questions"' : '提问')
        // 12 dialogs and 20 questions across the two days, the questions section after the threads'.
        expect(text(`usage-asks-${wide}`)).toMatch(new RegExp(isEn ? 'Subagents.*Questions.*Skills' : '子 agent.*提问.*Skills'))
        expect(text(`usage-asks-${wide}`)).toContain(isEn ? '12 dialogs · 20 questions' : '12 次对话框 · 20 个问题')
        expect(text(`usage-asks-${wide}`)).toContain(isEn ? 'recommended 40% · other option 20% · typed 15% · declined 25%' : '推荐 40% · 其他选项 20% · 自己输入 15% · 拒绝 25%')
        expect(text(`usage-asks-${wide}`)).toContain('<1m 6 · 1–2m 2 · 2–5m 1 · 5–10m 0 · >10m 3')

        if (surface === 'desktop') {
          const alts = (JSON.stringify(scenes.find(([name]) => name === 'usage-seven-days-80')![1]).match(/"alt":"[^"]*"/g) ?? []).map(alt => alt.slice(7, -1))

          expect(alts.filter(alt => DAYS.every(day => alt.includes(day.slice(5)))), 'one drawing of the seven days').toHaveLength(1)
          expect(alts.some(alt => alt.includes(isEn ? 'cache write' : '缓存写')), "today's composition").toBe(true)
          expect(text('usage-seven-days-80'), 'skills past three wait behind a button').toContain(isEn ? '"6 more"' : '"另有 6 项"')
        }
      })

      test(`the progress page with 0 nodes, nodes in all four statuses, a stale node, done_when lines, requests on lines, a series and legacy nodes on ${surface} in ${lang}`, () => {
        setLang(lang)

        const isEn = lang === 'en'
        const found: string[] = []
        const scenes: [string, unknown][] = []

        for (const [where, board] of PROGRESS_READS) {
          for (const columns of surface === 'terminal' ? [100, 60, 50] : [50, 80, 120]) {
            const progressPane: PaneData = { ...readerPane(READER_SCENES[0]![1], 0), page: 'progress', detail: null, columns, progress: board }

            scenes.push([`${where}-${columns}`, surface === 'terminal' ? lineTree(progressLines(board, columns, NOW)) : drawDesktopPane(READER_EL, progressPane)])
          }
        }

        for (const [where, tree] of scenes) {
          check(tree, where, surface, lang, found)
        }

        expect(found).toEqual([])

        const text = (where: string) => JSON.stringify(scenes.find(([name]) => name === where)![1])
        const wide = surface === 'terminal' ? 100 : 80

        expect(text(`progress-unchosen-${wide}`)).toContain(isEn ? 'not chosen yet' : '尚未选择')
        expect(text(`progress-empty-git-${wide}`)).toContain('/r/.notes/board/events')
        expect(text(`progress-all-${wide}`), 'old nodes under their own head').toContain(isEn ? 'No request · 7' : '未归入请求 · 7')
        expect(text(`progress-all-${wide}`), 'what a node builds on, by title').toContain(isEn ? 'builds on: Usage page, Ask reminder' : '基于：Usage page、Ask reminder')

        if (surface === 'desktop') {
          expect(text(`progress-all-${wide}`), 'the groups in order').toMatch(isEn ? /In progress.*Blocked.*To do.*Done/ : /进行中.*受阻.*待办.*已完成/)
          expect(text(`progress-all-${wide}`), 'each status in its theme key').toMatch(/"permission".*"error".*"inactive".*"success"/)
        } else {
          expect(text(`progress-all-${wide}`), 'newest first').toMatch(isEn ? /To do.*In progress.*Blocked.*Done/ : /待办.*进行中.*受阻.*已完成/)
          expect(text(`progress-all-${wide}`), 'each status in its theme key').toMatch(/"inactive".*"permission".*"error".*"success"/)
        }

        if (surface === 'desktop') {
          expect(text('progress-all-80'), 'done newest first, the fourth behind a button').toMatch(isEn ? /Ask reminder.*Ask outcomes.*Usage page.*"1 more"/ : /Ask reminder.*Ask outcomes.*Usage page.*"另有 1 项"/)
          expect(text('progress-all-80')).not.toContain('Usage ledger')
        } else {
          expect(text('progress-all-100'), 'done newest first, all of them').toMatch(/Ask reminder.*Ask outcomes.*Usage page.*Usage ledger/)
        }

        const stale = text(`progress-stale-${wide}`)

        expect(stale, 'the three open nodes with done_when, not the done one').toContain(isEn ? 'Done when: a commit on main' : '完成条件：a commit on main')
        expect(stale.split('a commit on main').length - 1).toBe(3)
        expect(stale, 'only the doing node 24h+ old').toContain(isEn ? ' · no update for 25h' : ' · 25 小时无更新')
        expect(stale).not.toMatch(isEn ? /no update for (23|48)h/ : /(23|48) 小时无更新/)
        expect(stale, 'its title inactive').toContain('"color":"inactive"},"children":[" Stale work"]')
        expect(stale).not.toContain('"color":"inactive"},"children":[" Fresh work"]')

        if (surface === 'desktop') {
          expect(stale, 'Done and Drop on an open node').toContain('"progress-done-s1"')
          expect(stale).toContain('"progress-drop-s1"')
          expect(stale).toContain(isEn ? '"Drop"' : '"放弃"')
          expect(stale, 'none on a done node').not.toContain('"progress-done-s5"')
        } else {
          expect(stale, 'the terminal draws no buttons').not.toContain('progress-done')
        }

        const flat = (node: unknown): string =>
          typeof node === 'string' ? node : Array.isArray(node) ? node.map(flat).join('') : node !== null && typeof node === 'object' ? flat((node as { children?: unknown[] }).children ?? []) : ''
        const words = (where: string) => flat(scenes.find(([name]) => name === where)![1])
        const requests = words(`progress-requests-${wide}`)

        expect(requests, 'a ready request waits for the person').toContain(isEn ? 'awaiting you' : '待验收')
        expect(text(`progress-requests-${wide}`), 'in warning').toContain(`{"color":"warning"},"children":["${isEn ? 'awaiting you' : '待验收'}"]`)
        expect(requests, 'the old node last').toMatch(isEn ? /Loose request.*No request · 1.*Old node/ : /Loose request.*未归入请求 · 1.*Old node/)
        expect(words(`progress-legacy-${wide}`)).toContain(isEn ? 'No request · 12' : '未归入请求 · 12')

        if (surface === 'desktop') {
          expect(requests, 'the now frame: this session\'s request, the ready one, the stale one').toMatch(
            isEn ? /Now.*Track the board by request.*this session.*README sync.*awaiting you.*Release 0\.8\.6 cleanup.*no update for 4d/ : /现在.*Track the board by request.*本会话.*README sync.*待验收.*Release 0\.8\.6 cleanup.*4 天无更新/,
          )
          expect(requests, 'a section per line, newest activity first, then no line').toMatch(isEn ? /DASHBOARD · 2 open · 2 closed.*RELEASE · 1 open · 0 closed.*No line · 1/ : /DASHBOARD · 进行中 2 · 已关闭 2.*RELEASE · 进行中 1 · 已关闭 0.*未归入工作线 · 1/)
          expect(requests, 'the count and its follow-up').toContain(isEn ? 'Track the board by request1 / 32m1 follow-up' : 'Track the board by request1 / 32m1 个后续')
          expect(text(`progress-requests-${wide}`), 'the closed ones folded behind their header').toContain(isEn ? '"▸ Done · 2"' : '"▸ 已完成 · 2"')
          expect(requests, 'a piece: its time, glyph, title and sha').toMatch(/✓ \d\d:\d\d Write request events {2}9c8d7e6/)

          for (const key of ['progress-accept-r1', 'progress-dropreq-r1', 'progress-now-accept-r2', 'progress-done-p2', 'progress-drop-p3']) {
            expect(text(`progress-requests-${wide}`), key).toContain(`"${key}"`)
          }

          expect(text(`progress-requests-${wide}`), 'no Done on a done piece').not.toContain('"progress-done-p1"')
          expect(words('progress-series-80'), 'the series as one chain, oldest first').toContain(`RELEASE (${isEn ? 'series' : '系列'})`)
          expect(words('progress-series-80')).toContain('0.8.3 ✓ ─ 0.8.4 ✓ ─ 0.8.5 ▸1/3')
          expect(words('progress-series-80'), 'its other request as a card').toContain('Fix the release notes')
          expect(text('progress-series-80')).toContain('"progress-accept-r4"')
        } else {
          expect(requests, 'the legend').toContain('D=dashboard  R=release')
          expect(requests, 'the one closed 9 days ago folded').toContain(isEn ? '1 more closed' : '另有 1 个已关闭')
          expect(requests).not.toContain('Old closed work')
          expect(requests, 'the rollup with its follow-up').toContain('▰▱▱ 1/3 +1')
          expect(requests, 'pieces under the open request, oldest first').toMatch(/Track the board by request.*↳ ✓ \d\d:\d\d Write request events +9c8d7e6.*↳ ▸ \d\d:\d\d Score candidate lines.*↳ ◌ {7}Daily tidy/)
          expect(requests, 'the stale request quiet 4 days').toMatch(/Release 0\.8\.6 cleanup.*4d!/)
          expect(words('progress-series-100'), 'the terminal lists the series as rows').toMatch(/Release 0\.8\.5.*Fix the release notes.*Release 0\.8\.4.*Release 0\.8\.3/)
          expect(words('progress-legacy-100'), 'ten old nodes, then a count').toContain(isEn ? '2 more' : '另有 2 项')
        }
      })

      if (surface === 'desktop') {
        test(`the timeline scenes on ${surface} in ${lang}`, () => {
          setLang(lang)

          const found: string[] = []
          const svgs = (tree: unknown) => (JSON.stringify(tree).match(/"alt":"[^"]*"/g) ?? []).map(alt => alt.slice(7, -1))
          const scenes: [string, unknown][] = []

          for (const width of [50, 80, 100]) {
            scenes.push(
              [`running-${width}`, drawTimelineDesktop(EL, TIMELINE, 't1', NOW, width)],
              [`ended-failed-${width}`, drawTimelineDesktop(EL, ENDED_FAILED, 't1', NOW, width)],
              [`open-fork-${width}`, drawTimelineDesktop(EL, TIMELINE, 't1', NOW, width, [{ agentId: 'c1', state: 'running' }])],
              [`page-2-${width}`, drawTimelineDesktop(EL, LONG_TURN, 't1', NOW, width, [], { back: 1 })],
              [`hotspots-${width}`, drawHotspotsDesktop(EL, [{ ...TIMELINE[0]!, turnId: 't0', endedAt: T0 + 90_000, durationMs: 90_000 }, ...TIMELINE], width)],
            )
          }

          for (const [where, tree] of scenes) {
            check(tree, `timeline-${where}`, surface, lang, found)
          }

          expect(found).toEqual([])

          const text = (where: string) => JSON.stringify(scenes.find(([name]) => name === where)![1])
          const isEn = lang === 'en'

          expect(text('running-80')).toContain(isEn ? '● running' : '● 运行')
          expect(text('ended-failed-80')).toContain(isEn ? '~ no result' : '~ 无结果')
          expect(text('ended-failed-80')).toContain(isEn ? '✗ failed' : '✗ 失败')
          expect(text('ended-failed-80')).toContain('"color":"warning"')
          expect(text('ended-failed-80')).toContain('"color":"error"')
          expect(svgs(scenes.find(([name]) => name === 'open-fork-80')![1]).some(alt => alt.includes('worker') && alt.includes(isEn ? 'running' : '运行中'))).toBe(true)
          expect(svgs(scenes.find(([name]) => name === 'running-80')![1]).some(alt => alt.includes('worker') && alt.includes(isEn ? 'end unknown' : '结束时间未知'))).toBe(true)
          expect(svgs(scenes.find(([name]) => name === 'page-2-80')![1]).filter(alt => /^#\d+ /.test(alt)).map(alt => alt.split(' ')[0])).toEqual(['#3', '#4', '#5', '#6', '#7', '#8', '#9', '#10', '#11', '#12'])
          expect(text('page-2-80')).toContain(isEn ? 'steps 4–13 of 23' : '第 4–13 步，共 23 步')
          expect(text('hotspots-100')).toContain(isEn ? 'Open this turn' : '打开这一轮')
        })

        test(`the report reader on ${surface} in ${lang}`, () => {
          setLang(lang)

          const found: string[] = []
          const drawn: string[] = []

          for (const [where, model, finding, over] of READER_SCENES) {
            const tree = drawDesktopPane(READER_EL, readerPane(model, finding, over))

            drawn.push(JSON.stringify(tree))
            check(tree, where, surface, lang, found)
          }

          const isEn = lang === 'en'

          expect(found).toEqual([])
          expect(drawn[0]).toContain(isEn ? 'Finding 1 / 2' : '\u7b2c 1 / 2 \u6761')
          expect(drawn[1]).toContain(isEn ? 'Finding 2 / 2' : '\u7b2c 2 / 2 \u6761')
          expect(drawn[2]).toContain(isEn ? 'No findings at this severity' : '\u8fd9\u4e00\u6863\u6ca1\u6709 finding')
          expect(drawn[3]).toContain('checks_run:')
          expect(drawn[4]).toContain('plain answer')
          expect(drawn[4], 'no transcript, no view Select').not.toContain('dash-view')
          expect(drawn[5]).toContain('"key":"dash-view"')
          expect(drawn[5]).toContain(isEn ? '12 earlier entries not shown' : '\u8f83\u65e9\u7684 12 \u6761\u672a\u663e\u793a')
          expect(drawn[5]).toContain(isEn ? '"Call"' : '"\u8c03\u7528"')
          expect(drawn[5]).toContain('"read_file"')
          expect(drawn[5]).toContain('"source":"const a = list[0]"')
          expect(drawn[5]).toContain('"text":"Need **a.ts** first"')
          expect(drawn[6]).toContain(isEn ? 'Could not read this transcript' : '\u8bfb\u4e0d\u5230\u8fd9\u4efd\u5bf9\u8bdd\u8bb0\u5f55')
        })

        test(`the overview scenes on ${surface} in ${lang}`, () => {
          setLang(lang)

          const isEn = lang === 'en'
          const heredoc = "python3 - <<'EOF'\np = 'hooks/register.tsx'\nEOF"
          const gate = (raw: string, where: string, fail: number, more: Partial<GateRun> = {}): GateRun => ({ at: NOW - 60_000, command: raw.replace(/\s+/g, ' ').slice(0, 120), key: raw, where, pass: 3, fail, failures: [], ...more })
          const worktree = (n: number): WorktreeInfo => ({ name: `agent-${n}`, path: `/r/.claude/worktrees/agent-${n}`, branch: `worktree-agent-${n}`, dirty: n, ahead: 1, behind: n, merged: n === 4, running: n === 1, error: n === 3 ? 'fatal: not a git repository' : null })
          const agent = (agentId: string, over: Partial<AgentRun>): AgentRun => ({ agentId, description: `Fix the overview so a long title never wraps ${agentId}`, subagentType: 'worker', model: 'claude-opus-5-5', background: true, startedAt: NOW - 300_000, tools: 4, lastTool: 'Edit x.ts', state: 'running', lastActivityAt: NOW - 1_000, ...over })
          const ended = { endedAt: NOW - 1_653_000, durationMs: 120_000 }
          const overviewPane = (over: Partial<PaneData>): PaneData => ({ ...readerPane(READER_SCENES[0]![1], 0), page: 'overview', detail: null, pages: [{ page: 'overview', label: 'Overview' }, { page: 'agents', label: 'Agents' }], ...over })
          const busy = overviewPane({
            agents: [...['e1', 'e2', 'e3', 'e4'].map(id => agent(id, { state: 'error', denied: 1, ...ended })), ...['r1', 'r2', 'r3', 'r4'].map(id => agent(id, {})), agent('d1', { state: 'done', ...ended }), agent('x1', { state: 'aborted', ...ended })],
            gates: [gate(`cd /${'p'.repeat(119)} && bun test`, 'main', 2), gate('S=/a/b; W=/c/d; bun test', 'agent-2', 0, { stale: true }), gate('go test ./...', 'agent-1', 1, { unit: 'packages' }), gate(heredoc, 'agent-1', 5)],
            trees: [1, 2, 3, 4].map(worktree),
            guards: [1, 2, 3, 4].map(n => ({ at: NOW - n * 60_000, guard: 'shared-tree-git', decision: 'deny' as const, op: `git checkout b${n}`, cwd: '/r', agentId: null })),
            peers: (['failed', 'permission', 'replied', 'working'] as const).map((state, i) => ({ id: `p${i}`, name: `harness-${i}`, title: 'fix the band', state, since: NOW - 65_000, updatedAt: NOW })),
          })
          const scenes: [string, unknown][] = []

          for (const columns of [50, 80, 120]) {
            scenes.push(
              // Each clock as the Text it shows, so its color is checked too.
              [`overview-busy-${columns}`, withClocks(drawDesktopPane(READER_EL, { ...busy, columns }))],
              [`overview-expanded-${columns}`, withClocks(drawDesktopPane(READER_EL, { ...busy, columns, disclosures: new Set(['more:needsYou', 'tree:/r/.claude/worktrees/agent-1']) }))],
              [`overview-idle-${columns}`, withClocks(drawDesktopPane(READER_EL, overviewPane({ columns, agents: [agent('d1', { state: 'done', ...ended })], seen: { agents: NOW, runs: NOW }, snap: null })))],
            )
          }

          const found: string[] = []

          for (const [where, tree] of scenes) {
            check(tree, where, surface, lang, found)
          }

          expect(found).toEqual([])

          const text = (where: string) => JSON.stringify(scenes.find(([name]) => name === where)![1])
          const flatText = (node: unknown): string =>
            typeof node === 'string' ? node : Array.isArray(node) ? node.map(flatText).join('') : node !== null && typeof node === 'object' ? flatText((node as { children?: unknown[] }).children ?? []) : ''

          expect(text('overview-busy-80'), 'four errored agents and three gates need you').toContain(isEn ? '"4 more"' : '"另有 4 项"')
          // At 80 the gate counts go before the command; at 120 the heredoc's head fits too.
          expect(text('overview-busy-120')).toContain("python3 - <<'EOF'")
          expect(text('overview-busy-80'), 'a heredoc shows its first body line, never its whole body').not.toContain('\\nEOF')
          // A stale pass: its word and 过期, its counts, its age; the command and the tree under it.
          expect(flatText(scenes.find(([name]) => name === 'overview-busy-50')![1])).toContain(isEn ? 'passed · stale  3 pass · 0 fail1m agobun test · agent-2' : '通过 · 过期  3 pass · 0 fail1m前bun test · agent-2')
          expect(text('overview-expanded-80')).toContain(isEn ? '"Collapse"' : '"收起"')
          expect(text('overview-expanded-80')).toContain("cd '/r/.claude/worktrees/agent-1'")
          expect(text('overview-idle-80')).toContain(isEn ? 'Nothing needs you and nothing is running' : '没有需要你处理或运行中的任务')
        })

        test(`the transcript scenes on ${surface} in ${lang}`, options, async ($, on) => {
          mock.clock(on, { now: NOW })
          seat(on, {})
          on('classic.PermissionDenied', () => ({}))
          await $.session.start(SESSION)
          await $.agent.spawn(SPAWN as never)
          await $.classic.PermissionDenied({ tool_name: 'Write', tool_input: {}, tool_use_id: 'toolu_w', reason: 'no', agent_id: 'a1' } as never)

          const isEn = lang === 'en'
          const bash = (stdout: string) => ({ stdout, stderr: '', interrupted: false })
          // Each scene: its row, then texts it must draw, with the theme key a Text of exactly that text takes (null: anywhere in the tree).
          const scenes: [string, object, [string, string | null][]][] = [
            ['tests-passed', resultRow('t_ok', 'Bash', bash(BUN_OK)), [[isEn ? '✓ tests passed' : '✓ 测试通过', 'success'], ['24 pass', 'text'], ['0 fail', 'text']]],
            ['tests-failed', resultRow('t_fail', 'Bash', bash(BUN_FAIL)), [[isEn ? '✗ tests failed' : '✗ 测试失败', 'error'], ['22 pass', 'text'], ['2 fail', 'error'], ['(fail) b > breaks [2ms]', null]]],
            ['go-packages', resultRow('t_go', 'Bash', bash(GO_OK)), [[isEn ? '✓ packages passed' : '✓ 包通过', 'success'], ['2 pass', 'text']]],
            [
              'agent-dispatched',
              useRow('toolu_1', 'Agent', { ...AGENT_INPUT, isolation: 'worktree', model: 'opus' }),
              [[isEn ? '▸ dispatched' : '▸ 已派出', 'inactive'], [isEn ? 'background · worktree · opus' : '后台 · worktree · opus', 'subtle'], [isEn ? 'Show task' : '显示任务', null]],
            ],
            [
              'agent-returned-denied',
              resultRow('toolu_1', 'Agent', AGENT_OUTPUT),
              [[isEn ? '✓ Returned' : '✓ 已返回', 'success'], [isEn ? 'Unverified' : '未验收', 'warning'], ['4m05s · 30 tools · +1 −2', 'text'], [isEn ? '✗ denied 1' : '✗ 被拒1', 'error']],
            ],
            [
              'guard',
              resultRow('t_guard', 'Bash', GUARD_GIT, true),
              [[isEn ? 'Blocked: git checkout on the shared main worktree' : '已拦截：在共享主工作树上执行 git checkout', 'error'], [isEn ? 'What to do' : '怎么办', null], [isEn ? 'Show raw result' : '显示原始结果', null]],
            ],
          ]
          const found: string[] = []

          for (const [where, row, parts] of scenes) {
            const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...row } as never)
            const drawn = await ui.drawn()
            const texts = await ui.findAll({ type: 'Text' })

            check(drawn, `transcript-${where}`, surface, lang, found)

            for (const [part, color] of parts) {
              expect(JSON.stringify(drawn), `${where}: ${part}`).toContain(part)

              if (color !== null) {
                expect(texts.find(one => one.text === part)?.props.color, `${where}: ${part}`).toBe(color)
              }
            }

            await ui.unmount()
          }

          expect(found).toEqual([])
        })
      }

      test(`the transcript rows on ${surface} in ${lang}`, options, async ($, on) => {
        await busy($, on)

        const found: string[] = []

        for (const row of ROWS) {
          const ui = await $.ui.mount({ plugin: PLUGIN, surface: surface as Surface, ...row } as never)

          check(await ui.drawn(), row.requestId, surface, lang, found)
          await ui.unmount()
        }

        expect(found).toEqual([])
      })

      test(`the use-recommended row above a question dialog on ${surface} in ${lang}`, options, async ($, on) => {
        seat(on, {})

        const option = (label: string) => ({ label, description: 'd' })
        const questions = [
          { question: 'Which way?', header: 'Way', options: [option('Bold (Recommended)'), option('Careful')], multiSelect: false },
          { question: 'Which lib?', header: 'Lib', options: [option('dayjs'), option('luxon (Recommended)')], multiSelect: false },
        ]
        const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AskUserQuestion', requestId: 'toolu_q', viewport: { columns: 100, rows: 40 }, props: { tool: 'AskUserQuestion', questions } } as never)
        const drawn = await ui.drawn()
        const isEn = lang === 'en'
        const line = `${isEn ? 'Recommended: ' : '推荐：'}Bold (Recommended) · luxon (Recommended)`

        expect(check(drawn, 'ask-recommended', surface, lang)).toEqual([])
        expect((await ui.find({ key: 'ask-recommended' }))?.props.label).toBe(isEn ? 'Use recommended' : '用推荐项')
        expect((await ui.findAll({ type: 'Text' })).find(one => one.text === line)?.props.color).toBe('subtle')
        expect(JSON.stringify(drawn), "the engine's dialog stays beneath").toContain('"type":"engine"')
        await ui.unmount()
      })
    }
  }
})

describe('the redesigned 外审, GPU, 用量 and 进度 pages, the Agents tiles and the overview gates follow the theme', () => {
  const flat = (node: unknown): string =>
    typeof node === 'string' ? node : Array.isArray(node) ? node.map(flat).join('') : node !== null && typeof node === 'object' ? flat((node as { children?: unknown[] }).children ?? []) : ''
  const svgsOf = (node: unknown): { source: string; alt: string }[] =>
    node === null || typeof node !== 'object'
      ? []
      : Array.isArray(node)
        ? node.flatMap(svgsOf)
        : [...((node as Node).type === 'Svg' ? [(node as Node).props as { source: string; alt: string }] : []), ...((node as Node).children ?? []).flatMap(svgsOf)]
  const keyed = (node: unknown, key: string): Node[] =>
    node === null || typeof node !== 'object'
      ? []
      : Array.isArray(node)
        ? node.flatMap(one => keyed(one, key))
        : [...((node as Node).props?.key === key ? [node as Node] : []), ...((node as Node).children ?? []).flatMap(one => keyed(one, key))]
  const pagePane = (over: Partial<PaneData>): PaneData => ({ ...readerPane(READER_SCENES[0]![1], 0), detail: null, reports: {}, ...over })
  const runid = (n: number) => `20261014-10000${n}-aaaa`
  const RUNS = {
    polledAt: NOW,
    runs: [1, 2, 3, 4, 5].map(n => ({
      runid: runid(n),
      tag: `run-${n}`,
      workdir: '/work',
      mode: 'review',
      createdAt: NOW - n * 600_000,
      models: [
        { name: 'codex', status: n === 1 ? 'RUNNING' : 'DONE', startedAt: NOW - 600_000, ...(n === 1 ? {} : { secs: 600 * n }), outputTokens: 47_100 },
        { name: 'grok', status: n === 2 ? 'CANCELLED' : 'DONE', startedAt: NOW - 600_000, secs: 22 },
      ],
    })),
  }
  // Run 1 this session's, its running codex reading; runs 4 and 5 another session's.
  const SESSION_RUNS = {
    ...RUNS,
    runs: RUNS.runs.map((run, i) => ({
      ...run,
      models: run.models.map(model => ({ ...model, ...(i === 0 && { claudeSession: 'me', tools: 3, lastTool: 'Read board.ts' }), ...(i >= 3 && { claudeSession: 'other' }) })),
    })),
  }
  const gpuOf = (error: string | null): GpuWatch => ({
    host: 'lab-box',
    okAt: NOW - 720_000,
    error,
    sample: {
      kind: 'nvidia',
      gpus: [
        { index: 0, name: 'NVIDIA GeForce RTX 4090', util: 72, memUsed: 18_636, memTotal: 24_564, temp: 58, power: 280 },
        { index: 1, name: 'NVIDIA A100', util: null, memUsed: null, memTotal: null, temp: null, power: null },
      ],
      procs: [{ pid: 4242, name: '/usr/bin/python3', memMiB: 10_240 }],
    },
  })

  for (const surface of SURFACES) {
    for (const lang of LANGS) {
      const options = { options: { language: lang } }

      test(`外审, GPU, 用量, 进度 and Agents mounted, fresh then stale, on ${surface} in ${lang}`, options, async ($, on) => {
        on('fs.read', { path: '/h/.claude/progress/-r/config.json' }, () => ({ value: JSON.stringify({ storage: 'local' }) }))

        const fills: string[] = []

        on('prompt.fill', ($, e) => {
          fills.push(e.text)

          return { isFilled: true } as never
        })

        const fail = await busy($, on)
        const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)
        const found: string[] = []

        for (const key of ['page-mmrun', 'page-gpu', 'page-usage', 'page-progress', 'page-agents']) {
          await pane.press({ key })
          check(await pane.drawn(), `redesign-${key}`, surface, lang, found)
        }

        await fail()
        await pane.press({ key: 'page-gpu' })

        const stale = await pane.drawn()

        check(stale, 'redesign-gpu-stale', surface, lang, found)
        expect(JSON.stringify(stale), 'stale numbers stay, never 0').toContain('52%')

        if (surface === 'desktop') {
          expect((await pane.find({ type: 'Text', text: /^~ / }))?.props.color, 'one warning line').toBe('warning')
          expect(svgsOf(stale).some(svg => svg.source.includes('url(#hatch)')), 'the rings hatched').toBe(true)
          // No host: the empty state's button fills `/gpu ` into the prompt.
          await pane.press({ key: 'gpu-change-host' })
          check(await pane.drawn(), 'redesign-gpu-empty', surface, lang, found)
          await pane.press({ key: 'gpu-fill' })
          expect(fills).toEqual(['/gpu '])
        }

        expect(found).toEqual([])
        await pane.unmount()
      })

      if (surface === 'desktop') {
        test(`the redesigned scenes on ${surface} in ${lang}`, () => {
          setLang(lang)

          const isEn = lang === 'en'
          const gpuPane: PaneData & GpuFill = { ...pagePane({ page: 'gpu', gpu: null, gpuHosts: ['lab-box'] }), onFillGpu: noop }
          const agent = (agentId: string, over: Partial<AgentRun>): AgentRun => ({ agentId, description: `task ${agentId}`, subagentType: 'worker', model: 'claude-opus-5-5', background: true, startedAt: NOW - 300_000, tools: 4, lastTool: 'Edit x.ts', state: 'running', lastActivityAt: NOW - 1_000, ...over })
          const gate = (where: string, fail: number, more: Partial<GateRun> = {}): GateRun => ({ at: NOW - 180_000, command: 'bun test', key: 'bun test', where, pass: 3, fail, failures: [], ...more })
          const scenes: [string, unknown][] = []

          for (const columns of [40, 80, 120]) {
            scenes.push(
              [`reviews-${columns}`, drawDesktopPane(READER_EL, pagePane({ page: 'mmrun', columns, snap: RUNS }))],
              [`reviews-open-${columns}`, drawDesktopPane(READER_EL, pagePane({ page: 'mmrun', columns, snap: RUNS, disclosures: new Set(['fold:runs']), reports: { [runid(1)]: { loadedAt: NOW, models: [reviewed('DONE', READER_REVIEW)] } } }))],
              [`reviews-sessions-${columns}`, drawDesktopPane(READER_EL, pagePane({ page: 'mmrun', columns, snap: SESSION_RUNS, sessionId: 'me' }))],
              [`reviews-sessions-open-${columns}`, drawDesktopPane(READER_EL, pagePane({ page: 'mmrun', columns, snap: SESSION_RUNS, sessionId: 'me', isRunsFoldOpen: true }))],
              [`gpu-empty-${columns}`, drawDesktopPane(READER_EL, { ...gpuPane, columns })],
              [`gpu-fresh-${columns}`, drawDesktopPane(READER_EL, pagePane({ page: 'gpu', columns, gpu: gpuOf(null) }))],
              [`gpu-stale-${columns}`, drawDesktopPane(READER_EL, pagePane({ page: 'gpu', columns, gpu: gpuOf('ssh: timeout') }))],
              [`gpu-tegra-${columns}`, drawDesktopPane(READER_EL, pagePane({ page: 'gpu', columns, gpu: { host: 'jetson', sample: { kind: 'tegra', util: 30, ramUsed: 2048, ramTotal: 8192, temp: 45.5 }, okAt: NOW - 5_000, error: null } }))],
              ...USAGE_WEEKS.map(([where, week]): [string, unknown] => [`${where}-${columns}`, drawDesktopPane(READER_EL, pagePane({ page: 'usage', columns, usage: week }))]),
              ...PROGRESS_READS.map(([where, board]): [string, unknown] => [`${where}-${columns}`, drawDesktopPane(READER_EL, pagePane({ page: 'progress', columns, progress: board }))]),
              [`progress-open-${columns}`, drawDesktopPane(READER_EL, pagePane({ page: 'progress', columns, progress: PROGRESS_READS[4]![1], disclosures: new Set(['fold:progress:l1:active', 'fold:progress:l1:closed']) }))],
              [
                `agents-kpi-${columns}`,
                drawDesktopPane(
                  READER_EL,
                  pagePane({
                    page: 'agents',
                    columns,
                    seen: { agents: NOW - 100_000, runs: 0 },
                    agents: [agent('r1', {}), agent('d1', { state: 'done', endedAt: NOW - 50_000, durationMs: 60_000 }), agent('d2', { state: 'done', endedAt: NOW - 500_000, durationMs: 60_000 }), agent('x1', { state: 'aborted', endedAt: NOW - 500_000, durationMs: 60_000 })],
                  }),
                ),
              ],
              [`overview-gates-${columns}`, withClocks(drawDesktopPane(READER_EL, pagePane({ page: 'overview', columns, gates: [gate('main', 0), gate('agent-2', 1, { stale: true }), gate('agent-1', 13)] })))],
            )
          }

          const found: string[] = []

          for (const [where, tree] of scenes) {
            check(tree, where, surface, lang, found)
          }

          expect(found).toEqual([])

          const tree = (where: string) => scenes.find(([name]) => name === where)![1]
          const text = (where: string) => JSON.stringify(tree(where))

          // 外审: the scale once, three runs and the rest folded, the model rows' bars, the legend once a report is read.
          expect(flat(tree('reviews-80')).split(isEn ? 'shared scale' : '共同刻度').length - 1, 'the scale note once').toBe(1)
          expect(text('reviews-80')).toContain(`"read-run-${runid(3)}"`)
          expect(text('reviews-80'), 'the older runs folded').not.toContain(`"read-run-${runid(4)}"`)
          expect(text('reviews-80')).toContain(isEn ? '"▸ Older · 2"' : '"▸ 更早 · 2"')
          expect(text('reviews-open-80')).toContain(`"read-run-${runid(5)}"`)
          expect(svgsOf(tree('reviews-80')).filter(svg => svg.alt.includes('codex')), 'a K1 bar per codex row').toHaveLength(3)
          expect(svgsOf(tree('reviews-40')), 'the narrow tier draws no bars').toEqual([])
          expect(flat(tree('reviews-open-80'))).toContain('■ Critical 1■ Major 1■ Minor 1')
          expect(text('reviews-80'), 'no legend before the report is read').not.toContain('Critical')
          expect(text('reviews-sessions-80')).toContain(isEn ? '"▸ Runs from other sessions: 2"' : '"▸ 其他 session 的 run：2 个"')
          expect(text('reviews-sessions-80'), 'the other session’s runs folded, no older fold').not.toMatch(new RegExp(`read-run-${runid(4)}|read-run-${runid(5)}|runs-older`))
          expect(text('reviews-sessions-open-80')).toContain(`"read-run-${runid(5)}"`)
          for (const columns of [40, 80, 120]) {
            expect(colorsOf(tree(`reviews-sessions-${columns}`), '3 tools · Read board.ts'), `the activity subtle on its own line at ${columns}`).toEqual(['subtle'])
          }

          // GPU: the empty state's icon and button; tiles, two rings per GPU, the unknown one N/A; stale rings hatched and dim.
          expect(keyed(tree('gpu-empty-80'), 'gpu-fill')[0]?.props?.label).toBe(isEn ? 'Fill in /gpu' : '填入 /gpu')
          expect(svgsOf(tree('gpu-empty-80')), 'the K5 gpu icon').toHaveLength(1)
          expect(text('gpu-empty-80'), 'the host picker stays').toContain('"gpu-input-host"')
          expect(flat(tree('gpu-fresh-80'))).toContain(isEn ? 'Hosts1GPUs2Utilization72%VRAM76%' : '主机1GPU2利用率72%显存76%')
          expect(svgsOf(tree('gpu-fresh-80')).filter(svg => svg.source.includes('stroke-dasharray')), 'one util and one memory ring for the known GPU').toHaveLength(2)
          expect(svgsOf(tree('gpu-fresh-80')).some(svg => svg.source.includes('#8A6CC9'))).toBe(true)
          expect(flat(tree('gpu-fresh-80')), 'an unknown value is N/A, never 0%').toContain('N/A')
          expect(flat(tree('gpu-stale-80'))).toContain(isEn ? '~ stale · not updated for 12m' : '~ 数据过期 · 12m前未更新')
          expect(svgsOf(tree('gpu-stale-80')).filter(svg => svg.source.includes('url(#hatch)'))).toHaveLength(2)
          expect(text('gpu-stale-80'), 'the stale percent dim').toContain('{"color":"inactive"},"children":["72%"]')
          expect(flat(tree('gpu-tegra-80'))).toContain('Tegra')

          // 用量: tiles, the week's columns today in full, today's four kinds, the two threads.
          const week = svgsOf(tree('usage-seven-days-80'))

          expect(flat(tree('usage-seven-days-80'))).toContain(isEn ? 'Today' : '今天')
          expect(week.filter(svg => svg.alt.includes(DAYS[6]!.slice(5)) && svg.alt.includes(DAYS[0]!.slice(5))), 'one week drawing, oldest first').toHaveLength(1)
          expect(week.find(svg => svg.alt.includes(DAYS[0]!.slice(5)))!.source.split('fill-opacity=".45"').length - 1, 'six earlier days lighter').toBe(6)
          expect(week.some(svg => svg.source.includes('#8A6CC9') && svg.source.includes('#D97706')), "today's stack: cache write MEMORY, output FILL.stale").toBe(true)
          expect(flat(tree('usage-seven-days-80'))).toMatch(isEn ? /Main thread.*Subagents/ : /主线程.*子 agent/)
          expect(text('usage-one-day-80'), 'skills stay').toContain('review')

          // 进度: the legend once, a segment per piece, the groups folded by their headers, the buttons kept.
          const requests = text('progress-requests-80')

          expect(svgsOf(tree('progress-requests-80')).some(svg => svg.source.includes('url(#hatch)')), 'the legend hatches blocked').toBe(true)
          expect(svgsOf(tree('progress-requests-80')).find(svg => svg.alt === '1/3')!.source.split('data-part="segment"').length - 1, 'a segment per piece').toBe(4)
          expect(requests).toContain(isEn ? '"▾ In progress · 2"' : '"▾ 进行中 · 2"')
          expect(requests).toContain(isEn ? '"▸ Done · 2"' : '"▸ 已完成 · 2"')
          expect(flat(tree('progress-requests-80')), 'the closed ones folded').not.toContain('Old closed work')
          expect(flat(tree('progress-requests-80'))).toContain('1 / 3')

          for (const key of ['progress-accept-r1', 'progress-dropreq-r1', 'progress-now-accept-r2', 'progress-done-p2', 'progress-drop-p3']) {
            expect(requests, key).toContain(`"${key}"`)
          }

          expect(text('progress-open-80'), 'folded: no buttons of the active group').not.toContain('"progress-accept-r1"')
          expect(flat(tree('progress-open-80')), 'opened: the closed ones').toContain('Old closed work')

          // Agents: the four tiles. The overview's gate counts stay whole beside the age at every width.
          expect(flat(tree('agents-kpi-80'))).toContain(isEn ? 'running1Returned2To verify1Aborted1' : '运行1已返回2待验收1中止1')

          for (const columns of [80, 120]) {
            expect(flat(tree(`overview-gates-${columns}`)), `${columns}`).toContain('3 pass · 13 fail')
            expect(flat(tree(`overview-gates-${columns}`)), `${columns}`).toContain('3 pass · 1 fail')
          }
        })
      }
    }
  }
})

const ledgerLine = (minutes: number, name: string, attributes: Record<string, unknown> = {}, session = 's-own', severity = 'INFO') =>
  JSON.stringify({ timestamp: new Date(NOW - minutes * 60_000).toISOString(), event_name: name, severity_text: severity, attributes: { 'session.id': session, ...attributes } })

/** One event of every kind this session, more than the 8 shown; another session's two. */
const LEDGER = groupEvents(
  parseLedger(
    [
      ledgerLine(60, 'session.start'),
      ledgerLine(55, 'mmrun.start', { 'run.id': 'r1', label: 'review', models: 'codex,grok' }),
      ledgerLine(50, 'guard.block', { 'rule.id': 'secret', target: '.env' }),
      ledgerLine(45, 'gate.result', { command: 'bun test', pass: 24, fail: 0, outcome: 'pass' }),
      ledgerLine(40, 'agent.end', { 'agent.id': 'a1', 'agent.type': 'worker', state: 'done', duration_ms: 245_000 }),
      ledgerLine(35, 'agent.denied', { 'agent.id': 'a2', 'agent.type': 'worker', tool: 'Bash' }, 's-own', 'WARN'),
      ledgerLine(30, 'agent.end', { 'agent.id': 'a3', 'agent.type': 'worker', state: 'aborted' }, 's-own', 'WARN'),
      ledgerLine(25, 'agent.end', { 'agent.id': 'a4', 'agent.type': 'worker', state: 'error' }, 's-own', 'ERROR'),
      ledgerLine(20, 'session.compact', { trigger: 'auto', tokens_before: 186_000, tokens_after: 41_000 }),
      ledgerLine(15, 'mmrun.end', { 'run.id': 'r1', label: 'review', status: 'codex:DONE' }),
      ledgerLine(10, 'rule.hint', { 'rule.id': 'reply-language' }),
      ledgerLine(5, 'gate.result', { command: 'bun test', pass: 22, fail: 2, outcome: 'fail' }, 's-own', 'WARN'),
      ledgerLine(120, 'session.start', {}, 's-peer'),
      ledgerLine(119, 'guard.block', { 'rule.id': 'secret' }, 's-peer'),
    ].join('\n'),
    's-own',
  ),
  's-own',
)

describe('the timeline steps and events views follow the theme', () => {
  for (const surface of SURFACES) {
    for (const lang of LANGS) {
      test(`the steps and the events views on ${surface} in ${lang}`, () => {
        setLang(lang)

        const isEn = lang === 'en'
        const found: string[] = []
        const scenes: [string, unknown][] = []
        const pane = (events: boolean, width: number) => ({
          ...readerPane(READER_SCENES[0]![1], 0),
          page: 'timeline' as const,
          columns: width,
          timeline: TIMELINE,
          ...(events && { disclosures: new Set(['timeline-events']) }),
          timelineEvents: LEDGER,
        })

        for (const width of [100, 50]) {
          if (surface === 'terminal') {
            scenes.push(
              [`steps-${width}`, lineTree(timelineLines(TIMELINE, 't1', NOW, width))],
              [`events-${width}`, lineTree(eventLines(LEDGER, width))],
              [`events-empty-${width}`, lineTree(eventLines(undefined, width))],
            )
          } else {
            scenes.push(
              [`steps-${width}`, timelineBody(EL, pane(false, width))],
              [`steps-folded-${width}`, drawTimelineDesktop(EL, LONG_TURN, 't1', NOW, width, [], { back: 1 })],
              [`events-${width}`, timelineBody(EL, pane(true, width))],
              [`events-all-${width}`, drawEventsDesktop(EL, LEDGER, { disclosures: new Set(['timeline-events-all']) })],
              [`events-empty-${width}`, drawEventsDesktop(EL, undefined)],
            )
          }
        }

        for (const [where, tree] of scenes) {
          check(tree, `timeline-views-${where}`, surface, lang, found)
        }

        expect(found).toEqual([])

        const text = (where: string) => JSON.stringify(scenes.find(([name]) => name === where)![1])

        expect(text('events-100')).toContain(isEn ? 'gate failed' : '门禁失败')
        expect(text('events-100')).toContain(isEn ? 'session s-pe…' : '会话 s-pe…')
        expect(text('events-100')).toContain('"color":"warning"')
        expect(text('events-100')).toContain('"color":"error"')
        expect(text('events-100')).toContain('"color":"success"')
        expect(text('events-empty-50')).toContain(isEn ? 'No events in this session today' : '本会话今天还没有事件')

        if (surface === 'desktop') {
          expect(text('steps-100')).toContain(isEn ? '"Steps"' : '"步骤"')
          expect(text('steps-100')).toContain(isEn ? 'Critical path' : '关键路径')
          expect(text('steps-folded-100')).toContain(isEn ? '▸ #0–#2 · 3 steps' : '▸ #0–#2 · 3 步')
          expect(text('events-100')).toContain(isEn ? '"Events"' : '"事件"')
          expect(text('events-all-100')).toContain(isEn ? 'guard blocked' : '守卫拦截')
        }
      })
    }
  }
})

describe("the band and SessionMode keep to the band's theme keys and Svg paints", () => {
  const BAND_KEYS = ['success', 'error', 'warning', 'permission', 'inactive', 'subtle', 'promptBorder', 'text']
  const PAINTS = new Set([TRACK, MEMORY, ...Object.values(FILL)].map(paint => paint.toUpperCase()))

  /** Colors outside BAND_KEYS; Svg paints outside TRACK, MEMORY and FILL, an interactive Svg, CSS animation or prefers-color-scheme. */
  function strict(node: unknown, where: string, out: string[] = []): string[] {
    if (node === null || typeof node !== 'object') {
      return out
    }

    const el = node as Node
    const props = el.props ?? {}

    for (const name of COLOR_PROPS) {
      if (props[name] !== undefined && !BAND_KEYS.includes(String(props[name]))) {
        out.push(`${where}: ${el.type}.${name}=${String(props[name])}`)
      }
    }

    if (el.type === 'Svg') {
      const source = String(props.source)

      for (const paint of source.match(/#[0-9a-f]{3,8}\b/gi) ?? []) {
        if (!PAINTS.has(paint.toUpperCase())) {
          out.push(`${where}: Svg paint ${paint}`)
        }
      }

      if (props.isInteractive !== undefined || /@keyframes|animation|prefers-color-scheme/.test(source)) {
        out.push(`${where}: Svg animated, themed by media or interactive`)
      }
    }

    for (const child of el.children ?? []) {
      strict(child, where, out)
    }

    return out
  }

  const nodesOf = (node: unknown, type: string, out: Node[] = []): Node[] => {
    const el = node as Node

    if (el?.type === type) {
      out.push(el)
    }

    for (const child of el?.children ?? []) {
      if (typeof child === 'object' && child !== null) {
        nodesOf(child, type, out)
      }
    }

    return out
  }

  const colorOf = (node: unknown, text: string) => nodesOf(node, 'Text').find(one => one.children?.length === 1 && one.children[0] === text)?.props?.color
  const bandAt = (surface: Surface, bodyColumns = 100, maxRows = 20) => ({ ...BAND, surface, props: { ...BAND.props, bodyColumns, maxRows, scroll: { offset: 0, bodyRows: maxRows - 1 } } })

  for (const surface of SURFACES) {
    for (const lang of LANGS) {
      const options = { options: { language: lang } }
      const isEn = lang === 'en'

      test(`the idle band and SessionMode on ${surface} in ${lang}`, options, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })
        const found: string[] = []
        const beneath: unknown[] = []

        on('session.root', () => ({ value: '/work' }))
        on('session.measure', ($, e) => ({ changed: e.changed }))
        on('ui.render', { component: 'SessionMode' }, ($, e) => {
          beneath.push(e.props.modes)

          return BOTTOM as never
        })
        seat(on, {})
        await $.session.start(SESSION)
        await $.agent.spawn(SPAWN as never)
        await clock.advance(5_000)
        await $.turn.complete(complete('a1', 'answer'))
        await clock.advance(25_000)

        const idle = await $.ui.render(bandAt(surface))
        const idleWord = isEn ? 'idle' : '空闲'

        check(idle, 'band-idle', surface, lang, found)
        strict(idle, 'band-idle', found)
        expect(colorOf(idle, idleWord), 'the keyword in success').toBe('success')

        if (surface === 'terminal') {
          expect(linesOf(idle)[0]).toMatch(new RegExp(`^✓ ${idleWord} · `))
          expect(colorOf(idle, '✓'), 'the glyph in success').toBe('success')
          expect(nodesOf(idle, 'Text').filter(one => one.props?.dimColor === true), 'not the whole line dim').toEqual([])
          expect(nodesOf(idle, 'Text').some(one => one.props?.color === 'subtle'), 'the rest subtle').toBe(true)
        } else {
          expect(nodesOf(idle, 'Svg').map(one => String(one.props?.source)), 'a check icon in FILL.done').toEqual([expect.stringContaining(FILL.done)])
        }

        await $.session.measure({
          context: { tokens: 85_000, window: 200_000, percent: 43 },
          rateLimits: [
            { kind: 'seven_day', percentUsed: 96, resetsAt: new Date(NOW + 30_000 + 3_900_000).toISOString() },
            { kind: 'five_hour', percentUsed: 84 },
          ],
          changed: ['context', 'rateLimits'],
        })

        const mode = await $.ui.render({ component: 'SessionMode', surface, requestId: 'session-mode', viewport: { columns: 120, rows: 40, isFullscreen: true }, props: { modes: ['plan'] } } as never)

        check(mode, 'session-mode-rings', surface, lang, found)
        strict(mode, 'session-mode-rings', found)
        expect(found).toEqual([])

        if (surface === 'terminal') {
          expect(beneath.at(-1), 'the terminal hands the modes on as given').toEqual(['plan'])

          return
        }

        expect(beneath, 'the desktop draws SessionMode itself').toEqual([])
        expect(nodesOf(mode, 'Text').map(one => textOf(one))).toEqual(['plan', '43%', isEn ? 'context' : '上下文', '84%', '5h', '96%', isEn ? '7d · resets in 1h05' : '7d · 1h05后重置'])
        expect(
          nodesOf(mode, 'Svg').map(one => [one.props?.width, ...[FILL.running, FILL.stale, FILL.failed].map(paint => String(one.props?.source).includes(paint))]),
          '18 px rings: normal, then amber from 80%, red from 95%',
        ).toEqual([
          [18, true, false, false],
          [18, false, true, false],
          [18, false, false, true],
        ])
        expect([colorOf(mode, '43%'), colorOf(mode, '84%'), colorOf(mode, '96%')]).toEqual(['text', 'warning', 'error'])
      })

      test(`the working band: a P0 card, a running row and a new result, on ${surface} in ${lang}`, options, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })
        const found: string[] = []

        on('session.id', () => ({ value: 'me' }))
        on('session.root', () => ({ value: '/work' }))
        on('fs.write', () => ({ value: undefined }))
        seat(on, {}, { 'p2.json': peerFile('p2', 'ui', 'permission', { detail: 'Bash' }) })
        await $.session.start(SESSION)
        await $.agent.spawn(SPAWN as never)
        await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_2', description: 'Review band' } as never)
        await clock.advance(5_000)
        await $.classic.PostToolUse({ tool_name: 'Read', tool_input: { file_path: '/w/x.md' }, tool_response: 'ok', tool_use_id: 'toolu_r', agent_id: 'a1', cwd: '/work' } as never)
        await $.turn.complete(complete('a2', 'answer'))

        const band = await $.ui.mount({ plugin: PLUGIN, ...bandAt(surface) } as never)
        const drawn = await band.drawn()
        const text = JSON.stringify(drawn)

        check(drawn, 'band-working', surface, lang, found)
        strict(drawn, 'band-working', found)
        expect(found).toEqual([])
        expect(text).toContain(isEn ? 'ui needs approval' : 'ui 待授权')
        expect(text).toContain(isEn ? 'waiting 1m10s' : '已等 1m10s')
        expect((await band.find({ key: 'ask-p2' }))?.props).toMatchObject({ label: isEn ? 'Handle it' : '去处理' })
        expect((await band.find({ key: 'ask-p2' }))?.props.hotkey, 'no number hotkey on the band').toBeUndefined()
        expect((await band.find({ key: 'dash-open' }))?.props.hotkey).toBeUndefined()

        if (surface === 'terminal') {
          const lines = linesOf(drawn)

          expect(lines[0], 'the card framed in warning').toMatch(isEn ? /^╭─ Needs you ─+╮$/ : /^╭─ 需要你 ─+╮$/)
          expect(colorOf(drawn, '!'), 'its ! in warning').toBe('warning')
          expect(lines.find(line => line.startsWith('● Build mm plugin'))).toMatch(/^● Build mm plugin ▰*▱+ {2}Read x\.md 5s$/)
          expect(nodesOf(drawn, 'Text').find(one => one.children?.[0] === 'Read x.md')?.props?.bold, 'the step label bold').toBe(true)
          expect(nodesOf(drawn, 'Text').find(one => one.children?.[0] === '5s')?.props?.dimColor, 'the time dim').toBe(true)
          expect(text, 'no percent without a real progress fraction').not.toMatch(/\d%/)
        } else {
          const svgs = nodesOf(drawn, 'Svg')

          expect(svgs.filter(one => one.props?.width === 16), 'a 16 px icon on the card, the running row and the result').toHaveLength(3)
          expect(svgs.some(one => one.props?.width === 120 && String(one.props?.source).includes(FILL.running)), 'a K1 bar on the running row').toBe(true)
          expect((await band.find({ key: 'dismiss-a2' }))?.props).toMatchObject({ label: '✕' })
          await band.press({ key: 'dismiss-a2' })
          expect(await band.find({ key: 'dismiss-a2' }), '✕ marks the result read: off the band').toBeUndefined()
          expect(JSON.stringify(await band.drawn())).not.toContain('Review band')
        }

        await band.unmount()
      })

      // U4: the engine draws `[-]` and the `n more` row of a band taller than maxRows, and bodyColumns already leaves it five columns.
      test(`the band fits bodyColumns and draws no overflow row of its own on ${surface} in ${lang}`, options, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })

        on('session.id', () => ({ value: 'me' }))
        on('session.root', () => ({ value: '/work' }))
        on('fs.write', () => ({ value: undefined }))
        seat(on, {}, { 'p1.json': peerFile('p1', 'mm', 'failed'), 'p2.json': peerFile('p2', 'ui', 'permission', { detail: 'Bash' }) })
        await $.session.start(SESSION)

        for (const n of [1, 2, 3, 4, 5]) {
          await $.agent.spawn({ ...SPAWN, tool_use_id: `toolu_${n}`, description: `A long task description number ${n}` } as never)
        }

        await clock.advance(5_000)

        for (const [columns, maxRows] of [[40, 20], [40, 3], [100, 8]] as const) {
          const lines = linesOf(await $.ui.render(bandAt(surface, columns, maxRows))).filter(line => line !== 'engine band')

          expect(lines.filter(line => /\bmore\b|另有/.test(line)), `${columns}×${maxRows}: no overflow row`).toEqual([])

          if (surface === 'terminal') {
            expect(lines.filter(line => widthOf(line) > columns), `${columns}×${maxRows}: every row within bodyColumns`).toEqual([])
            // The card's button row is a Box of Texts: its closing ` │` counts with its row.
            expect(lines.filter(line => line !== ' │').length, `${columns}×${maxRows}: within maxRows`).toBeLessThanOrEqual(maxRows)
          }
        }
      })
    }
  }
})

describe('the transcript tool rows, test bar and guard card follow the theme', () => {
  const SVG_COLORS = [TRACK, MEMORY, ...Object.values(FILL)].map(color => color.toUpperCase())
  const bash = (stdout: string) => ({ stdout, stderr: '', interrupted: false })
  const FOREGROUND = { ...AGENT_INPUT, run_in_background: false }
  const withOutput = (row: ReturnType<typeof useRow>, output: unknown) => ({ ...row, props: { ...row.props, output } })

  for (const surface of SURFACES) {
    for (const lang of LANGS) {
      test(`the transcript cards on ${surface} in ${lang}`, { options: { language: lang } }, async ($, on) => {
        mock.clock(on, { now: NOW })
        seat(on, {})
        await $.session.start(SESSION)

        const isEn = lang === 'en'
        const isDesktop = surface === 'desktop'
        const scenes: [string, object][] = [
          ['agent-row', withOutput(useRow('c_agent', 'Agent', FOREGROUND), AGENT_OUTPUT)],
          ['agent-row-partial', withOutput(useRow('c_partial', 'Agent', FOREGROUND), { totalDurationMs: 245_000 })],
          ['agent-row-running', useRow('c_running', 'Agent', FOREGROUND, { isRunning: true })],
          ['mmrun-row', useRow('c_mmrun', 'Bash', { command: `mmrun result codex ${R1}` })],
          ['tests-passed', resultRow('c_ok', 'Bash', bash(BUN_OK))],
          ['tests-failed', resultRow('c_fail', 'Bash', bash(BUN_FAIL))],
          ['tests-unknown-pass', resultRow('c_unknown', 'Bash', bash(ST_FAILED_ONLY))],
          ['guard-git', resultRow('c_git', 'Bash', GUARD_GIT, true)],
          ['guard-raw', resultRow('c_raw', 'Bash', GUARD_RAW, true)],
        ]
        const found: string[] = []
        const drawn: Record<string, { tree: unknown; texts: { text?: string; props: Record<string, unknown> }[]; svgs: Record<string, unknown>[] }> = {}

        for (const [where, row] of scenes) {
          const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...row } as never)
          const tree = await ui.drawn()

          check(tree, `transcript-cards-${where}`, surface, lang, found)
          drawn[where] = { tree, texts: await ui.findAll({ type: 'Text' }), svgs: (await ui.findAll({ type: 'Svg' })).map(svg => svg.props) }
          await ui.unmount()
        }

        expect(found).toEqual([])

        const colorOf = (where: string, text: string) => drawn[where]!.texts.find(one => one.text === text)?.props.color
        const altsOf = (where: string) => drawn[where]!.svgs.map(svg => svg.alt)
        const json = (where: string) => JSON.stringify(drawn[where]!.tree)

        for (const [where] of scenes) {
          for (const svg of drawn[where]!.svgs) {
            const source = String(svg.source)

            expect((source.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).filter(color => !SVG_COLORS.includes(color.toUpperCase())), `${where}: Svg colors`).toEqual([])
            expect(source, `${where}: no animation or color scheme`).not.toMatch(/animat|@keyframes|prefers-color-scheme/)
          }
        }

        if (!isDesktop) {
          // The terminal keeps its text: no icon, no bar, no kv card, no meta on the tool row.
          for (const [where] of scenes) expect(altsOf(where), where).toEqual([])
          expect(json('agent-row')).not.toContain('4m05s')
          expect(json('tests-passed')).toContain('✓ tests · 24 pass · 0 fail')
          expect(colorOf('guard-git', isEn ? '✗ Blocked: shared main worktree git' : '✗ 已阻止:共享主树 git 操作')).toBe('error')
          expect(json('guard-git')).not.toContain('guard-shared-tree-git.py')
          return
        }

        expect(altsOf('agent-row')).toEqual(['Agent'])
        expect(drawn['agent-row']!.svgs[0]).toMatchObject({ width: 14, height: 14 })
        expect(colorOf('agent-row', '4m05s · 30 tools · +1 −2')).toBe('subtle')
        expect(colorOf('agent-row', '+1')).toBe('success')
        expect(colorOf('agent-row', '−2')).toBe('error')
        expect(colorOf('agent-row-partial', '4m05s')).toBe('subtle')
        expect(json('agent-row-partial')).not.toContain('tools')
        expect(json('agent-row-running'), 'a running call has no totals yet').not.toContain('tools')
        expect(altsOf('mmrun-row')).toEqual(['Bash'])

        expect(altsOf('tests-passed')).toEqual(['24 pass · 0 fail'])
        expect(String(drawn['tests-passed']!.svgs[0]!.source)).toContain(FILL.done)
        expect(String(drawn['tests-passed']!.svgs[0]!.source)).not.toContain(FILL.failed)
        expect(altsOf('tests-failed')).toEqual(['22 pass · 2 fail'])
        expect(String(drawn['tests-failed']!.svgs[0]!.source)).toContain(FILL.failed)
        expect(altsOf('tests-unknown-pass'), 'no bar without both counts').toEqual([])

        expect(json('guard-git')).toContain('"borderColor":"error"')
        expect(altsOf('guard-git')).toEqual([isEn ? 'Blocked: shared main worktree git' : '已阻止:共享主树 git 操作'])
        expect(colorOf('guard-git', isEn ? 'Blocked: git checkout on the shared main worktree' : '已拦截：在共享主工作树上执行 git checkout')).toBe('error')

        for (const label of isEn ? ['Command', 'Reason', 'What to do'] : ['命令', '原因', '怎么办']) {
          expect(colorOf('guard-git', label), label).toBe('subtle')
        }

        expect(drawn['guard-git']!.texts.find(one => one.text === 'git checkout')?.props.bold).toBe(true)
        expect(drawn['guard-git']!.texts.find(one => one.text === 'harness · guard-shared-tree-git.py')?.props).toMatchObject({ dimColor: true, italic: true })
        expect(json('guard-raw'), 'no command row when the guard names none').not.toContain(isEn ? '"Command"' : '"命令"')
        expect(drawn['guard-raw']!.texts.find(one => one.text === 'mm · guard.py')?.props).toMatchObject({ dimColor: true, italic: true })
      })
    }
  }
})

describe('the CI row (E2) and the notice row (E3) on the band follow the theme', () => {
  const BAND_KEYS = ['success', 'error', 'warning', 'permission', 'inactive', 'subtle', 'promptBorder', 'text']
  const PAINTS = new Set([TRACK, MEMORY, ...Object.values(FILL)].map(paint => paint.toUpperCase()))
  const PR = JSON.stringify({ number: 12, url: 'https://github.com/o/r/pull/12', headRefName: 'feature', state: 'OPEN' })

  /** Colors outside BAND_KEYS, Svg paints outside TRACK / MEMORY / FILL, an interactive or animated Svg. */
  function strict(node: unknown, where: string, out: string[] = []): string[] {
    const el = node as Node
    const props = el?.props ?? {}

    for (const name of COLOR_PROPS) {
      if (props[name] !== undefined && !BAND_KEYS.includes(String(props[name]))) {
        out.push(`${where}: ${el.type}.${name}=${String(props[name])}`)
      }
    }

    if (el?.type === 'Svg') {
      const source = String(props.source)

      for (const paint of source.match(/#[0-9a-f]{3,8}\b/gi) ?? []) {
        if (!PAINTS.has(paint.toUpperCase())) {
          out.push(`${where}: Svg paint ${paint}`)
        }
      }

      if (props.isInteractive !== undefined || /@keyframes|animation|prefers-color-scheme/.test(source)) {
        out.push(`${where}: Svg animated, themed by media or interactive`)
      }
    }

    for (const child of el?.children ?? []) {
      if (typeof child === 'object' && child !== null) {
        strict(child, where, out)
      }
    }

    return out
  }

  const nodesOf = (node: unknown, type: string, out: Node[] = []): Node[] => {
    const el = node as Node

    if (el?.type === type) {
      out.push(el)
    }

    for (const child of el?.children ?? []) {
      if (typeof child === 'object' && child !== null) {
        nodesOf(child, type, out)
      }
    }

    return out
  }

  for (const surface of SURFACES) {
    for (const lang of LANGS) {
      const isEn = lang === 'en'

      test(`a failing CI row and a notice on ${surface} in ${lang}`, { options: { language: lang } }, async ($, on) => {
        const clock = mock.clock(on, { now: NOW })
        const found: string[] = []

        on('session.id', () => ({ value: 'me' }))
        on('session.root', () => ({ value: '/work' }))
        on('fs.write', () => ({ value: undefined }))

        const faults = seat(on, {})

        faults.replies['git -C /work rev-parse --abbrev-ref HEAD'] = 'feature\n'
        faults.replies['gh pr view --json number,url,headRefName,state'] = PR
        faults.replies['gh pr checks --json name,state,bucket'] = JSON.stringify([
          { name: 'lint', state: 'SUCCESS', bucket: 'pass' },
          { name: 'build', state: 'FAILURE', bucket: 'fail' },
        ])
        await $.session.start(SESSION)
        await clock.advance(1_000)
        await $.command.run(command('notice', 'deploy freeze'))

        const drawn = await $.ui.render({ ...BAND, surface })
        const ciText = `CI ✗ build · PR #12 · ${isEn ? '1s ago' : '1s前'}`
        const noticeText = `${isEn ? 'Notice' : '公告'} · deploy freeze`

        check(drawn, 'band-ci-notice', surface, lang, found)
        strict(drawn, 'band-ci-notice', found)
        expect(found).toEqual([])

        const texts = nodesOf(drawn, 'Text')
        const notice = texts.find(one => one.children?.length === 1 && one.children[0] === noticeText)

        expect(texts.find(one => one.children?.length === 1 && one.children[0] === '✗')?.props?.color, 'the ✗ in error').toBe('error')

        if (surface === 'terminal') {
          expect(linesOf(drawn)).toEqual([ciText, noticeText, 'engine band'])
          expect(notice?.props?.dimColor, 'the notice dim').toBe(true)
          expect(notice?.props?.color, 'and no color of its own').toBeUndefined()
        } else {
          expect(textOf(drawn)).toContain(ciText)
          expect(notice?.props?.color, 'the notice a subtle Text').toBe('subtle')
          expect(nodesOf(drawn, 'Svg').filter(one => one.props?.width === 16), 'one 16 px icon: the CI row, none for the notice').toHaveLength(1)
          expect(String(nodesOf(drawn, 'Svg')[0]?.props?.source)).toContain(FILL.failed)
        }
      })
    }
  }
})
