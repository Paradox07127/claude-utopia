import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { promptSamples } from './predict-prompt'

const REPLIED = { answer: 'done', durationMs: 2_000, isAborted: false, turnId: 't', reason: 'answer' } as const
const typed = (text: string, kind = 'composer') => ({ text, wait: false, origin: { kind } }) as never

const USAGE = { input_tokens: 10, output_tokens: 30, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 }

// Stands in for the engine: the fork answers `reply` (null = nothing to fork); records fork prompts and shown suggestions.
const world = (on: On, reply: string | null, surfaces: string[] = ['desktop'], stored: Record<string, unknown> = {}) => {
  const seen = { forks: [] as string[], suggested: [] as string[], storeWrites: 0 }
  const store = new Map<string, unknown>(Object.entries(stored))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    seen.storeWrites += 1
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('model.fork', ($, e) => {
    seen.forks.push(e.prompt)
    return { value: reply === null ? { isAnswered: false, reason: 'nothing-to-fork' } : { isAnswered: true, text: reply, usage: USAGE } } as never
  })
  on('prompt.suggest', ($, e) => {
    seen.suggested.push(e.text)
    return { isShown: true }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.surfaces', () => ({ value: surfaces }) as never)
  on('session.cwd', () => ({ value: '/proj' }))
  on('ui.log', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('env.get', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 1_000_000 }, rateLimits: {} } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  return { seen, store, clock: mock.clock(on, { now: 0 }) }
}

async function turnEnds($: Engine, clock: { advance: (ms: number) => Promise<void> }, agentId?: string): Promise<void> {
  await $.turn.complete({ ...REPLIED, ...(agentId !== undefined && { agentId }) } as never)
  await clock.advance(0)
}

describe('promptSamples', () => {
  const at = (cwd: string, ...texts: string[]) => texts.map(text => ({ text, cwd }))

  test('recent holds only this project, oldest first', () => {
    const got = promptSamples([...at('/a', 'a1'), ...at('/b', 'b1'), ...at('/a', 'a2')], '/a')
    expect(got.recent).toEqual(['a1', 'a2'])
  })

  test('a project with no history falls back to the latest prompts anywhere', () => {
    expect(promptSamples(at('/b', 'b1', 'b2'), '/new').recent).toEqual(['b1', 'b2'])
  })

  test('habits are short messages sent at least 3 times, trailing punctuation ignored, most frequent first', () => {
    const history = [...at('/a', 'merge to main', 'merge to main.', 'go on', 'go on', 'go on', 'go on'), ...at('/b', 'merge to main'), ...at('/a', 'rare', 'x'.repeat(41), 'x'.repeat(41), 'x'.repeat(41))]
    expect(promptSamples(history, '/a').habits).toEqual(['go on', 'merge to main'])
  })
})

describe('next-prompt prediction', () => {
  test('a main turn proposes the fork reply, unquoted, as the suggestion', async ($, on) => {
    const { seen, clock } = world(on, '"run the auth tests and show the failures"')
    await turnEnds($, clock)
    expect(seen.forks).toHaveLength(1)
    expect(seen.suggested).toEqual(['run the auth tests and show the failures'])
  })

  test('a NONE reply shows nothing and counts an abstention', async ($, on) => {
    const { seen, store, clock } = world(on, 'NONE')
    await turnEnds($, clock)
    expect(seen.suggested).toEqual([])
    expect(store.get('predictionAbstained')).toBe(1)
  })

  test('nothing to fork counts no abstention', async ($, on) => {
    const { store, clock } = world(on, null)
    await turnEnds($, clock)
    expect(store.get('predictionAbstained')).toBeUndefined()
  })

  test('the fork prompt carries the prompts the person typed, not slash commands or notifications', async ($, on) => {
    const { seen, clock } = world(on, 'next')
    await $.prompt.submit(typed('first typed prompt'))
    await $.prompt.submit(typed('/compact'))
    await $.prompt.submit(typed('a task finished', 'task-notification'))
    await $.prompt.submit(typed('desktop prompt', 'sdk'))
    await turnEnds($, clock)
    expect(seen.forks[0]).toContain('<message>first typed prompt</message>\n<message>desktop prompt</message>\n\nShort messages')
    expect(seen.forks[0]).not.toContain('/compact')
    expect(seen.forks[0]).not.toContain('a task finished')
  })

  for (const reply of ['NONE', '  ', 'x'.repeat(601)]) {
    test(`shows nothing when the fork replies ${JSON.stringify(reply.slice(0, 8))}`, async ($, on) => {
      const { seen, clock } = world(on, reply)
      await turnEnds($, clock)
      expect(seen.suggested).toEqual([])
    })
  }

  test('shows nothing when there is nothing to fork', async ($, on) => {
    const { seen, clock } = world(on, null)
    await turnEnds($, clock)
    expect(seen.suggested).toEqual([])
  })

  for (const [surfaces, writes] of [[['desktop'], 1], [[], 0]] as const) {
    test(`a session with ${surfaces.length} surfaces records ${writes} typed prompt`, async ($, on) => {
      const { seen } = world(on, 'next', [...surfaces])
      await $.prompt.submit(typed('a prompt', 'sdk'))
      expect(seen.storeWrites).toBe(writes)
    })
  }

  test('a -p run with no surface does not fork', async ($, on) => {
    const { seen, clock } = world(on, 'next', [])
    await turnEnds($, clock)
    expect(seen.forks).toEqual([])
  })

  test('a subagent turn does not fork', async ($, on) => {
    const { seen, clock } = world(on, 'next')
    await turnEnds($, clock, 'a1')
    expect(seen.forks).toEqual([])
  })

  test("a plugin's suggestion passes the hook that hides the engine's own", async ($, on) => {
    world(on, 'next')
    expect((await $.prompt.suggest({ text: 'from a plugin' } as never)).isShown).toBe(true)
  })
})

const command = (name: string) => ({ command: name, args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })
const outcome = (forkMs: number, isAccepted: boolean, cachedTokens = 800, edit: { editDistance?: number; retainedChars?: number } = {}) =>
  ({ at: 0, forkMs, chars: 10, isAccepted, inputTokens: 1_000, cachedTokens, ...edit })
const logged = (suggestion: string, actual: string, isAccepted: boolean, editDistance: number) =>
  ({ at: 0, forkMs: 0, chars: suggestion.length, isAccepted, inputTokens: 1_000, cachedTokens: 900, suggestion, actual, editDistance, retainedChars: suggestion.length - editDistance })

describe('prediction outcomes', () => {
  test('a typed prompt that starts with the shown suggestion is logged as taken, with the fork time', async ($, on) => {
    const { store, clock } = world(on, 'run the tests')
    await turnEnds($, clock)
    await $.prompt.submit(typed('run the tests, then show me the failures'))
    expect(store.get('predictionLog')).toEqual([logged('run the tests', 'run the tests, then show me the failures', true, 0)])
  })

  test('a typed prompt that does not start with it is logged as not taken', async ($, on) => {
    const { store, clock } = world(on, 'run the tests')
    await turnEnds($, clock)
    await $.prompt.submit(typed('why is the button slow?'))
    expect(store.get('predictionLog')).toEqual([logged('run the tests', 'why is the button slow?', false, 10)])
  })

  test('an outcome holds the edit distance to the typed prompt cut to the suggestion length, and the characters kept', async ($, on) => {
    const { store, clock } = world(on, 'run the tests')
    await turnEnds($, clock)
    await $.prompt.submit(typed('run the test suite please'))
    expect(store.get('predictionLog')).toEqual([
      { at: 0, forkMs: 0, chars: 13, isAccepted: false, inputTokens: 1_000, cachedTokens: 900, suggestion: 'run the tests', actual: 'run the test suite please', editDistance: 1, retainedChars: 12 },
    ])
  })

  test('nothing is logged when no suggestion was shown', async ($, on) => {
    const { store, clock } = world(on, 'NONE')
    await turnEnds($, clock)
    await $.prompt.submit(typed('run the tests'))
    expect(store.get('predictionLog')).toBeUndefined()
  })

  test('a prompt the person did not type drops the pending suggestion', async ($, on) => {
    const { store, clock } = world(on, 'run the tests')
    await turnEnds($, clock)
    await $.prompt.submit(typed('a task finished', 'task-notification'))
    await $.prompt.submit(typed('run the tests'))
    expect(store.get('predictionLog')).toBeUndefined()
  })

  test('/prediction-stats reports the share taken and the median fork time', async ($, on) => {
    world(on, null, ['desktop'], { predictionLog: [outcome(1_000, true, 900), outcome(3_000, true, 1_000), outcome(2_000, false, 800)] })
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/proj' })
    const got = await $.command.run(command('prediction-stats'))
    expect(got.text).toContain('2 of the last 3')
    expect(got.text).toContain('67%')
    expect(got.text).toContain('2.0 s')
    expect(got.text).toContain('90% of fork input tokens read from cache')
  })

  test('/prediction-stats reports near-taken, characters kept and abstentions over the entries that hold them', async ($, on) => {
    const log = [
      outcome(1_000, true),
      outcome(1_000, true, 800, { editDistance: 0, retainedChars: 10 }),
      outcome(1_000, false, 800, { editDistance: 3, retainedChars: 7 }),
      outcome(1_000, false, 800, { editDistance: 8, retainedChars: 2 }),
    ]
    world(on, null, ['desktop'], { predictionLog: log, predictionAbstained: 1 })
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/proj' })
    const got = await $.command.run(command('prediction-stats'))
    expect(got.text).toContain('2 of 3 near-taken (67%')
    expect(got.text).toContain('mean 6.3 chars kept')
    expect(got.text).toContain('1 abstained (25% of decisions)')
  })

  test('/prediction-stats with no log says so', async ($, on) => {
    world(on, null)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/proj' })
    const got = await $.command.run(command('prediction-stats'))
    expect(got.text).toContain('No prediction')
  })
})
