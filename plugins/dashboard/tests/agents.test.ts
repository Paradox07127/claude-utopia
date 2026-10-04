import { describe, expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import type { AgentRun, TimelineTurn } from '../types'
import { noteDone, noteSpawn, noteTool, peekOf } from '../hooks/agent-model'
import { agentFold, agentLine, agentTable, bandLines, boardOf, isStalled, runningLine, usageText } from '../hooks/board'
import type { Line } from '../hooks/board'
import { setLang } from '../hooks/i18n'
import { toolsInFlight } from '../hooks/timeline'

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

const NONE_SEEN = { agents: 0, runs: 0 }
const textOf = (line: Line) => line.map(seg => seg.text).join('')

/** a1's open turn: a Read that ended, a Bash requested at 10 s and still running; a2's turn ended with a call never closed. */
const TURNS: TimelineTurn[] = [
  {
    turnId: 'c1',
    agentId: 'a1',
    startedAt: 5_000,
    steps: [],
    tools: [
      { toolUseId: 'r', name: 'Read', agentId: 'a1', requestedAt: 6_000, endedAt: 7_000 },
      { toolUseId: 'b', name: 'Bash', agentId: 'a1', requestedAt: 10_000 },
      { toolUseId: 'g', name: 'Grep', agentId: 'a1', requestedAt: 20_000 },
    ],
    forks: [],
  },
  { turnId: 'c2', agentId: 'a2', startedAt: 5_000, endedAt: 9_000, steps: [], tools: [{ toolUseId: 'x', name: 'Bash', agentId: 'a2', requestedAt: 6_000 }], forks: [] },
  { turnId: 'm1', startedAt: 0, steps: [], tools: [{ toolUseId: 'm', name: 'Bash', requestedAt: 1_000 }], forks: [] },
]

describe('A4: a long tool call is no quiet', () => {
  test('toolsInFlight: per agent its open turn’s longest-running call that began and has not ended; none from an ended turn or the main loop', () => {
    const flights = toolsInFlight(TURNS)

    expect(flights.get('a1')).toEqual({ name: 'Bash', requestedAt: 10_000 })
    expect(flights.has('a2')).toBe(false)
    expect([...flights.keys()]).toEqual(['a1'])
  })

  test('with a call in flight: not stalled, the band and the table read `Bash 3m…`; without timeline data 静默 as before', () => {
    setLang('zh-CN')
    const run = noteTool([RUN], 'a1', 'Read x', 10_000)[0]!
    const now = 10_000 + 180_000
    const flights = toolsInFlight(TURNS)
    const flight = flights.get('a1')

    expect(isStalled(run, now)).toBe(true)
    expect(isStalled(run, now, flight)).toBe(false)
    expect(textOf(agentLine(run, now, false, flight))).toBe('● worker  Build mm plugin  3m10s  1 tools  Bash 3m…')
    expect(textOf(agentLine(run, now))).toMatch(/Read x  静默 3m00s$/)

    const band = bandLines(boardOf([run], null, NONE_SEEN, now, [], [], null, flights), 5, 100).map(textOf)

    expect(band).toEqual(['● worker  Build mm plugin   3m10s  1 tools  Bash 3m…'])
    expect(bandLines(boardOf([run], null, NONE_SEEN, now), 5, 100).map(textOf)[0]).toMatch(/静默 3m00s$/)

    const table = agentTable([run], now, 100, flights)

    expect(textOf(table.rows[0]!.after), 'after the blank 被拒 cell').toBe(`  ${' '.repeat(4)}  Bash 3m…`)
    expect(table.rows[0]!.after.at(-1)).toMatchObject({ text: 'Bash 3m…', dim: true })
    expect(textOf(agentTable([run], now, 100).rows[0]!.after)).toBe('')
    expect(textOf(runningLine({ kind: 'agent', run }, now, now, 80, flight))).toMatch(/^● 运行 /)
  })
})

const USAGE = { input: 2_000, output: 9_400, cacheRead: 165_000, cacheWrite: 15_000, model: 'claude-opus-5-5' }

describe('B2: a subagent’s whole usage', () => {
  test('turn.complete’s four counts and model are kept; a run sent on again drops them', () => {
    const done = noteDone([RUN], 'a1', { reason: 'answer', durationMs: 5_000, outputTokens: 9_400, endedAt: 5_000, usage: USAGE })[0]!

    expect(done.usage).toEqual(USAGE)
    expect(noteTool([done], 'a1', 'Read x', 9_000)[0]?.usage).toBeUndefined()
  })

  test('the detail line `in 182k · 缓存读 91% · out 9.4k`', () => {
    setLang('zh-CN')
    expect(usageText(USAGE)).toBe('in 182k · 缓存读 91% · out 9.4k')
    setLang('en')
    expect(usageText(USAGE)).toBe('in 182k · cache read 91% · out 9.4k')
    expect(usageText({ ...USAGE, input: 0, cacheRead: 0, cacheWrite: 0 })).toBe('in 0 · cache read 0% · out 9.4k')
  })

  test('the Agents table has a tokens column, in + out, — without usage; narrow, it goes first', () => {
    setLang('zh-CN')
    const done: AgentRun = { ...RUN, agentId: 'd', state: 'done', endedAt: 5_000, durationMs: 5_000, usage: USAGE }
    const wide = agentTable([RUN, done], 10_000, 100)

    expect(wide.head).toMatch(/^状态 +类型 +任务 +模型 +耗时 +tokens +tools +被拒$/)
    expect(wide.rows[0]!.label).toMatch(/opus-5-5 +10s +— +0$/)
    expect(wide.rows[1]!.label).toMatch(/opus-5-5 +5s +191k +0$/)

    const narrow = agentTable([RUN, done], 10_000, 62)

    expect(narrow.head, 'tokens goes before 模型').toMatch(/^状态 +类型 +任务 +模型 +耗时 +tools +被拒$/)
  })
})

const msg = (role: 'user' | 'assistant', text: string, toolUses: { tool: string; input: Record<string, unknown> }[] = []): SessionMessage => ({
  role,
  text,
  toolUses: toolUses.map((use, i) => ({ tool_use_id: `u${i}`, ...use })),
})

describe('B4: a running subagent’s transcript, read', () => {
  test('the task is the first user message’s first line; the last three calls, a name and its arguments in a line; the latest text’s first line', () => {
    const peek = peekOf([
      msg('user', '\n  Fix the band\nmore detail'),
      msg('assistant', 'Looking.', [{ tool: 'Read', input: { file_path: '/w/hooks/board.ts' } }]),
      msg('user', ''),
      msg('assistant', '', [
        { tool: 'Bash', input: { command: 'bun   test\n  --watch' } },
        { tool: 'Grep', input: { pattern: 'isStalled', path: '/w' } },
      ]),
      msg('assistant', 'Found it.\nThe stall check', [{ tool: 'TodoWrite', input: { todos: [] } }]),
      msg('assistant', ''),
    ])

    expect(peek).toEqual({ task: 'Fix the band', calls: ['Bash bun test --watch', 'Grep isStalled', 'TodoWrite'], text: 'Found it.' })
    expect(peekOf([])).toEqual({ task: '', calls: [], text: '' })
  })
})

describe('B8: the Agents page folds what ended and was read', () => {
  test('running, failed and unread are listed; the others ended fold; a failure read stays listed', () => {
    const ended = (agentId: string, state: AgentRun['state'], endedAt: number, more: Partial<AgentRun> = {}): AgentRun => ({ ...RUN, agentId, state, endedAt, durationMs: 1, ...more })
    const runs = [
      RUN,
      ended('e', 'error', 1_000),
      ended('dn', 'done', 1_000, { denied: 1 }),
      ended('d1', 'done', 1_000),
      ended('ab', 'aborted', 1_000),
      ended('d2', 'done', 9_000),
    ]
    const { listed, folded } = agentFold(runs, 5_000)

    expect(listed.map(one => one.agentId)).toEqual(['a1', 'e', 'dn', 'd2'])
    expect(folded.map(one => one.agentId)).toEqual(['d1', 'ab'])
  })
})

describe('digits: what an agent still needs you for keeps its digit', () => {
  test('a new spawn takes back no digit from a failed or unread agent; with 1–9 all held, none', () => {
    const at = (list: AgentRun[], id: string) => list.find(one => one.agentId === id)?.slot
    let list = noteSpawn([], { ...RUN, agentId: 'f' })

    list = noteSpawn(list, { ...RUN, agentId: 'u' })
    list = noteSpawn(list, { ...RUN, agentId: 's' })
    list = noteDone(list, 'f', { reason: 'error', durationMs: 1, endedAt: 1_000 })
    list = noteDone(list, 'u', { reason: 'answer', durationMs: 1, endedAt: 9_000 })
    list = noteDone(list, 's', { reason: 'answer', durationMs: 1, endedAt: 1_000 })
    list = noteSpawn(list, { ...RUN, agentId: 'n' }, 5_000)

    expect([at(list, 'f'), at(list, 'u'), at(list, 's'), at(list, 'n')], 'the read return gives its 3 up').toEqual(['1', '2', undefined, '3'])

    const seenFailure = noteSpawn(list, { ...RUN, agentId: 'n2' }, 99_000)

    expect(at(seenFailure, 'f'), 'a failure keeps its digit read or not').toBe('1')
    expect(at(seenFailure, 'n2'), 'the read return gives its 2 up').toBe('2')

    let full = list

    for (let i = 0; i < 6; i += 1) {
      full = noteSpawn(full, { ...RUN, agentId: `r${i}` }, 5_000)
    }

    expect(full.filter(one => one.slot !== undefined)).toHaveLength(9)
    expect(at(noteSpawn(full, { ...RUN, agentId: 'late' }, 5_000), 'late'), 'nine held: no digit').toBeUndefined()
  })
})
