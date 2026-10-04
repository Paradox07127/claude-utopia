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
import { emptyDay, lastDays, requestNoted, skillNoted, weekOf } from '../hooks/usage'
import type { AgentRun, BoardNode, BoardRead, DashReport, GateRun, TimelineTurn, UsageDay, WorktreeInfo } from '../types'

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
  builds_on,
  depends_on: [],
  at: NOW - hoursAgo * 3_600_000,
  updatedAt: NOW - hoursAgo * 3_600_000,
  commit: null,
})
/** The progress page with no storage chosen, an empty git board, and nodes in all four statuses: four done, so one waits behind a button. */
const PROGRESS_READS: [string, BoardRead][] = [
  ['progress-unchosen', { storage: null, dir: null, nodes: [] }],
  ['progress-empty-git', { storage: 'git', dir: '/r/.notes/board/events', nodes: [] }],
  [
    'progress-all',
    {
      storage: 'local',
      dir: '/h/.claude/dashboard/board/-r/events',
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
]

const lineTree = (lines: Line[]) =>
  lines.map(line => ({ type: 'Text', props: {}, children: line.map(seg => ({ type: 'Text', props: { ...(seg.color !== undefined && { color: seg.color }) }, children: [seg.text] })) }))

// Host types, so a drawn tree is plain data to walk.
const EL = { Box: 'Box', Text: 'Text', Button: 'Button', Svg: 'Svg', Markdown: 'Markdown' } as never
const READER_EL = { Box: 'Box', Text: 'Text', Button: 'Button', Svg: 'Svg', Markdown: 'Markdown', Code: 'Code', Select: 'Select', Input: 'Input' } as never

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
/** The reader at each of its states: a review's first finding and the next, a review without findings, a run report, a bare .out. */
const READER_SCENES: [string, DashReport['models'][number], number][] = [
  ['reader-review', reviewed('DONE', READER_REVIEW), 0],
  ['reader-review-next', reviewed('STALE', READER_REVIEW), 1],
  ['reader-review-empty', reviewed('DONE', { ...READER_REVIEW, verdict: 'approve', findings: [] }), 0],
  ['reader-run', { name: 'grok', status: 'FAIL:1', markdown: reportOf(READER_RUN, '', 'run', false, READER_OUT) }, 0],
  ['reader-out', { name: 'grok', status: 'RUNNING', markdown: reportOf(null, 'plain answer', 'review', false, READER_OUT) }, 0],
]
const noop = () => {}
const readerPane = (model: DashReport['models'][number], finding: number): PaneData => ({
  page: 'mmrun',
  pages: [{ page: 'mmrun', label: 'Reviews' }],
  now: NOW,
  columns: 80,
  agents: [],
  snap: { polledAt: NOW, runs: [{ runid: 'r1', tag: 'design', workdir: '/work', mode: 'review', createdAt: NOW - 400_000, models: [{ name: 'grok', status: model.status, startedAt: NOW - 300_000 }] }] },
  seen: { agents: 0, runs: 0 },
  gpu: null,
  gates: [],
  trees: [],
  guards: [],
  peers: [],
  paneRuns: 5,
  detail: { page: 'mmrun', runid: 'r1', showAll: false, finding },
  reports: { r1: { loadedAt: NOW, models: [model] } },
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
        expect((await band.findAll({ type: 'Text', text: /✗/ })).map(one => one.props.color), 'a failed session is red on the band').toContain('error')
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
        const limit = (percentUsed: number) => ({ kind: 'five_hour', percentUsed, resetsAt: new Date(NOW + 7_800_000).toISOString() })
        const measure = (percentUsed: number) =>
          $.session.measure({ context: { tokens: 85_000, window: 200_000, percent: 43 }, rateLimits: [limit(percentUsed)], cost: { usd: 3.41 }, changed: ['context', 'rateLimits', 'cost'] })

        on('session.root', () => ({ value: '/work' }))
        on('session.measure', ($, e) => ({ changed: e.changed }))
        on('ui.render', { component: 'PromptHint' }, ($, e) => {
          hints.push(e.props)

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
        expect(text(`usage-seven-days-${wide}`), 'the newest day first').toMatch(new RegExp(`${DAYS[0]!.slice(5)}.*${DAYS[6]!.slice(5)}`))
        expect(text(`usage-seven-days-${wide}`), 'review: 7 calls, most first').toMatch(/review.*swarm/)
        expect(text(`usage-seven-days-${wide}`), 'no dialog, no questions section').not.toContain(isEn ? '"Questions"' : '提问')
        // 12 dialogs and 20 questions across the two days, the questions section after the threads'.
        expect(text(`usage-asks-${wide}`)).toMatch(new RegExp(isEn ? 'Subagents.*Questions.*Skills' : '子 agent.*提问.*Skills'))
        expect(text(`usage-asks-${wide}`)).toContain(isEn ? '12 dialogs · 20 questions' : '12 次对话框 · 20 个问题')
        expect(text(`usage-asks-${wide}`)).toContain(isEn ? 'recommended 40% · other option 20% · typed 15% · declined 25%' : '推荐 40% · 其他选项 20% · 自己输入 15% · 拒绝 25%')
        expect(text(`usage-asks-${wide}`)).toContain('<1m 6 · 1–2m 2 · 2–5m 1 · 5–10m 0 · >10m 3')

        if (surface === 'desktop') {
          const alts = (JSON.stringify(scenes.find(([name]) => name === 'usage-seven-days-80')![1]).match(/"alt":"[^"]*"/g) ?? []).map(alt => alt.slice(7, -1))

          expect(alts.length, 'a bar per day').toBe(7)
          expect(alts.every(alt => alt.includes(isEn ? 'shared scale' : '共同刻度') && alt.includes(isEn ? 'cache write' : '缓存写'))).toBe(true)
          expect(text('usage-seven-days-80'), 'skills past three wait behind a button').toContain(isEn ? '"6 more"' : '"另有 6 项"')
        }
      })

      test(`the progress page with 0 nodes and nodes in all four statuses on ${surface} in ${lang}`, () => {
        setLang(lang)

        const isEn = lang === 'en'
        const found: string[] = []
        const scenes: [string, unknown][] = []

        for (const [where, board] of PROGRESS_READS) {
          for (const columns of surface === 'terminal' ? [100, 50] : [50, 80, 120]) {
            const progressPane: PaneData = { ...readerPane(READER_SCENES[0]![1], 0), page: 'progress', detail: null, columns, progress: board }

            scenes.push([`${where}-${columns}`, surface === 'terminal' ? lineTree(progressLines(board, columns)) : drawDesktopPane(READER_EL, progressPane)])
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
        expect(text(`progress-all-${wide}`), 'the groups in order').toMatch(isEn ? /In progress.*Blocked.*To do.*Done/ : /进行中.*受阻.*待办.*已完成/)
        expect(text(`progress-all-${wide}`), 'what a node builds on, by title').toContain(isEn ? 'builds on: Usage page, Ask reminder' : '基于：Usage page、Ask reminder')
        expect(text(`progress-all-${wide}`), 'each status in its theme key').toMatch(/"permission".*"error".*"inactive".*"success"/)

        if (surface === 'desktop') {
          expect(text('progress-all-80'), 'done newest first, the fourth behind a button').toMatch(isEn ? /Ask reminder.*Ask outcomes.*Usage page.*"1 more"/ : /Ask reminder.*Ask outcomes.*Usage page.*"另有 1 项"/)
          expect(text('progress-all-80')).not.toContain('Usage ledger')
        } else {
          expect(text('progress-all-100'), 'done newest first, all of them').toMatch(/Ask reminder.*Ask outcomes.*Usage page.*Usage ledger/)
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

          for (const [where, model, finding] of READER_SCENES) {
            const tree = drawDesktopPane(READER_EL, readerPane(model, finding))

            drawn.push(JSON.stringify(tree))
            check(tree, where, surface, lang, found)
          }

          expect(found).toEqual([])
          expect(drawn[0]).toContain(lang === 'en' ? 'Finding 1 / 2' : '\u7b2c 1 / 2 \u6761')
          expect(drawn[1]).toContain(lang === 'en' ? 'Finding 2 / 2' : '\u7b2c 2 / 2 \u6761')
          expect(drawn[2]).toContain(lang === 'en' ? 'No findings at this severity' : '\u8fd9\u4e00\u6863\u6ca1\u6709 finding')
          expect(drawn[3]).toContain('checks_run:')
          expect(drawn[4]).toContain('plain answer')
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
              [`overview-busy-${columns}`, drawDesktopPane(READER_EL, { ...busy, columns })],
              [`overview-expanded-${columns}`, drawDesktopPane(READER_EL, { ...busy, columns, disclosures: new Set(['more:needsYou', 'tree:/r/.claude/worktrees/agent-1']) })],
              [`overview-idle-${columns}`, drawDesktopPane(READER_EL, overviewPane({ columns, agents: [agent('d1', { state: 'done', ...ended })], seen: { agents: NOW, runs: NOW }, snap: null }))],
            )
          }

          const found: string[] = []

          for (const [where, tree] of scenes) {
            check(tree, where, surface, lang, found)
          }

          expect(found).toEqual([])

          const text = (where: string) => JSON.stringify(scenes.find(([name]) => name === where)![1])

          expect(text('overview-busy-80'), 'four errored agents and three gates need you').toContain(isEn ? '"4 more"' : '"另有 4 项"')
          expect(text('overview-busy-80')).toContain("python3 - <<'EOF'")
          expect(text('overview-busy-80'), 'a heredoc shows its first body line, never its whole body').not.toContain('\\nEOF')
          expect(text('overview-busy-80')).toContain(isEn ? 'agent-2 · 3 pass · stale · 1m ago' : 'agent-2 · 通过 3 · 过期 · 1m前')
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
              [[isEn ? 'Blocked: git checkout on the shared main worktree' : '已拦截：在共享主工作树上执行 git checkout', 'error'], [isEn ? 'Allowed next step' : '允许的下一步', null], [isEn ? 'Show raw result' : '显示原始结果', null]],
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
