import { describe, expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { fit, widthOf } from '../hooks/agent-model'
import { PLUGIN, SESSION, IDLE, NOW, ROOT, SESSIONS, R1, R3, R4, bandOf, BAND, PANE, command, SPAWN, ran, denied, usage, complete, NVIDIA_RUN, NVML_RUN, type Files, runMeta, mmruns, seat, mine, PROMPT, typeKey, peer, writes, textOf, linesOf, colorsOf, boxesWithButton, isDimText, rowsOf } from './hooks-kit'

describe('mmrun runs', () => {
  test('reads the 24 h window from ~/.claude/mmruns, never a .raw, and draws a band line per active run', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    expect(rowsOf(await $.ui.render(PANE)).slice(1).map(line => line.replace(/ +/g, ' ').trim())).toEqual([
      'design · review aaaa proj [ Read ]',
      '● codex RUNNING 4m15s — tok',
      '✓ grok DONE 5m02s 25.8k tok',
      '- · review cccc proj [ Read ]',
      '✗ agy FAIL:1 1m40s — tok',
    ])
    expect(world.reads.some(path => path.endsWith('.raw'))).toBe(false)
    expect(linesOf(await $.ui.render(BAND))[0], 'R3 failed before the session: read already').toBe('design · codex ● 4m15s · grok ✓ 5m02s')
    expect(world.toasts).toEqual([])
  })

  test('model names and pids from run files never leave the run directory or reach kill unchecked', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R1}/run.meta`] = { text: runMeta(R1, 'design', 'codex,../../../../etc/x,grok'), mtimeMs: NOW - 300_000 }
    files[`${R1}/codex.pid`] = { text: '-1\n' }

    const world = seat(on, files)

    await $.session.start(SESSION)
    await clock.advance(3_000)

    expect(world.reads.filter(path => path.includes('..'))).toEqual([])
    expect(world.kills).toEqual([])
  })

  test('a model leaving RUNNING toasts once; several in one poll make one toast; the first load none', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R1}/grok.status`] = { text: 'RUNNING\n' }
    files[`${R1}/grok.pid`] = { text: '222\n' }
    delete files[`${R1}/grok.meta`]

    const world = seat(on, files)

    world.alive.add('111')
    world.alive.add('222')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    expect(world.toasts).toEqual([])
    expect(linesOf(await $.ui.render(BAND))[0]).toMatch(/^design · codex ● \S+ · grok ● \S+$/)

    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 4_000 }
    await clock.advance(3_000)
    expect(world.toasts).toEqual(['design：codex 已返回，grok 仍在运行'])

    world.alive.delete('222')
    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 4_000 }
    await clock.advance(3_000)
    expect(world.toasts).toEqual(['design：codex 已返回，grok 仍在运行', 'design：grok 已失联 STALE'])
    expect(textOf(await $.ui.render(BAND))).toContain('grok ✗ STALE')

    await clock.advance(30_000)
    expect(world.toasts).toHaveLength(2)
  })

  test('two models ending in the same poll share one toast', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R1}/grok.status`] = { text: 'RUNNING\n' }
    files[`${R1}/grok.pid`] = { text: '222\n' }

    const world = seat(on, files)

    world.alive.add('111')
    world.alive.add('222')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 4_000 }
    files[`${R1}/grok.status`] = { text: 'FAIL:2\n', mtimeMs: NOW + 4_500 }
    await clock.advance(3_000)
    expect(world.toasts).toEqual(['design：codex 已返回、grok 失败 FAIL:2'])
  })

  test('a model rewritten STALE long after its last output ends then, so it is not new on the band', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R3}/agy.status`] = { text: 'STALE\n', mtimeMs: NOW + 1_000 }
    files[`${R3}/agy.raw`] = { text: 'never read', mtimeMs: NOW - 3_650_000 }

    const world = seat(on, files)

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)

    expect(textOf(await $.ui.render(BAND))).not.toContain('agy')
  })

  test('a model still marked RUNNING whose worker died long ago ends at its last output, so it is not new on the band', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R3}/agy.status`] = { text: 'RUNNING\n', mtimeMs: NOW - 3_600_000 }
    files[`${R3}/agy.pid`] = { text: '333\n' }
    files[`${R3}/agy.raw`] = { text: 'never read', mtimeMs: NOW - 3_650_000 }

    const world = seat(on, files)

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)

    expect(textOf(await $.ui.render(BAND))).not.toContain('agy')
  })

  test('a listing that fails keeps the runs it had and says so above them; a poll that reads again clears it', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    for (const [path, refusal] of [[ROOT, "EACCES: permission denied, scandir '/h/.claude/mmruns'\nsecond line"], [`${ROOT}/${R1}`, 'EIO: i/o error']] as const) {
      world.listDenied[path] = refusal
      await clock.advance(3_000)

      for (const surface of ['terminal', 'desktop'] as const) {
        const tree = await $.ui.render({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 120 } })
        const lines = linesOf(tree)
        const warning = lines.find(line => line.startsWith('~ 读不到 ~/.claude/mmruns：'))

        expect(warning, `${surface}: ${path}`).toContain(refusal.split('\n')[0])
        expect(warning).not.toContain('second line')
        expect(colorsOf(tree, warning ?? '')).toEqual(['warning'])
        expect(lines.indexOf(warning ?? ''), 'above the runs').toBeLessThan(lines.findIndex(line => line.includes('aaaa')))
        expect(textOf(tree), 'the runs read before stay').toContain('codex')
        expect(textOf(tree)).toContain('cccc')
      }

      delete world.listDenied[path]
      await clock.advance(3_000)
      expect(textOf(await $.ui.render(PANE))).not.toContain('读不到')
    }
  })

  test('no ~/.claude/mmruns at all is no runs, not a read failure', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    for (const surface of ['terminal', 'desktop'] as const) {
      const text = textOf(await $.ui.render({ ...PANE, surface }))

      expect(text).toContain('最近 24 小时没有 mmrun 运行')
      expect(text).not.toContain('读不到')
    }
  })

  test('外审 hands every run to the pane to scroll, each run one block with its 阅读 button', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const tree = await $.ui.render({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 3 } } })
    const blocks = boxesWithButton(tree).map(box => ['aaaa', 'cccc'].filter(tail => textOf(box).includes(tail))).filter(found => found.length > 0)

    expect(textOf(tree).replace(/ +/g, ' ')).toContain('agy FAIL:1')
    expect(blocks).toEqual([['aaaa'], ['cccc']])
  })

  test('a model ending while 外审 is on screen does not toast; on another page it does', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R1}/grok.status`] = { text: 'RUNNING\n' }
    files[`${R1}/grok.pid`] = { text: '222\n' }
    delete files[`${R1}/grok.meta`]

    const world = seat(on, files)

    world.alive.add('111')
    world.alive.add('222')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))
    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 4_000 }
    await clock.advance(3_000)
    expect(world.toasts).toEqual([])

    await $.command.run(command('subagents'))
    world.alive.delete('222')
    await clock.advance(3_000)
    expect(world.toasts).toEqual(['design：grok 已失联 STALE'])
  })

  test('a run another session started, folded on 外审, toasts when its model ends; open under the fold it does not', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const started = JSON.stringify({ type: 'task_started', ts: NOW, task_id: 'x', provider: 'codex', mode: 'review', description: 'design', claude_session: 'someone-else' })

    files[`${R1}/grok.status`] = { text: 'RUNNING\n' }
    files[`${R1}/grok.pid`] = { text: '222\n' }
    files[`${R1}/codex.events.jsonl`] = { text: `${started}\n` }
    delete files[`${R1}/grok.meta`]

    const world = seat(on, files)

    world.alive.add('111')
    world.alive.add('222')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))
    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 4_000 }
    await clock.advance(3_000)
    expect(world.toasts, 'folded: not on screen').toEqual(['design：codex 已返回，grok 仍在运行'])

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await ui.press({ key: 'runs-fold' })
    world.alive.delete('222')
    await clock.advance(3_000)
    expect(world.toasts, 'the fold open: on screen').toHaveLength(1)
    await ui.unmount()
  })

  test('a poll with nothing running and nothing changed leaves the runs unwritten; a running model is written every poll', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const world = seat(on, files)
    const written = writes(on, 'runs')

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)

    const first = written()

    await clock.advance(3_000)
    expect(written(), 'codex running').toBe(first + 1)

    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 7_000 }
    await clock.advance(3_000)

    const ended = written()

    expect(ended).toBe(first + 2)
    await clock.advance(40_000)
    expect(written(), 'idle polls found the same runs').toBe(ended)
  })

  test('provisional-state-cached: a run read before its models settled is read again until every model is final', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    // R4 lists no model yet; R1's grok started past the pid grace with no status or pid file: STALE.
    const files: Files = {
      [`${R4}/run.meta`]: { text: runMeta(R4, 'early', ''), mtimeMs: NOW - 60_000 },
      [`${R1}/run.meta`]: { text: runMeta(R1, 'design', 'grok'), mtimeMs: NOW - 300_000 },
      [`${R1}/grok.started`]: { text: `${(NOW - 120_000) / 1000}\n` },
    }

    seat(on, files)
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const rows = async () => rowsOf(await $.ui.render(PANE)).map(line => line.replace(/ +/g, ' ').trim())

    const before = await rows()

    expect(before.some(row => row.includes('grok STALE')), before.join('\n')).toBe(true)
    expect(before.some(row => row.includes('codex')), before.join('\n')).toBe(false)

    files[`${R4}/run.meta`] = { text: runMeta(R4, 'early', 'codex'), mtimeMs: NOW - 60_000 }
    files[`${R4}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 5_000 }
    files[`${R1}/grok.status`] = { text: 'DONE\n', mtimeMs: NOW + 5_000 }
    await clock.advance(16_000)

    const after = await rows()

    expect(after.some(row => row.startsWith('✓ codex DONE')), after.join('\n')).toBe(true)
    expect(after.some(row => row.startsWith('✓ grok DONE')), after.join('\n')).toBe(true)
  })

  test('stale-open-report: the open report of a running review reloads once a model ends, and only then', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const world = seat(on, files)
    const codexJson = () => world.reads.filter(path => path === `${ROOT}/${R1}/codex.json`).length

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await ui.press({ key: `read-run-${R1}` })
    expect(await ui.find({ type: 'Markdown', text: /CLAIM-NEW/ })).toBeUndefined()

    files[`${R1}/codex.json`] = { text: JSON.stringify({ verdict: 'needs_changes', summary: 's', findings: [{ severity: 'major', file: 'a.ts', line: 1, claim: 'CLAIM-NEW', quote: 'q', failure_scenario: 'f' }] }) }
    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 4_000 }
    await clock.advance(3_000)
    expect(await ui.find({ type: 'Markdown', text: /CLAIM-NEW/ })).toBeDefined()

    const loaded = codexJson()

    await clock.advance(40_000)
    expect(codexJson(), 'nothing changed: no reload').toBe(loaded)
    await ui.unmount()
  })

  test('a reload begun before the severity toggle lands after it without undoing it: body and button agree', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const world = seat(on, files)
    let release = () => {}
    let isHeld = false

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await ui.press({ key: `read-run-${R1}` })
    files[`${R1}/codex.json`] = { text: JSON.stringify({ verdict: 'needs_changes', summary: 's', findings: [{ severity: 'minor', file: 'a.ts', line: 1, claim: 'CLAIM-MINOR', quote: 'q', failure_scenario: 'f' }] }) }
    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 4_000 }
    world.beforeRead = path => {
      if (isHeld || path !== `${ROOT}/${R1}/codex.json`) {
        return Promise.resolve()
      }

      isHeld = true

      return new Promise(resolve => {
        release = resolve
      })
    }
    await clock.advance(3_000)
    expect(isHeld, 'the tick reload waits on codex.json').toBe(true)

    await ui.press({ key: 'dash-severity' })
    release()
    await clock.settle()
    expect(await ui.find({ type: 'Markdown', text: /CLAIM-MINOR/ })).toBeDefined()
    expect((await ui.find({ key: 'dash-severity' }))?.props.label).toBe('只看 Critical/Major')
    await ui.unmount()
  })

  test('conversation-view: a running codex’s own transcript shows in the desktop reader, read again on each poll while it runs', { options: { language: 'en' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const rollout = '/h/.codex/sessions/2026/10/02/rollout-x.jsonl'
    const item = (payload: Record<string, unknown>) => JSON.stringify({ timestamp: 't', type: 'response_item', payload })

    files[`${R1}/codex.events.jsonl`] = { text: `${JSON.stringify({ type: 'task_progress', ts: NOW, task_id: 'x', usage: { tool_uses: 1, output_tokens: 3_400 }, transcript_path: rollout })}\n` }

    const world = seat(on, files)
    const tails = () => world.runs.filter(argv => argv[0] === 'tail' && argv.at(-1) === rollout).length

    world.alive.add('111')
    world.stdout = [
      item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'REVIEW-THE-DIFF' }] }),
      item({ type: 'custom_tool_call', name: 'apply_patch', input: 'PATCH-INPUT' }),
      item({ type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'PATCH-OK' }] }),
    ].join('\n')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const pane = (await $.ui.mount({ plugin: PLUGIN, ...PANE, surface: 'desktop' } as never)) as Mounted<'desktop'>

    expect(JSON.stringify(await pane.drawn()), 'the running codex’s tokens from its progress').toContain('3.4k')
    await pane.press({ key: `read-run-${R1}` })
    expect((await pane.find({ key: 'dash-view' }))?.props).toMatchObject({ value: 'report' })
    expect(tails(), 'not read for the report view').toBe(0)

    await pane.select({ key: 'dash-view', value: 'conversation' })
    expect(world.runs).toContainEqual(['tail', '-c', '262144', rollout])
    expect(await pane.find({ type: 'Markdown', text: 'REVIEW-THE-DIFF' })).toBeDefined()
    expect(JSON.stringify(await pane.drawn())).toContain('"source":"PATCH-INPUT"')
    expect(JSON.stringify(await pane.drawn())).toContain('"source":"PATCH-OK"')
    expect(await pane.find({ type: 'Text', text: 'apply_patch' })).toBeDefined()

    const once = tails()

    await clock.advance(3_000)
    expect(tails(), 'the next poll reads it again').toBe(once + 1)

    await pane.select({ key: 'dash-model', value: 'grok' })
    expect(await pane.find({ key: 'dash-view' }), 'grok gave no transcript').toBeUndefined()
    await clock.advance(3_000)
    expect(tails(), 'grok shown: no read of codex’s').toBe(once + 1)
    await pane.unmount()
  })

  test('conversation-view: a codex that ends between two polls has its last reply read once more', { options: { language: 'en' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const rollout = '/h/.codex/sessions/2026/10/02/rollout-x.jsonl'
    const item = (payload: Record<string, unknown>) => JSON.stringify({ timestamp: 't', type: 'response_item', payload })

    files[`${R1}/codex.events.jsonl`] = { text: `${JSON.stringify({ type: 'task_progress', ts: NOW, task_id: 'x', usage: { tool_uses: 1 }, transcript_path: rollout })}\n` }

    const world = seat(on, files)
    const tails = () => world.runs.filter(argv => argv[0] === 'tail' && argv.at(-1) === rollout).length

    world.alive.add('111')
    world.stdout = item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'REVIEW-THE-DIFF' }] })
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const pane = (await $.ui.mount({ plugin: PLUGIN, ...PANE, surface: 'desktop' } as never)) as Mounted<'desktop'>

    await pane.press({ key: `read-run-${R1}` })
    await pane.select({ key: 'dash-view', value: 'conversation' })
    expect(await pane.find({ type: 'Markdown', text: 'REVIEW-THE-DIFF' })).toBeDefined()

    world.stdout = [world.stdout, item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FINAL-REPLY' }] })].join('\n')
    world.alive.delete('111')
    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 4_000 }
    await clock.advance(3_000)
    expect(await pane.find({ type: 'Markdown', text: 'FINAL-REPLY' }), 'the poll that sees it done reads it once more').toBeDefined()

    const done = tails()

    await clock.advance(3_000)
    expect(tails(), 'done before this poll: not read again').toBe(done)
    await pane.unmount()
  })

  test('conversation-view: a transcript_path outside the codex and grok sessions runs no process and reads as unreadable', { options: { language: 'en' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const outside = '/h/.codex/sessions/../../.ssh/id_rsa'

    files[`${R1}/codex.events.jsonl`] = { text: `${JSON.stringify({ type: 'task_progress', ts: NOW, task_id: 'x', transcript_path: outside })}\n` }

    const world = seat(on, files)

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const pane = (await $.ui.mount({ plugin: PLUGIN, ...PANE, surface: 'desktop' } as never)) as Mounted<'desktop'>

    await pane.press({ key: `read-run-${R1}` })
    await pane.select({ key: 'dash-view', value: 'conversation' })
    expect((await pane.findAll({ type: 'Text', text: 'Could not read this transcript' })).map(one => one.props.color)).toEqual(['warning'])

    await clock.advance(3_000)
    expect(world.runs.filter(argv => argv.some(arg => arg.includes('.ssh')))).toEqual([])
    await pane.unmount()
  })

  test('a running model shows its tools and last tool from its events; a run another session started folds under one row', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const started = (session: string) => JSON.stringify({ type: 'task_started', ts: NOW, task_id: 'x', provider: 'codex', mode: 'review', description: 'design', claude_session: session })

    files[`${R1}/codex.events.jsonl`] = {
      text: `${[started('me'), JSON.stringify({ type: 'task_progress', ts: NOW, task_id: 'x', usage: { tool_uses: 3 }, last_tool_name: 'Read board.ts', summary: 'reading' })].join('\n')}\n`,
    }
    files[`${R4}/run.meta`] = { text: runMeta(R4, 'other', 'grok'), mtimeMs: NOW - 200_000 }
    files[`${R4}/grok.status`] = { text: 'DONE\n', mtimeMs: NOW - 100_000 }
    files[`${R4}/grok.started`] = { text: `${(NOW - 160_000) / 1000}\n` }
    files[`${R4}/grok.meta`] = { text: 'secs=60\nexit=0\n' }
    files[`${R4}/grok.events.jsonl`] = { text: `${started('someone-else')}\n` }

    const world = seat(on, files)

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)
    const rows = async () => rowsOf(await ui.drawn()).slice(1).map(line => line.replace(/ +/g, ' ').trim())

    expect(await rows()).toEqual([
      'design · review aaaa proj [ Read ]',
      '● codex RUNNING 4m15s — tok 3 tools · Read board.ts',
      '✓ grok DONE 5m02s 25.8k tok',
      '- · review cccc proj [ Read ]',
      '✗ agy FAIL:1 1m40s — tok',
      'Runs from other sessions: 1',
    ])
    await ui.press({ key: 'runs-fold' })
    expect((await rows()).slice(-3)).toEqual(['Runs from other sessions: 1', 'other · review dddd proj [ Read ]', '✓ grok DONE 1m00s — tok'])
    expect(world.reads.some(path => path.endsWith('.raw'))).toBe(false)
    await ui.unmount()
  })
})

describe('gpu page', () => {
  test('/gpu opens the GPU page on one ssh that sends a sample every 3 s, ended on another page or once the pane closes', { options: { language: 'zh-CN' }, timeoutMs: 15_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on, {}, clock)

    await $.session.start(SESSION)
    await $.command.run(command('gpu', 'gpu-box'))
    await clock.settle()

    expect(world.opened).toEqual([{ id: 'dashboard', title: '工作台' }])
    expect(world.spawns).toHaveLength(1)
    expect(world.spawns[0]?.at(-2)).toBe('gpu-box')

    const tegra = textOf(await $.ui.render(PANE))

    expect(tegra).toContain('GPU · gpu-box')
    expect(tegra).toContain('GR3D ')
    expect(tegra).toContain('37%')
    expect(tegra).toContain('RAM 5.0/29.8 GiB')
    expect(tegra).toContain('46°C')

    await clock.advance(6_000)
    expect(world.samples).toBe(3)
    expect(world.spawns, 'one connection').toHaveLength(1)

    await $.command.run(command('subagents'))
    await clock.settle()
    expect(world.killed, 'another page ends the ssh').toBe(1)

    await clock.advance(9_000)
    expect(world.samples, 'nothing read on another page').toBe(3)

    await $.command.run(command('gpu'))
    await clock.settle()
    expect(world.spawns).toHaveLength(2)
    expect(world.samples).toBe(4)

    // The test engine cannot raise the person's close; the pane leaving the engine's list is the same signal to the stream.
    world.panes.delete('dashboard')
    await clock.advance(9_000)
    expect(world.killed, 'the next pass finds the pane gone and ends the ssh').toBe(2)
    expect(world.samples).toBe(5)
    expect(world.spawns).toHaveLength(2)
  })

  test('pane-existence-as-visibility: the GPU page behind another tab ends its ssh at the next pass; drawn on screen again, it connects again', { options: { language: 'zh-CN' }, timeoutMs: 15_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on, {}, clock)

    await $.session.start(SESSION)
    await $.command.run(command('gpu', 'gpu-box'))
    await clock.settle()
    expect(world.samples).toBe(1)

    world.hidden.add('dashboard')
    await clock.advance(9_000)
    expect(world.killed, 'the next pass finds the pane hidden and ends the ssh').toBe(1)
    expect(world.samples).toBe(2)
    expect(world.spawns).toHaveLength(1)

    world.hidden.delete('dashboard')
    await $.ui.render(PANE)
    await clock.settle()
    expect(world.spawns, 'shown again: a new ssh').toHaveLength(2)
    expect(world.samples).toBe(3)

    await $.ui.render(PANE)
    await clock.settle()
    expect(world.spawns, 'a drawing while it runs adds none').toHaveLength(2)
  })

  test('nvidia rows with a bar, the top processes, and an NVML error', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on, {}, clock)

    world.stdout = NVIDIA_RUN
    await $.session.start(SESSION)
    await $.command.run(command('gpu', 'lab-box'))
    await clock.settle()

    const rows = textOf(await $.ui.render(PANE))

    expect(rows).toContain('0  RTX 4090  ▇')
    expect(rows).toContain('52%  18.2/24.0 GiB  67°C  280W')
    expect(rows).toContain('4242')
    expect(rows).toContain('python3')

    world.stdout = NVML_RUN
    await clock.advance(3_000)

    const tree = await $.ui.render(PANE)

    expect(linesOf(tree).slice(0, 3)).toEqual(['GPU · lab-box', '~ stale · last success 3s ago', '✗ Failed to initialize NVML: Driver/library version mismatch'])
    expect(colorsOf(tree, '~ stale · last success 3s ago')).toEqual(['warning'])
    expect(textOf(tree), 'the last good sample stays').toContain('52%  18.2/24.0 GiB  67°C  280W')
    expect(isDimText(tree, '52%  18.2/24.0 GiB'), 'and is dim').toBe(true)
    expect(isDimText(tree, 'python3')).toBe(true)
  })

  test('zh-CN: /gpu replies and the GPU page lines are Chinese', { options: { language: 'zh-CN' }, timeoutMs: 15_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on, {}, clock)

    await $.session.start(SESSION)
    expect((await $.command.run(command('gpu'))).text).toBe('用法：/gpu <host>')
    expect((await $.command.run(command('gpu', '-oProxyCommand=x'))).text).toBe('不是主机名：-oProxyCommand=x')

    world.stdout = NVML_RUN
    expect((await $.command.run(command('gpu', 'lab-box'))).text).toBeUndefined()
    await clock.settle()
    expect(textOf(await $.ui.render(PANE))).toContain('还没有成功的采样')

    world.stdout = '@@NOGPU'
    await clock.advance(3_000)
    expect(textOf(await $.ui.render(PANE))).toContain('此主机上没有 GPU。')

    world.stdout = NVIDIA_RUN
    await clock.advance(3_000)
    expect(textOf(await $.ui.render(PANE))).toContain('显存占用最多的进程')

    world.stdout = NVML_RUN
    await clock.advance(3_000)
    expect(textOf(await $.ui.render(PANE))).toContain('~ 数据过期 · 上次成功 3s 前')
    expect(textOf(await $.ui.render(PANE)), 'the last good sample stays').toContain('显存占用最多的进程')
  })

  test('/gpu with a host that looks like an option is refused', async ($, on) => {
    mock.clock(on)

    const world = seat(on)

    await $.session.start(SESSION)
    expect((await $.command.run(command('gpu', '-oProxyCommand=x'))).text).toContain('Not a host name')
    expect(world.opened).toEqual([])
  })

  test('a Bash ssh call to a listed host opens the GPU page once; other commands do not', { options: { gpuHosts: 'gpu-box, lab-box', language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.ui.render(BAND)

    for (const cmd of ['echo ssh gpu-box', 'ssh other nvidia-smi', 'ls']) {
      await $.classic.PostToolUse(ran('Bash', { command: cmd }))
    }

    await $.classic.PostToolUse(ran('Read', { command: 'ssh gpu-box' }))
    expect(await $.tool.call({ tool: 'Bash', command: 'ssh gpu-box ls' } as never), 'no tool.call hook stands in the way of Bash').toMatchObject({ text: 'ok' })
    await clock.settle()
    expect(world.opened).toEqual([])

    await $.classic.PostToolUse(ran('Bash', { command: 'ssh gpu-box nvidia-smi' }))
    await clock.settle()
    await $.classic.PostToolUse(ran('Bash', { command: 'ssh -p 22 gpu-box ls' }))
    await clock.settle()
    expect(world.opened).toEqual([{ id: 'dashboard', title: '工作台' }])

    await $.classic.PostToolUse(ran('Bash', { command: 'ssh -o BatchMode=yes lab-box ls' }))
    await clock.settle()
    expect(world.spawns.at(-1)?.at(-2), 'on the GPU page the new host replaces the old').toBe('lab-box')
    expect(world.killed, 'and its ssh ends').toBe(1)
    expect(world.opened).toHaveLength(1)
  })

  test('an ssh call opens nothing unasked where a pane would take over the screen, or before any drawing said', { options: { gpuHosts: 'gpu-box', language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.classic.PostToolUse(ran('Bash', { command: 'ssh gpu-box ls' }))
    await clock.settle()
    expect(world.opened, 'nothing drawn yet').toEqual([])

    await $.ui.render({ ...BAND, viewport: { columns: 120, rows: 40, isFullscreen: false } })
    await $.classic.PostToolUse(ran('Bash', { command: 'ssh gpu-box ls' }))
    await clock.settle()
    expect(world.opened, 'the main screen').toEqual([])

    await $.command.run(command('gpu', 'gpu-box'))
    await clock.settle()
    expect(world.opened, 'asked: opens').toHaveLength(1)
  })

  test('an ssh call leaves another page alone, and once the person closes the pane it never opens unasked', { options: { gpuHosts: 'gpu-box', language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.command.run(command('subagents'))
    await $.classic.PostToolUse(ran('Bash', { command: 'ssh gpu-box ls' }))
    await clock.settle()
    expect(textOf(await $.ui.render(PANE)), 'still on Agents').not.toContain('GPU · gpu-box')
    expect(world.spawns).toHaveLength(0)

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect((await ui.find({ key: 'dash-close' }))?.props).toMatchObject({ label: '关闭' })
    expect((await ui.find({ key: 'dash-close' }))?.props.hotkey).toBeUndefined()
    await ui.press({ key: 'dash-close' })
    await ui.unmount()
    expect(world.panes.size).toBe(0)

    await $.classic.PostToolUse(ran('Bash', { command: 'ssh gpu-box ls' }))
    await clock.settle()
    expect(world.opened).toHaveLength(1)
    expect(world.panes.size).toBe(0)

    await $.command.run(command('gpu', 'gpu-box'))
    await clock.settle()
    expect(world.opened, 'asked: opens').toHaveLength(2)
  })
  test('a dropped ssh keeps the last sample dim under its error, and connects again 3 s, 6 s, 12 s … at most 60 s later', { options: { language: 'zh-CN' }, timeoutMs: 15_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on, {}, clock)

    world.stdout = NVIDIA_RUN
    await $.session.start(SESSION)
    await $.command.run(command('gpu', 'lab-box'))
    await clock.settle()
    world.sshDown = 'Connection to lab-box closed by remote host.'
    await clock.advance(3_000)

    const tree = await $.ui.render(PANE)

    expect(linesOf(tree).slice(0, 3)).toEqual(['GPU · lab-box', '~ 数据过期 · 上次成功 3s 前', '✗ Connection to lab-box closed by remote host.'])
    expect(isDimText(tree, '52%  18.2/24.0 GiB'), 'the last sample stays, dim').toBe(true)

    await clock.advance(214_000)
    expect(world.spawnedAt).toEqual([1_000, 7_000, 13_000, 25_000, 49_000, 97_000, 157_000, 217_000])
    expect(world.killed).toBe(0)

    world.sshDown = null
    await clock.advance(60_000)
    expect(world.spawnedAt.at(-1)).toBe(277_000)
    expect(textOf(await $.ui.render(PANE)), 'a sample again: no longer stale').not.toContain('数据过期')

    world.sshDown = 'Connection to lab-box closed by remote host.'
    await clock.advance(3_000)
    await clock.advance(3_000)
    expect(world.spawnedAt.at(-1), 'a sample since: the wait starts again at 3 s').toBe(283_000)
  })

  test('the session ending ends the GPU ssh; a /clear leaves it', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.command.run(command('gpu', 'lab-box'))
    await clock.settle()
    await $.session.end({ reason: 'clear', sessionId: 'me' } as never)
    await clock.settle()
    expect(world.killed).toBe(0)

    await $.session.end({ reason: 'other', sessionId: 'me' } as never)
    await clock.settle()
    expect(world.killed).toBe(1)
  })
})

describe('other sessions', () => {
  test('prompt.submit writes working, the main turn.complete replied, a heartbeat every 30 s; a subagent turn.complete leaves the file alone', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    expect(mine(world)).toMatchObject({ id: 'me', name: 'harness', state: 'idle', since: NOW, updatedAt: NOW })

    await clock.advance(1_000)
    await $.prompt.submit(PROMPT)
    expect(mine(world)).toMatchObject({ state: 'working', since: NOW + 1_000, turnStartedAt: NOW + 1_000 })

    await $.agent.spawn(SPAWN as never)

    const before = world.sessions['me.json']

    await $.turn.complete(complete('a1'))
    expect(world.sessions['me.json'], 'a subagent turn').toBe(before)

    await clock.advance(2_000)
    await $.turn.complete({ answer: 'done', durationMs: 2_000, isAborted: false, turnId: 't', reason: 'answer', usage: usage(10) } as never)
    expect(mine(world)).toMatchObject({ state: 'replied', since: NOW + 3_000, turnStartedAt: NOW + 1_000 })

    await clock.advance(30_000)
    expect(mine(world)).toMatchObject({ state: 'replied', since: NOW + 3_000, updatedAt: NOW + 30_000 })

    await $.session.end({ reason: 'other', sessionId: 'me', resume: {} } as never)
    expect(mine(world)).toMatchObject({ state: 'ended' })
  })

  test('a main-thread PermissionRequest writes permission and the tool; the next main-thread tool result writes working', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await clock.advance(1_000)
    await $.classic.PermissionRequest({ tool_name: 'Write', tool_input: {}, agent_id: 'a9' } as never)
    expect(mine(world), 'a subagent asking').toMatchObject({ state: 'permission', detail: 'a9: Write' })

    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm x' } } as never)
    expect(mine(world)).toMatchObject({ state: 'permission', detail: 'Bash', since: NOW + 1_000, turnStartedAt: NOW })

    await $.classic.PostToolUse(ran('Read', { file_path: '/w/x' }, 'a9'))
    expect(mine(world)).toMatchObject({ state: 'permission' })

    await clock.advance(1_000)
    await $.classic.PostToolUse(ran('Bash', { command: 'rm x' }))
    expect(mine(world)).toMatchObject({ state: 'working', since: NOW + 2_000, turnStartedAt: NOW })
    expect(mine(world)?.detail).toBeUndefined()
  })

  test('a subagent asking marks the session permission with its type and the tool; its own tool result answers it, another agent\'s does not', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await $.agent.spawn({ ...SPAWN, background: false } as never)
    await clock.advance(1_000)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {}, agent_id: 'a1' } as never)
    expect(mine(world)).toMatchObject({ state: 'permission', detail: 'worker: Bash', since: NOW + 1_000, turnStartedAt: NOW })

    await $.classic.PostToolUse(ran('Read', { file_path: '/w/x' }, 'b2'))
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/x' }))
    expect(mine(world), 'another agent and the main thread').toMatchObject({ state: 'permission' })

    await clock.advance(1_000)
    await $.classic.PostToolUse(ran('Bash', { command: 'ls' }, 'a1'))
    expect(mine(world)).toMatchObject({ state: 'working', since: NOW + 2_000, turnStartedAt: NOW })

    await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: {}, agent_id: 'f00dcafe1234' } as never)
    expect(mine(world), 'not in the agents list: its id cut to 8').toMatchObject({ state: 'permission', detail: 'f00dcafe: Edit' })

    await $.classic.PermissionDenied(denied('Edit', 'f00dcafe1234'))
    expect(mine(world)).toMatchObject({ state: 'working' })
  })

  test('a PermissionRequest the settings hooks beneath already decided asks nobody: the session stays working', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await clock.advance(1_000)
    world.decision = { behavior: 'allow' }
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    expect(mine(world)).toMatchObject({ state: 'working', since: NOW })

    world.decision = { behavior: 'deny', message: 'no' }
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {}, agent_id: 'a9' } as never)
    expect(mine(world)).toMatchObject({ state: 'working', since: NOW })

    world.decision = undefined
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    expect(mine(world)).toMatchObject({ state: 'permission', detail: 'Bash', since: NOW + 1_000 })
  })

  test('a reload mid-turn keeps the presence the session had: session.start again leaves state and since alone', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await clock.advance(1_000)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    await clock.advance(1_000)
    await $.session.start(SESSION)
    expect(mine(world), 'asking').toMatchObject({ state: 'permission', detail: 'Bash', since: NOW + 1_000, turnStartedAt: NOW })

    await $.classic.PostToolUse(ran('Bash', { command: 'ls' }))
    await clock.advance(1_000)
    await $.session.start(SESSION)
    expect(mine(world), 'working').toMatchObject({ state: 'working', since: NOW + 2_000, turnStartedAt: NOW })
  })

  test('a main Stop with background work in flight leaves the session working, before or after turn.complete; with none it is replied', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const TASK = { id: 'w1', type: 'subagent', status: 'running', description: 'worker', agent_type: 'worker' }
    const stop = (background_tasks: unknown[]) => $.classic.Stop({ stop_hook_active: false, background_tasks } as never)
    const reply = () => $.turn.complete({ answer: 'done', durationMs: 2_000, isAborted: false, turnId: 't', reason: 'answer', usage: usage(10) } as never)
    const turn = async (n: number) => {
      await $.prompt.submit(PROMPT)
      await $.turn.start({ text: 'go', turnId: `t${n}` } as never)
      await clock.advance(1_000)
    }

    await $.session.start(SESSION)
    await turn(1)
    await stop([TASK])
    await reply()
    expect(mine(world), 'Stop first').toMatchObject({ state: 'working' })

    await turn(2)
    await reply()
    await stop([TASK])
    expect(mine(world), 'turn.complete first').toMatchObject({ state: 'working' })

    await turn(3)
    await stop([])
    await reply()
    expect(mine(world), 'Stop first, nothing in flight').toMatchObject({ state: 'replied' })

    await turn(4)
    await reply()
    await stop([])
    expect(mine(world), 'turn.complete first, nothing in flight').toMatchObject({ state: 'replied' })

    await $.classic.Stop({ stop_hook_active: false, background_tasks: [TASK], agent_id: 'a1' } as never)
    expect(mine(world), 'a subagent\'s Stop').toMatchObject({ state: 'replied' })
  })

  test('another session waiting on a permission draws its ! in warning, on the band, in its summary and on the overview', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'permission', NOW - 1_000, { name: 'mm', detail: 'Bash', updatedAt: NOW })
    world.sessions['p2.json'] = peer('p2', 'permission', NOW - 1_000, { name: 'ui', detail: 'Edit', updatedAt: NOW })
    world.sessions['p3.json'] = peer('p3', 'permission', NOW - 1_000, { name: 'web', detail: 'Write', updatedAt: NOW })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    expect(colorsOf(await $.ui.render(BAND), '!')).toEqual(['warning', 'warning', 'warning'])
    expect(linesOf(await $.ui.render(bandOf(2))).slice(0, 2)).toEqual(['! mm 待授权 Bash · 6s', '会话 !2'])
    expect(colorsOf(await $.ui.render(bandOf(2)), '!'), 'a line, then the group of the other two').toEqual(['warning', 'warning'])

    await $.command.run(command('dashboard'))
    expect(colorsOf(await $.ui.render(PANE), '!')).toEqual(['warning', 'warning', 'warning'])
  })

  test('another session waiting on a permission is a 需要你 row and 等你1; working ones count as running; 90 s without a heartbeat or ended is gone', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'permission', NOW - 180_000, { name: 'mm', detail: 'Bash', turnStartedAt: NOW - 200_000, updatedAt: NOW })
    world.sessions['p2.json'] = peer('p2', 'permission', NOW - 60_000, { name: 'old', detail: 'Edit', updatedAt: NOW - 86_000 })
    world.sessions['p3.json'] = peer('p3', 'ended', NOW - 1_000, { updatedAt: NOW })
    world.sessions['p4.json'] = peer('p4', 'working', NOW - 65_000, { name: 'ui', title: 'fix band', turnStartedAt: NOW - 65_000, updatedAt: NOW })
    await $.session.start(SESSION)
    await clock.advance(5_000)

    const card = linesOf(await $.ui.render(BAND))

    expect(card[0], 'a card framed in warning, as wide as the band').toMatch(/^╭─ 需要你 ─+╮$/)
    expect(card.slice(1, 4).map(line => line.replace(/ +│$/, ''))).toEqual(['│ ! mm 待授权  · 已等 3m05s', '│ 任务  mm', '│ 请求  Bash'])
    expect(card.slice(-2)).toEqual([`╰${'─'.repeat(98)}╯`, 'engine band'])
    expect([card[0], ...card.slice(1, 4)].map(line => widthOf(line ?? ''))).toEqual([100, 100, 100, 100])

    const band = await $.ui.mount({ plugin: PLUGIN, ...BAND } as never)

    expect((await band.find({ key: 'ask-p1' }))?.props, 'no number hotkey').toMatchObject({ label: '去处理' })
    expect((await band.find({ key: 'ask-p1' }))?.props.hotkey).toBeUndefined()
    expect((await band.find({ key: 'dash-open' }))?.props, 'the card alone on the band carries 工作台').toMatchObject({ label: '工作台' })
    await band.press({ key: 'ask-p1' })
    expect(world.opened).toEqual([{ id: 'dashboard', title: '工作台' }])
    await band.unmount()

    await $.command.run(command('dashboard'))

    const lines = linesOf(await $.ui.render(PANE))

    expect(lines.slice(0, 3)).toEqual(['其他会话 · 2', expect.stringMatching(/^! 待授权 mm +3m05s$/), expect.stringMatching(/^● 进行中 ui · fix band +1m10s$/)])
    expect(widthOf(lines[1] ?? ''), 'the copy button after it ends at the pane edge').toBe(70 - widthOf('[ 复制 resume ]') - 1)
    expect(lines.join('\n')).not.toContain('old')

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface: 'desktop' } as never)

    expect(await ui.find({ type: 'Text', text: '其他会话 · 2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ui · fix band' })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: '! 待授权' })).map(one => one.props.color), 'waiting on a permission is no failure: yellow').toContain('warning')
    await ui.unmount()
  })

  test('a session entering permission, or replying after a long turn, toasts once; a short turn does not', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'working', NOW - 1_000, { name: 'mm', turnStartedAt: NOW - 1_000 })
    world.sessions['p2.json'] = peer('p2', 'working', NOW - 1_000, { turnStartedAt: NOW - 1_000 })
    world.sessions['p3.json'] = peer('p3', 'working', NOW - 1_000, { name: 'ui', turnStartedAt: NOW + 15_000 - 720_000 })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    expect(world.toasts).toEqual([])

    world.sessions['p1.json'] = peer('p1', 'permission', NOW + 5_000, { name: 'mm', detail: 'Bash', turnStartedAt: NOW - 1_000 })
    world.sessions['p2.json'] = peer('p2', 'replied', NOW + 5_000, { turnStartedAt: NOW - 1_000 })
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['mm 等你授权：Bash'])

    await clock.advance(5_000)
    expect(world.toasts, 'the same change polled again').toHaveLength(1)

    world.sessions['p3.json'] = peer('p3', 'replied', NOW + 15_000, { name: 'ui', turnStartedAt: NOW + 15_000 - 720_000 })
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['mm 等你授权：Bash', 'ui 已答复（这轮 12m00s）'])
  })

  test('a session replied 30 min ago or more no longer waits on you', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'replied', NOW - 29 * 60_000, { name: 'mm', updatedAt: NOW })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    await $.command.run(command('dashboard'))
    expect(textOf(await $.ui.render(PANE))).toContain('其他会话 · 1')

    world.sessions['p1.json'] = peer('p1', 'replied', NOW + 5_000 - 31 * 60_000, { name: 'mm', updatedAt: NOW + 5_000 })
    await clock.advance(5_000)
    expect(textOf(await $.ui.render(PANE))).not.toContain('其他会话')

    world.sessions['p1.json'] = peer('p1', 'replied', NOW + 10_000 - 29 * 60_000, { name: 'mm', updatedAt: NOW + 10_000 })
    await clock.advance(5_000)
    expect(textOf(await $.ui.render(PANE))).toContain('其他会话 · 1')
  })

  test('a second PermissionRequest with another tool rewrites the detail and toasts again; the same tool writes once', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    // Another session sees this one's file as `other.json`.
    const share = () => {
      world.sessions['other.json'] = world.sessions['me.json'] ?? ''
    }

    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    share()
    await clock.advance(5_000)

    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    share()
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['harness · go 等你授权：Bash'])

    const before = world.sessions['me.json']

    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    expect(world.sessions['me.json'], 'the same tool').toBe(before)

    await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: {} } as never)
    expect(mine(world)).toMatchObject({ state: 'permission', detail: 'Edit', since: NOW + 10_000 })
    share()
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['harness · go 等你授权：Bash', 'harness · go 等你授权：Edit'])
  })

  test('polls that find the same sessions write the peers once', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const written = writes(on, 'peers')

    world.sessions['p1.json'] = peer('p1', 'working', NOW - 1_000, { name: 'mm', turnStartedAt: NOW - 1_000 })
    await $.session.start(SESSION)
    await clock.advance(5_000)

    const first = written()

    expect(first).toBeGreaterThan(0)
    await clock.advance(15_000)
    expect(written()).toBe(first)

    world.sessions['p1.json'] = peer('p1', 'permission', NOW + 20_000, { name: 'mm', detail: 'Bash', turnStartedAt: NOW - 1_000 })
    await clock.advance(5_000)
    expect(written(), 'a change is written').toBe(first + 1)
  })

  test('this session\'s own file and idle sessions are not shown', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'idle', NOW - 1_000)
    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    await clock.advance(5_000)
    expect(mine(world)).toMatchObject({ state: 'permission' })
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)

    await $.command.run(command('dashboard'))
    expect(textOf(await $.ui.render(PANE))).not.toContain('其他会话')
  })

  test('a main turn ended by Esc is idle; by an error or a refusal failed, which a later Stop leaves alone until the next prompt; a cron is background work', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const end = (reason: string) => $.turn.complete({ answer: '', durationMs: 1_000, isAborted: reason === 'aborted', turnId: 't', reason, usage: usage(10) } as never)
    const stop = (more: Record<string, unknown> = {}) => $.classic.Stop({ stop_hook_active: false, background_tasks: [], ...more } as never)

    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await clock.advance(1_000)
    await end('aborted')
    expect(mine(world), 'Esc').toMatchObject({ state: 'idle' })
    await stop()
    expect(mine(world), 'a Stop after Esc').toMatchObject({ state: 'idle' })

    for (const reason of ['error', 'refusal']) {
      await $.prompt.submit(PROMPT)
      expect(mine(world)).toMatchObject({ state: 'working' })
      await clock.advance(1_000)
      await end(reason)
      expect(mine(world), reason).toMatchObject({ state: 'failed' })
      await stop()
      expect(mine(world), `a Stop after ${reason}`).toMatchObject({ state: 'failed' })
    }

    await $.prompt.submit(PROMPT)
    await stop({ session_crons: [{ id: 'c1', cron: '*/5 * * * *', prompt: 'check' }] })
    await end('answer')
    expect(mine(world), 'a cron wakes it later').toMatchObject({ state: 'working' })
  })

  test('another session whose turn failed is a red ✗ on the band and the overview, waits on you until its next prompt, and toasts once', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const names = ['mm', 'ui', 'web']

    names.forEach((name, i) => {
      world.sessions[`p${i}.json`] = peer(`p${i}`, 'working', NOW - 1_000, { name, title: 'fix band', turnStartedAt: NOW - 1_000 })
    })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    names.forEach((name, i) => {
      world.sessions[`p${i}.json`] = peer(`p${i}`, 'failed', NOW + 5_000 + i, { name, title: 'fix band', turnStartedAt: NOW - 1_000 })
    })
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['✗ mm · fix band 出错', '✗ ui · fix band 出错', '✗ web · fix band 出错'])
    expect(linesOf(await $.ui.render(BAND)).slice(0, 3)).toEqual(['✗ mm 出错 · 5s', '✗ ui 出错 · 4s', '✗ web 出错 · 4s'])
    expect(colorsOf(await $.ui.render(BAND), '✗')).toEqual(['error', 'error', 'error'])
    expect(linesOf(await $.ui.render(bandOf(2))).slice(0, 2)).toEqual(['✗ mm 出错 · 5s', '会话 ✗2'])
    expect(colorsOf(await $.ui.render(bandOf(2)), '✗'), 'a line, then the group of the other two').toEqual(['error', 'error'])
    expect(linesOf(await $.ui.render(bandOf(1)))[0]).toBe('等你3')

    await $.command.run(command('dashboard'))
    expect(linesOf(await $.ui.render(PANE)).slice(0, 2)).toEqual(['其他会话 · 3', expect.stringMatching(/^✗ 出错 mm · fix band +5s$/)])
    expect(colorsOf(await $.ui.render(PANE), '✗')).toEqual(['error', 'error', 'error'])

    await clock.advance(30 * 60_000)
    names.forEach((name, i) => {
      world.sessions[`p${i}.json`] = peer(`p${i}`, 'failed', NOW + 5_000 + i, { name, title: 'fix band', turnStartedAt: NOW - 1_000, updatedAt: NOW + 30 * 60_000 })
    })
    await clock.advance(5_000)
    expect(linesOf(await $.ui.render(bandOf(1)))[0], 'still waiting after 30 min').toBe('等你3')
    expect(world.toasts).toHaveLength(3)

    names.forEach((name, i) => {
      world.sessions[`p${i}.json`] = peer(`p${i}`, 'working', NOW + 30 * 60_000 + 5_000, { name, turnStartedAt: NOW + 30 * 60_000 + 5_000 })
    })
    await clock.advance(5_000)
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)
  })

  test('a session that went silent and came back toasts nothing again: neither the state it toasted nor a new one', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const asking = (since: number, detail: string, updatedAt = since) => peer('p1', 'permission', since, { name: 'mm', detail, turnStartedAt: NOW - 1_000, updatedAt })

    world.sessions['p1.json'] = peer('p1', 'working', NOW - 1_000, { name: 'mm', turnStartedAt: NOW - 1_000 })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    world.sessions['p1.json'] = asking(NOW + 5_000, 'Bash')
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['mm 等你授权：Bash'])

    await clock.advance(95_000)
    await $.command.run(command('dashboard'))
    expect(textOf(await $.ui.render(PANE)), 'silent past 90 s').not.toContain('其他会话')

    world.sessions['p1.json'] = asking(NOW + 5_000, 'Bash', NOW + 105_000)
    await clock.advance(5_000)
    expect(textOf(await $.ui.render(PANE))).toContain('其他会话 · 1')
    expect(world.toasts, 'back in the state it toasted').toHaveLength(1)

    delete world.sessions['p1.json']
    await clock.advance(5_000)
    world.sessions['p1.json'] = asking(NOW + 115_000, 'Edit')
    await clock.advance(5_000)
    expect(world.toasts, 'back in a new state').toHaveLength(1)

    world.sessions['p1.json'] = asking(NOW + 125_000, 'Write')
    await clock.advance(5_000)
    expect(world.toasts, 'a change while seen').toEqual(['mm 等你授权：Bash', 'mm 等你授权：Write'])
  })

  test('a session file silent past 90 s by its mtime is not read; one whose mtime did not move is read once', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const reads = (name: string) => world.reads.filter(path => path === `${SESSIONS}/${name}`).length

    world.sessions['p1.json'] = peer('p1', 'working', NOW - 100_000, { name: 'old' })
    world.sessions['p2.json'] = peer('p2', 'working', NOW - 1_000, { name: 'mm', updatedAt: NOW })
    await $.session.start(SESSION)
    await clock.advance(15_000)
    expect(reads('p1.json')).toBe(0)
    expect(reads('p2.json')).toBe(1)

    world.sessions['p2.json'] = peer('p2', 'permission', NOW + 15_000, { name: 'mm', detail: 'Bash' })
    await clock.advance(5_000)
    expect(reads('p2.json'), 'a new mtime').toBe(2)
  })

  test('a session file with a field missing or of the wrong kind is left out, never drawn as NaN', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = JSON.stringify({ id: 'p1', name: 'nosince', state: 'working', updatedAt: NOW })
    world.sessions['p2.json'] = JSON.stringify({ id: 'p2', name: 'badstate', state: 'asleep', since: NOW - 1_000, updatedAt: NOW })
    world.sessions['p3.json'] = JSON.stringify({ id: 3, name: 'badid', state: 'working', since: NOW - 1_000, updatedAt: NOW })
    world.sessions['p4.json'] = JSON.stringify({ id: 'p4', name: 'badtime', state: 'permission', since: 'soon', updatedAt: NOW })
    world.sessions['p5.json'] = peer('p5', 'working', NOW - 1_000, { name: 'ok', updatedAt: NOW })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    await $.command.run(command('dashboard'))

    const text = textOf(await $.ui.render(PANE)) + textOf(await $.ui.render(BAND))

    expect(text).toContain('其他会话 · 1')
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('nosince')
  })

  test('a toast names the session with its title; the first prompt titles a session that has none; a reply carries the first line of the last message', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const share = () => {
      world.sessions['other.json'] = world.sessions['me.json'] ?? ''
    }
    const ASK = '把 band 的会话行改成按状态排序，并且在每一行后面加上复制按钮，然后跑一遍测试'
    const SAID = '已把会话行按状态排序，复制按钮也加上了，全部测试通过，没有遗留问题需要你再处理，可以合并了。'

    await $.session.start(SESSION)
    await $.prompt.submit({ text: `${ASK}\n第二行`, wait: false, origin: { kind: 'composer' } } as never)
    expect(mine(world)?.title).toBe(fit(ASK, 40))
    expect(widthOf(String(mine(world)?.title))).toBeLessThanOrEqual(40)
    share()

    for (let i = 0; i < 4; i += 1) {
      await clock.advance(30_000)
      share()
    }

    await $.prompt.submit(PROMPT)
    expect(mine(world)?.title, 'a later prompt keeps it').toBe(fit(ASK, 40))
    await clock.advance(5_000)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], last_assistant_message: `${SAID}\n细节如下` } as never)
    await $.turn.complete({ answer: SAID, durationMs: 2_000, isAborted: false, turnId: 't', reason: 'answer', usage: usage(10) } as never)
    expect(mine(world)).toMatchObject({ state: 'replied', detail: fit(SAID, 60) })
    share()
    await clock.advance(5_000)
    expect(world.toasts).toEqual([`harness · ${fit(ASK, 40)} 已答复（这轮 2m05s）：${fit(SAID, 60)}`])
  })

  test('an other-sessions row copies `claude --resume \'<id>\'` and toasts 已复制, with no letter hotkey, on the terminal and the desktop', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'working', NOW - 1_000, { name: 'mm', updatedAt: NOW })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    await $.command.run(command('dashboard'))

    for (const surface of ['terminal', 'desktop']) {
      const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)
      const button = await ui.find({ key: 'copy-resume-p1' })

      expect(button?.props, surface).toMatchObject({ label: surface === 'terminal' ? '复制 resume' : '命令' })
      expect(button?.props.hotkey, surface).toBeUndefined()
      await ui.press({ key: 'copy-resume-p1' })
      await clock.settle()

      if (surface === 'desktop') {
        expect((await ui.findAll({ type: 'Code' })).map(one => one.props.source), 'the desktop shows the command instead').toContain("claude --resume 'p1'")
      }

      await ui.unmount()
    }

    expect(world.copies).toEqual(["claude --resume 'p1'"])
    expect(world.toasts).toEqual(['已复制'])
  })

  test('typing writes lastInputAt at most every 15 s; the heartbeat carries the latest; a prompt writes it with its state', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await clock.advance(1_000)
    await typeKey($)
    expect(mine(world)).toMatchObject({ lastInputAt: NOW + 1_000 })

    const first = world.sessions['me.json']

    await clock.advance(5_000)
    await typeKey($)
    expect(world.sessions['me.json'], 'within 15 s of the last write').toBe(first)

    await clock.advance(10_000)
    await typeKey($)
    expect(mine(world)).toMatchObject({ lastInputAt: NOW + 16_000 })

    await clock.advance(4_000)
    await typeKey($)
    expect(mine(world)?.lastInputAt).toBe(NOW + 16_000)

    await clock.advance(10_000)
    expect(mine(world), 'the heartbeat').toMatchObject({ lastInputAt: NOW + 20_000, updatedAt: NOW + 30_000 })

    await clock.advance(1_000)
    await $.prompt.submit(PROMPT)
    expect(mine(world)).toMatchObject({ state: 'working', lastInputAt: NOW + 31_000 })
  })

  test('automated-input-as-attention: a prompt the person did not send starts work but is no input; the person\'s own is', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await clock.advance(1_000)
    await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } } as never)
    expect(mine(world)).toMatchObject({ state: 'working' })
    expect(mine(world)?.lastInputAt, 'a task notification').toBeUndefined()

    await clock.advance(20_000)
    await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'peer' } } as never)
    await $.prompt.submit({ text: 'tick', wait: false, origin: { kind: 'scheduled-trigger' } } as never)
    await clock.advance(30_000)
    expect(mine(world)?.lastInputAt, 'a peer and a schedule, through a heartbeat').toBeUndefined()

    await $.prompt.submit(PROMPT)
    expect(mine(world)).toMatchObject({ lastInputAt: NOW + 51_000 })
  })

  test('only the session typed in last within 2 min toasts the other sessions; with no input for 2 min every session does', { options: { language: 'zh-CN', askSound: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    // Heartbeats far ahead keep both files read as live while the clock runs on.
    const mm = (state: string, since: number, detail: string) => peer('p1', state, since, { name: 'mm', detail, turnStartedAt: NOW - 1_000, updatedAt: since + 300_000 })

    world.sessions['p1.json'] = mm('working', NOW - 1_000, '')
    world.sessions['p2.json'] = peer('p2', 'idle', NOW - 1_000, { name: 'ui', lastInputAt: NOW + 1_000, updatedAt: NOW + 300_000 })
    await $.session.start(SESSION)
    await typeKey($)
    await clock.advance(5_000)
    world.sessions['p1.json'] = mm('permission', NOW + 5_000, 'Bash')
    await clock.advance(5_000)
    expect(world.toasts, 'ui was typed in after this one').toEqual([])
    expect(world.clips).toEqual([])

    await typeKey($)
    world.sessions['p1.json'] = mm('failed', NOW + 10_000, '')
    await clock.advance(5_000)
    expect(world.toasts, 'this one typed in last').toEqual(['✗ mm 出错'])

    await clock.advance(125_000)
    world.sessions['p1.json'] = mm('permission', NOW + 140_000, 'Edit')
    await clock.advance(5_000)
    expect(world.toasts, 'no input for 2 min').toEqual(['✗ mm 出错', 'mm 等你授权：Edit'])
  })

  test('askSound: a toast of a session asking or failed chimes once, a reply none, a clip that cannot play nothing', { options: { language: 'zh-CN', askSound: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const mm = (state: string, since: number, more: Record<string, unknown> = {}) => peer('p1', state, since, { name: 'mm', turnStartedAt: NOW - 600_000, ...more })

    world.sessions['p1.json'] = mm('working', NOW - 1_000)
    await $.session.start(SESSION)
    await clock.advance(5_000)
    world.sessions['p1.json'] = mm('permission', NOW + 5_000, { detail: 'Bash' })
    await clock.advance(5_000)
    expect(world.clips).toHaveLength(1)
    expect(world.clips[0], 'a WAV made in code').toMatch(/^UklGR/)

    await clock.advance(5_000)
    expect(world.clips, 'the same toast polled again').toHaveLength(1)

    world.sessions['p1.json'] = mm('replied', NOW + 15_000)
    await clock.advance(5_000)
    expect(world.toasts).toHaveLength(2)
    expect(world.clips, 'a reply').toHaveLength(1)

    world.isMuted = true
    world.sessions['p1.json'] = mm('failed', NOW + 20_000)
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['mm 等你授权：Bash', 'mm 已答复（这轮 10m15s）', '✗ mm 出错'])
    expect(world.clips).toHaveLength(2)
  })

  test('askSound is off unless set', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'working', NOW - 1_000, { name: 'mm' })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    world.sessions['p1.json'] = peer('p1', 'permission', NOW + 5_000, { name: 'mm', detail: 'Bash' })
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['mm 等你授权：Bash'])
    expect(world.clips).toEqual([])
  })

  test('toastPeerAsks off: a session asking or failed neither toasts nor chimes; a reply still toasts', { options: { language: 'zh-CN', askSound: true, toastPeerAsks: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const mm = (state: string, since: number, more: Record<string, unknown> = {}) => peer('p1', state, since, { name: 'mm', turnStartedAt: NOW - 600_000, ...more })

    world.sessions['p1.json'] = mm('working', NOW - 1_000)
    await $.session.start(SESSION)
    await clock.advance(5_000)
    world.sessions['p1.json'] = mm('permission', NOW + 5_000, { detail: 'Bash' })
    await clock.advance(5_000)
    world.sessions['p1.json'] = mm('failed', NOW + 10_000)
    await clock.advance(5_000)
    world.sessions['p1.json'] = mm('replied', NOW + 15_000)
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['mm 已答复（这轮 10m15s）'])
    expect(world.clips).toEqual([])
  })

  test('toastPeerReplies and toastRuns off: a long reply and a model ending toast nothing; a session asking still does', { options: { language: 'zh-CN', toastPeerReplies: false, toastRuns: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const world = seat(on, files)

    world.alive.add('111')
    world.sessions['p1.json'] = peer('p1', 'working', NOW - 1_000, { name: 'mm', turnStartedAt: NOW - 600_000 })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 5_000 }
    world.sessions['p1.json'] = peer('p1', 'replied', NOW + 5_000, { name: 'mm', turnStartedAt: NOW - 600_000 })
    await clock.advance(5_000)
    expect(world.toasts).toEqual([])
    expect(textOf(await $.ui.render(BAND)), 'the run ended all the same').toContain('codex ✓')

    world.sessions['p1.json'] = peer('p1', 'permission', NOW + 10_000, { name: 'mm', detail: 'Bash' })
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['mm 等你授权：Bash'])
  })

  test('an AskUserQuestion asking through PermissionRequest is permission with detail 提问, written once; its answer is working again', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const ASK = { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }

    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await clock.advance(1_000)
    await $.classic.PermissionRequest(ASK as never)
    expect(mine(world)).toMatchObject({ state: 'permission', detail: '提问', since: NOW + 1_000 })

    const before = world.sessions['me.json']

    await $.classic.PermissionRequest(ASK as never)
    expect(world.sessions['me.json'], 'the same question').toBe(before)

    await clock.advance(1_000)
    await $.classic.PostToolUse(ran('AskUserQuestion', { questions: [] }))
    expect(mine(world)).toMatchObject({ state: 'working', since: NOW + 2_000 })

    await $.agent.spawn({ ...SPAWN, background: false } as never)
    await $.classic.PermissionRequest({ ...ASK, agent_id: 'a1' } as never)
    expect(mine(world)).toMatchObject({ state: 'permission', detail: 'worker: 提问' })
  })

  test('with the workbench closed the status line counts running subagents and what waits on you; open, or both 0, it is cleared; set only on a change', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'failed', NOW - 1_000, { name: 'mm', updatedAt: NOW + 300_000 })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn(SPAWN as never)
    await clock.advance(1_000)
    expect(world.statuses).toEqual(['! 1 等你', '● 2 运行 · ! 1 等你'])

    await $.prompt.submit(PROMPT)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    await clock.advance(5_000)
    expect(world.statuses.slice(2), 'this session asking').toEqual(['● 2 运行 · ! 2 等你'])

    await $.command.run(command('dashboard'))
    expect(world.statuses.at(-1), 'the workbench open').toBeUndefined()

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await ui.press({ key: 'dash-close' })
    await clock.settle()
    await ui.unmount()
    expect(world.statuses.at(-1)).toBe('● 2 运行 · ! 2 等你')

    await $.turn.complete(complete('a1'))
    await $.turn.complete(complete('a2'))
    await $.classic.PostToolUse(ran('Bash', { command: 'ls' }))
    await clock.advance(5_000)
    expect(world.statuses.at(-1)).toBe('! 1 等你')

    world.sessions['p1.json'] = peer('p1', 'working', NOW + 15_000, { name: 'mm', updatedAt: NOW + 300_001 })
    await clock.advance(5_000)
    expect(world.statuses.at(-1), 'both 0').toBeUndefined()

    const count = world.statuses.length

    await clock.advance(30_000)
    expect(world.statuses, 'nothing changed').toHaveLength(count)
  })
})
