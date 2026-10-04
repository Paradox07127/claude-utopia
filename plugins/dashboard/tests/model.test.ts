import { describe, expect, test } from 'claude-code/testing'

import type { AgentRun, GateRun, GpuWatch, MmRun, MmSnapshot } from '../types'
import { bandText, elapsedOf, fit, fmtDuration, fmtTokens, noteDenied, noteDone, noteListed, noteResumed, noteSpawn, noteTool, toolLabel, widthOf } from '../hooks/agent-model'
import { agentLine, bandLines, boardOf, fitLine, idleLine, STALL_MS } from '../hooks/board'
import type { Line } from '../hooks/board'
import { setLang } from '../hooks/i18n'
import { endToast, fmtRunTokens, parseKv } from '../hooks/runs'
import { bar, hostsOf, isHostName, parseNvidiaCsv, parseProbe, parseTegra, sshArgv, sshHostOf, takeSamples } from '../hooks/gpu-probe'
import { gpuLines } from '../hooks/register'

const RUN: AgentRun = {
  agentId: 'a1',
  description: 'Build mm plugin',
  subagentType: 'worker',
  model: 'claude-opus-5-5',
  background: true,
  startedAt: 0,
  tools: 0,
  lastTool: '',
  state: 'running',
  lastActivityAt: 0,
}

describe('agent model', () => {
  test('spawn, tool calls and completion move one run through its states', () => {
    let list = noteSpawn([], RUN)

    list = noteTool(list, 'a1', 'Edit register.tsx', 7_000)
    list = noteTool(list, 'other', 'Read x', 8_000)
    expect(list[0]).toMatchObject({ tools: 1, lastTool: 'Edit register.tsx', state: 'running', lastActivityAt: 7_000 })
    expect(bandText(list[0]!, 192_000)).toBe('worker  Build mm plugin  3m12s  1 tools  Edit register.tsx')

    list = noteDone(list, 'a1', { reason: 'answer', durationMs: 65_000, outputTokens: 12_000, endedAt: 70_000 })
    expect(list[0]).toMatchObject({ state: 'done', durationMs: 65_000, outputTokens: 12_000 })
    expect(bandText(list[0]!, 80_000)).toBe('worker  Build mm plugin  1m05s  12k out')

    expect(noteDone([RUN], 'a1', { reason: 'answer', durationMs: 1, endedAt: 1, answer: 'x'.repeat(5000) })[0]?.answer).toHaveLength(4000)

    for (const [reason, state] of [['aborted', 'aborted'], ['error', 'error'], ['refusal', 'refusal']] as const) {
      expect(noteDone([RUN], 'a1', { reason, durationMs: 1, endedAt: 1 })[0]?.state).toBe(state)
    }
  })

  test('a tool call of an ended agent runs it again: its start and last answer kept, its end and tokens dropped', () => {
    const ended = noteDone([RUN], 'a1', { reason: 'answer', durationMs: 65_000, outputTokens: 12_000, endedAt: 70_000, answer: 'first' })
    const again = noteTool(ended, 'a1', 'Read x', 90_000)[0]!

    expect(again).toMatchObject({ state: 'running', startedAt: 0, answer: 'first', tools: 1, lastTool: 'Read x', lastActivityAt: 90_000 })
    expect([again.endedAt, again.durationMs, again.outputTokens]).toEqual([undefined, undefined, undefined])
  })

  test('a resumed agent runs at once, and its elapsed time adds the turns before: it never shrinks across resume and completion', () => {
    const ended = noteDone([RUN], 'a1', { reason: 'answer', durationMs: 65_000, endedAt: 70_000 })
    const resumed = noteResumed(ended, 'a1', 600_000)[0]!

    expect(resumed).toMatchObject({ state: 'running', startedAt: 0, lastActivityAt: 600_000 })
    expect(resumed.endedAt).toBeUndefined()
    expect([elapsedOf(resumed, 600_000), elapsedOf(resumed, 610_000)], 'the idle gap does not count').toEqual([65_000, 75_000])
    expect(noteResumed(ended, 'other', 600_000), 'another id: left alone').toEqual(ended)
    expect(noteResumed([resumed], 'a1', 700_000)[0], 'a running one: left alone').toEqual(resumed)

    const tooled = noteTool([resumed], 'a1', 'Read x', 620_000)[0]!

    expect(elapsedOf(tooled, 620_000), 'a tool ending does not restart the clock').toBe(85_000)

    const done = noteDone([tooled], 'a1', { reason: 'answer', durationMs: 25_000, endedAt: 625_000 })[0]!

    expect(done.durationMs, 'the turns before plus the latest').toBe(90_000)
    expect(elapsedOf(done, 900_000)).toBe(90_000)

    const byTool = noteTool(ended, 'a1', 'Read x', 90_000)[0]!

    expect([elapsedOf(byTool, 90_000), elapsedOf(byTool, 100_000)], 'resumed by a tool ending: the same rule').toEqual([65_000, 75_000])
  })

  test('the engine list closes a running agent it reports ended; one it lists running or not at all stays', () => {
    const list = ['k', 'f', 'c', 'r', 'gone'].map(agentId => ({ ...RUN, agentId, startedAt: 1_000 }))
    const info = (id: string, status: string) => ({ id, status, description: '', type: 'worker' })
    const after = noteListed(list, [info('k', 'killed'), info('f', 'failed'), info('c', 'completed'), info('r', 'running')], 200_000)

    expect(after.map(one => one.state)).toEqual(['aborted', 'error', 'done', 'running', 'running'])
    expect(after[0]).toMatchObject({ endedAt: 200_000, durationMs: 199_000 })
    expect(after[3]?.endedAt).toBeUndefined()

    const done: AgentRun = { ...RUN, state: 'done', endedAt: 5, durationMs: 5 }

    expect(noteListed([done], [info('a1', 'killed')], 9)[0], 'an ended one is left alone').toEqual(done)
  })

  test('keeps at most 30 runs, dropping the oldest', () => {
    let list: AgentRun[] = []

    for (let i = 0; i < 35; i += 1) {
      list = noteSpawn(list, { ...RUN, agentId: `a${i}` })
    }

    expect(list).toHaveLength(30)
    expect(list[0]?.agentId).toBe('a5')
  })

  test('tool labels', () => {
    expect(toolLabel({ tool: 'Edit', file_path: '/a/b/register.tsx' })).toBe('Edit register.tsx')
    expect(toolLabel({ tool: 'Read', file_path: 'notes.md' })).toBe('Read notes.md')
    expect(toolLabel({ tool: 'Bash', command: 'git   status --short && echo done && echo more' })).toBe('Bash git status --short && echo don')
    expect(toolLabel({ tool: 'Grep' })).toBe('Grep')
  })

  test('one way to write a token count: 950, 9.4k, 182k, 1.2M, — when unknown; mmrun adds tok', () => {
    expect([950, 9_400, 9_000, 41_000, 99_960, 182_400, 999_600, 1_200_000].map(fmtTokens)).toEqual(['950', '9.4k', '9k', '41k', '100k', '182k', '1M', '1.2M'])
    expect([null, undefined].map(fmtTokens)).toEqual(['—', '—'])
    expect([950, 25_835, 182_000, undefined].map(fmtRunTokens)).toEqual(['950 tok', '25.8k tok', '182k tok', '— tok'])
  })

  test('durations and truncation by terminal cells', () => {
    expect(fmtDuration(42_000)).toBe('42s')
    expect(fmtDuration(3_725_000)).toBe('1h02m')
    expect(fit('abcdef', 4)).toBe('abc…')
    expect(fit('abc', 3)).toBe('abc')
    expect(fit('构建插件', 5)).toBe('构建…')
  })
})

const NONE_SEEN = { agents: 0, runs: 0 }
const textOf = (line: Line) => line.map(seg => seg.text).join('')

describe('band and toasts', () => {
  const failed: AgentRun = { ...RUN, agentId: 'f', startedAt: 3, state: 'error', endedAt: 9_000, durationMs: 9_000 }
  const done: AgentRun = { ...RUN, agentId: 'd', startedAt: 4, state: 'done', endedAt: 10_000, durationMs: 5_000 }
  const running = [1, 2].map(i => ({ ...RUN, agentId: `r${i}`, startedAt: i, description: `job ${i}` }))

  test('failures first, then fresh results, then running in start order; a result leaves after 20 s', () => {
    setLang('zh-CN')
    const board = boardOf([...running.slice().reverse(), done, failed], null, NONE_SEEN, 20_000)

    expect(board.entries.map(entry => textOf(entry.full))).toEqual([
      '✗ worker  Build mm plugin  9s  出错',
      '✓ worker  Build mm plugin  5s  已返回',
      '● worker  job 1  19s  0 tools',
      '● worker  job 2  19s  0 tools',
    ])
    expect(bandLines(board, 5, 100).map(textOf), 'four items: more than three, so not one line each').toEqual(['✗ worker  Build mm plugin      9s  出错', 'agents ●2 ✓1'])
    expect(board.counts).toEqual({ pending: 1, running: 2, unread: 1 })
    expect(bandLines(boardOf([done], null, NONE_SEEN, 30_001), 5, 100)).toEqual([])
    expect(bandLines(boardOf([failed], null, { agents: 9_000, runs: 0 }, 60_000), 5, 100), 'a seen failure is off the band').toEqual([])
  })

  test('over budget: failures alone and the rest grouped, then groups, then one line of counts', () => {
    setLang('zh-CN')
    const board = boardOf([...running, done, failed, { ...RUN, agentId: 'r3', startedAt: 5 }], null, NONE_SEEN, 20_000)

    expect(bandLines(board, 3, 100).map(textOf)).toEqual(['✗ worker  Build mm plugin      9s  出错', 'agents ●3 ✓1'])
    expect(bandLines(board, 1, 100).map(textOf)).toEqual(['! 待处理1 · ●运行3 · 待读1'])
    expect(bandLines(board, 2, 100).map(textOf)).toEqual(['✗ worker  Build mm plugin      9s  出错', 'agents ●3 ✓1'])
  })

  test('a denied call keeps the agent a failure while it runs, marked 被拒N', () => {
    setLang('zh-CN')
    const denied = noteDenied(noteDenied([RUN], 'a1'), 'a1')[0]!
    const board = boardOf([denied], null, { agents: 50_000, runs: 0 }, 60_000)

    expect(bandLines(board, 5, 100).map(textOf)).toEqual(['● worker  Build mm plugin   1m00s  0 tools  ✗ 被拒2'])
    expect(board.counts).toEqual({ pending: 1, running: 0, unread: 0 })
  })

  test('aborted is a warning, no failure: ⊘ in yellow beside its word, out of 待处理; error and refusal stay red ✗ in it', () => {
    setLang('zh-CN')
    const aborted: AgentRun = { ...RUN, state: 'aborted', endedAt: 9_000, durationMs: 9_000 }
    const line = agentLine(aborted, 10_000)

    expect(textOf(line)).toBe('⊘ worker  Build mm plugin  9s  已中止')
    expect(line[0]).toEqual({ text: '⊘', color: 'warning' })
    expect(boardOf([aborted], null, NONE_SEEN, 10_000).counts).toEqual({ pending: 0, running: 0, unread: 1 })

    for (const state of ['error', 'refusal'] as const) {
      expect(agentLine({ ...aborted, state }, 10_000)[0]).toEqual({ text: '✗', color: 'error' })
      expect(boardOf([{ ...aborted, state }], null, NONE_SEEN, 10_000).counts.pending).toBe(1)
    }
  })

  test('mmrun: one band line per run with models side by side; unread counts models', () => {
    const run: MmRun = {
      runid: '20261002-010000-aaaa', tag: 'review-ui', workdir: '/w/proj', mode: 'review', createdAt: 0,
      models: [
        { name: 'codex', status: 'RUNNING', startedAt: 1_000 },
        { name: 'grok', status: 'DONE', startedAt: 1_000, endedAt: 50_000, secs: 302 },
      ],
    }
    const board = boardOf([], { polledAt: 60_000, runs: [run] }, NONE_SEEN, 60_000)

    expect(bandLines(board, 5, 100).map(textOf)).toEqual(['review-ui · codex ● 59s · grok ✓ 5m02s'])
    expect(board.counts).toEqual({ pending: 0, running: 1, unread: 1 })
    expect(bandLines(boardOf([...running], { polledAt: 60_000, runs: [run] }, NONE_SEEN, 60_000), 2, 100).map(textOf)).toEqual(['review ●1 ✓1 · agents ●2'])
  })

  describe('band layout', () => {
    const now = 20_000
    const bad = [1, 2].map(i => ({ ...RUN, agentId: `f${i}`, startedAt: i, description: `bad ${i}`, state: 'error' as const, endedAt: 9_000, durationMs: 9_000 }))
    const gate: GateRun = { at: 0, command: 'bun test', where: 'main', pass: 1, fail: 2, failures: [] }
    const review: MmRun = {
      runid: '20261002-010000-aaaa', tag: 't', workdir: '/w', mode: 'review', createdAt: 30,
      models: [{ name: 'codex', status: 'RUNNING', startedAt: 1_000 }],
    }
    // The board's lines are drawn here, at collection, before any test body runs.
    setLang('zh-CN')
    const board = boardOf([...bad, done, ...running], { polledAt: now, runs: [review] }, NONE_SEEN, now, [gate])

    test('band: up to three items, one full line each', () => {
      setLang('zh-CN')
      expect(bandLines(boardOf([done, ...running], null, NONE_SEEN, now), 5, 100).map(textOf)).toEqual([
        '✓ worker  Build mm plugin      5s  已返回',
        `● worker  job 1${' '.repeat(15)}19s  0 tools`,
        `● worker  job 2${' '.repeat(15)}19s  0 tools`,
      ])
    })

    test('band: failures alone in rows - 1, the rest on one summary line joined by ·', () => {
      expect(bandLines(board, 3, 100).map(textOf)).toEqual(['✗ 门禁 bun test · 2 fail', '✗ worker  bad 1      9s  出错', 'agents ✗1 ●2 ✓1 · review ●1'])
      expect(bandLines(board, 2, 100).map(textOf), 'failures past rows - 1 count in the summary').toEqual(['✗ 门禁 bun test · 2 fail', 'agents ✗2 ●2 ✓1 · review ●1'])
      expect(bandLines(board, 1, 100).map(textOf)).toEqual(['! 待处理3 · ●运行3 · 待读1'])
    })

    test('band: a summary too wide drops whole groups from the right, a dot in the worst tier for each', () => {
      const narrow = bandLines(board, 2, 20)
      const summary = narrow.at(-1)!

      expect(textOf(summary)).toBe('agents ✗2 ●2 ✓1 •')
      expect(summary.at(-1)).toEqual({ text: '•', color: 'permission' })
      expect(widthOf(textOf(summary))).toBeLessThanOrEqual(20)
      expect(bandLines(board, 2, 10).map(textOf), 'not even the first group fits: the counts, fit to the width').toEqual(['✗ 门禁 bun test · 2 fail', '! 待处理3'])
    })

    test('band: with one row the counts fit any width, running dropped first, then unread, then waiting; 待处理 kept longest', () => {
      const asking = boardOf([...bad, done, ...running], { polledAt: now, runs: [review] }, NONE_SEEN, now, [gate], [{ id: 'p', name: 'p', state: 'permission', since: 0, updatedAt: 0 }])

      for (const lang of ['zh-CN', 'en'] as const) {
        setLang(lang)

        for (let columns = 10; columns <= 120; columns += 1) {
          const lines = bandLines(asking, 1, columns)

          expect(lines).toHaveLength(1)
          expect(widthOf(textOf(lines[0]!)), `${lang} at ${columns}`).toBeLessThanOrEqual(columns)
        }
      }

      setLang('zh-CN')
      expect([100, 25, 20, 10].map(columns => textOf(bandLines(asking, 1, columns)[0]!))).toEqual([
        '! 待处理3 · ●运行3 · 待读1 · 等你1',
        '! 待处理3 · 待读1 · 等你1',
        '! 待处理3 · 等你1',
        '! 待处理3',
      ])
    })
  })

  test('band rows line up: type in a fixed width, title, time right-aligned in a fixed width, tools, then the last tool dim', () => {
    setLang('zh-CN')
    const a: AgentRun = { ...RUN, agentId: 'x1', subagentType: 'general-purpose', description: 'Fix the band', tools: 41, lastTool: 'Edit register.tsx', lastActivityAt: 190_000 }
    const b: AgentRun = { ...RUN, agentId: 'x2', description: 'Wire the timeline page', startedAt: 1_000, tools: 3, lastTool: 'Read x', lastActivityAt: 190_000 }
    const board = boardOf([a, b], null, NONE_SEEN, 192_000)
    const lines = bandLines(board, 5, 100)

    expect(lines.map(textOf)).toEqual([
      `● general-purpose  Fix the band${' '.repeat(13)}3m12s  41 tools  Edit register.tsx`,
      `● worker${' '.repeat(11)}Wire the timeline page   3m11s  3 tools   Read x`,
    ])
    expect(lines[0]!.find(seg => seg.text === 'Edit register.tsx')?.dim).toBe(true)
    expect(bandLines(board, 5, 50).map(textOf), 'narrow: tools and the last tool go first').toEqual([
      `● general-purpose  Fix the band${' '.repeat(13)}3m12s`,
      `● worker${' '.repeat(11)}Wire the timeline page   3m11s`,
    ])
    expect(bandLines(board, 5, 40).map(textOf), 'narrower: then the title is cut').toEqual([
      `● general-purpose  Fix the band    3m12s`,
      `● worker${' '.repeat(11)}Wire the tim…   3m11s`,
    ])
  })

  test('band summary: an aborted agent counts ⊘N in yellow, apart from ✓', () => {
    setLang('zh-CN')
    const aborted: AgentRun = { ...RUN, agentId: 'ab', state: 'aborted', endedAt: 9_000, durationMs: 9_000 }
    const summary = bandLines(boardOf([...running, done, aborted], null, NONE_SEEN, 10_000), 5, 100)

    expect(summary.map(textOf)).toEqual(['agents ●2 ✓1 ⊘1'])
    expect(summary[0]!.find(seg => seg.text === '⊘')).toEqual({ text: '⊘', color: 'warning' })
    expect(bandLines(boardOf([...running, aborted, { ...aborted, agentId: 'ab2' }], null, NONE_SEEN, 10_000), 5, 100).map(textOf)).toEqual(['agents ●2 ⊘2'])
  })

  test('band gate row: the worktree when not main; failed with 0 fail reads 失败', () => {
    setLang('zh-CN')
    const wt: GateRun = { at: 0, command: 'swift test', where: 'agent-wt', pass: null, fail: 0, failed: true, failures: [] }
    const main: GateRun = { at: 0, command: 'bun test', where: 'main', pass: 1, fail: 2, failures: [] }

    expect(bandLines(boardOf([], null, NONE_SEEN, 1_000, [wt, main]), 5, 100).map(textOf)).toEqual(['✗ 门禁 swift test · 失败 · agent-wt', '✗ 门禁 bun test · 2 fail'])
    setLang('en')
    expect(bandLines(boardOf([], null, NONE_SEEN, 1_000, [wt]), 5, 100).map(textOf)).toEqual(['✗ gate swift test · failed · agent-wt'])
  })

  test('idle band: the last item that ended and the last gate, dim with glyphs in their state color; with neither just 空闲', () => {
    setLang('zh-CN')
    const ended: AgentRun = { ...RUN, state: 'done', endedAt: 0, durationMs: 5_000 }
    const gate: GateRun = { at: 540_000, command: 'bun test', where: 'main', pass: 186, fail: 0, failures: [] }
    const line = idleLine({ kind: 'agent', run: ended }, gate, 720_000)

    expect(textOf(idleLine(undefined, undefined, 720_000))).toBe('空闲')
    expect(textOf(line)).toBe('空闲 · 最近 ✓ worker 已返回 12m前 · 门禁 ✓ 186 pass 3m前')
    expect(line.filter(seg => seg.color !== undefined)).toEqual([{ text: '✓', color: 'success' }, { text: '✓', color: 'success' }])
    expect(line.filter(seg => seg.color === undefined).every(seg => seg.dim === true)).toBe(true)
    expect(textOf(idleLine(undefined, { ...gate, pass: null }, 720_000))).toBe('空闲 · 门禁 ✓ — pass 3m前')
    expect(idleLine({ kind: 'agent', run: { ...ended, state: 'aborted' } }, undefined, 720_000).find(seg => seg.text === '⊘')?.color).toBe('warning')
    expect(textOf(idleLine(undefined, { ...gate, fail: 0, failed: true }, 720_000))).toBe('空闲 · 门禁 ✗ 失败 3m前')

    const stale: MmRun = { runid: '20261002-010000-aaaa', tag: 'ui', workdir: '/w', mode: 'review', createdAt: 0, models: [] }

    expect(textOf(idleLine({ kind: 'model', run: stale, model: { name: 'kimi', status: 'STALE', startedAt: 0, endedAt: 0 } }, undefined, 3_600_000))).toBe('空闲 · 最近 ~ ui / kimi STALE 1h前')
    setLang('en')
    expect(textOf(idleLine({ kind: 'agent', run: ended }, gate, 720_000))).toBe('idle · last ✓ worker returned 12m ago · gate ✓ 186 pass 3m ago')
  })

  test('band: a cold cache folded into the summary reads 缓存 ~ in yellow, and its dropped dot is yellow', () => {
    setLang('zh-CN')
    const many = [1, 2, 3, 4].map(i => ({ ...RUN, agentId: `a${i}`, lastActivityAt: 0 }))
    const cold = boardOf(many, null, NONE_SEEN, 1000, [], [], { idleMs: 3_600_000, tokens: 1000 })
    const wide = bandLines(cold, 5, 200).at(-1)!

    expect(textOf(wide)).toBe('agents ●4 · 缓存 ~')
    expect(wide.at(-1)).toEqual({ text: '~', color: 'warning' })
    expect(bandLines(cold, 5, 12).at(-1)!.at(-1)).toEqual({ text: '•', color: 'warning' })
  })

  test('stall: a running agent with no tool call for STALL_MS reads 静默 in yellow, and stays out of 待处理', () => {
    setLang('zh-CN')
    const list = noteTool(noteSpawn([], RUN), 'a1', 'Read x', 10_000)
    const quiet = list[0]!

    expect(STALL_MS).toBe(120_000)
    expect(textOf(agentLine(quiet, 10_000 + STALL_MS - 1))).not.toContain('静默')

    const stalled = agentLine(quiet, 10_000 + 180_000)

    expect(textOf(stalled)).toMatch(/Read x  静默 3m00s$/)
    expect(stalled.at(-1)).toEqual({ text: '静默 3m00s', color: 'warning' })
    expect(textOf(agentLine({ ...quiet, state: 'done', endedAt: 11_000, durationMs: 11_000 }, 10_000 + 180_000))).not.toContain('静默')
    expect(boardOf([quiet], null, NONE_SEEN, 10_000 + 180_000).counts).toEqual({ pending: 0, running: 1, unread: 0 })
  })

  test('lines of segments are cut by cells with an ellipsis', () => {
    expect(textOf(fitLine([{ text: '●' }, { text: ' 构建插件' }], 6))).toBe('● 构…')
    expect(textOf(fitLine([{ text: 'ab' }, { text: 'cd' }], 4))).toBe('abcd')
    expect(textOf(fitLine([{ text: 'ab' }, { text: 'cd' }], 2))).toBe('a…')
  })

  test('parseKv reads key=value lines, values may hold =', () => {
    expect(parseKv('runid=R\ntag=\nusage={"a":1}\nnoise\nx=a=b\n')).toEqual({ runid: 'R', tag: '', usage: '{"a":1}', x: 'a=b' })
  })

  test('models that ended between two polls make one toast per poll', () => {
    setLang('zh-CN')
    const base: MmRun = { runid: '20261002-010000-aaaa', tag: 'review-ui', workdir: '/w', mode: 'review', createdAt: 0, models: [] }
    const snap = (models: MmRun['models'], other: MmRun['models'] = []): MmSnapshot => ({
      polledAt: 0,
      runs: [{ ...base, models }, { ...base, runid: '20261002-020000-bbbb', tag: '', models: other }],
    })
    const prev = snap(
      [{ name: 'codex', status: 'RUNNING', startedAt: 0 }, { name: 'grok', status: 'RUNNING', startedAt: 0 }, { name: 'agy', status: 'RUNNING', startedAt: 0 }],
      [{ name: 'codex', status: 'RUNNING', startedAt: 0 }],
    )

    expect(endToast(prev, prev)).toBeNull()
    expect(endToast(prev, snap([
      { name: 'codex', status: 'RUNNING', startedAt: 0 },
      { name: 'grok', status: 'DONE', startedAt: 0, endedAt: 1 },
      { name: 'agy', status: 'FAIL:1', startedAt: 0, endedAt: 1 },
    ], [{ name: 'codex', status: 'STALE', startedAt: 0, endedAt: 1 }]))).toBe('review-ui：grok 已返回、agy 失败 FAIL:1，codex 仍在运行；bbbb：codex 已失联 STALE')
  })
})

describe('GPU page width', () => {
  const card = (index: number, name: string) => ({ index, name, util: 52, memUsed: 18_636, memTotal: 97_887, temp: 67, power: 280 })
  const nvidia: GpuWatch = {
    host: 'lab-box-with-a-long-hostname.example.internal',
    okAt: 1_000,
    error: null,
    sample: { kind: 'nvidia', gpus: [card(0, 'NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition'), card(1, 'NVIDIA A100')], procs: [{ pid: 4242, name: 'python3-with-a-long-process-name', memMiB: 10_240 }] },
  }
  const watches: GpuWatch[] = [
    nvidia,
    { ...nvidia, error: 'ssh: connect to host lab-box port 22: Operation timed out after waiting a long while' },
    { ...nvidia, okAt: null, sample: null, error: 'ssh: connect to host lab-box port 22: Operation timed out after waiting a long while' },
    { ...nvidia, sample: { kind: 'tegra', util: 23, ramUsed: 2_345, ramTotal: 7_620, temp: 45.5 } },
  ]

  test('every row gpuLines returns fits the width, 10 to 120 columns', () => {
    for (const lang of ['zh-CN', 'en'] as const) {
      setLang(lang)

      for (const watch of watches) {
        for (let columns = 10; columns <= 120; columns += 1) {
          for (const line of gpuLines(watch, 9_000, columns)) {
            expect(widthOf(line.text), `${lang} ${watch.sample?.kind ?? 'none'} at ${columns}: ${line.text}`).toBeLessThanOrEqual(columns)
          }
        }
      }
    }
  })

  test('a long model name is cut first: utilization, memory, temperature and power stay on the row', () => {
    setLang('en')

    for (const columns of [64, 80]) {
      const row = gpuLines(nvidia, 9_000, columns)[2]!.text

      expect(row, `at ${columns}`).toMatch(/^0  RTX PRO .*…  ▇+░+  52%  18\.2\/95\.6 GiB  67°C  280W$/)
      expect(widthOf(row)).toBeLessThanOrEqual(columns)
    }

    expect(gpuLines(nvidia, 9_000, 60)[2]!.text).toMatch(/^0  RTX PRO .*…   52%  18\.2\/95\.6 GiB  67°C  280W$/)
  })
})

const NVSMI_OK = [
  '@@NVSMI',
  '0, NVIDIA GeForce RTX 4090, 52, 18636, 24564, 67, 280.45',
  '1, NVIDIA A100-SXM4-80GB, [N/A], 100, 81920, [Not Supported], [N/A]',
  '@@APPS',
  '4242, /usr/bin/python3, 10240',
  '77, /opt/app/server, [N/A]',
].join('\n')

const NVML_MISMATCH = ['@@NVERR', 'Failed to initialize NVML: Driver/library version mismatch', 'NVML library version: 535.183', '@@NOGPU'].join('\n')

const TEGRA_XAVIER =
  'RAM 2345/7620MB (lfb 2x4MB) SWAP 0/3810MB (cached 0MB) CPU [2%@1420,1%@1420] EMC_FREQ 0% GR3D_FREQ 23%@1377 APE 150 MTS fg 0% bg 0% AO@40C GPU@45.5C PMIC@50C'
const TEGRA_ORIN =
  'RAM 5120/30536MB (lfb 4x4MB) CPU [0%@729,0%@729] GR3D_FREQ 0% cpu@47.343C soc2@45.468C gpu@45.843C tj@47.343C VDD_GPU_SOC 2382mW/2382mW'

describe('gpu probe parsing', () => {
  test('nvidia-smi csv, with [N/A] and [Not Supported] fields read as null', () => {
    expect(parseNvidiaCsv(NVSMI_OK.split('\n').slice(1, 3).join('\n'))).toEqual([
      { index: 0, name: 'NVIDIA GeForce RTX 4090', util: 52, memUsed: 18636, memTotal: 24564, temp: 67, power: 280.45 },
      { index: 1, name: 'NVIDIA A100-SXM4-80GB', util: null, memUsed: 100, memTotal: 81920, temp: null, power: null },
    ])

    const sample = parseProbe({ exitCode: 0, stdout: NVSMI_OK, stderr: '' })

    expect(sample.kind).toBe('nvidia')
    expect(sample.kind === 'nvidia' && sample.procs).toEqual([
      { pid: 4242, name: 'python3', memMiB: 10240 },
      { pid: 77, name: 'server', memMiB: null },
    ])
  })

  test('tegrastats lines from Xavier and Orin', () => {
    expect(parseTegra(TEGRA_XAVIER)).toEqual({ kind: 'tegra', util: 23, ramUsed: 2345, ramTotal: 7620, temp: 45.5 })
    expect(parseTegra(TEGRA_ORIN)).toEqual({ kind: 'tegra', util: 0, ramUsed: 5120, ramTotal: 30536, temp: 45.843 })
    expect(parseTegra('nothing useful')).toBeNull()
  })

  test('Jetson: nvidia-smi answered N/A, so the tegrastats section wins', () => {
    const stdout = ['@@NVSMI', '0, Orin (nvgpu), [N/A], [N/A], [N/A], [N/A], [N/A]', '@@APPS', '@@TEGRA', TEGRA_ORIN].join('\n')

    expect(parseProbe({ exitCode: 0, stdout, stderr: '' })).toMatchObject({ kind: 'tegra', util: 0 })
  })

  test('NVML driver/library mismatch is an error with its first line', () => {
    expect(parseProbe({ exitCode: 0, stdout: NVML_MISMATCH, stderr: '' })).toEqual({
      kind: 'error',
      message: 'Failed to initialize NVML: Driver/library version mismatch',
    })
  })

  test('probe output: a Jetson Orin, and a host whose NVML mismatches its driver', () => {
    const jetson = [
      '@@NVSMI',
      '0, Orin (nvgpu), [N/A], [N/A], [N/A], [N/A], [N/A]',
      '@@APPS',
      '[N/A], [N/A], [N/A]',
      '@@TEGRA',
      '01-01-2026 00:00:00 RAM 12000/32000MB (lfb 100x4MB) SWAP 0/2048MB (cached 0MB) CPU [2%@729,4%@729] GR3D_FREQ 0% cpu@50.000C/50.000C soc2@45.000C/45.000C gpu@45.500C/45.500C tj@50.000C/50.000C VDD_GPU_SOC 3000mW/3000mW/3000mW',
    ].join('\n')
    const mismatch = ['@@NVERR', 'Failed to initialize NVML: Driver/library version mismatch', 'NVML library version: 550.00', '@@NOGPU'].join('\n')

    expect(parseProbe({ exitCode: 0, stdout: jetson, stderr: '' })).toEqual({ kind: 'tegra', util: 0, ramUsed: 12000, ramTotal: 32000, temp: 45.5 })
    expect(parseProbe({ exitCode: 0, stdout: mismatch, stderr: '' })).toEqual({ kind: 'error', message: 'Failed to initialize NVML: Driver/library version mismatch' })
  })

  test('ssh failure, no GPU, and an empty answer', () => {
    expect(parseProbe({ exitCode: 255, stdout: '', stderr: 'ssh: Could not resolve hostname nope: nodename nor servname provided\n' })).toEqual({
      kind: 'error',
      message: 'ssh: Could not resolve hostname nope: nodename nor servname provided',
    })
    expect(parseProbe({ exitCode: 0, stdout: '@@NOGPU\n', stderr: '' })).toEqual({ kind: 'none' })
    expect(parseProbe({ exitCode: 1, stdout: '', stderr: '' })).toEqual({ kind: 'error', message: 'ssh exited 1' })
  })

  test('the probe argv is ssh with the batch, multiplexing and keepalive options, then the host and the probe looping every 3 s', () => {
    const argv = sshArgv('gpu-box')

    expect(argv.slice(0, 15)).toEqual([
      'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ControlMaster=auto', '-o', 'ControlPath=~/.ssh/cm-%C', '-o', 'ControlPersist=10m',
      '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
    ])
    expect(argv[15]).toBe('gpu-box')
    expect(argv[16]?.startsWith("sh -c 'while :; do\n")).toBe(true)
    expect(argv[16]?.slice(7, -1).includes("'")).toBe(false)
    expect(argv[16]?.endsWith("\necho @@END\nsleep 3\ndone'")).toBe(true)
  })

  test('a stream read in pieces: each pass up to @@END is a sample, the unfinished rest kept for the next piece', () => {
    const text = `${NVSMI_OK}\n@@END\n@@NOGPU\n@@END\n@@TEGRA\n`
    const kinds: string[] = []
    let rest = ''

    for (let i = 0; i < text.length; i += 7) {
      const taken = takeSamples(rest + text.slice(i, i + 7))

      rest = taken.rest
      kinds.push(...taken.samples.map(sample => sample.kind))
    }

    expect(kinds).toEqual(['nvidia', 'none'])
    expect(rest).toBe('@@TEGRA\n')
    expect(takeSamples('@@NOGPU\n@@EN')).toEqual({ samples: [], rest: '@@NOGPU\n@@EN' })
  })

  test('bars', () => {
    expect(bar(0.52, 10)).toBe('▇▇▇▇▇░░░░░')
    expect(bar(2, 4)).toBe('▇▇▇▇')
  })
})

describe('ssh command recognition', () => {
  test('the host of a command that starts with ssh, options skipped', () => {
    expect(sshHostOf('ssh gpu-box nvidia-smi')).toBe('gpu-box')
    expect(sshHostOf('ssh -p 22 lab-box ls')).toBe('lab-box')
    expect(sshHostOf('  ssh -o BatchMode=yes -i ~/.ssh/k -tt user@lab-box "nvidia-smi"')).toBe('lab-box')
    expect(sshHostOf('ssh -p22 gpu-box')).toBe('gpu-box')
    expect(sshHostOf('echo ssh gpu-box')).toBeNull()
    expect(sshHostOf('sshfs gpu-box:/ /mnt')).toBeNull()
    expect(sshHostOf('ssh')).toBeNull()
  })

  test('the host list option and host-name check', () => {
    expect(hostsOf(' gpu-box, lab-box ,,')).toEqual(['gpu-box', 'lab-box'])
    expect(hostsOf('')).toEqual([])
    expect(isHostName('gpu-box')).toBe(true)
    expect(isHostName('-oProxyCommand=x')).toBe(false)
    expect(isHostName('a b')).toBe(false)
  })
})
