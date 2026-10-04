import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

import { register } from '../hooks/register'
import { compacted, criticalPathMs, forked, hotspotsOf, MAX_STEPS, MAX_TURNS, stepNoted, stepOf, toolEnded, turnEnded, turnStarted, watchChunk } from '../hooks/timeline'
import type { Hotspots } from '../hooks/timeline'
import type { TimelineStep, TimelineTool, TimelineTurn } from '../types'

const TIMELINE = { plugin: 'dashboard', key: 'timeline' } as const

const HEAD = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 }

const step = (more: Partial<TimelineStep> = {}): TimelineStep => ({ ...HEAD, sentAt: 1_000, toolUseIds: [], ...more })

describe('timeline folds', () => {
  test('a tool that ends before its step is merged when the step ends', () => {
    let turns = turnStarted([], 't1', 1_000)

    turns = stepNoted(turns, step())
    turns = toolEnded(turns, { toolUseId: 'tu1', name: 'Read', endedAt: 1_400, durationMs: 30, outcome: 'ok' })

    const watch = { tools: [{ toolUseId: 'tu1', name: 'Read', atMs: 200 }], firstMs: 120, firstKind: 'thinking' as const }
    const done = stepOf(HEAD, 1_000, watch, { ms: 900, result: { stopReason: 'tool_use', usage: null } })

    turns = stepNoted(turns, done.step, done.tools)

    expect(turns).toHaveLength(1)
    expect(turns[0]!.steps).toEqual([
      { ...HEAD, sentAt: 1_000, ttftMs: 120, firstKind: 'thinking', endedAt: 1_900, stepMs: 900, stopReason: 'tool_use', usage: null, toolUseIds: ['tu1'] },
    ])
    expect(turns[0]!.tools).toEqual([
      { toolUseId: 'tu1', name: 'Read', turnId: 't1', stepIndex: 0, requestedAt: 1_200, endedAt: 1_400, durationMs: 30, outcome: 'ok' },
    ])
  })

  test("a subagent's first step opens its turn; a step it never ended keeps its unknowns absent", () => {
    const sub = { ...HEAD, turnId: 'ts', agentId: 'a1' }
    const turns = stepNoted(turnStarted([], 't1', 1_000), stepOf(sub, 2_000, { tools: [] }).step)

    expect(turns).toHaveLength(2)
    expect(turns[1]).toStrictEqual({ turnId: 'ts', agentId: 'a1', startedAt: 2_000, steps: [{ ...sub, sentAt: 2_000, toolUseIds: [] }], tools: [], forks: [] })

    const open = turns[1]!.steps[0]!

    for (const key of ['ttftMs', 'firstKind', 'endedAt', 'stepMs', 'stopReason', 'usage', 'effort'] as const) {
      expect(key in open, `${key} absent, not 0`).toBe(false)
    }

    expect(criticalPathMs(turns[1]!), 'an open step: no critical path yet').toBe(undefined)
  })

  test('a tool end, a fork or a compaction with no turn of its loop is dropped', () => {
    const turns = turnStarted([], 't1', 1_000)

    expect(toolEnded(turns, { toolUseId: 'x', name: 'Read', agentId: 'ghost', endedAt: 5, outcome: 'ok' })).toBe(turns)
    expect(forked(turns, { parentAgentId: 'ghost', childAgentId: 'c', background: false, at: 5, subagentType: 'w', description: 'd' })).toBe(turns)
    expect(compacted(turns, 'ghost', { at: 5, trigger: 'auto' })).toBe(turns)
  })

  test("turn.complete closes the turn; one never started is opened from its duration", () => {
    let turns = turnEnded(turnStarted([], 't1', 1_000), { turnId: 't1', endedAt: 4_000, durationMs: 3_000, reason: 'answer' })

    expect(turns[0]).toMatchObject({ endedAt: 4_000, durationMs: 3_000, reason: 'answer' })

    turns = turnEnded(turns, { turnId: 'ts', agentId: 'a1', endedAt: 9_000, durationMs: 500, reason: 'error' })
    expect(turns[1]).toEqual({ turnId: 'ts', agentId: 'a1', startedAt: 8_500, steps: [], tools: [], forks: [], endedAt: 9_000, durationMs: 500, reason: 'error' })
  })

  test('over 30 turns, or over 400 steps, the oldest whole turns go; the newest stays whatever its size', () => {
    let turns: TimelineTurn[] = []

    for (let i = 0; i < MAX_TURNS + 5; i++) {
      turns = turnStarted(turns, `t${i}`, i)
    }

    expect(turns).toHaveLength(MAX_TURNS)
    expect(turns[0]!.turnId).toBe('t5')

    const many = (turnId: string, n: number, all: TimelineTurn[]) =>
      Array.from({ length: n }, (_, index) => index).reduce((acc, index) => stepNoted(acc, step({ turnId, index })), all)

    turns = many('big1', 250, [])
    turns = many('big2', 100, turns)
    turns = many('big3', 100, turns)

    expect(turns.map(one => one.turnId), '450 steps: big1 goes').toEqual(['big2', 'big3'])

    turns = many('huge', MAX_STEPS + 10, turns)
    expect(turns.map(one => one.turnId)).toEqual(['huge'])
    expect(turns[0]!.steps).toHaveLength(MAX_STEPS + 10)
  })

  test('critical path: each step plus its longest foreground tool; a background fork does not count', () => {
    let turns = turnStarted([], 't1', 0)

    turns = stepNoted(turns, step({ index: 0, stepMs: 1_000, endedAt: 1_000, toolUseIds: ['r1', 'r2', 'bg'] }), [
      { toolUseId: 'r1', name: 'Read', requestedAt: 100 },
      { toolUseId: 'r2', name: 'Grep', requestedAt: 200 },
      { toolUseId: 'bg', name: 'Agent', requestedAt: 300 },
    ])
    turns = toolEnded(turns, { toolUseId: 'r1', name: 'Read', endedAt: 1_100, durationMs: 50, outcome: 'ok' })
    turns = toolEnded(turns, { toolUseId: 'r2', name: 'Grep', endedAt: 1_300, durationMs: 300, outcome: 'error' })
    turns = toolEnded(turns, { toolUseId: 'bg', name: 'Agent', endedAt: 9_000, durationMs: 8_000, outcome: 'ok' })
    turns = forked(turns, { toolUseId: 'bg', childAgentId: 'a1', background: true, at: 1_050, subagentType: 'worker', description: 'side job' })
    turns = stepNoted(turns, step({ index: 1, stepMs: 2_000, endedAt: 3_500, toolUseIds: ['d1'] }), [{ toolUseId: 'd1', name: 'Edit', requestedAt: 3_000 }])
    turns = toolEnded(turns, { toolUseId: 'd1', name: 'Edit', endedAt: 3_600, outcome: 'denied' })
    turns = stepNoted(turns, step({ index: 2, stepMs: 700, endedAt: 4_400 }))

    expect(criticalPathMs(turns[0]!)).toBe(1_000 + 300 + 2_000 + 700)
    expect(turns[0]!.forks).toHaveLength(1)
    expect(turns[0]!.tools.find(one => one.toolUseId === 'd1')).toEqual({ toolUseId: 'd1', name: 'Edit', turnId: 't1', stepIndex: 1, requestedAt: 3_000, endedAt: 3_600, outcome: 'denied' })
  })

  test('the watch takes the first content chunk and every tool chunk; engine chunks are not content', () => {
    // Chunks as the stream yields them, wider than the fields the watch reads.
    const chunks: Record<string, Parameters<typeof watchChunk>[1]> = {
      engine: { kind: 'engine', ref: 1 } as Parameters<typeof watchChunk>[1],
      text: { kind: 'text', index: 0, text: 'hi' } as Parameters<typeof watchChunk>[1],
      thinking: { kind: 'thinking', index: 1, text: 'x' } as Parameters<typeof watchChunk>[1],
      tool: { kind: 'tool', index: 2, id: 'tu9', name: 'Bash' } as Parameters<typeof watchChunk>[1],
      input: { kind: 'input', index: 2, json: '{}' } as Parameters<typeof watchChunk>[1],
    }
    let watch = watchChunk({ tools: [] }, chunks.engine!, 5)

    expect(watch).toEqual({ tools: [] })

    watch = watchChunk(watch, chunks.text!, 40)
    watch = watchChunk(watch, chunks.thinking!, 50)
    watch = watchChunk(watch, chunks.tool!, 70)
    watch = watchChunk(watch, chunks.input!, 80)

    expect(watch).toEqual({ firstMs: 40, firstKind: 'text', tools: [{ toolUseId: 'tu9', name: 'Bash', atMs: 70 }] })
  })
})

const call = (toolUseId: string, name: string, durationMs?: number): TimelineTool => ({ toolUseId, name, ...(durationMs !== undefined && { durationMs, endedAt: 1 }) })

/** A main turn ended after `durationMs`, unless null: still open. */
const mainTurn = (turnId: string, durationMs: number | null, more: Partial<TimelineTurn> = {}): TimelineTurn => ({
  turnId,
  startedAt: 0,
  steps: [],
  tools: [],
  forks: [],
  ...(durationMs !== null && { endedAt: durationMs, durationMs }),
  ...more,
})

const NO_HOTSPOTS: Hotspots = { turns: 0, tools: [], slowest: [] }

const HOTSPOT_CASES: { name: string; turns: TimelineTurn[]; want: Partial<Hotspots> }[] = [
  { name: 'no turn: nothing ranked, no model time', turns: [], want: NO_HOTSPOTS },
  {
    name: "a subagent's turns are not counted",
    turns: [mainTurn('s1', 9_000, { agentId: 'a1', tools: [call('x', 'Bash', 5_000)], steps: [step({ turnId: 's1', ttftMs: 100, stepMs: 900 })] })],
    want: NO_HOTSPOTS,
  },
  {
    name: 'a call without a duration is no sample: neither counted nor 0',
    turns: [mainTurn('t1', null, { tools: [call('r1', 'Read', 100), call('r2', 'Read'), call('d1', 'Edit')] })],
    want: { turns: 1, tools: [{ name: 'Read', count: 1, totalMs: 100, maxMs: 100 }] },
  },
  {
    name: "one tool's calls across turns add up; the longest one is kept",
    turns: [mainTurn('t1', 1_000, { tools: [call('b1', 'Bash', 300), call('r1', 'Read', 50)] }), mainTurn('t2', 2_000, { tools: [call('b2', 'Bash', 1_200)] })],
    want: { tools: [{ name: 'Bash', count: 2, totalMs: 1_500, maxMs: 1_200 }, { name: 'Read', count: 1, totalMs: 50, maxMs: 50 }] },
  },
  {
    name: 'equal totals rank by name',
    turns: [mainTurn('t1', 1_000, { tools: [call('g', 'Grep', 100), call('b', 'Bash', 100), call('r', 'Read', 300)] })],
    want: { tools: [{ name: 'Read', count: 1, totalMs: 300, maxMs: 300 }, { name: 'Bash', count: 1, totalMs: 100, maxMs: 100 }, { name: 'Grep', count: 1, totalMs: 100, maxMs: 100 }] },
  },
  {
    name: 'the 8 longest tools',
    turns: [mainTurn('t1', 1_000, { tools: Array.from({ length: 10 }, (_, i) => call(`u${i}`, `T${i}`, (i + 1) * 10)) })],
    want: { tools: Array.from({ length: 8 }, (_, i) => ({ name: `T${9 - i}`, count: 1, totalMs: (10 - i) * 10, maxMs: (10 - i) * 10 })) },
  },
  {
    name: 'model time: steps that ended with a first token; a running step or one with no first token has no sample',
    turns: [
      mainTurn('t1', 9_000, { steps: [step({ index: 0, ttftMs: 1_000, stepMs: 4_000 }), step({ index: 1, stepMs: 2_000 }), step({ index: 2, ttftMs: 500 })] }),
      mainTurn('t2', 3_000, { steps: [step({ turnId: 't2', ttftMs: 600, stepMs: 1_600 })] }),
    ],
    want: { model: { waitMs: 1_600, genMs: 4_000 } },
  },
  {
    name: 'the 3 slowest ended turns: an open turn is not one; equal times keep turn order; the slowest step when one ended',
    turns: [
      mainTurn('t1', 5_000, { steps: [step({ index: 0, stepMs: 700 }), step({ index: 1, stepMs: 1_200 }), step({ index: 2, stepMs: 1_200 })] }),
      mainTurn('t2', 9_000, { steps: [step({ turnId: 't2', ttftMs: 10 })] }),
      mainTurn('s1', 99_000, { agentId: 'a1' }),
      mainTurn('t3', null),
      mainTurn('t4', 9_000),
      mainTurn('t5', 1_000),
    ],
    want: {
      turns: 5,
      slowest: [
        { turnId: 't2', ordinal: 2, durationMs: 9_000 },
        { turnId: 't4', ordinal: 4, durationMs: 9_000 },
        { turnId: 't1', ordinal: 1, durationMs: 5_000, slowStep: { index: 1, ms: 1_200 } },
      ],
    },
  },
]

describe('hotspots', () => {
  for (const one of HOTSPOT_CASES) {
    test(one.name, () => {
      const got = hotspotsOf(one.turns)

      expect(Object.fromEntries(Object.keys(one.want).map(key => [key, got[key as keyof Hotspots]]))).toStrictEqual(one.want)

      if (one.want.model === undefined) {
        expect('model' in got, 'no sample: no model time, not 0').toBe(false)
      }
    })
  }
})

const STEP_IN: TurnStepInput ={ turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 4 }
const USAGE = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 300, model: 'claude-opus-5-5' }
const CHUNKS: TurnStepChunk[] = [
  { kind: 'thinking', index: 0, text: 'plan' },
  { kind: 'text', index: 1, text: 'Reading it.' },
  { kind: 'tool', index: 2, id: 'toolu_r', name: 'Read' },
  { kind: 'input', index: 2, json: '{"file_path":"/w/a.md"}' },
  { kind: 'stop', stopReason: 'tool_use', usage: USAGE },
]
const RESULT: TurnStepResult = { turnId: 'turn-1', index: 0, answer: 'Reading it.', toolUses: [{ name: 'Read', input: { file_path: '/w/a.md' } }], stopReason: 'tool_use', usage: USAGE }

/** The engine beneath: a step that streams CHUNKS and returns RESULT, and the events the timeline hooks pass on. */
function engine(on: On): void {
  on('turn.step', async function* () {
    for (const chunk of CHUNKS) {
      yield chunk
    }

    return RESULT
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.PermissionDenied', () => ({}))
  on('classic.StopFailure', () => ({}))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 150_000, tokensAfter: 20_000 }))
}

const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

/** The timeline as last written: the test's `$` has no state noun, so the writes are read on their way down. */
function timelineOf(on: On): () => TimelineTurn[] {
  let last: TimelineTurn[] = []

  on('state.set', ($, e, next) => {
    if (e.plugin === TIMELINE.plugin && e.key === TIMELINE.key) {
      last = (e.value as { value: TimelineTurn[] }).value
    }

    return next(e)
  })

  return () => last
}

/** The chunks the stream yields and the value it returns (the test's `$` hands back no `result` promise). */
async function drain(stream: AsyncGenerator<TurnStepChunk, TurnStepResult>) {
  const chunks: TurnStepChunk[] = []
  let item = await stream.next()

  while (item.done !== true) {
    chunks.push(item.value)
    item = await stream.next()
  }

  return { chunks, result: item.value }
}

describe('timeline hooks', () => {
  test('turn.step passes every chunk and the result through, and records the step', async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    engine(on)

    const timeline = timelineOf(on)

    await $.turn.start({ text: 'go', turnId: 'turn-1' })

    const { chunks, result } = await drain($.turn.step(STEP_IN))

    expect(chunks).toEqual(CHUNKS)
    expect(result).toEqual(RESULT)

    const turn = timeline()[0]!

    expect(turn).toMatchObject({ turnId: 'turn-1', startedAt: 1_000_000 })
    expect(turn.steps).toEqual([
      {
        turnId: 'turn-1',
        index: 0,
        model: 'claude-opus-5-5',
        effort: 'high',
        messageCount: 4,
        sentAt: 1_000_000,
        ttftMs: expect.any(Number),
        firstKind: 'thinking',
        endedAt: expect.any(Number),
        stepMs: expect.any(Number),
        stopReason: 'tool_use',
        usage: { input: 10, output: 200, cacheRead: 9_000, cacheWrite: 300 },
        toolUseIds: ['toolu_r'],
      },
    ])
    expect(turn.tools).toEqual([{ toolUseId: 'toolu_r', name: 'Read', turnId: 'turn-1', stepIndex: 0, requestedAt: expect.any(Number) }])
  })

  test('a timeline that cannot be written leaves the stream whole', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    engine(on)
    on('state.set', () => {
      throw new Error('state is down')
    })

    expect(await drain($.turn.step(STEP_IN))).toEqual({ chunks: CHUNKS, result: RESULT })
  })

  test('a clock that fails leaves the stream whole', async ($, on) => {
    engine(on)
    on('clock.now', () => {
      throw new Error('no clock')
    })

    expect(await drain($.turn.step(STEP_IN))).toEqual({ chunks: CHUNKS, result: RESULT })
  })

  test('tools, a fork, a compaction, an API error and turn.complete land on the turn', async ($, on) => {
    const clock = mock.clock(on, { now: 5_000 })

    engine(on)

    const timeline = timelineOf(on)

    await $.turn.start({ text: 'go', turnId: 'turn-1' })
    await drain($.turn.step(STEP_IN))
    await clock.advance(100)
    await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: 'ok', tool_use_id: 'toolu_r', duration_ms: 42 })
    await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: {}, tool_use_id: 'toolu_b', error: 'stopped', is_interrupt: true, duration_ms: 7 })
    await $.classic.PermissionDenied({ tool_name: 'Edit', tool_input: {}, tool_use_id: 'toolu_e', reason: 'no' })
    await $.agent.spawn({ tool_use_id: 'toolu_a', prompt: 'p', description: 'side job', subagentType: 'worker', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false })
    await $.session.compact({ trigger: 'auto', messages: SUMMARY })
    await $.classic.StopFailure({ error: 'overloaded', error_details: '529' })
    await clock.advance(400)
    await $.turn.complete({ answer: '', durationMs: 500, isAborted: false, turnId: 'turn-1', reason: 'error' })

    const turn = timeline()[0]!

    expect(turn.tools).toEqual([
      { toolUseId: 'toolu_r', name: 'Read', turnId: 'turn-1', stepIndex: 0, requestedAt: expect.any(Number), endedAt: 5_100, durationMs: 42, outcome: 'ok' },
      { toolUseId: 'toolu_b', name: 'Bash', turnId: 'turn-1', endedAt: 5_100, durationMs: 7, outcome: 'interrupted' },
      { toolUseId: 'toolu_e', name: 'Edit', turnId: 'turn-1', endedAt: 5_100, outcome: 'denied' },
    ])
    expect(turn.forks).toEqual([{ toolUseId: 'toolu_a', childAgentId: 'a1', background: true, at: 5_100, subagentType: 'worker', description: 'side job' }])
    expect(turn.compactions).toEqual([{ at: 5_100, trigger: 'auto', tokensBefore: 150_000, tokensAfter: 20_000 }])
    expect(turn.apiError).toEqual({ error: 'overloaded', details: '529' })
    expect(turn).toMatchObject({ endedAt: 5_500, durationMs: 500, reason: 'error' })
  })
})

type Seen = { pattern: string; matcher?: Record<string, unknown> }

/** Whether an event pattern selects tool.call: by name, by a glob over it, or by a negation of something else. */
const selectsToolCall = (pattern: string): boolean =>
  pattern === 'tool.call' || pattern === '*' || pattern === 'tool.*' || (pattern.startsWith('!') && !selectsToolCall(pattern.slice(1)))

const matchesBash = (leaf: unknown): boolean => leaf === 'Bash' || (leaf instanceof RegExp && leaf.test('Bash')) || (Array.isArray(leaf) && leaf.some(matchesBash))

/** A registration whose hook a Bash call would reach: no matcher on `tool`, or one Bash satisfies. */
const reachesBash = (one: Seen) => selectsToolCall(one.pattern) && (one.matcher === undefined || !('tool' in one.matcher) || matchesBash(one.matcher.tool))

describe('registration', () => {
  test('no hook stands on tool.call where a Bash call would reach it (claude-code#92533)', () => {
    const seen: Seen[] = []
    const on = ((pattern: string, matcher: unknown) => {
      seen.push({ pattern, ...(typeof matcher === 'object' && matcher !== null && { matcher: matcher as Record<string, unknown> }) })

      return { catch: () => undefined }
    }) as unknown as On

    register(on, { gpuHosts: '', cacheTtlMinutes: 60, language: 'en' })

    expect(seen.map(one => one.pattern), 'the timeline is registered').toContain('turn.step')
    expect(seen.filter(reachesBash)).toEqual([])
    expect([{ pattern: 'tool.call' }, { pattern: '*' }, { pattern: 'tool.call', matcher: { tool: /^B/ } }].every(reachesBash), 'the check itself').toBe(true)
    expect(reachesBash({ pattern: 'tool.call', matcher: { tool: 'Read' } })).toBe(false)
  })
})
