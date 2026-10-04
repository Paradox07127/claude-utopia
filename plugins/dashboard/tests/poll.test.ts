import { describe, expect, test } from 'claude-code/testing'

import { poll } from '../hooks/register'

/** The `$` poll uses, in memory: `after` timers that fire as `advance` passes them, and the lines sent to the log. */
function fakeEngine() {
  let now = 0
  const timers: { at: number; fn: () => void; isCancelled: boolean }[] = []
  const logs: { text: string; to?: string }[] = []
  const $ = {
    clock: {
      after: (ms: number, fn: () => void) => {
        const timer = { at: now + ms, fn, isCancelled: false }

        timers.push(timer)

        return { cancel: () => (timer.isCancelled = true) }
      },
    },
    ui: { log: (text: string, options?: { to?: string }) => logs.push({ text, to: options?.to }) },
  }
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve()
    }
  }
  const advance = async (ms: number) => {
    const end = now + ms

    for (;;) {
      const due = timers.filter(one => !one.isCancelled && one.at <= end).sort((a, b) => a.at - b.at)[0]

      if (due === undefined) {
        break
      }

      timers.splice(timers.indexOf(due), 1)
      now = due.at
      due.fn()
      await flush()
    }

    now = end
  }

  return { $: $ as never, logs, flush, advance, armed: () => timers.filter(one => !one.isCancelled).length }
}

/** A run the test ends by hand. */
function held() {
  let calls = 0
  let finish = () => {}
  const fn = () => {
    calls += 1

    return new Promise<void>(resolve => {
      finish = resolve
    })
  }

  return { fn, calls: () => calls, finish: () => finish() }
}

describe('poll', () => {
  test('a run comes ms after the last one ended, never two at once', async () => {
    const engine = fakeEngine()
    const run = held()

    poll(engine.$, 'test', 3000, run.fn)
    await engine.advance(2999)
    expect(run.calls()).toBe(0)

    await engine.advance(1)
    expect(run.calls()).toBe(1)

    await engine.advance(10_000)
    expect(run.calls(), 'still in flight: no timer armed meanwhile').toBe(1)
    expect(engine.armed()).toBe(0)

    run.finish()
    await engine.flush()
    expect(engine.armed()).toBe(1)

    await engine.advance(2999)
    expect(run.calls()).toBe(1)

    await engine.advance(1)
    expect(run.calls()).toBe(2)
  })

  test('now() runs at once, and not while a run is in flight', async () => {
    const engine = fakeEngine()
    const run = held()
    const loop = poll(engine.$, 'test', 3000, run.fn)

    void loop.now()
    expect(run.calls()).toBe(1)

    void loop.now()
    await engine.advance(3000)
    expect(run.calls(), 'the in-flight run stands for both').toBe(1)

    run.finish()
    await engine.flush()
    void loop.now()
    expect(run.calls()).toBe(2)
  })

  test('now() during a run runs once more as it ends: what was asked mid-run is not lost', async () => {
    const engine = fakeEngine()
    const run = held()
    const loop = poll(engine.$, 'test', 3000, run.fn)

    await engine.advance(3000)
    void loop.now()
    void loop.now()
    run.finish()
    await engine.flush()
    expect(run.calls()).toBe(2)

    run.finish()
    await engine.flush()
    expect(run.calls(), 'one rerun for any number of asks').toBe(2)
  })

  test('a run that throws goes to the debug log and the loop goes on', async () => {
    const engine = fakeEngine()
    let calls = 0

    poll(engine.$, 'runs', 3000, async () => {
      calls += 1

      if (calls === 1) {
        throw new Error('EIO: i/o error\nsecond line')
      }
    })
    await engine.advance(3000)
    expect(engine.logs).toEqual([{ text: 'dashboard: the runs poll failed: EIO: i/o error', to: 'debug' }])

    await engine.advance(3000)
    expect(calls).toBe(2)
    expect(engine.logs).toHaveLength(1)
  })

  test('cancel() arms nothing more, a run in flight then included', async () => {
    const engine = fakeEngine()
    const run = held()
    const loop = poll(engine.$, 'test', 3000, run.fn)

    await engine.advance(3000)
    loop.cancel()
    run.finish()
    await engine.flush()
    expect(engine.armed()).toBe(0)

    await engine.advance(30_000)
    expect(run.calls()).toBe(1)

    const idle = poll(engine.$, 'test', 3000, run.fn)

    idle.cancel()
    await engine.advance(30_000)
    expect(run.calls(), 'cancelled while waiting').toBe(1)
  })
})
