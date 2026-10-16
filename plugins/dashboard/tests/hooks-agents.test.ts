import { describe, expect, mock, test } from 'claude-code/testing'

import { widthOf } from '../hooks/agent-model'
import { PLUGIN, SESSION, BOTTOM, IDLE, IDLE_AFTER_WORKER, NOW, R1, bandOf, BAND, PANE, command, SPAWN, ran, denied, usage, complete, BUN_OK, mmruns, seat, mine, writes, textOf, linesOf, rowsOf, stepper, stepIn, drain, mainTurn } from './hooks-kit'

describe('subagent status', () => {
  test('agent.spawn, tools that ran and turn.complete drive the band', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })

    seat(on)
    await $.session.start(SESSION)

    expect(linesOf(await $.ui.render(BAND)), 'no agents: the idle line').toEqual(IDLE)

    await $.agent.spawn(SPAWN as never)
    await clock.advance(5_000)
    await $.classic.PostToolUse(ran('Edit', { file_path: '/w/hooks/register.tsx', old_string: 'a', new_string: 'b' }, 'a1'))
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/README.md' }, 'a1'))
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/main-loop.md' }))

    const running = textOf(await $.ui.render(BAND))

    expect(running).toContain('●')
    expect(running).toMatch(/● Build mm plugin [▰▱]{10} {2}Read README\.md 5s/)
    expect(running, 'composes with the band beneath').toContain('engine band')

    await clock.advance(60_000)
    await $.turn.complete({ answer: 'ok', durationMs: 65_000, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer', usage: usage(12_000) } as never)

    const done = textOf(await $.ui.render(BAND))

    expect(done).toContain('✓')
    expect(done).toContain('worker  Build mm plugin   1m05s  12k out  已返回')

    await clock.advance(21_000)
    expect(linesOf(await $.ui.render(BAND)), 'finished more than 20 s ago: back to idle').toEqual(IDLE_AFTER_WORKER)
  })

  test('a message delivered to an ended agent runs it again at once, its time going on from the turns before', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })

    seat(on)
    on('session.send', ($, e) => (e.to === 'a1' ? { isDelivered: true } : { isDelivered: false, reason: `nobody named ${e.to}` }))
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await clock.advance(65_000)
    await $.turn.complete(complete('a1', 'answer', 65_000))
    await clock.advance(600_000)

    await $.session.send({ to: 'nobody', text: 'one more thing', origin: { kind: 'model' } })
    expect(textOf(await $.ui.render(BAND)), 'not delivered: still ended').not.toContain('●')

    await $.session.send({ to: 'a1', text: 'one more thing', origin: { kind: 'model' } })
    await clock.advance(10_000)
    expect(textOf(await $.ui.render(BAND)), 'running before any tool of it ends, the idle gap left out').toMatch(/● Build mm plugin [▰▱]{10} {2}1m15s/)

    await clock.advance(5_000)
    await $.turn.complete(complete('a1', 'answer', 15_000))
    expect(textOf(await $.ui.render(BAND)), 'done: both turns, not the latest alone').toContain('✓ worker  Build mm plugin   1m20s')
  })

  test('an interrupted agent shows ⊘, and a survey takes the band', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)

    // The engine stamps the drawn node with the plugin that drew it.
    const { part: _part, ...drawn } = (await $.ui.render({ ...BAND, props: { ...BAND.props, hasSurvey: true } })) as typeof BOTTOM & { part?: unknown }
    expect(drawn).toEqual(BOTTOM)

    await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: true, turnId: 't', agentId: 'a1', reason: 'aborted' } as never)
    expect(textOf(await $.ui.render(BAND))).toContain('⊘')
  })

  test('a permission denied to a subagent marks it 被拒1 on the band', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })

    seat(on)

    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.classic.PermissionDenied(denied('Write', 'a1'))
    await $.classic.PermissionDenied(denied('Write'))
    await $.classic.PermissionDenied(denied('Write', 'someone-else'))
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/x' }, 'a1'))

    const band = textOf(await $.ui.render(BAND))

    expect(band, 'the denied call counts as a tool call too').toContain('2 tools  Read x  ✗ 被拒1')

    await $.turn.complete(complete('a1'))
    expect(textOf(await $.ui.render(BAND)), 'still on the band once returned, until the Agents page is opened').toContain('被拒1')

    await $.command.run(command('subagents'))
    expect(textOf(await $.ui.render(PANE))).toContain('✗1')
    await clock.advance(21_000)
    expect(linesOf(await $.ui.render(BAND)), 'seen and past its 20 s: off the band').toEqual(IDLE_AFTER_WORKER)
  })

  test('two agents whose redraw-timer checks overlap start one timer, not one each', async ($, on) => {
    let timers = 0
    let release: (() => void) | undefined
    let onHeld = () => {}
    const isHeld = new Promise<void>(resolve => {
      onHeld = resolve
    })

    // Above mock.clock's hook, so it sees every period asked.
    on('clock.every', { ms: 1000 }, ($, e, next) => {
      timers += 1

      return next(e)
    })
    mock.clock(on, { now: 1_000 })

    const world = seat(on)

    // The first agent's liveness read is held until the second agent's own read: both checks are in flight at once.
    on('state.get', async ($, e, next) => {
      const r = await next(e)
      const list = (r as { value?: { value?: { value?: unknown } } }).value?.value?.value
      const count = (e as { key: string }).key === 'agents' && Array.isArray(list) ? list.length : 0

      if (count === 1 && release === undefined) {
        await new Promise<void>(resolve => {
          release = resolve
          onHeld()
        })
      }

      if (count === 2) {
        release?.()
      }

      return r
    })
    world.beforeSpawn = async n => (n === 2 ? isHeld : undefined)
    await $.session.start(SESSION)
    await Promise.all([$.agent.spawn(SPAWN as never), $.agent.spawn(SPAWN as never)])

    expect(timers).toBe(1)
  })

  test('an agent spawned while the redraw timer decides to stop still gets a timer', async ($, on) => {
    let isHolding = false
    let release = () => {}
    let onHeld = () => {}
    const isHeld = new Promise<void>(resolve => {
      onHeld = resolve
    })

    const clock = mock.clock(on, { now: 1_000 })
    const ticks = writes(on, 'tick')

    seat(on)

    // The timer's liveness check is held once it has read the agents (gates come after them), until a second agent is spawned.
    on('state.get', async ($, e, next) => {
      if (isHolding && (e as { key: string }).key === 'gates') {
        isHolding = false
        await new Promise<void>(resolve => {
          release = resolve
          onHeld()
        })
      }

      return next(e)
    })
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.turn.complete(complete('a1'))
    await clock.advance(19_000)
    isHolding = true

    // a1 ended 20 s ago at this tick: the timer finds nothing live.
    const ticking = clock.advance(1_000)

    await isHeld
    await $.agent.spawn(SPAWN as never)
    release()
    await ticking
    await clock.settle()

    const before = ticks()

    await clock.advance(2_000)

    expect(ticks() - before, 'a2 runs: the band is redrawn every second').toBeGreaterThanOrEqual(2)
  })

  test('the redraw timer redraws the workbench each second, never a Bash result row of the transcript', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command('dashboard'))

    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 'toolu_b',
      props: { tool_use_id: 'toolu_b', tool: 'Bash', output: { stdout: 'hello', stderr: '', interrupted: false }, isErrored: false },
    } as never)
    const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await row.drawn()

    const before = world.toolResults

    world.invalidated = 0
    await clock.advance(5_000)
    expect(world.invalidated, 'no redraw of every instance the plugin drew').toBe(0)
    expect(rowsOf(await pane.drawn()).join('\n'), 'the elapsed time moves').toMatch(/worker .* 5s$/m)
    await row.drawn()
    expect(world.toolResults - before, 'five ticks: the row is not drawn again').toBe(0)
    await row.unmount()
    await pane.unmount()
  })

  test('failed and denied calls are activity: an agent whose calls keep failing is not quiet', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })

    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await clock.advance(100_000)
    await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'make' }, tool_use_id: 'toolu_f', error: 'Exit code 2', agent_id: 'a1' } as never)
    await clock.advance(100_000)
    await $.classic.PermissionDenied(denied('Write', 'a1'))
    await clock.advance(100_000)

    const band = textOf(await $.ui.render(BAND))

    expect(band).toContain('2 tools  Write  ✗ 被拒1')
    expect(band).not.toContain('静默')
  })

  test('an agent that returned and is sent on runs again, its time going on from its turns before; its earlier answer stays readable', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })

    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await clock.advance(5_000)
    await $.turn.complete(complete('a1'))
    expect(textOf(await $.ui.render(BAND))).toContain('已返回')

    await clock.advance(30_000)
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/x' }, 'a1'))

    const band = textOf(await $.ui.render(BAND))

    expect(band, 'its 1 s turn, the idle gap left out').toMatch(/● Build mm plugin [▰▱]{10} {2}Read x 1s/)
    expect(band).not.toContain('已返回')

    await $.command.run(command('subagents'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect(await ui.find({ key: 'read-agent-a1' })).toBeDefined()
    await ui.unmount()
  })

  test('a quiet agent the engine lists as killed, or listed before and no more, is closed ⊘ 已中止; one it never listed stays running; the list is asked every 15 s at most', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn({ ...SPAWN, description: 'Other job' } as never)
    await $.agent.spawn({ ...SPAWN, description: 'Workflow job' } as never)
    world.listed = [
      { id: 'a1', description: 'Build mm plugin', type: 'worker', status: 'killed' },
      { id: 'a2', description: 'Other job', type: 'worker', status: 'running' },
    ]
    await clock.advance(119_000)
    expect(world.listCalls, 'nobody quiet yet').toBe(0)

    await clock.advance(16_000)
    expect(world.listCalls).toBe(2)

    const band = textOf(await $.ui.render(BAND))

    expect(band).toContain('⊘ worker  Build mm plugin')
    expect(band).toContain('已中止')
    expect(band).toMatch(/● Other job +[▰▱]{10} .*静默/)
    expect(band).toMatch(/● Workflow job [▰▱]{10} .*静默/)

    world.listed = []
    await clock.advance(15_000)
    expect(world.listCalls).toBe(3)

    const later = textOf(await $.ui.render(BAND))

    expect(later, 'listed before, dropped now').toMatch(/⊘ worker {2}Other job .*已中止/)
    expect(later, 'never listed: a workflow agent').toMatch(/● Workflow job [▰▱]{10} .*静默/)
  })

  test('an idle agent is listed every 15 s with nothing running: killed, or dropped from the list, it ends ⊘ 已中止', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn({ ...SPAWN, description: 'Other job' } as never)
    world.listed = [
      { id: 'a1', description: 'Build mm plugin', type: 'worker', status: 'idle' },
      { id: 'a2', description: 'Other job', type: 'worker', status: 'idle' },
    ]
    await clock.advance(135_000)
    expect(textOf(await $.ui.render(BAND)), 'both idle').not.toContain('已中止')

    world.listed = [{ id: 'a1', description: 'Build mm plugin', type: 'worker', status: 'killed' }]
    await clock.advance(31_000)

    const band = textOf(await $.ui.render(BAND))

    expect(band).toMatch(/⊘ worker {2}Build mm plugin .*已中止/)
    expect(band, 'listed before, dropped now').toMatch(/⊘ worker {2}Other job .*已中止/)
  })

  test('agent.spawn keeps the loop it happened in as parentAgentId', async ($, on) => {
    let stored: { agentId: string; parentAgentId?: string }[] = []

    on('state.set', ($, e, next) => {
      if (e.plugin === 'dashboard' && e.key === 'agents') {
        stored = (e as unknown as { value: { value: typeof stored } }).value.value
      }

      return next(e)
    })
    mock.clock(on, { now: 1_000 })
    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn({ ...SPAWN, parentAgentId: 'a1' } as never)

    expect(stored.map(one => [one.agentId, one.parentAgentId])).toEqual([['a1', undefined], ['a2', 'a1']])
  })

  test('over budget the band groups like items, and with one row it is a line of counts', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: 1_000 })
    seat(on)
    await $.session.start(SESSION)

    for (let i = 0; i < 4; i += 1) {
      await $.agent.spawn(SPAWN as never)
    }

    await $.turn.complete(complete('a1', 'error'))
    await $.turn.complete(complete('a2'))

    expect(linesOf(await $.ui.render(bandOf(5))), 'four items: more than three, so grouped even with five rows').toEqual(['✗ worker  Build mm plugin      1s  出错', 'agents ●2 ✓1', 'engine band'])
    expect(linesOf(await $.ui.render(bandOf(2)))).toEqual(['✗ worker  Build mm plugin      1s  出错', 'agents ●2 ✓1', 'engine band'])
    expect(linesOf(await $.ui.render(bandOf(1)))).toEqual(['! 待处理1 · ●运行2 · 待读1', 'engine band'])
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn(SPAWN as never)
    expect(linesOf(await $.ui.render(bandOf(99))), 'six items: never more than 5 rows of ours').toEqual(['✗ worker  Build mm plugin      1s  出错', 'agents ●4 ✓1', 'engine band'])
  })
})

describe('workbench', () => {
  test('commands register without built-in names and each lands on its page', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    // progress-close and progress-line come from progress-hooks.ts, which the public export splits into its own plugin (release/split.json)
    expect(world.commands.filter(name => !name.startsWith('progress-'))).toEqual(['dashboard', 'subagents', 'mmrun', 'gpu', 'timeline', 'progress', 'notice'])

    await $.agent.spawn(SPAWN as never)
    await $.command.run(command('dashboard'))
    const first = textOf(await $.ui.render(PANE))

    expect(first, 'first time: 总览').toContain('运行中 · 2')
    expect(first, 'no empty sections').not.toContain('待处理')

    await $.command.run(command('subagents'))
    expect(rowsOf(await $.ui.render(PANE))[2]).toMatch(/^● 运行 +1: worker  Build mm plug… +opus-5-5 +0s +— +0$/)

    await $.command.run(command('mmrun'))
    expect(rowsOf(await $.ui.render(PANE))).toContain('design · review  aaaa  proj [ 阅读 ]')

    await $.command.run(command('gpu', 'gpu-box'))
    await clock.settle()
    expect(textOf(await $.ui.render(PANE))).toContain('GR3D ')

    await $.command.run(command('dashboard'))
    await clock.settle()
    expect(textOf(await $.ui.render(PANE)), '/dashboard reopens the last page').toContain('GR3D ')
    expect(new Set(world.opened.map(one => JSON.stringify(one)))).toEqual(new Set([JSON.stringify({ id: 'dashboard', title: '工作台' })]))
  })

  test('deferred-monitoring-command: each command only opens a page, so each registers immediate and runs mid-turn', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    // progress-close and progress-line wait for the recording chain, so they are not immediate.
    expect(world.specs.filter(one => !one.name.startsWith('progress-')).map(one => [one.name, one.immediate])).toEqual([
      ['dashboard', true],
      ['subagents', true],
      ['mmrun', true],
      ['gpu', true],
      ['timeline', true],
      ['progress', true],
      ['notice', true],
    ])
  })

  test('/progress opens the progress page; with an https canvas url its row names the canvas', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    expect((await $.command.run(command('progress'))).text, 'no canvas file: no row').toBeUndefined()
    expect(world.opened).toEqual([{ id: 'dashboard', title: '工作台' }])
    expect(textOf(await $.ui.render(PANE))).toContain('存放位置')

    world.canvas = '{}'
    expect((await $.command.run(command('progress'))).text, 'no url').toBeUndefined()

    world.canvas = JSON.stringify({ url: 'http://claude.ai/artifact/abc' })
    expect((await $.command.run(command('progress'))).text, 'not https').toBeUndefined()

    world.canvas = JSON.stringify({ url: 'https://claude.ai/artifact/abc' })
    expect((await $.command.run(command('progress'))).text).toBe('画布: https://claude.ai/artifact/abc')
  })

  test('open_progress registers at session.start; a call opens the progress page and names only an https canvas url', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)
    const call = async () =>
      ((await $.tool.call({ tool: 'mcp__dashboard__open_progress', tool_use_id: 'toolu_p' } as never)) as { result?: { type: string; text: string }[] }).result?.[0]

    await $.session.start(SESSION)
    // progress_plan comes from progress-hooks.ts, which the public export splits into its own plugin (release/split.json)
    expect(world.tools.filter(name => name !== 'progress_plan')).toEqual(['open_progress'])

    const bare = await call()

    expect(world.opened).toEqual([{ id: 'dashboard', title: '工作台' }])
    expect(textOf(await $.ui.render(PANE))).toContain('存放位置')
    expect(bare?.text, 'no canvas file').toBe("Opened the workbench's Progress page for the person.")

    world.canvas = JSON.stringify({ url: 'http://claude.ai/artifact/abc' })
    expect((await call())?.text, 'not https').not.toContain('claude.ai')

    world.canvas = JSON.stringify({ url: 'https://claude.ai/artifact/abc' })

    const linked = await call()

    expect(linked?.text).toContain('https://claude.ai/artifact/abc')
  })

  test('the open_progress result row: desktop draws a button to the progress page and a Link only with a canvas file; terminal one line', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)
    const CANVAS = 'https://claude.ai/artifact/abc'
    const row = (surface: 'terminal' | 'desktop', isErrored = false) =>
      ({
        plugin: PLUGIN,
        surface,
        component: 'ToolResult',
        requestId: 'toolu_p',
        props: { tool_use_id: 'toolu_p', tool: 'mcp__dashboard__open_progress', output: [{ type: 'text', text: 'opened' }], isErrored },
      }) as never

    await $.session.start(SESSION)

    const bare = await $.ui.mount(row('desktop'))

    expect((await bare.find({ key: 'open-progress' }))?.props).toMatchObject({ label: '进度', variant: 'secondary' })
    expect(await bare.findAll({ type: 'Link' }), 'no canvas url: no Link').toEqual([])
    await bare.press({ key: 'open-progress' })
    expect(world.opened).toEqual([{ id: 'dashboard', title: '工作台' }])
    expect(textOf(await $.ui.render(PANE))).toContain('存放位置')
    await bare.unmount()

    world.canvas = JSON.stringify({ url: CANVAS })

    const linked = await $.ui.mount(row('desktop'))

    expect((await linked.findAll({ type: 'Link' })).map(one => one.props)).toEqual([expect.objectContaining({ href: CANVAS, label: '画布' })])
    await linked.unmount()

    const terminal = await $.ui.mount(row('terminal'))

    expect(textOf(await terminal.drawn())).toBe(`进度 · /progress · 画布: ${CANVAS}`)
    expect(await terminal.findAll({ type: 'Button' }), 'no button on the terminal').toEqual([])
    await terminal.unmount()

    const before = world.toolResults
    const errored = await $.ui.mount(row('desktop', true))

    expect(textOf(await errored.drawn()), 'errored: the engine draws it').toBe('engine band')
    expect(world.toolResults - before).toBe(1)
    await errored.unmount()
  })

  test('the overview behind another tab reads no worktrees; opened or on screen again it does', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const lists = () => world.runs.filter(argv => argv[0] === 'git' && argv.includes('worktree')).length

    await $.session.start(SESSION)
    await $.command.run(command('dashboard'))
    expect(lists(), 'opening the overview reads them at once').toBe(1)

    world.hidden.add('dashboard')
    await clock.advance(15_000)
    expect(lists(), 'hidden: not read').toBe(1)

    world.hidden.delete('dashboard')
    await clock.advance(15_000)
    expect(lists()).toBe(2)
  })

  test('session.start runs whole: no hook fails, only open_progress registers', async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    // progress_plan comes from progress-hooks.ts, which the public export splits into its own plugin (release/split.json)
    expect(world.tools.filter(name => name !== 'progress_plan')).toEqual(['open_progress'])
    expect(world.logs.filter(one => one.text.includes('failed'))).toEqual([])
  })

  test('a refused command name skips only that command: the others register and the session writes its presence', async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    world.refusedNames.add('subagents')
    await $.session.start(SESSION)
    expect(world.commands.filter(name => !name.startsWith('progress-'))).toEqual(['dashboard', 'mmrun', 'gpu', 'timeline', 'progress', 'notice'])
    expect(mine(world)?.state).toBe('idle')
  })

  test('the page buttons switch pages; 外审 shows the runs', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('dashboard'))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

      expect((await ui.find({ key: 'page-mmrun' }))?.props).toMatchObject({ label: '外审' })
      expect((await ui.find({ key: 'page-mmrun' }))?.props.hotkey, 'no letter hotkey').toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'aaaa' })).toBeUndefined()

      await ui.press({ key: 'page-mmrun' })
      expect(await ui.find({ type: 'Text', text: 'aaaa' })).toBeDefined()
      if (surface === 'terminal') {
        expect((await ui.find({ type: 'Text', text: /grok/ }))?.text).toMatch(/DONE +5m02s +25\.8k tok/)
      } else {
        expect((await ui.findAll({ type: 'Box', text: /grok.*tok/ })).at(-1)?.text, 'the model row: name, status, time, tokens').toMatch(/grok ?✓ 完成 ?5m02s ?25\.8k tok/)
      }

      expect((await ui.find({ key: 'page-mmrun' }))?.props).toMatchObject({ variant: 'primary' })

      await ui.press({ key: 'page-overview' })
      expect(await ui.find({ type: 'Text', text: 'aaaa' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('the band button opens the overview', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: 1_000 })

    const world = seat(on)

    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)

    const ui = await $.ui.mount({ plugin: PLUGIN, ...BAND } as never)

    expect((await ui.find({ key: 'dash-open' }))?.props).toMatchObject({ label: '工作台' })
    expect((await ui.find({ key: 'dash-open' }))?.props.hotkey, 'no hotkey on the band').toBeUndefined()
    await ui.press({ key: 'dash-open' })
    expect(world.opened).toEqual([{ id: 'dashboard', title: '工作台' }])
    expect(textOf(await $.ui.render(PANE))).toContain('运行中 · 1')
  })

})

describe('timeline page', () => {
  test('/timeline opens it on the main loop latest turn; 上一轮 / 下一轮 / 最新 move between main turns, a button with nowhere to go not drawn', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    stepper(on)
    await $.session.start(SESSION)
    await mainTurn($, 'm1', 2)
    await mainTurn($, 'm2', 1)
    await drain($.turn.step(stepIn('s1', 0, 'a9')))

    expect(world.commands).toContain('timeline')
    expect((await $.command.run(command('timeline'))).text).toBeUndefined()

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)
    const shown = async () => {
      const keys: string[] = []

      for (const key of ['timeline-prev', 'timeline-next', 'timeline-latest']) {
        if ((await ui.find({ key })) !== undefined) {
          keys.push(key)
        }
      }

      return keys
    }

    expect((await ui.find({ key: 'page-timeline' }))?.props).toMatchObject({ label: '时间线', variant: 'primary' })
    expect((await ui.find({ key: 'page-timeline' }))?.props.hotkey).toBeUndefined()
    expect((await ui.find({ key: 'timeline-prev' }))?.props.hotkey).toBeUndefined()
    expect((await ui.find({ key: 'timeline-prev' }))?.props).toMatchObject({ label: '上一轮' })
    expect(textOf(await ui.drawn())).toContain('时间线 · 1步')
    expect(await shown(), 'the latest: only back').toEqual(['timeline-prev'])

    await ui.press({ key: 'timeline-prev' })
    expect(textOf(await ui.drawn())).toContain('时间线 · 2步')
    expect(await shown(), 'the first: forward and to the latest').toEqual(['timeline-next', 'timeline-latest'])

    await ui.press({ key: 'timeline-latest' })
    expect(textOf(await ui.drawn())).toContain('时间线 · 1步')
    await mainTurn($, 'm3', 3, true)
    expect(textOf(await ui.drawn()), 'following the latest: a new turn shows').toContain('时间线 · 3步')

    await ui.press({ key: 'timeline-prev' })
    await ui.press({ key: 'timeline-next' })
    expect(textOf(await ui.drawn())).toContain('时间线 · 3步')
    expect(await shown()).toEqual(['timeline-prev'])
    await ui.unmount()
  })

  test('hidden-follow-mode-control: stepping forward to the newest turn follows again, so a new turn shows', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    stepper(on)
    await $.session.start(SESSION)
    await mainTurn($, 'm1', 2)
    await mainTurn($, 'm2', 3)
    await $.command.run(command('timeline'))

    let next = 4

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

      await ui.press({ key: 'timeline-prev' })
      expect(textOf(await ui.drawn()), surface).toContain(`${next - 2}步`)
      await ui.press({ key: 'timeline-next' })
      expect(await ui.find({ key: 'timeline-latest' }), `${surface}: the newest turn needs no 最新`).toBeUndefined()
      await mainTurn($, `m${next}`, next, true)
      expect(textOf(await ui.drawn()), `${surface}: the new turn shows`).toContain(`${next}步`)
      await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: `m${next}`, reason: 'answer' } as never)
      next += 1
      await ui.unmount()
    }
  })

  test('热点 switches to the hotspots of every main turn and 单轮 back; the view is kept, the button has no hotkey', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    stepper(on)
    await $.session.start(SESSION)
    await mainTurn($, 'm1', 2)
    await mainTurn($, 'm2', 1)
    await drain($.turn.step(stepIn('s1', 0, 'a9')))
    await $.command.run(command('timeline'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect((await ui.find({ key: 'timeline-view' }))?.props).toMatchObject({ label: '热点' })
    expect((await ui.find({ key: 'timeline-view' }))?.props.hotkey).toBeUndefined()

    await ui.press({ key: 'timeline-view' })

    const text = textOf(await ui.drawn())

    expect(text).toContain('热点 · 主线程 2轮')
    expect(text).toContain('最慢的回合')
    expect(text).not.toContain('时间线 · ')
    expect((await ui.find({ key: 'timeline-view' }))?.props).toMatchObject({ label: '单轮' })
    expect(await ui.find({ key: 'timeline-prev' }), 'stepping between turns is the single-turn view’s').toBeUndefined()
    await ui.unmount()

    const again = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect(textOf(await again.drawn()), 'the view is kept').toContain('热点 · 主线程 2轮')
    await again.press({ key: 'timeline-view' })
    expect(textOf(await again.drawn())).toContain('时间线 · 1步')
    await again.unmount()
  })

  test('a page whose data cannot be read draws ✗ and why under the page buttons; the other pages still work', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    let isBroken = false

    const { logs } = seat(on)
    on('state.get', ($, e, next) => (isBroken && (e as { key: string }).key === 'timeline' ? ({ deny: 'timeline unreadable' } as never) : next(e)))
    await $.session.start(SESSION)
    await $.command.run(command('timeline'))

    for (const surface of ['terminal', 'desktop'] as const) {
      isBroken = true

      const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)
      const failure = await ui.find({ type: 'Text', text: /^✗ / })

      expect((await ui.find({ key: 'page-timeline' }))?.props, surface).toMatchObject({ variant: 'primary' })
      // The desktop host draws its own close control.
      expect(await ui.find({ key: 'dash-close' }), surface)[surface === 'terminal' ? 'toBeDefined' : 'toBeUndefined']()
      expect(failure?.text, surface).toContain('timeline unreadable')
      expect(failure?.props.color, surface).toBe('error')

      // The desktop reads every page's data up front, so there the failure stays on every page until the read works.
      if (surface === 'terminal') {
        await ui.press({ key: 'page-agents' })
        expect(textOf(await ui.drawn()), 'another page draws').not.toContain('timeline unreadable')
      }

      isBroken = false
      await ui.press({ key: 'page-timeline' })
      expect(await ui.find({ type: 'Text', text: /^✗ / }), `${surface}: drawn again once the read works`).toBeUndefined()
      await ui.unmount()
    }

    expect(logs.some(one => one.to === 'debug' && one.text.includes('timeline unreadable'))).toBe(true)
  })

  test('no turn yet: the empty line and no buttons', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    await $.session.start(SESSION)
    await $.command.run(command('timeline'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect(textOf(await ui.drawn())).toContain('从本次加载起记录；还没有模型请求')
    expect(await ui.find({ key: 'timeline-prev' })).toBeUndefined()
    expect(await ui.find({ key: 'timeline-latest' })).toBeUndefined()
    await ui.unmount()
  })

  test('the redraw timer runs while the page shows a turn not ended, and stops once it ends', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const ticks = writes(on, 'tick')

    seat(on)
    stepper(on)
    await $.session.start(SESSION)
    await $.command.run(command('timeline'))
    await mainTurn($, 'm1', 1, true)

    const running = ticks()

    await clock.advance(3_000)
    expect(ticks() - running, 'a running turn: redrawn every second').toBeGreaterThanOrEqual(3)

    await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 'm1', reason: 'answer' } as never)
    await clock.advance(2_000)

    const ended = ticks()

    await clock.advance(3_000)
    expect(ticks() - ended, 'ended: no more ticks').toBe(0)
  })
})

describe('overview layout', () => {
  test('需要你, 运行中 right-aligned, 已完成 folded into one line with buttons; empty sections not drawn', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R1}/grok.status`] = { text: 'DONE\n', mtimeMs: NOW + 1_000 }

    const world = seat(on, files)

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.agent.spawn(SPAWN as never)
    await $.turn.complete(complete('a1', 'error'))
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn(SPAWN as never)
    await $.turn.complete(complete('a3'))
    await $.command.run(command('dashboard'))

    const lines = rowsOf(await $.ui.render(PANE)).slice(1)

    expect(lines.slice(0, 8)).toEqual([
      expect.stringMatching(/^! 需要你1 · ● 运行2 · 待读2 · 更新 \d+s前$/),
      '需要你 · 1',
      '✗ 1: worker  Build mm plugin  1s  500 out  出错',
      '运行中 · 2',
      expect.stringMatching(/^● 2: 运行 worker · Build mm plugin +0 tools  0s$/),
      expect.stringMatching(/^● 运行 design \/ codex +4m15s$/),
      '已完成',
      '✓ 已返回 1 · ✓ 外审完成 1 [ 看 Agents ] [ 看外审 ]',
    ])
    expect(widthOf(lines[4] ?? ''), 'the time column ends at the pane edge').toBe(70)
    expect(widthOf(lines[5] ?? '')).toBe(70)

    const text = lines.join('\n')

    for (const gone of ['待处理', '最近门禁', '工作树']) {
      expect(text, gone).not.toContain(gone)
    }

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect((await ui.find({ key: 'overview-mmrun' }))?.props).toMatchObject({ label: '看外审' })
    await ui.press({ key: 'overview-agents' })
    expect((await ui.find({ key: 'page-agents' }))?.props, '看 Agents goes to the Agents page').toMatchObject({ variant: 'primary' })
    await ui.press({ key: 'page-overview' })
    expect(await ui.find({ type: 'Text', text: '已返回' }), 'visiting Agents read the returned one').toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '✓ 外审完成 1' })).toBeDefined()
    await ui.unmount()
  })

  test('a running agent quiet for two minutes reads 静默 on the band and the overview, and is not 需要你', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })

    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await clock.advance(60_000)
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/x.md' }, 'a1'))
    await clock.advance(119_000)
    expect(textOf(await $.ui.render(BAND))).not.toContain('静默')

    await clock.advance(1_000)
    expect(textOf(await $.ui.render(BAND))).toMatch(/Read x\.md 3m00s {2}静默 2m00s/)

    await $.command.run(command('dashboard'))

    const lines = rowsOf(await $.ui.render(PANE))

    expect(lines[2]).toBe('运行中 · 1')
    expect(lines[3]).toMatch(/^◐ 静默 2m00s 1: worker · Build mm plugin +1 tools  3m00s$/)
  })

  test('idle: one gray line, then the last three that ended, agents and models by end time', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW - 60_000 }

    seat(on, files)
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.agent.spawn(SPAWN as never)
    await clock.advance(5_000)
    await $.turn.complete(complete('a1'))
    await $.command.run(command('subagents'))

    for (const cmd of ['bun test a', 'bun test b', 'bun test c', 'bun test d']) {
      await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: cmd }, tool_response: { stdout: BUN_OK, stderr: '', interrupted: false }, tool_use_id: 'toolu_g', cwd: '/work' } as never)
    }

    await clock.advance(10_000)

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await ui.press({ key: 'page-overview' })

    const lines = linesOf(await $.ui.render(PANE))

    expect(lines.slice(0, 4)).toEqual([
      '没有需要你处理或运行中的任务',
      '✓ worker · Build mm plugin · 10s 前',
      expect.stringMatching(/^✓ design \/ codex · 1m1\ds 前$/),
      expect.stringMatching(/^✓ design \/ grok · 2m1\ds 前$/),
    ])
    expect(lines[4]).toBe('最近门禁')
    expect(lines.filter(line => line.includes('bun test'))).toHaveLength(3)
    expect(lines.join('\n')).not.toContain('bun test a')
    expect((await ui.find({ type: 'Text', text: '没有需要你处理或运行中的任务' }))?.props).toMatchObject({ dimColor: true })
    expect((await ui.find({ type: 'Text', text: 'design / grok' }))?.props).toMatchObject({ dimColor: true })
    await ui.unmount()
  })
})
