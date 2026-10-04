import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

const ENGINE = { type: 'Text', text: 'engine row' } as const
const PROMPT = '修复 X 的完整任务单正文'
const GUARD_GIT =
  'Blocked on the shared main worktree: `git checkout` would take away uncommitted changes from other sessions or the user. Undo your own edit with a reverse Edit; for a clean baseline open a temporary worktree. Linked worktrees are exempt.'
const GUARD_RAW = 'mm: *.raw is the full event stream (tens of thousands of tokens); do not read it. Use `mmrun status <RUNID>` for status and `mmrun result <model> <RUNID>` for findings.'
const STEP_GIT = 'Undo your own edit with a reverse Edit; for a clean baseline open a temporary worktree'
const STEP_RAW = 'Use `mmrun status <RUNID>` for status and `mmrun result <model> <RUNID>` for findings.'
const BUN_FAIL = ['(pass) a [1ms]', '(fail) b > breaks [2ms]', '', ' 22 pass', ' 2 fail'].join('\n')

const ZH = { options: { language: 'zh-CN' } }
const EN = { options: { language: 'en' } }
const HAN = /\p{Script=Han}/u

/** The first Han character anywhere in a drawn row, props included. */
const hanIn = async (ui: { drawn: () => Promise<unknown> }) => HAN.exec(JSON.stringify(await ui.drawn()))?.[0]

// Stands in for the engine's own drawing beneath the plugin.
const engineDraws = (on: On) => {
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
}

const mountUse = (
  $: Engine,
  surface: Surface,
  id: string,
  tool: string,
  input: unknown,
  state: { isRunning?: boolean; isErrored?: boolean; output?: unknown } = {},
) =>
  $.ui.mount({
    plugin: 'dashboard',
    surface,
    component: 'ToolUse',
    requestId: id,
    props: {
      tool_use_id: id,
      tool,
      input,
      isRunning: state.isRunning ?? false,
      isErrored: state.isErrored ?? false,
      isInterrupted: false,
      ...(state.output === undefined ? {} : { output: state.output }),
    },
  })

const NOW = 1_790_922_800_000
const ROOT = '/h/.claude/mmruns'
const R1 = '20261002-010000-aaaa'

/**
 * ~/.claude/mmruns holding R1 (codex running as pid 111, grok done with 25835 output tokens), polled once
 * by session.start's 3 s tick; `endCodex` marks codex done and lets the next poll read it.
 * `unknownTime` adds kimi, running with no start time; `settings` and `env` are what the engine reports.
 */
async function mmrunSeat(
  $: Engine,
  on: On,
  opts: { settings?: Record<string, unknown>; env?: Record<string, string>; unknownTime?: boolean } = {},
): Promise<{ endCodex: () => Promise<void> }> {
  const clock = mock.clock(on, { now: NOW })
  const files: Record<string, { text: string; mtimeMs?: number }> = {
    'run.meta': { text: `runid=${R1}\nworkdir=/x\ntag=design\nmodels=codex,grok${opts.unknownTime ? ',kimi' : ''}\nmode=review\n`, mtimeMs: NOW - 300_000 },
    ...(opts.unknownTime ? { 'kimi.status': { text: 'RUNNING\n' } } : {}),
    'codex.status': { text: 'RUNNING\n' },
    'codex.started': { text: `${(NOW - 432_000) / 1000}\n` },
    'codex.pid': { text: '111\n' },
    'grok.status': { text: 'DONE\n', mtimeMs: NOW - 120_000 },
    'grok.started': { text: `${(NOW - 422_000) / 1000}\n` },
    'grok.meta': { text: 'secs=302\nexit=0\nusage={"input_tokens":1,"output_tokens":25835}\n' },
  }
  const entry = (name: string) => ({ name, kind: 'file' as const, size: 1, mtimeMs: files[name]?.mtimeMs ?? NOW - 1000, isLink: false })
  const fileOf = (path: string) => (path.startsWith(`${ROOT}/${R1}/`) ? files[path.slice(ROOT.length + R1.length + 2)] : undefined)

  mock.env(on, { HOME: '/h', ...opts.env })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', ($, e) => ({ value: { exitCode: e.argv[2] === '111' ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', ($, e) => {
    if (e.path === ROOT) return { value: [{ name: R1, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    return e.path === `${ROOT}/${R1}` ? { value: Object.keys(files).map(entry) } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', ($, e) => (fileOf(e.path) ? { value: { kind: 'file', size: 1, mtimeMs: fileOf(e.path)?.mtimeMs ?? NOW - 1000, isLink: false } } : { deny: `ENOENT ${e.path}` }))
  on('fs.read', ($, e) => {
    const file = fileOf(e.path)
    return file ? { value: file.text } : { deny: `ENOENT ${e.path}` }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('settings.read', () => ({ value: opts.settings ?? {} }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(3_000)
  await clock.settle()

  return {
    endCodex: async () => {
      delete files['codex.pid']
      files['codex.status'] = { text: 'DONE\n' }
      files['codex.meta'] = { text: 'secs=431\nexit=0\nusage={"output_tokens":1200}\n' }
      await clock.advance(3_000)
      await clock.settle()
    },
  }
}

const mountResult = ($: Engine, surface: Surface, id: string, tool: string, output: unknown, isErrored = false) =>
  $.ui.mount({ plugin: 'dashboard', surface, component: 'ToolResult', requestId: id, props: { tool_use_id: id, tool, output, isErrored } })

const textsOf = async (ui: { findAll: (q: { type?: string }) => Promise<{ text?: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')

describe('Agent ToolUse', () => {
  test('one line with type, task and tags; the task folds behind 任务单', ZH, async ($, on) => {
    engineDraws(on)
    const input = { subagent_type: 'worker', description: '修复 X', prompt: PROMPT, run_in_background: true, isolation: 'worktree' }
    for (const surface of SURFACES) {
      const ui = await mountUse($, surface, `toolu_agent_${surface}`, 'Agent', input, { isRunning: true })
      expect(await ui.find({ text: /worker · 修复 X/ })).toBeDefined()
      expect(await ui.find({ text: '后台' })).toBeDefined()
      expect(await ui.find({ text: 'worktree' })).toBeDefined()
      expect(await ui.find({ text: PROMPT })).toBeUndefined()
      await ui.press({ key: 'task' })
      expect(await ui.find({ type: 'Markdown', text: PROMPT })).toBeDefined()
      await ui.press({ key: 'task' })
      expect(await ui.find({ text: PROMPT })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a background call that has returned is dispatched (▸), not done (✓)', async ($, on) => {
    engineDraws(on)
    const input = { subagent_type: 'worker', description: 'Fix X', prompt: 'do it', run_in_background: true }
    for (const surface of SURFACES) {
      // The terminal colors the glyph alone; the desktop the glyph and its word.
      const ui = await mountUse($, surface, `toolu_bg_${surface}`, 'Agent', input)
      expect((await ui.findAll({ type: 'Text' })).find(t => t.text === (surface === 'terminal' ? '▸' : '▸ dispatched'))?.props.color).toBe('inactive')
      expect(JSON.stringify(await ui.drawn())).not.toContain('✓')
      await ui.unmount()
      const fg = await mountUse($, surface, `toolu_fg_${surface}`, 'Agent', { ...input, run_in_background: false })
      expect((await fg.findAll({ type: 'Text' })).find(t => t.text === (surface === 'terminal' ? '✓' : '✓ Returned'))?.props.color).toBe('success')
      await fg.unmount()
    }
  })
})

describe('Agent ToolResult', () => {
  test('a head line above the engine row', ZH, async ($, on) => {
    engineDraws(on)
    const output = {
      agentId: 'a1',
      agentType: 'worker',
      status: 'completed',
      content: [{ type: 'text', text: 'done' }],
      totalDurationMs: 245000,
      totalToolUseCount: 30,
      totalTokens: 1000,
      toolStats: { readCount: 1, searchCount: 0, bashCount: 2, editFileCount: 3, linesAdded: 164, linesRemoved: 18, otherToolCount: 0 },
      worktreeBranch: 'worktree-agent-abc',
    }
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_ar_${surface}`, 'Agent', output)
      const head = surface === 'terminal' ? ['已返回 · 未验收'] : ['✓ 已返回', '未验收']
      for (const part of [...head, '4m05s', '30 tools', '+164 −18', 'worktree-agent-abc']) {
        expect(await ui.find({ text: part })).toBeDefined()
      }
      expect(await ui.find(ENGINE)).toBeDefined()
      await ui.unmount()
    }
  })

  test('calls of the agent the engine denied: ✗ 被拒N in red on the head line, found by the call id', ZH, async ($, on) => {
    engineDraws(on)
    mock.clock(on, { now: NOW })
    on('ui.invalidate', () => ({ value: undefined }))
    on('ui.panes', () => ({ value: [] }))
    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
    on('classic.PermissionDenied', () => ({}))
    const spawn = { prompt: 'p', description: 'Fix X', subagentType: 'worker', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as const
    await $.agent.spawn({ ...spawn, tool_use_id: 'toolu_denied' })
    for (let i = 0; i < 2; i += 1) {
      await $.classic.PermissionDenied({ tool_name: 'Write', tool_input: {}, tool_use_id: `toolu_w${i}`, reason: 'no', agent_id: 'a1' })
    }
    const output = { agentType: 'worker', totalDurationMs: 5_000, totalToolUseCount: 3 }
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, 'toolu_denied', 'Agent', output)
      // The terminal's head line carries it; the desktop gives it a line of its own.
      const denied = (await ui.findAll({ type: 'Text' })).find(one => one.text === (surface === 'terminal' ? ' · ✗ 被拒2' : '✗ 被拒2'))
      expect(denied?.props.color, surface).toBe('error')
      await ui.unmount()
      const other = await mountResult($, surface, 'toolu_other', 'Agent', output)
      expect(JSON.stringify(await other.drawn())).not.toContain('被拒')
      await other.unmount()
    }
  })

  test('legacy-agent-payload: decided by status; no agentType is named from its spawn or a neutral word; a launch is dispatched', ZH, async ($, on) => {
    engineDraws(on)
    mock.clock(on, { now: NOW })
    on('ui.invalidate', () => ({ value: undefined }))
    on('ui.panes', () => ({ value: [] }))
    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
    on('classic.PermissionDenied', () => ({}))
    const spawn = { prompt: 'p', description: 'Fix X', subagentType: 'worker', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false } as const
    await $.agent.spawn({ ...spawn, tool_use_id: 'toolu_legacy' })
    await $.classic.PermissionDenied({ tool_name: 'Write', tool_input: {}, tool_use_id: 'toolu_w', reason: 'no', agent_id: 'a1' })
    const completed = { agentId: 'a1', status: 'completed', content: [{ type: 'text', text: 'done' }], totalDurationMs: 5_000, totalToolUseCount: 3, totalTokens: 10, prompt: 'p' }
    const launched = { status: 'async_launched', agentId: 'a1', description: 'Fix X', prompt: 'p', outputFile: '/tmp/a1' }
    const remote = { status: 'remote_launched', taskId: 't1', sessionUrl: 'https://example.com/s', description: 'Fix X', prompt: 'p', outputFile: '/tmp/t1' }
    for (const surface of SURFACES) {
      const named = await mountResult($, surface, 'toolu_legacy', 'Agent', completed)
      const drawn = JSON.stringify(await named.drawn())
      for (const part of ['worker', '已返回', '3 tools']) {
        expect(drawn, `${surface} ${part}`).toContain(part)
      }
      expect((await named.findAll({ type: 'Text' })).find(one => /^(?: · )?✗ 被拒1$/.test(one.text ?? ''))?.props.color, surface).toBe('error')
      await named.unmount()
      const neutral = await mountResult($, surface, 'toolu_nobody', 'Agent', completed)
      expect(JSON.stringify(await neutral.drawn()), surface).toContain('子 agent')
      await neutral.unmount()
      for (const [id, output] of [['toolu_legacy', launched], ['toolu_remote', remote]] as const) {
        const ui = await mountResult($, surface, id, 'Agent', output)
        expect((await ui.findAll({ type: 'Text' })).find(one => one.text?.startsWith('▸'))?.props.color, `${surface} ${output.status}`).toBe('inactive')
        expect(JSON.stringify(await ui.drawn())).toContain('已派出')
        expect(JSON.stringify(await ui.drawn())).not.toContain('✓')
        expect(await ui.find(ENGINE)).toBeDefined()
        await ui.unmount()
      }
    }
  })

  test('an output it cannot read is left to the engine', async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_ar0_${surface}`, 'Agent', {})
      expect(await textsOf(ui)).toEqual(['engine row'])
      await ui.unmount()
    }
  })
})

describe('mmrun ToolUse', () => {
  test('wait in the background: subcommand, RUNID, 后台等待', ZH, async ($, on) => {
    engineDraws(on)
    const input = { command: '~/.claude/bin/mmrun wait 20260101-000000-abcd --timeout 3600', run_in_background: true }
    for (const surface of SURFACES) {
      const ui = await mountUse($, surface, `toolu_mw_${surface}`, 'Bash', input)
      for (const part of ['mmrun wait', '20260101-000000-abcd', '后台等待']) {
        expect(await ui.find({ text: part })).toBeDefined()
      }
      await ui.unmount()
    }
  })

  test('review: subcommand and models', async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountUse($, surface, `toolu_mr_${surface}`, 'Bash', { command: 'mmrun review --base main --models codex,grok' })
      expect(await ui.find({ text: 'mmrun review' })).toBeDefined()
      expect(await ui.find({ text: 'codex,grok' })).toBeDefined()
      // The engine's row stays under the heading: it carries the command's output.
      expect(await ui.find(ENGINE)).toBeDefined()
      await ui.unmount()
    }
  })

  test('wait: a card of the run per model, redrawn as the poll changes', ZH, async ($, on) => {
    engineDraws(on)
    const seat = await mmrunSeat($, on)
    const uis = []
    for (const surface of SURFACES) {
      const ui = await mountUse($, surface, `toolu_mc_${surface}`, 'Bash', { command: `mmrun wait ${R1}` }, { isRunning: true })
      for (const part of ['codex', 'grok', '25.8k']) {
        expect(await ui.find({ text: part })).toBeDefined()
      }
      if (surface === 'desktop') {
        expect(await ui.find({ type: 'Svg' })).toBeDefined()
      } else {
        expect(await ui.find({ type: 'Svg' })).toBeUndefined()
      }
      expect(await ui.find({ text: '已结束' })).toBeUndefined()
      uis.push(ui)
    }
    await seat.endCodex()
    for (const ui of uis) {
      expect(await ui.find({ text: '已结束' })).toBeDefined()
      expect(await ui.find(ENGINE)).toBeDefined()
      await ui.unmount()
    }
  })

  test('review: the RUNID comes from the RUN line of its output', async ($, on) => {
    engineDraws(on)
    await mmrunSeat($, on)
    const output = { stdout: `RUN ${R1}  models=codex  mode=review  dir=/x\n`, stderr: '' }
    for (const surface of SURFACES) {
      const ui = await mountUse($, surface, `toolu_mo_${surface}`, 'Bash', { command: 'mmrun review --models codex' }, { output })
      expect(await ui.find({ text: 'grok' })).toBeDefined()
      expect(await ui.find({ text: '25.8k' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('result: no card under the heading', async ($, on) => {
    engineDraws(on)
    await mmrunSeat($, on)
    for (const surface of SURFACES) {
      const ui = await mountUse($, surface, `toolu_mx_${surface}`, 'Bash', { command: `mmrun result codex ${R1}` })
      expect(await ui.find({ text: 'grok' })).toBeUndefined()
      expect(await ui.find({ text: '25.8k' })).toBeUndefined()
      expect(await ui.find({ type: 'Svg' })).toBeUndefined()
      expect(await ui.find(ENGINE)).toBeDefined()
      await ui.unmount()
    }
  })

  test('review ended but its run not polled yet: 等待状态…', ZH, async ($, on) => {
    engineDraws(on)
    await mmrunSeat($, on)
    const output = { stdout: 'RUN 20261002-020000-bbbb  models=codex  mode=review  dir=/x\n', stderr: '' }
    for (const surface of SURFACES) {
      const ui = await mountUse($, surface, `toolu_mn_${surface}`, 'Bash', { command: 'mmrun review --models codex' }, { output })
      expect(await ui.find({ text: '等待状态…' })).toBeDefined()
      expect(await ui.find({ text: 'grok' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a command not starting with mmrun is left to the engine', async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountUse($, surface, `toolu_ml_${surface}`, 'Bash', { command: 'ls mmrun' })
      expect(await textsOf(ui)).toEqual(['engine row'])
      await ui.unmount()
    }
  })
})

// Stands in for the engine's drawing of a command's output: the text itself.
const engineDrawsCommand = (on: On) => {
  on('ui.render', { component: 'CommandOutput' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
}

const mountCommand = ($: Engine, surface: Surface, id: string, command: string, text: string) =>
  $.ui.mount({ plugin: 'dashboard', surface, component: 'CommandOutput', requestId: id, props: { command, args: '', text, isErrored: false } })

describe('mm command output', () => {
  test('mm:review: its output, then the live card of the run', async ($, on) => {
    engineDrawsCommand(on)
    await mmrunSeat($, on)
    const text = `RUN ${R1}  models=codex,grok  mode=review`
    for (const surface of SURFACES) {
      const ui = await mountCommand($, surface, `cmd_review_${surface}`, 'mm:review', text)
      expect((await textsOf(ui))[0]).toBe(text)
      expect(await ui.find({ text: 'grok' })).toBeDefined()
      expect(await ui.find({ text: '25.8k' })).toBeDefined()
      if (surface === 'desktop') {
        expect(await ui.find({ text: 'codex' })).toBeDefined()
        expect(await ui.find({ text: '● RUNNING' })).toBeDefined()
        expect(await ui.find({ type: 'Svg' })).toBeDefined()
      } else {
        expect(await ui.find({ text: 'codex ●' })).toBeDefined()
      }
      await ui.unmount()
    }
  })

  test('mm:run whose run is not polled yet: 等待 mmrun 状态…', ZH, async ($, on) => {
    engineDrawsCommand(on)
    await mmrunSeat($, on)
    const text = 'RUN 20261002-120000-abcd  models=codex,grok  mode=review'
    for (const surface of SURFACES) {
      const ui = await mountCommand($, surface, `cmd_wait_${surface}`, 'mm:run', text)
      expect(await textsOf(ui)).toEqual([text, '等待 mmrun 状态…'])
      expect((await ui.find({ type: 'Text', text: '等待 mmrun 状态…' }))?.props.dimColor).toBe(true)
      await ui.unmount()
    }
  })

  test('another command is left to the engine', async ($, on) => {
    engineDrawsCommand(on)
    await mmrunSeat($, on)
    const text = `RUN ${R1}  models=codex,grok  mode=review`
    for (const surface of SURFACES) {
      const ui = await mountCommand($, surface, `cmd_compact_${surface}`, 'compact', text)
      expect(await textsOf(ui)).toEqual([text])
      await ui.unmount()
    }
  })
})

describe('guard denials', () => {
  test('shared-tree git: blocked head and the next step', ZH, async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_gg_${surface}`, 'Bash', GUARD_GIT, true)
      if (surface === 'terminal') {
        expect(await ui.find({ text: '已阻止:共享主树 git 操作' })).toBeDefined()
        expect(await textsOf(ui)).toContain(STEP_GIT)
      } else {
        // The desktop names the command and gives the whole explanation under 允许的下一步; the raw result is behind its button.
        expect((await ui.find({ type: 'Text', text: '已拦截：在共享主工作树上执行 git checkout' }))?.props.color).toBe('error')
        expect(await ui.find({ type: 'Code' }), 'the title names the command once').toBeUndefined()
        expect(await ui.find({ type: 'Text', text: '允许的下一步' })).toBeDefined()
        expect((await textsOf(ui)).some(text => text.includes(STEP_GIT))).toBe(true)
        expect(await ui.find(ENGINE)).toBeUndefined()
        await ui.press({ key: 'raw' })
      }
      expect(await ui.find(ENGINE)).toBeDefined()
      await ui.unmount()
    }
  })

  test('mmrun raw stream: blocked head', ZH, async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_gr_${surface}`, 'Bash', { stdout: '', stderr: GUARD_RAW, interrupted: false }, true)
      expect(await ui.find({ text: surface === 'terminal' ? '已阻止:读 mmrun 事件流' : '已拦截：读取 mmrun 事件流' })).toBeDefined()
      expect(await textsOf(ui)).toContain(STEP_RAW)
      await ui.unmount()
    }
  })

  test('an ordinary failure is left to the engine', async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_gf_${surface}`, 'Bash', { stdout: '', stderr: 'ls: nope: No such file', interrupted: false }, true)
      expect(await textsOf(ui)).toEqual(['engine row'])
      await ui.unmount()
    }
  })
})

const AGENT_OUTPUT = { agentType: 'worker', totalDurationMs: 245_000, totalToolUseCount: 30, toolStats: { linesAdded: 1, linesRemoved: 2 }, worktreeBranch: 'wt' }

describe('English', () => {
  test('Agent rows: tags, the task, returned and errored heads', EN, async ($, on) => {
    engineDraws(on)
    const input = { subagent_type: 'worker', description: 'Fix X', prompt: 'The full task for X', run_in_background: true, isolation: 'worktree', model: 'opus' }
    for (const surface of SURFACES) {
      const use = await mountUse($, surface, `toolu_ea_${surface}`, 'Agent', input, { isRunning: true })
      expect(await use.find({ text: 'background' })).toBeDefined()
      await use.press({ key: 'task' })
      expect(await hanIn(use)).toBeUndefined()
      await use.unmount()
      const returned = await mountResult($, surface, `toolu_er_${surface}`, 'Agent', AGENT_OUTPUT)
      for (const part of surface === 'terminal' ? ['worker returned · not verified'] : ['✓ Returned', 'Unverified', 'worker']) {
        expect(await returned.find({ text: part })).toBeDefined()
      }
      expect(await hanIn(returned)).toBeUndefined()
      await returned.unmount()
      const errored = await mountResult($, surface, `toolu_ee_${surface}`, 'Agent', AGENT_OUTPUT, true)
      expect(await errored.find({ text: 'worker errored' })).toBeDefined()
      expect(await hanIn(errored)).toBeUndefined()
      await errored.unmount()
    }
  })

  test('mmrun rows: a background wait with its card through the end, runs not polled yet', EN, async ($, on) => {
    engineDraws(on)
    engineDrawsCommand(on)
    const seat = await mmrunSeat($, on)
    const unpolled = { stdout: 'RUN 20261002-020000-bbbb  models=codex  mode=review  dir=/x\n', stderr: '' }
    const uis = []
    for (const surface of SURFACES) {
      const wait = await mountUse($, surface, `toolu_ew_${surface}`, 'Bash', { command: `mmrun wait ${R1}`, run_in_background: true }, { isRunning: true })
      expect(await wait.find({ text: 'waiting in background' })).toBeDefined()
      expect(await hanIn(wait)).toBeUndefined()
      uis.push(wait)
      const review = await mountUse($, surface, `toolu_en_${surface}`, 'Bash', { command: 'mmrun review --models codex' }, { output: unpolled })
      expect(await review.find({ text: 'Waiting for status…' })).toBeDefined()
      expect(await hanIn(review)).toBeUndefined()
      await review.unmount()
      const command = await mountCommand($, surface, `cmd_en_${surface}`, 'mm:run', 'RUN 20261002-120000-abcd  models=codex  mode=review')
      expect(await command.find({ text: 'Waiting for mmrun status…' })).toBeDefined()
      expect(await hanIn(command)).toBeUndefined()
      await command.unmount()
    }
    await seat.endCodex()
    for (const ui of uis) {
      expect(await ui.find({ text: `Ended · mmrun result <model> ${R1} --top` })).toBeDefined()
      expect(await hanIn(ui)).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a model with no known start: its card says so', EN, async ($, on) => {
    engineDraws(on)
    await mmrunSeat($, on, { unknownTime: true })
    const ui = await mountUse($, 'desktop', 'toolu_eu', 'Bash', { command: `mmrun wait ${R1}` }, { isRunning: true })
    expect(await ui.find({ text: 'Elapsed time unknown' })).toBeDefined()
    expect(await hanIn(ui)).toBeUndefined()
    await ui.unmount()
  })

  test('guard denials: the English head and the next step', EN, async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const git = await mountResult($, surface, `toolu_eg_${surface}`, 'Bash', GUARD_GIT, true)
      if (surface === 'desktop') await git.press({ key: 'raw' })
      expect(await textsOf(git)).toEqual(
        surface === 'terminal'
          ? ['✗ Blocked: shared main worktree git', STEP_GIT, 'engine row']
          : ['Blocked: git checkout on the shared main worktree', 'Allowed next step', `${STEP_GIT}. Linked worktrees are exempt.`, 'engine row'],
      )
      expect(await hanIn(git)).toBeUndefined()
      await git.unmount()
      const raw = await mountResult($, surface, `toolu_eraw_${surface}`, 'Bash', { stdout: '', stderr: GUARD_RAW, interrupted: false }, true)
      if (surface === 'desktop') await raw.press({ key: 'raw' })
      expect(await textsOf(raw)).toEqual(
        surface === 'terminal' ? ['✗ Blocked: reading the mmrun event stream', STEP_RAW, 'engine row'] : ['Blocked: reading the mmrun event stream', 'Allowed next step', STEP_RAW, 'engine row'],
      )
      expect(await hanIn(raw)).toBeUndefined()
      await raw.unmount()
    }
  })

  test('a test run: counts, failures and the full output', EN, async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_et_${surface}`, 'Bash', { stdout: BUN_FAIL, stderr: '', interrupted: false })
      expect(JSON.stringify(await ui.drawn())).toContain(surface === 'terminal' ? 'Full output' : 'Show output')
      await ui.press({ key: 'full' })
      expect(await ui.find(ENGINE)).toBeDefined()
      expect(await hanIn(ui)).toBeUndefined()
      await ui.unmount()
    }
  })
})

describe('Chinese', () => {
  test('errored head, unknown time, full output', ZH, async ($, on) => {
    engineDraws(on)
    await mmrunSeat($, on, { unknownTime: true })
    const card = await mountUse($, 'desktop', 'toolu_zu', 'Bash', { command: `mmrun wait ${R1}` }, { isRunning: true })
    expect(await card.find({ text: '耗时未知' })).toBeDefined()
    await card.unmount()
    const errored = await mountResult($, 'terminal', 'toolu_ze', 'Agent', AGENT_OUTPUT, true)
    expect(await errored.find({ text: 'worker 出错' })).toBeDefined()
    await errored.unmount()
    const tests = await mountResult($, 'terminal', 'toolu_zt', 'Bash', { stdout: BUN_FAIL, stderr: '', interrupted: false })
    expect(JSON.stringify(await tests.drawn())).toContain('完整输出')
    await tests.unmount()
  })
})

describe('a row hook that fails', () => {
  test('the engine draws its own row; one debug line however often it fails', async ($, on) => {
    engineDraws(on)
    const logs: { text: string; to: string }[] = []
    on('ui.log', ($, e) => {
      logs.push({ text: e.text, to: e.to })
      return { value: undefined }
    })
    on('state.get', ($, e, next) => ((e as { key: string }).key === 'agents' ? ({ deny: 'agents unreadable' } as never) : next(e)))
    const output = { agentType: 'worker', totalDurationMs: 5_000, totalToolUseCount: 3 }
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_fail_${surface}`, 'Agent', output)
      expect(await textsOf(ui), surface).toEqual(['engine row'])
      await ui.unmount()
    }
    const debug = logs.filter(one => one.to === 'debug')
    expect(debug).toHaveLength(1)
    expect(debug[0]?.text).toContain('dashboard: ui.render ToolResult Agent hook failed')
    expect(debug[0]?.text).toContain('agents unreadable')
  })
})

describe('language auto', () => {
  const backgroundWait = async ($: Engine) => {
    const ui = await mountUse($, 'terminal', 'toolu_auto', 'Bash', { command: `mmrun wait ${R1}`, run_in_background: true })
    const texts = await textsOf(ui)
    await ui.unmount()
    return texts
  }

  test('session.start follows the settings language', async ($, on) => {
    engineDraws(on)
    await mmrunSeat($, on, { settings: { language: '简体中文' }, env: { LANG: 'en_US.UTF-8' } })
    expect(await backgroundWait($)).toContain('  后台等待')
  })

  test('no settings language: LANG', async ($, on) => {
    engineDraws(on)
    await mmrunSeat($, on, { env: { LANG: 'zh_CN.UTF-8' } })
    expect(await backgroundWait($)).toContain('  后台等待')
  })

  test('neither: English', async ($, on) => {
    engineDraws(on)
    await mmrunSeat($, on)
    expect(await backgroundWait($)).toContain('  waiting in background')
  })
})
