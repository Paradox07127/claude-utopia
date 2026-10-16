import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On, RenderInput } from 'claude-code'

import { widthOf } from '../hooks/agent-model'
import { PLUGIN, SESSION, BOTTOM, IDLE, NOW, ROOT, R1, R4, BAND, hintOf, PANE, command, SPAWN, ran, denied, usage, complete, NVIDIA_RUN, measure, FILLED, SUMMARY, runMeta, mmruns, seat, PROMPT, peer, writes, textOf, linesOf, colorsOf, boxesWithButton, isDimText, dimTexts, rowsOf, stepper, stepIn, drain, mainTurn, MM } from './hooks-kit'

describe('cold cache', () => {
  const REPLIED = { answer: 'done', durationMs: 2_000, isAborted: false, turnId: 't', reason: 'answer', usage: usage(10) } as never
  const MINUTE = 60_000
  const switched = (cache_ttl: '5m' | '1h') =>
    ({ from_model: 'a', to_model: 'b', requested_model: null, source: 'command', context_tokens: 1, prompt_cache_warm: true, cache_ttl, estimated_cache_write_usd: 1, pricing: 'catalog' }) as never

  test('idle past the TTL after a main reply: one line with the tokens to rewrite; the next prompt clears it', { timeoutMs: 60_000, options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await $.turn.complete(REPLIED)
    await measure($, FILLED)
    await clock.advance(59 * MINUTE)
    expect(linesOf(await $.ui.render(BAND)), 'inside the TTL').toEqual(IDLE)

    await clock.advance(MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 1h00m · 下一条重写约 182k tokens', 'engine band'])

    await clock.advance(12 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 1h12m · 下一条重写约 182k tokens', 'engine band'])

    await $.prompt.submit(PROMPT)
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)
  })

  test('a subagent turn.complete does not restart the count', { timeoutMs: 60_000, options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    await $.session.start(SESSION)
    await $.turn.complete(REPLIED)
    await measure($, FILLED)
    await clock.advance(30 * MINUTE)
    await $.turn.complete(complete('a1'))
    await clock.advance(30 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 1h00m · 下一条重写约 182k tokens', 'engine band'])
  })

  test('a PostModelSwitch with a 5m TTL turns the cache cold after 6 minutes; no tokens known, no second half', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    await $.session.start(SESSION)
    await $.classic.PostModelSwitch(switched('5m'))
    await $.turn.complete(REPLIED)
    await clock.advance(4 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)

    await clock.advance(2 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 6m00s', 'engine band'])
  })

  test('assumed-cache-duration: the transcript\'s last main reply that wrote the cache sets the TTL; a subagent\'s line after it does not', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const reply = (written: Record<string, number>, isSidechain: boolean) => JSON.stringify({ type: 'assistant', isSidechain, message: { usage: { cache_creation: written } } })

    world.stdout = ['":"cut by tail"}', reply({ ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 }, false), reply({ ephemeral_1h_input_tokens: 500 }, true), ''].join('\n')
    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], last_assistant_message: 'done', transcript_path: '/t/me.jsonl' } as never)
    await $.turn.complete(REPLIED)
    expect(world.runs).toContainEqual(['tail', '-c', '262144', '/t/me.jsonl'])

    await clock.advance(4 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)

    await clock.advance(2 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 6m00s', 'engine band'])
  })

  test('a transcript that tells no TTL keeps the one before: a turn.complete before the Stop is counted with it', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    await $.session.start(SESSION)
    await $.classic.PostModelSwitch(switched('5m'))
    await $.prompt.submit(PROMPT)
    await $.turn.complete(REPLIED)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], last_assistant_message: 'done', transcript_path: '/t/me.jsonl' } as never)
    await clock.advance(6 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 6m00s', 'engine band'])
  })

  test('reply-based-cache-expiry: the TTL counts from the last main request, so a long tool phase after it eats into it; a subagent request does not', { timeoutMs: 60_000, options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    stepper(on)
    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await mainTurn($, 'm1', 1, true)
    await clock.advance(30 * MINUTE)
    await drain($.turn.step(stepIn('s1', 0, 'a9')))
    await clock.advance(20 * MINUTE)
    await $.turn.complete({ ...(REPLIED as object), turnId: 'm1' } as never)
    await clock.advance(9 * MINUTE)
    expect(linesOf(await $.ui.render(BAND)), '59 minutes after the request').toEqual(IDLE)

    await clock.advance(MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 1h00m', 'engine band'])
  })

  test('a resume two hours after the last response is cold at once', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    await $.session.start(SESSION)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 7200, context_tokens: 182_000, prompt_cache_likely_expired: true } as never)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 2h00m · 下一条重写约 182k tokens', 'engine band'])
  })

  test('a resume 10 minutes after a reply that wrote a 5m cache is cold at once: the transcript tells the TTL', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    world.stdout = [JSON.stringify({ type: 'assistant', isSidechain: false, message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 900 } } } }), ''].join('\n')
    await $.session.start(SESSION)
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/t/me.jsonl', seconds_since_last_response: 600, prompt_cache_likely_expired: true } as never)
    expect(world.runs).toContainEqual(['tail', '-c', '262144', '/t/me.jsonl'])
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 10m00s', 'engine band'])
  })

  test('a resume the engine judges expired is cold though the transcript tells no TTL; the next main reply is warm', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    await $.session.start(SESSION)
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/t/me.jsonl', seconds_since_last_response: 600, prompt_cache_likely_expired: true } as never)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 10m00s', 'engine band'])

    await $.prompt.submit(PROMPT)
    await $.turn.complete(REPLIED)
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)
  })

  test('a resume\'s context_tokens is the cold line\'s alone: the prompt hint waits for the engine\'s measurement', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 7200, context_tokens: 182_000, prompt_cache_likely_expired: true } as never)
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 —')
  })

  test('a /clear ends the cold line and the context figures', { timeoutMs: 60_000, options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.turn.complete(REPLIED)
    await measure($, FILLED)
    await $.session.end({ reason: 'clear', sessionId: 'me' } as never)
    await clock.advance(61 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)

    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 —')
  })
})

describe('context under the prompt', () => {
  const HOUR = 3_600_000
  const at = (ms: number) => new Date(NOW + ms).toISOString()
  const FIVE_HOUR = { kind: 'five_hour', percentUsed: 42, resetsAt: at(2 * HOUR + 10 * 60_000) }
  const SEVEN_DAY = { kind: 'seven_day', percentUsed: 12, resetsAt: at(3 * 24 * HOUR) }
  const HALF = { context: { tokens: 85_000, window: 200_000, percent: 41 } }

  test('terminal: the engine\'s tokens, window and percent end the tail, after any tail already there, working or drafting', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await measure($, HALF)

    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1), 'the percent as the engine gave it, not 85/200').toMatchObject({ hint: '? for shortcuts', tail: '上下文 85k/200k · 41%' })

    await $.ui.render(hintOf('terminal', { tail: 'pill', isWorking: true, isDraft: true }))
    expect(world.hints.at(-1)?.tail).toBe('pill · 上下文 85k/200k · 41%')
  })

  test('desktop: the hint itself carries it', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await measure($, HALF)

    await $.ui.render(hintOf('desktop'))
    expect(world.hints.at(-1)?.hint).toBe('? for shortcuts · 上下文 85k/200k · 41%')
  })

  const modeOf = (surface: 'terminal' | 'desktop'): RenderInput<'SessionMode'> => ({
    component: 'SessionMode',
    surface,
    requestId: 'session-mode',
    viewport: { columns: 120, rows: 40, isFullscreen: true },
    props: { modes: ['plan'] },
  })
  /** The SessionMode labels that reach the engine beneath, one list per render. */
  const modesBeneath = (on: On) => {
    const seen: (readonly string[])[] = []

    on('ui.render', { component: 'SessionMode' }, ($, e) => {
      seen.push(e.props.modes)

      return BOTTOM as never
    })

    return seen
  }

  // The desktop app shows SessionMode only as a tree a plugin draws: an engine node beneath draws nothing there.
  test('desktop: SessionMode draws the modes, the context and every rate-limit window itself as rings, 5h first', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const modes = modesBeneath(on)

    seat(on)
    await $.session.start(SESSION)
    await measure($, { ...HALF, rateLimits: [SEVEN_DAY, FIVE_HOUR], cost: { usd: 3.4123 }, changed: ['context', 'rateLimits', 'cost'] })

    const ui = await $.ui.mount({ plugin: PLUGIN, ...modeOf('desktop') } as never)

    expect((await ui.findAll({ type: 'Text' })).map(one => textOf(one))).toEqual(['plan', '41%', '上下文', '42%', '5h · 2h10后重置', '12%', '7d · 3d0h后重置'])
    expect((await ui.findAll({ type: 'Svg' })).map(one => one.props.alt)).toEqual(['上下文 41%', '5h 42% · 2h10m后重置', '7d 12% · 3d0h后重置'])
    expect((await ui.findAll({ type: 'Svg' })).map(one => one.props.width), '18 px rings').toEqual([18, 18, 18])
    expect((await ui.findAll({ type: 'Text', text: '42%' })).map(one => one.props.bold), 'the percent bold').toEqual([true])
    expect(modes, 'not handed to the engine').toEqual([])
  })

  test('desktop: a narrow SessionMode drops the labels and keeps the rings and percents', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    await $.session.start(SESSION)
    await measure($, { ...HALF, rateLimits: [SEVEN_DAY, FIVE_HOUR], changed: ['context', 'rateLimits'] })

    const ui = await $.ui.mount({ plugin: PLUGIN, ...modeOf('desktop'), viewport: { columns: 60, rows: 40, isFullscreen: true } } as never)

    expect((await ui.findAll({ type: 'Text' })).map(one => textOf(one))).toEqual(['plan', '41%', '42%', '12%'])
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
  })

  test('desktop: SessionMode colors each ring by how much is used: under 80% normal, 80% to 94% amber', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    await $.session.start(SESSION)
    await measure($, { ...HALF, rateLimits: [{ ...SEVEN_DAY, percentUsed: 80 }, { ...FIVE_HOUR, percentUsed: 79 }], changed: ['context', 'rateLimits'] })

    const ui = await $.ui.mount({ plugin: PLUGIN, ...modeOf('desktop') } as never)
    const svgs = await ui.findAll({ type: 'Svg' })

    expect((await ui.findAll({ type: 'Text' })).map(one => textOf(one))).toEqual(['plan', '41%', '上下文', '79%', '5h · 2h10后重置', '80%', '7d · 3d0h后重置'])
    expect(svgs).toHaveLength(3)
    expect(String(svgs[1]?.props.source), 'under 80%: blue').toContain('stroke="#0284C7"')
    expect(String(svgs[2]?.props.source), '80% to 94%: amber').toContain('stroke="#D97706"')
    expect((await ui.find({ type: 'Text', text: '79%' }))?.props.color).toBe('text')
    expect((await ui.find({ type: 'Text', text: '80%' }))?.props.color).toBe('warning')
  })

  test('desktop: SessionMode draws a window at 95% or more in red', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    await $.session.start(SESSION)
    await measure($, { ...HALF, rateLimits: [{ ...FIVE_HOUR, percentUsed: 95 }, { ...SEVEN_DAY, percentUsed: 94 }], changed: ['context', 'rateLimits'] })

    const ui = await $.ui.mount({ plugin: PLUGIN, ...modeOf('desktop') } as never)
    const svgs = await ui.findAll({ type: 'Svg' })

    expect(svgs).toHaveLength(3)
    expect(String(svgs[1]?.props.source)).toContain('stroke="#DC2626"')
    expect(String(svgs[2]?.props.source), '94%: still amber').toContain('stroke="#D97706"')
    expect((await ui.find({ type: 'Text', text: '95%' }))?.props.color).toBe('error')
  })

  test('desktop: SessionMode with no rate limits but a cost adds the cost', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const modes = modesBeneath(on)

    seat(on)
    await $.session.start(SESSION)
    await measure($, { ...HALF, cost: { usd: 3.4123 }, changed: ['context', 'cost'] })

    const ui = await $.ui.mount({ plugin: PLUGIN, ...modeOf('desktop') } as never)

    expect((await ui.findAll({ type: 'Text' })).map(one => textOf(one))).toEqual(['plan & $3.41', '41%', '上下文'])
    expect(modes, 'not handed to the engine').toEqual([])
  })

  test('desktop: SessionMode with neither a limit nor a cost draws the modes as given', async ($, on) => {
    mock.clock(on, { now: NOW })

    seat(on)
    await $.session.start(SESSION)

    const bare = await $.ui.mount({ plugin: PLUGIN, ...modeOf('desktop') } as never)

    expect((await bare.findAll({ type: 'Text' })).map(one => textOf(one)), 'nothing measured').toEqual(['plan'])
    await bare.unmount()
    await measure($, HALF)

    const context = await $.ui.mount({ plugin: PLUGIN, ...modeOf('desktop') } as never)

    expect((await context.findAll({ type: 'Text' })).map(one => textOf(one)), 'only the context').toEqual(['plan', '41%', 'context'])
  })

  test('desktop: SessionMode carries two buttons that open the workbench on the overview and on progress', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)

    const ui = await $.ui.mount({ plugin: PLUGIN, ...modeOf('desktop') } as never)

    expect((await ui.find({ key: 'mode-workbench' }))?.props).toMatchObject({ label: '工作台', variant: 'secondary' })
    expect((await ui.find({ key: 'mode-progress' }))?.props).toMatchObject({ label: '进度', variant: 'secondary' })
    await ui.press({ key: 'mode-progress' })
    expect(world.opened).toEqual([{ id: 'dashboard', title: '工作台' }])
    expect(textOf(await $.ui.render(PANE))).toContain('存放位置')
    await ui.press({ key: 'mode-workbench' })
    expect(world.opened).toHaveLength(2)
    expect(textOf(await $.ui.render(PANE))).not.toContain('存放位置')
  })

  test('terminal: SessionMode keeps the modes as given, the hint tail already has the limit', async ($, on) => {
    mock.clock(on, { now: NOW })

    const modes = modesBeneath(on)

    seat(on)
    await $.session.start(SESSION)
    await measure($, { ...HALF, rateLimits: [FIVE_HOUR], cost: { usd: 3.4123 }, changed: ['context', 'rateLimits', 'cost'] })
    await $.ui.render(modeOf('terminal'))
    expect(modes.at(-1)).toEqual(['plan'])
  })

  test('no measurement yet: a dash; one with no fill yet, or a compaction since: a dash for the tokens', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 —')

    await measure($)
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 —/200k')

    await measure($, HALF)
    await $.session.compact({ trigger: 'manual', messages: SUMMARY })
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 —/200k')
  })

  test('the tightest rate-limit window follows, with when it resets; with none, the cost; with neither, nothing', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await measure($, { ...HALF, rateLimits: [SEVEN_DAY, FIVE_HOUR], cost: { usd: 3.4123 }, changed: ['context', 'rateLimits', 'cost'] })
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 85k/200k · 41% · 5h 42% · 2h10m后重置')

    await measure($, { ...HALF, cost: { usd: 3.4123 }, changed: ['rateLimits'] })
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 85k/200k · 41% · $3.41')

    await measure($, { ...HALF, changed: ['cost'] })
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 85k/200k · 41%')
  })

  test('in English', { options: { language: 'en' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await measure($, { ...HALF, rateLimits: [{ ...SEVEN_DAY, percentUsed: 50 }], changed: ['context', 'rateLimits'] })
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('Context 85k/200k · 41% · 7d 50% · resets in 3d0h')
  })

  test('a window at 80% or more shows only under the prompt, not on the band', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await measure($, { rateLimits: [{ ...FIVE_HOUR, percentUsed: 81 }] })
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)

    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 —/200k · 5h 81% · 2h10m后重置')
  })
})

describe('the trees validate on every surface', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`band and every page on ${surface}`, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      const world = seat(on, mmruns())

      world.alive.add('111')
      world.stdout = NVIDIA_RUN
      await $.session.start(SESSION)
      await clock.advance(3_000)
      await $.agent.spawn(SPAWN as never)
      await $.command.run(command('gpu', 'lab-box'))
      await clock.settle()

      const band = await $.ui.mount({ plugin: PLUGIN, ...BAND, surface } as never)

      expect((await band.findAll({ type: 'Text' })).length).toBeGreaterThan(0)
      await band.unmount()

      const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

      for (const key of ['page-overview', 'page-agents', 'page-mmrun', 'page-gpu']) {
        await pane.press({ key })
        expect((await pane.findAll({ type: 'Text' })).length).toBeGreaterThan(1)
      }

      await pane.unmount()
    })
  }
})

describe('workbench tables', () => {
  /** a1 errored, a2 running, a3 returned; R1 codex running and grok done unread; R3 failed before. */
  async function busyOverview($: Engine, on: On) {
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
  }

  test('总览: a count bar first; 需要你 and 运行中 rows are plain Buttons that open the item, an agent numbered by its spawn digit, a model not', { options: { language: 'zh-CN' } }, async ($, on) => {
    await busyOverview($, on)

    const tree = await $.ui.render(PANE)
    const rows = rowsOf(tree).filter(row => row.trim() !== '')

    expect(rows[1]).toMatch(/^! 需要你1 · ● 运行2 · 待读2 · 更新 \d+s前$/)
    expect(colorsOf(tree, '!')).toEqual(['warning'])
    expect(rows.slice(2, 6)).toEqual([
      '需要你 · 1',
      '✗ 1: worker  Build mm plugin  1s  500 out  出错',
      '运行中 · 2',
      expect.stringMatching(/^● 2: 运行 worker · Build mm plugin +0 tools  0s$/),
    ])
    expect(rows[6]).toMatch(/^● 运行 design \/ codex +4m15s$/)
    expect(widthOf(rows[5] ?? ''), 'the hotkey counted in, the time still ends at the pane edge').toBe(70)

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect((await ui.find({ key: 'open-agent-a1' }))?.props).toMatchObject({ plain: true, label: 'worker  Build mm plugin  1s  500 out  出错' })
    expect((await ui.find({ key: 'open-agent-a1' }))?.props.hotkey, 'a failure still needing you keeps its digit').toBe('1')
    expect((await ui.find({ key: 'open-agent-a2' }))?.props).toMatchObject({ plain: true, hotkey: '2' })
    expect((await ui.find({ key: `open-model-${R1}-codex` }))?.props).toMatchObject({ plain: true })
    expect((await ui.find({ key: `open-model-${R1}-codex` }))?.props.hotkey).toBeUndefined()
    await ui.press({ key: 'open-agent-a1' })
    expect((await ui.find({ key: 'page-agents' }))?.props).toMatchObject({ variant: 'primary' })
    expect(await ui.find({ type: 'Markdown', text: 'report' })).toBeDefined()

    await ui.press({ key: 'page-overview' })
    await ui.press({ key: `open-model-${R1}-codex` })
    expect((await ui.find({ key: 'page-mmrun' }))?.props).toMatchObject({ variant: 'primary' })
    expect(await ui.find({ key: 'dash-back' })).toBeDefined()
    await ui.unmount()
  })

  test('总览 placed inline: the count bar and 需要你 alone', { options: { language: 'zh-CN' } }, async ($, on) => {
    await busyOverview($, on)

    const rows = rowsOf(await $.ui.render({ ...PANE, props: { ...PANE.props, placement: 'inline' } })).filter(row => row.trim() !== '')

    expect(rows.slice(1)).toEqual([expect.stringMatching(/^! 需要你1 · /), '需要你 · 1', '✗ 1: worker  Build mm plugin  1s  500 out  出错'])
  })

  test('Agents: a dim header, then a row per agent in columns by display width, the whole row a plain Button', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: 1_000 })
    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.classic.PermissionDenied(denied('Write', 'a1'))
    await $.turn.complete(complete('a1'))
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn(SPAWN as never)
    await $.turn.complete(complete('a3', 'error'))
    await $.command.run(command('subagents'))

    const tree = await $.ui.render(PANE)
    const [, head = '', ...rows] = rowsOf(tree)
    const at = (row: string, part: string) => widthOf(row.slice(0, row.indexOf(part)))

    expect(head).toMatch(/^状态 +类型 +任务 +模型 +耗时 +tokens +tools +被拒$/)
    expect(isDimText(tree, '状态')).toBe(true)
    expect(rows, 'running first; unread a1 kept 1, so a2 took 2 and a3 3').toEqual([
      expect.stringMatching(/^● 运行 +2: worker  Build mm pl…  opus-5-5 +0s +— +0$/),
      expect.stringMatching(/^✗ 出错 +3: worker  Build mm pl…  opus-5-5 +1s +501 +0$/),
      expect.stringMatching(/^✓ 已返回 +1: worker  Build mm pl…  opus-5-5 +1s +501 +1  ✗1$/),
    ])

    for (const row of rows) {
      expect(at(row, 'worker'), row).toBe(at(head, '类型'))
      expect(at(row, 'opus-5-5'), row).toBe(at(head, '模型'))
      expect(at(row, 's ') + 1, row).toBe(at(head, '耗时') + widthOf('耗时'))

      const tokens = row.includes('501') ? '501' : '—'

      expect(at(row, tokens) + widthOf(tokens), row).toBe(at(head, 'tokens') + widthOf('tokens'))
    }

    expect(textOf(tree)).not.toContain('claude-')
    expect(colorsOf(tree, '✗1')).toEqual(['error'])

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect((await ui.find({ key: 'read-agent-a1' }))?.props, 'a returned row is dim').toMatchObject({ plain: true, dimColor: true })
    expect((await ui.find({ key: 'read-agent-a1' }))?.props.hotkey, 'unread: it kept its digit').toBe('1')
    expect((await ui.find({ key: 'read-agent-a2' }))?.props.dimColor).toBeUndefined()
    expect(await ui.find({ key: 'read-agent' })).toBeUndefined()
    await ui.press({ key: 'read-agent-a2' })
    expect(await ui.find({ text: '仍在运行,还没有返回正文' })).toBeDefined()
    await ui.unmount()

    const narrow = async (columns: number) => rowsOf(await $.ui.render({ ...PANE, props: { ...PANE.props, bodyColumns: columns } })).slice(1)

    await $.command.run(command('subagents'))

    const [head60 = '', ...rows60] = await narrow(60)

    expect(head60, '60 columns: 模型 goes first').toMatch(/^状态 +类型 +任务 +耗时 +tools +被拒$/)
    expect(rows60.every(row => widthOf(row) <= 60 && !row.includes('opus'))).toBe(true)

    const [head40 = '', ...rows40] = await narrow(40)

    expect(head40, '40 columns: then tools, then 被拒; 状态 and 耗时 stay').toMatch(/^状态 +类型 +任务 +耗时$/)
    expect(rows40[2]).toMatch(/^✓ 已返回 +1: worker  .+ +1s$/)
  })

  test('Agents: a digit stays with its agent: a later spawn leaves the rows drawn before as they were numbered', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command('subagents'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)
    const digits = async () => {
      const out: Record<string, unknown> = {}

      for (const id of ['a1', 'a2', 'a3']) {
        out[id] = (await ui.find({ key: `read-agent-${id}` }))?.props.hotkey
      }

      return out
    }

    expect(await digits()).toEqual({ a1: '1', a2: '2', a3: undefined })
    await $.agent.spawn(SPAWN as never)
    expect(await digits(), 'a3 takes the next free digit').toEqual({ a1: '1', a2: '2', a3: '3' })
    await ui.unmount()
  })

  test('Agents: past nine rows no hotkey, the row still lined up', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: 1_000 })
    seat(on)
    await $.session.start(SESSION)

    for (let i = 0; i < 11; i += 1) {
      await $.agent.spawn(SPAWN as never)
    }

    await $.command.run(command('subagents'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect((await ui.find({ key: 'read-agent-a9' }))?.props).toMatchObject({ hotkey: '9' })
    expect((await ui.find({ key: 'read-agent-a10' }))?.props.hotkey, 'the tenth running at once: no digit left').toBeUndefined()
    await ui.unmount()

    const rows = rowsOf(await $.ui.render(PANE)).slice(2)

    expect(rows[10]?.indexOf('worker')).toBe(rows[8]?.indexOf('worker'))
  })

  test('Agents: a running agent opened reads its transcript once per move; a failed read says 读不到 and waits for the next move', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let answer: 'rows' | 'deny' | 'refuse' = 'rows'
    const asked: unknown[] = []

    seat(on)
    on('session.messages', ($, e) => {
      asked.push(e.agentId)

      if (answer === 'refuse') {
        return { deny: 'refused' }
      }

      return {
        value:
          answer === 'deny'
            ? { deny: 'gone' }
            : [
                { role: 'user', text: 'Fix the band\nin detail', toolUses: [] },
                { role: 'assistant', text: 'Looking.', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: '/w/board.ts' } }] },
                { role: 'assistant', text: 'Found it.\nmore', toolUses: [{ tool_use_id: 'u2', tool: 'Bash', input: { command: 'bun test' } }] },
              ],
      } as never
    })
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command('subagents'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await ui.press({ key: 'read-agent-a1' })

    const rows = rowsOf(await $.ui.render(PANE))

    expect(rows).toEqual(expect.arrayContaining(['仍在运行,还没有返回正文', '任务  Fix the band', '最近调用', '  Read board.ts', '  Bash bun test', '最新  Found it.']))
    expect(asked).toEqual(['a1'])
    await $.ui.render(PANE)
    expect(asked, 'a redraw reads nothing').toHaveLength(1)

    await clock.advance(1_000)
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/x.md' }, 'a1'))
    expect(asked, 'the agent moved: read again').toHaveLength(2)

    answer = 'deny'
    await clock.advance(1_000)
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/y.md' }, 'a1'))
    expect(rowsOf(await $.ui.render(PANE))).toContain('读不到它的运行记录')
    expect(colorsOf(await $.ui.render(PANE), '读不到它的运行记录')).toEqual(['warning'])
    await ui.press({ key: 'dash-back' })
    await ui.press({ key: 'read-agent-a1' })
    expect(asked, 'no retry before the agent moves').toHaveLength(3)

    answer = 'refuse'
    await clock.advance(1_000)
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/z.md' }, 'a1'))
    expect(asked).toHaveLength(4)
    expect(rowsOf(await $.ui.render(PANE))).toContain('读不到它的运行记录')
    await ui.unmount()
  })

  test('Agents: a slow read of an agent left for another does not overwrite the other\'s peek', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    let release = () => {}
    let asked = () => {}
    const isAsked = new Promise<void>(resolve => {
      asked = resolve
    })
    const held = new Promise<void>(resolve => {
      release = resolve
    })

    seat(on)
    on('session.messages', async ($, e) => {
      if (e.agentId === 'a1') {
        asked()
        await held
      }

      return { value: [{ role: 'user', text: `Task of ${e.agentId}`, toolUses: [] }] } as never
    })
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command('subagents'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)
    const first = ui.press({ key: 'read-agent-a1' })

    await isAsked
    await ui.press({ key: 'dash-back' })
    await ui.press({ key: 'read-agent-a2' })
    expect(rowsOf(await $.ui.render(PANE))).toContain('任务  Task of a2')

    release()
    await first
    await clock.settle()
    expect(rowsOf(await $.ui.render(PANE))).toContain('任务  Task of a2')
    await ui.unmount()
  })

  test('Agents: read on a past visit, the ended fold into one ✓N 已完成 row that opens and closes; failures and the running stay listed', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    await $.session.start(SESSION)

    for (let i = 0; i < 4; i += 1) {
      await $.agent.spawn(SPAWN as never)
    }

    await $.turn.complete(complete('a1'))
    await $.turn.complete(complete('a2', 'error'))
    await $.turn.complete(complete('a3', 'aborted'))
    await $.command.run(command('subagents'))
    expect(rowsOf(await $.ui.render(PANE)).slice(2), 'all unread on this visit').toHaveLength(4)

    await clock.advance(1_000)
    await $.command.run(command('subagents'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)
    const rows = async () => rowsOf(await $.ui.render(PANE)).slice(2)

    expect(await rows()).toEqual([expect.stringMatching(/^● 运行 +4: /), expect.stringMatching(/^✗ 出错 +2: /), '✓1 已完成 · ⊘1 已中止'])
    expect((await ui.find({ key: 'agents-fold' }))?.props).toMatchObject({ plain: true })
    expect((await ui.find({ key: 'agents-fold' }))?.props.hotkey).toBeUndefined()
    await ui.press({ key: 'agents-fold' })
    expect(await rows()).toEqual([
      expect.stringMatching(/^● 运行 +4: /),
      expect.stringMatching(/^✗ 出错 +2: /),
      '✓1 已完成 · ⊘1 已中止',
      expect.stringMatching(/^⊘ 已中止 +3: /),
      expect.stringMatching(/^✓ 已返回 +1: /),
    ])
    await ui.press({ key: 'agents-fold' })
    expect(await rows()).toHaveLength(3)
    await ui.unmount()
  })

  test('a subagent call still running: `Bash 3m…` on the band and the Agents page, no 静默; once it ends, 静默 again', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    on('turn.step', async function* ($, e) {
      yield { kind: 'tool', index: 0, id: 'toolu_b', name: 'Bash' }

      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Bash', input: {} }], stopReason: 'tool_use', usage: usage(1) }
    })
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)

    const stream = $.turn.step({ turnId: 'c1', index: 0, agentId: 'a1', model: 'claude-opus-5-5', messageCount: 2 } as never)

    while ((await stream.next()).done !== true) {}

    // The call's request time carries the stream's few real milliseconds: a second over keeps it at 3m.
    await clock.advance(181_000)

    const band = textOf(await $.ui.render(BAND))

    expect(band).toMatch(/● Build mm plugin [▰▱]{10} {2}Bash 3m… 3m01s/)
    expect(band).not.toContain('静默')
    await $.command.run(command('subagents'))
    expect(rowsOf(await $.ui.render(PANE))[2]).toMatch(/  Bash 3m…$/)

    await $.classic.PostToolUse({ ...(ran('Bash', { command: 'sleep 180' }, 'a1') as object), tool_use_id: 'toolu_b' } as never)
    await clock.advance(121_000)
    expect(textOf(await $.ui.render(BAND))).toContain('静默')
  })

  test('外审: a head per run with its 阅读 button, then a row per model in columns; a returned model dim', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const tree = await $.ui.render(PANE)

    expect(rowsOf(tree).slice(1)).toEqual([
      'design · review  aaaa  proj [ 阅读 ]',
      '  ● codex  RUNNING  4m15s      — tok',
      '  ✓ grok   DONE     5m02s  25.8k tok',
      '- · review  cccc  proj [ 阅读 ]',
      '  ✗ agy    FAIL:1   1m40s      — tok',
    ])
    expect(colorsOf(tree, '●')).toEqual(['permission'])
    expect(colorsOf(tree, '✗')).toEqual(['error'])
    expect(dimTexts(tree).some(text => text.includes('grok'))).toBe(true)
    expect(dimTexts(tree).some(text => text.includes('codex'))).toBe(false)
    expect(dimTexts(tree)).toContain('  aaaa  proj')
    expect(boxesWithButton(tree).map(box => rowsOf(box)[0])).toContain('design · review  aaaa  proj [ 阅读 ]')
  })

  test('GPU: a dim header, a row per card lined up; a missing value is -, not 0; no bar under 64 columns', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on)

    world.stdout = ['@@NVSMI', '0, NVIDIA GeForce RTX 4090, 52, 18636, 24564, 67, 280.45', '1, NVIDIA A100, [N/A], [N/A], [N/A], [N/A], [N/A]', '@@APPS'].join('\n')
    await $.session.start(SESSION)
    await $.command.run(command('gpu', 'lab-box'))
    await clock.settle()

    const tree = await $.ui.render(PANE)
    const [, , head = '', one = '', two = ''] = rowsOf(tree)

    expect(head).toMatch(/^# +model +util +VRAM +temp +power$/)
    expect(isDimText(tree, 'VRAM')).toBe(true)
    expect(one).toMatch(/^0  RTX 4090  ▇+░+  52%  18\.2\/24\.0 GiB  67°C  280W$/)
    expect(two).toMatch(/^1  A100 +-  - +- +-$/)
    expect(head.indexOf('util')).toBe(one.indexOf('▇'))
    expect(head.indexOf('VRAM')).toBe(one.indexOf('18.2'))
    expect(head.indexOf('power')).toBe(one.indexOf('280W'))
    expect(widthOf(one)).toBeLessThanOrEqual(70)

    const [, , head60 = '', one60 = ''] = rowsOf(await $.ui.render({ ...PANE, props: { ...PANE.props, bodyColumns: 60 } }))

    expect(one60).toBe('0  RTX 4090   52%  18.2/24.0 GiB  67°C  280W')
    expect(head60.indexOf('VRAM')).toBe(one60.indexOf('18.2'))
  })

  test('idle, the band is redrawn every heartbeat so its 12m前 moves; with work on the band the heartbeat redraws nothing', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const ticks = writes(on, 'tick')

    seat(on)
    await $.session.start(SESSION)
    await clock.advance(1_000)

    const idle = ticks()

    await clock.advance(30_000)
    expect(ticks() - idle).toBeGreaterThanOrEqual(1)

    await $.agent.spawn(SPAWN as never)
    await $.turn.complete(complete('a1', 'error'))
    await clock.advance(30_000)

    const held = ticks()

    await clock.advance(30_000)
    expect(ticks() - held, 'a failed agent holds the band: no idle line to move').toBe(0)
  })
})

describe('progress page close buttons', () => {
  const BOARD = '/h/.claude/progress/-work-harness'
  const added = (id: string, title: string, status: string) => ({
    type: 'add',
    node: id,
    at: NOW - 3_600_000,
    session: 'other',
    commit: null,
    fields: { title, summary: 's', status, kind: 'feature', done_when: 'tests pass', builds_on: [], depends_on: [] },
  })

  /**
   * ~/.claude/progress in memory, a local board holding an open node n1 and a done n2; registered before seat, so outside its fs hooks.
   * Nothing answers /progress-close: the buttons write the event themselves.
   */
  function board(on: On): { files: Record<string, string>; closes: () => unknown } {
    const files: Record<string, string> = {
      [`${BOARD}/config.json`]: JSON.stringify({ storage: 'local' }),
      [`${BOARD}/events/other.json`]: JSON.stringify([added('n1', 'Open work', 'doing'), added('n2', 'Closed work', 'done')]),
    }
    const closes = () => JSON.parse(files[`${BOARD}/events/me.json`] ?? 'null')
    const inBoard = { path: /^\/h\/\.claude\/progress\// }

    on('fs.read', inBoard, ($, e) => {
      const text = files[e.path]

      return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
    })
    on('fs.write', inBoard, ($, e) => {
      files[e.path] = e.text

      return { value: undefined }
    })
    on('fs.list', inBoard, ($, e) => {
      const entries = Object.entries(files)
        .filter(([path]) => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
        .map(([path, text]) => ({ name: path.slice(e.path.length + 1), kind: 'file', size: text.length, mtimeMs: NOW, isLink: false }) as FsEntry)

      return entries.length > 0 ? { value: entries } : { deny: `ENOENT ${e.path}` }
    })

    return { files, closes }
  }

  async function progressPage($: Engine, surface: 'terminal' | 'desktop') {
    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

    await ui.press({ key: 'page-overview' })
    await ui.press({ key: 'page-progress' })

    return ui
  }

  test('desktop: 完成 on an open node writes a done event to this session\'s file and re-reads the board; a done node has none', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const { closes } = board(on)

    seat(on)
    await $.session.start(SESSION)

    const ui = await progressPage($, 'desktop')

    expect((await ui.find({ key: 'progress-done-n1' }))?.props).toMatchObject({ label: '完成', variant: 'secondary' })
    expect((await ui.find({ key: 'progress-drop-n1' }))?.props).toMatchObject({ label: '放弃', variant: 'secondary' })
    expect(await ui.find({ key: 'progress-done-n2' })).toBeUndefined()
    expect(await ui.find({ key: 'progress-drop-n2' })).toBeUndefined()

    await ui.press({ key: 'progress-done-n1' })
    expect(closes()).toEqual([{ type: 'update', node: 'n1', at: NOW, session: 'me', commit: null, fields: { status: 'done' } }])
    expect(await ui.find({ key: 'progress-done-n1' }), 'read again: n1 is done').toBeUndefined()
    await ui.unmount()
  })

  test('desktop: 完成 on the one piece of an open request also closes the request', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const { files, closes } = board(on)
    const request = { type: 'request', request: 'r1', at: NOW - 3_600_000, session: 'other', commit: null, fields: { title: 'Asked', acceptance: ['it works'], status: 'open' } }
    const piece = { ...added('n1', 'Open work', 'doing'), fields: { ...added('n1', 'Open work', 'doing').fields, request: 'r1' } }

    files[`${BOARD}/events/other.json`] = JSON.stringify([request, piece])
    seat(on)
    await $.session.start(SESSION)

    const ui = await progressPage($, 'desktop')

    await ui.press({ key: 'progress-done-n1' })
    expect(closes()).toMatchObject([
      { type: 'update', node: 'n1', fields: { status: 'done' } },
      { type: 'request', request: 'r1', fields: { status: 'closed', resolution: { by: 'piece' } } },
    ])
    await ui.unmount()
  })

  test('desktop: 放弃 writes a dropped event, and the node leaves the page', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const { closes } = board(on)

    seat(on)
    await $.session.start(SESSION)

    const ui = await progressPage($, 'desktop')

    await ui.press({ key: 'progress-drop-n1' })
    expect(closes()).toMatchObject([{ node: 'n1', fields: { status: 'dropped' } }])
    expect(textOf(await ui.drawn())).not.toContain('Open work')
    await ui.unmount()
  })

  test('desktop: 完成 and 放弃 pressed at once on two nodes: both events land in this session\'s file', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const { files, closes } = board(on)

    files[`${BOARD}/events/other.json`] = JSON.stringify([added('n1', 'Open work', 'doing'), added('n3', 'More work', 'todo')])
    seat(on)
    await $.session.start(SESSION)

    const ui = await progressPage($, 'desktop')

    await Promise.all([ui.press({ key: 'progress-done-n1' }), ui.press({ key: 'progress-drop-n3' })])
    expect(closes()).toMatchObject([
      { node: 'n1', fields: { status: 'done' } },
      { node: 'n3', fields: { status: 'dropped' } },
    ])
    await ui.unmount()
  })

  test('desktop: with a canvas url, 完成 also mirrors the event to the canvas in one ArtifactData batch', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const { files } = board(on)
    const batches: { url: string; writes: { collection: string; data: { type?: string; node?: string; fields?: { status?: string } } }[] }[] = []

    files['/h/.claude/progress/canvas.json'] = JSON.stringify({ url: 'https://claude.ai/artifact/abc' })
    on('tool.call', { tool: 'ArtifactData' }, ($, e) => {
      batches.push(e as never)

      return { result: 'ok', text: 'ok' } as never
    })
    seat(on)
    await $.session.start(SESSION)

    const ui = await progressPage($, 'desktop')

    await ui.press({ key: 'progress-done-n1' })
    expect(batches.map(one => one.url)).toEqual(['https://claude.ai/artifact/abc'])
    expect(batches[0]!.writes.filter(one => one.collection.endsWith('/events')).map(one => [one.data.type, one.data.node, one.data.fields?.status])).toEqual([
      ['add', 'n1', 'done'],
      ['update', 'n1', 'done'],
    ])
    await ui.unmount()
  })

  test('terminal: no close buttons', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    board(on)
    seat(on)
    await $.session.start(SESSION)

    const ui = await progressPage($, 'terminal')

    expect(textOf(await ui.drawn())).toContain('Open work')
    expect(await ui.find({ key: 'progress-done-n1' })).toBeUndefined()
    expect(await ui.find({ key: 'progress-drop-n1' })).toBeUndefined()
    await ui.unmount()
  })

  const HOUR = 3_600_000
  const asked = (id: string, title: string, at: number, session = 'other', fields: Record<string, unknown> = {}) => ({
    type: 'request',
    request: id,
    at,
    session,
    commit: null,
    fields: { title, acceptance: ['it works'], status: 'open', ...fields },
  })
  const pieceOf = (id: string, title: string, status: string, request: string, at = NOW - HOUR, session = 'other') => {
    const one = added(id, title, status)

    return { ...one, at, session, fields: { ...one.fields, request } }
  }

  /** r1 asked in this session with a doing piece; another session's r2 ready, its r3 quiet for 4 days. */
  function asks(files: Record<string, string>): void {
    files[`${BOARD}/events/me.json`] = JSON.stringify([asked('r1', 'Mine', NOW - HOUR, 'me'), pieceOf('n1', 'Doing piece', 'doing', 'r1', NOW - HOUR, 'me')])
    files[`${BOARD}/events/other.json`] = JSON.stringify([
      asked('r2', 'Ready one', NOW - 2 * HOUR),
      pieceOf('n2', 'Done piece', 'done', 'r2', NOW - 2 * HOUR),
      asked('r3', 'Quiet one', NOW - 96 * HOUR),
      pieceOf('n3', 'Waiting piece', 'todo', 'r3', NOW - 96 * HOUR),
    ])
  }

  test('desktop: the now frame lists this session\'s request, a ready one with its 验收 button, a stale one', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const { files } = board(on)

    asks(files)
    seat(on)
    await $.session.start(SESSION)

    const ui = await progressPage($, 'desktop')

    expect(textOf(await ui.drawn())).toMatch(/现在.*▸ Mine.*本会话.*\? Ready one.*待验收.*! Quiet one.*4 天无更新/)
    expect((await ui.find({ key: 'progress-now-accept-r2' }))?.props).toMatchObject({ label: '验收', variant: 'secondary' })
    expect(await ui.find({ key: 'progress-now-accept-r1' }), 'this session\'s open request is not ready').toBeUndefined()
    await ui.unmount()
  })

  test('desktop: 验收 writes a closed request event by the person to this session\'s file and re-reads the board', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const { files, closes } = board(on)

    asks(files)
    seat(on)
    await $.session.start(SESSION)

    const ui = await progressPage($, 'desktop')

    expect((await ui.find({ key: 'progress-accept-r1' }))?.props).toMatchObject({ label: '验收', variant: 'secondary' })
    await ui.press({ key: 'progress-accept-r1' })
    expect((closes() as unknown[]).at(-1)).toEqual({ type: 'request', request: 'r1', at: NOW, session: 'me', commit: null, fields: { status: 'closed', resolution: { by: 'person', evidence: 'accepted on the progress page' } } })
    expect(await ui.find({ key: 'progress-accept-r1' }), 'read again: r1 is closed').toBeUndefined()
    await ui.unmount()
  })

  test('desktop: with a canvas url, 验收 also mirrors the request event to the canvas as a q… doc', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const { files } = board(on)
    const batches: { url: string; writes: { collection: string; doc_id: string; data: { type?: string; request?: string; fields?: { status?: string } } }[] }[] = []

    asks(files)
    files['/h/.claude/progress/canvas.json'] = JSON.stringify({ url: 'https://claude.ai/artifact/abc' })
    on('tool.call', { tool: 'ArtifactData' }, ($, e) => {
      batches.push(e as never)

      return { result: 'ok', text: 'ok' } as never
    })
    seat(on)
    await $.session.start(SESSION)

    const ui = await progressPage($, 'desktop')

    await ui.press({ key: 'progress-accept-r1' })
    expect(batches.map(one => one.url)).toEqual(['https://claude.ai/artifact/abc'])
    expect(batches[0]!.writes.filter(one => one.collection.endsWith('/events')).map(one => [one.doc_id, one.data.type, one.data.request, one.data.fields?.status])).toEqual([
      [`q${NOW}-r1`, 'request', 'r1', 'closed'],
    ])
    await ui.unmount()
  })

  test('desktop: 放弃请求 writes a dropped request event, its pieces left as they are, and the request leaves the page', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const { files, closes } = board(on)

    asks(files)
    seat(on)
    await $.session.start(SESSION)

    const ui = await progressPage($, 'desktop')

    expect((await ui.find({ key: 'progress-dropreq-r1' }))?.props).toMatchObject({ label: '放弃请求', variant: 'secondary' })
    await ui.press({ key: 'progress-dropreq-r1' })
    expect(closes()).toHaveLength(3)
    expect((closes() as unknown[]).at(-1)).toEqual({ type: 'request', request: 'r1', at: NOW, session: 'me', commit: null, fields: { status: 'dropped' } })
    expect(textOf(await ui.drawn())).not.toContain('Mine')
    await ui.unmount()
  })

  test('desktop: three requests of one line titled 发布 <ver> draw as one chain, oldest first', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const { files } = board(on)
    const line = { type: 'line', line: 'l1', at: NOW - 5 * HOUR, session: 'other', commit: null, fields: { name: 'release', definition: 'the releases', status: 'active', keys: { paths: [], scopes: [], patterns: [] } } }
    const closed = { line: 'l1', status: 'closed', resolution: { by: 'person', evidence: 'done' } }

    files[`${BOARD}/events/other.json`] = JSON.stringify([
      line,
      asked('r1', '发布 0.8.3 清理', NOW - 4 * HOUR, 'other', closed),
      asked('r2', '发布 0.8.4 清理', NOW - 3 * HOUR, 'other', closed),
      asked('r3', '发布 0.8.5 清理', NOW - 2 * HOUR, 'other', { line: 'l1' }),
      pieceOf('p1', 'Tag', 'done', 'r3'),
      pieceOf('p2', 'Notes', 'doing', 'r3'),
      pieceOf('p3', 'Upload', 'todo', 'r3'),
    ])
    seat(on)
    await $.session.start(SESSION)

    const ui = await progressPage($, 'desktop')
    const text = textOf(await ui.drawn())

    expect(text).toContain('RELEASE (系列)')
    expect(text).toContain('0.8.3 ✓ ─ 0.8.4 ✓ ─ 0.8.5 ▸1/3')
    await ui.unmount()
  })

  test('desktop: an open request of a series keeps its card under the chain; its closed members stay only in the chain', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const { files, closes } = board(on)
    const line = { type: 'line', line: 'l1', at: NOW - 5 * HOUR, session: 'other', commit: null, fields: { name: 'release', definition: 'the releases', status: 'active', keys: { paths: [], scopes: [], patterns: [] } } }
    const closed = { line: 'l1', status: 'closed', resolution: { by: 'person', evidence: 'done' } }

    files[`${BOARD}/events/other.json`] = JSON.stringify([
      line,
      asked('r1', '发布 0.8.3 清理', NOW - 4 * HOUR, 'other', closed),
      asked('r2', '发布 0.8.4 清理', NOW - 3 * HOUR, 'other', closed),
      asked('r3', '发布 0.8.5 清理', NOW - 2 * HOUR, 'other', { line: 'l1' }),
      pieceOf('p1', 'Tag', 'done', 'r3'),
      pieceOf('p2', 'Notes', 'doing', 'r3'),
      pieceOf('p3', 'Upload', 'todo', 'r3'),
    ])
    seat(on)
    await $.session.start(SESSION)

    const ui = await progressPage($, 'desktop')

    expect(textOf(await ui.drawn())).toContain('0.8.3 ✓ ─ 0.8.4 ✓ ─ 0.8.5 ▸1/3')
    expect((await ui.find({ key: 'progress-accept-r3' }))?.props).toMatchObject({ label: '验收' })
    expect(await ui.find({ key: 'progress-dropreq-r3' })).toBeDefined()
    expect(await ui.find({ key: 'progress-drop-p3' })).toBeDefined()
    expect(await ui.find({ key: 'progress-accept-r1' }), 'a closed member has no card').toBeUndefined()
    expect(await ui.find({ key: 'progress-accept-r2' })).toBeUndefined()

    await ui.press({ key: 'progress-done-p2' })
    expect(closes()).toEqual([{ type: 'update', node: 'p2', at: NOW, session: 'me', commit: null, fields: { status: 'done' } }])
    await ui.unmount()
  })
})

describe('commands that open the workbench', () => {
  // A command's text is stored as a transcript row the model reads: opening a page tells the model nothing.
  test('print nothing; only a /gpu it cannot run says why', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    await $.session.start(SESSION)

    for (const [name, args] of [['dashboard', ''], ['subagents', ''], ['mmrun', ''], ['timeline', ''], ['gpu', 'lab-box']] as const) {
      const r = await $.command.run(command(name, args))

      expect(r.text, name).toBeUndefined()
      expect(r.context, name).toBeUndefined()
    }

    expect((await $.command.run(command('gpu', '-x'))).text).toBe('不是主机名：-x')
  })
})

describe('state an older build left', () => {
  /** Each kept value in a shape this build does not read. */
  const OLD: Record<string, unknown> = {
    agents: { list: [] },
    runs: [],
    gates: {},
    trees: [{ name: 'agent-a' }],
    peers: {},
    presence: 'idle',
    toasted: {},
    timeline: { turns: [] },
    cache: null,
    usage: [],
    seen: [],
    detail: 'agents',
    reports: [],
    gpu: 'lab-box',
    peek: [],
    guards: [],
  }

  test('without the shape tag reads as the initial value, one debug line per key; nothing throws and the next write is whole', { options: { language: 'zh-CN', gpuHosts: 'lab-box' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())
    const debug = () => world.logs.filter(one => one.to === 'debug').map(one => one.text)

    // Kept from before this load until the plugin writes the key.
    const kept = new Map(Object.entries(OLD))

    on('state.get', ($, e, next) => {
      const key = (e as { key: string }).key

      return e.plugin === PLUGIN && kept.has(key) ? ({ value: { value: kept.get(key), version: 1 } } as never) : next(e)
    })
    on('state.set', ($, e, next) => {
      kept.delete(e.key)

      return next(e)
    })
    await $.session.start(SESSION)
    expect(textOf(await $.ui.render(BAND))).toContain('空闲')
    await $.command.run(command('subagents'))
    expect(textOf(await $.ui.render(PANE))).toContain('本会话还没有子 agent。')

    await $.agent.spawn(SPAWN as never)
    await clock.settle()
    expect(rowsOf(await $.ui.render(PANE)).filter(row => row.includes('Build mm plug'))).toHaveLength(1)

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    for (const page of ['overview', 'mmrun', 'timeline', 'gpu'] as const) {
      await ui.press({ key: `page-${page}` })
      expect(await ui.find({ type: 'Text', text: /^✗ / }), page).toBeUndefined()
    }

    await ui.unmount()
    await clock.advance(5_000)

    for (const key of ['agents', 'runs', 'gates', 'peers', 'presence', 'timeline']) {
      expect(debug().filter(line => line.includes(`kept ${key} `)), key).toHaveLength(1)
    }

    // toasted is read by the peers poll alone, from its timer: that the poll ran clean is its check.
    expect(debug().filter(line => line.includes('poll failed'))).toEqual([])
  })
})

describe('loops', () => {
  test('a -p or SDK session starts no loop and writes no presence file', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())
    const written: Record<string, number> = {}

    on('state.set', ($, e, next) => {
      if (e.plugin === 'dashboard') {
        written[e.key] = (written[e.key] ?? 0) + 1
      }

      return next(e)
    })
    world.alive.add('111')
    world.sessions['p1.json'] = peer('p1', 'working', NOW)
    await $.session.start({ ...SESSION, surface: null, isInteractive: false })
    await $.prompt.submit(PROMPT)
    await clock.advance(60_000)
    await $.turn.complete({ answer: 'done', durationMs: 2_000, isAborted: false, turnId: 't', reason: 'answer', usage: usage(10) } as never)
    await $.session.end({ reason: 'other', sessionId: 'me' } as never)

    expect(written.runs, 'no runs read').toBeUndefined()
    expect(written.peers, 'no other sessions read').toBeUndefined()
    expect(written.trees, 'no worktrees read').toBeUndefined()
    expect(world.runs, 'no git').toEqual([])
    expect(world.sessions['me.json'], 'no presence file, heartbeat or not').toBeUndefined()
  })

  test('a reload that raised no session.start (an option changed): the first band drawing starts the loops, once', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())
    const written = writes(on, 'runs')

    world.alive.add('111')
    await $.ui.render(BAND)
    await $.ui.render(BAND)
    await clock.advance(3_000)
    expect(written(), 'a running model is written every poll: once, one loop').toBe(1)

    await clock.advance(3_000)
    expect(written()).toBe(2)
  })

  test('session.start, then the band drawn: still one loop', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())
    const written = writes(on, 'runs')

    world.alive.add('111')
    await $.session.start(SESSION)
    await $.ui.render(BAND)
    await clock.advance(3_000)
    expect(written()).toBe(1)
  })

  test('mm writing its watches reads the runs at once; with nothing running the 15 s poll is the fallback', { plugins: [MM] }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const world = seat(on, files)

    await $.session.start(SESSION)
    await clock.advance(3_000)
    files[`${R4}/run.meta`] = { text: runMeta(R4, 'fresh', 'codex'), mtimeMs: NOW + 4_000 }
    files[`${R4}/codex.status`] = { text: 'RUNNING\n' }
    files[`${R4}/codex.started`] = { text: `${(NOW + 4_000) / 1000}\n` }
    files[`${R4}/codex.pid`] = { text: '444\n' }
    world.alive.add('444')
    await clock.advance(3_000)
    expect(textOf(await $.ui.render(BAND)), 'nothing was running: the next poll is 15 s on').not.toContain('fresh')

    await $.command.run(command('mm-watch'))
    await clock.settle()
    expect(textOf(await $.ui.render(BAND))).toContain('fresh · codex ●')
  })

  test('mm writing its watches while a poll reads the runs reads them again once it ends, past the idle wait', { plugins: [MM] }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const world = seat(on, files)
    let release = () => {}
    let isHeld = false

    await $.session.start(SESSION)
    await clock.advance(3_000)
    world.beforeRead = path => {
      if (isHeld || !path.startsWith(`${ROOT}/`)) {
        return Promise.resolve()
      }

      isHeld = true

      return new Promise(resolve => {
        release = resolve
      })
    }
    await clock.advance(15_000)
    expect(isHeld, 'the 15 s poll waits on a run file').toBe(true)

    files[`${R4}/run.meta`] = { text: runMeta(R4, 'fresh', 'codex'), mtimeMs: NOW + 18_000 }
    files[`${R4}/codex.status`] = { text: 'RUNNING\n' }
    files[`${R4}/codex.started`] = { text: `${(NOW + 18_000) / 1000}\n` }
    files[`${R4}/codex.pid`] = { text: '444\n' }
    world.alive.add('444')
    await $.command.run(command('mm-watch'))
    release()
    await clock.settle()
    expect(textOf(await $.ui.render(BAND))).toContain('fresh · codex ●')
  })
})
