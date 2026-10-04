import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/proj'
const HOME = '/home'
const ENGINE = { plugin: 'engine', tier: 'core' } as const

const spawnInput = (model?: string) => ({
  tool_use_id: 'toolu_1',
  prompt: 'do it',
  description: 'task',
  subagentType: 'worker',
  provider: ENGINE,
  model,
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
})

const offerInput = (agent: string) => ({
  agent,
  description: 'x',
  source: 'built-in',
  provider: ENGINE,
})

// Stands in for the engine beneath the plugin: a project root holding `files`; root null = unavailable.
const world = (on: On, files: string[], root: string | null = ROOT) => {
  on('session.root', () => (root === null ? { deny: 'no root' } : { value: root }))
  on('env.get', ($, e) => (e.name === 'HOME' ? { value: HOME } : { value: undefined }))
  on('fs.stat', ($, e) =>
    files.includes(e.path)
      ? { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
      : { deny: `ENOENT ${e.path}` },
  )
  on('agent.spawn', ($, e) => ({ model: e.model ?? 'claude-opus-5-5', agentId: 'a1' }))
  on('agent.offer', () => ({ isOffered: true }))
}

const offered = async ($: Engine, agent: string) => (await $.agent.offer(offerInput(agent))).isOffered

describe('agent.spawn', () => {
  for (const model of ['sonnet', 'claude-sonnet-4-5', 'Sonnet[1m]']) {
    test(`denies ${model} when sonnet is blocked`, { options: { blockedSubagentModels: 'sonnet' } }, async ($, on) => {
      world(on, [])
      const got = await $.agent.spawn(spawnInput(model))
      expect(got.deny).toContain('sonnet')
    })
  }

  for (const model of ['opus', 'claude-opus-5-5', 'sonnet', undefined]) {
    test(`allows ${model ?? 'omitted model'}`, async ($, on) => {
      world(on, [])
      const got = await $.agent.spawn(spawnInput(model))
      expect(got.deny).toBeUndefined()
      expect(got.agentId).toBe('a1')
    })
  }

  test('a configured comma list blocks each entry',{ options: { blockedSubagentModels: 'haiku, opus-4' } }, async ($, on) => {
    world(on, [])
    expect((await $.agent.spawn(spawnInput('claude-Haiku-4-5'))).deny).toContain('haiku')
    expect((await $.agent.spawn(spawnInput('claude-opus-4-1'))).deny).toContain('opus-4')
    expect((await $.agent.spawn(spawnInput('sonnet'))).agentId).toBe('a1')
  })

  test('an empty list blocks nothing', { options: { blockedSubagentModels: '' } }, async ($, on) => {
    world(on, [])
    for (const model of ['sonnet', 'haiku']) {
      const got = await $.agent.spawn(spawnInput(model))
      expect(got.deny).toBeUndefined()
      expect(got.agentId).toBe('a1')
    }
  })

  test('a hook that throws logs one debug line and denies the spawn', async ($, on) => {
    const logs: { text: string; to: string }[] = []
    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
    on('ui.log', ($, e) => {
      logs.push({ text: e.text, to: e.to })
      return { value: undefined }
    })
    // A model that is not a string makes the check throw.
    const got = await $.agent.spawn(spawnInput(5 as never))
    expect(got.deny).toContain('harness: the subagent model check failed')
    expect(got.agentId).toBeUndefined()
    expect(logs.length).toBe(1)
    expect(logs[0]?.to).toBe('debug')
    expect(logs[0]?.text).toContain('harness: agent.spawn')
  })
})

describe('agent.offer', () => {
  test('hides general-purpose when worker.md exists', async ($, on) => {
    world(on, [`${ROOT}/.claude/agents/worker.md`])
    expect(await offered($, 'general-purpose')).toBe(false)
  })

  test('hides general-purpose when researcher.md exists', async ($, on) => {
    world(on, [`${ROOT}/.claude/agents/researcher.md`])
    expect(await offered($, 'general-purpose')).toBe(false)
  })

  test('hides general-purpose when only the user-level worker.md exists', async ($, on) => {
    world(on, [`${HOME}/.claude/agents/worker.md`])
    expect(await offered($, 'general-purpose')).toBe(false)
  })

  test('hides general-purpose by the user-level definition when the project root is unavailable', async ($, on) => {
    world(on, [`${HOME}/.claude/agents/researcher.md`], null)
    expect(await offered($, 'general-purpose')).toBe(false)
  })

  test('keeps Explore when worker.md exists', async ($, on) => {
    world(on, [`${ROOT}/.claude/agents/worker.md`])
    expect(await offered($, 'Explore')).toBe(true)
  })

  test('keeps general-purpose without definitions', async ($, on) => {
    world(on, [])
    expect(await offered($, 'general-purpose')).toBe(true)
  })

  test('keeps general-purpose when the project root is unavailable', async ($, on) => {
    world(on, [`${ROOT}/.claude/agents/worker.md`], null)
    expect(await offered($, 'general-purpose')).toBe(true)
  })

  test('a hook that throws logs one debug line, and general-purpose stays offered', async ($, on) => {
    const logs: { text: string; to: string }[] = []
    on('session.root', () => ({ value: ROOT }))
    on('env.get', () => ({ deny: 'env unreadable' }))
    on('fs.stat', ($, e) => ({ deny: `ENOENT ${e.path}` }))
    on('agent.offer', () => ({ isOffered: true }))
    on('ui.log', ($, e) => {
      logs.push({ text: e.text, to: e.to })
      return { value: undefined }
    })
    expect(await offered($, 'general-purpose')).toBe(true)
    expect(logs.length).toBe(1)
    expect(logs[0]?.to).toBe('debug')
    expect(logs[0]?.text).toContain('harness: agent.offer')
    expect(logs[0]?.text).toContain('env unreadable')
  })
})

const ASK_GUIDANCE =
  'Ask only what blocks you. Prefer one question per dialog, at most two. Give 2–3 distinct options, each with a one-line consequence, and mark one "(Recommended)" with its reason. Say which default you will assume for anything you do not ask. For an open-ended question, ask in plain prose instead of options.'

const describeInput = (tool: string) => ({ tool, description: `${tool} does its job.`, provider: ENGINE })

describe('tool.describe', () => {
  test('AskUserQuestion gets the guidance after one blank line', async ($, on) => {
    on('tool.describe', ($, e) => ({ description: e.description }))
    const got = await $.tool.describe(describeInput('AskUserQuestion'))
    expect(got.description).toBe(`AskUserQuestion does its job.\n\n${ASK_GUIDANCE}`)
  })

  for (const tool of ['Bash', 'Read']) {
    test(`${tool} keeps its description`, async ($, on) => {
      on('tool.describe', ($, e) => ({ description: e.description }))
      expect((await $.tool.describe(describeInput(tool))).description).toBe(`${tool} does its job.`)
    })
  }

  test('two calls return the same text', async ($, on) => {
    on('tool.describe', ($, e) => ({ description: e.description }))
    const first = await $.tool.describe(describeInput('AskUserQuestion'))
    const second = await $.tool.describe(describeInput('AskUserQuestion'))
    expect(second.description).toBe(first.description)
    expect(first.description.endsWith(ASK_GUIDANCE)).toBe(true)
  })
})

const MINUTE = 60_000
const NOW = 1_000_000
const REPLIED = { answer: 'done', durationMs: 2_000, isAborted: false, turnId: 't', reason: 'answer' } as const
const PROMPT = { text: 'go', wait: false, origin: { kind: 'composer' } } as never
const TRANSCRIPT = '/t/session.jsonl'
const switched = (cache_ttl: '5m' | '1h') =>
  ({ from_model: 'a', to_model: 'b', requested_model: null, source: 'command', context_tokens: 1, prompt_cache_warm: true, cache_ttl, estimated_cache_write_usd: 1, pricing: 'catalog' }) as never
// Escaped so the plugin sources outside hooks/i18n.ts stay free of Han characters.
const ZH_TOAST = '\u7a7a\u95f2\u5c06\u6ee1\u7f13\u5b58\u65f6\u6548\uff0c\u5df2\u81ea\u52a8\u538b\u7f29\u4e0a\u4e0b\u6587'

/** One transcript line of an assistant reply that wrote `h1` tokens to the 1h cache and `m5` to the 5m one. */
const reply = (h1: number, m5: number, isSidechain = false) =>
  JSON.stringify({ type: 'assistant', isSidechain, message: { usage: { cache_creation: { ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5 } } } })
const tailOf = (...lines: string[]) => `${lines.join('\n')}\n`
const TAIL_5M = tailOf(reply(900, 0), reply(0, 900), JSON.stringify({ type: 'user', isSidechain: false }))
const TAIL_1H = tailOf(reply(0, 900), reply(934, 0))

// The engine beneath the plugin for idle compaction: the context holds `tokens`, the transcript ends in `tail`
// (null: the tail fails); counts compactions, toasts and tails.
const idleWorld = (on: On, tokens: number, tail: string | null = '') => {
  const seen = { compacts: 0, toasts: [] as string[], tails: [] as string[][] }
  on('settings.read', () => ({ value: {} }))
  on('env.get', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens, window: 1_000_000 }, rateLimits: {} } }) as never)
  on('session.compact', () => {
    seen.compacts += 1
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    seen.tails.push([...e.argv])
    return { value: { exitCode: tail === null ? 1 : 0, stdout: tail ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'hi' }
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn' } as never
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('classic.PostModelSwitch', () => ({}))
  on('classic.Stop', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  return { seen, clock: mock.clock(on, { now: NOW }) }
}

/** One model request of the main thread, or of subagent `agentId`. */
async function step($: Engine, agentId?: string): Promise<void> {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 2, ...(agentId !== undefined && { agentId }) } as never)
  while ((await stream.next()).done !== true) {}
}

/** A main turn of one step that ends at once and stops with `transcript`. */
async function mainTurn($: Engine, transcript = TRANSCRIPT): Promise<void> {
  await step($)
  await $.turn.complete(REPLIED)
  await $.classic.Stop({ stop_hook_active: false, transcript_path: transcript })
}

describe('idle compaction', () => {
  test('a 5m cache compacts a context over 200k 1 minute before it expires, once, with a toast', async ($, on) => {
    const { seen, clock } = idleWorld(on, 250_000, TAIL_5M)
    await mainTurn($)
    expect(seen.tails).toEqual([['tail', '-c', String(256 * 1024), TRANSCRIPT]])
    await clock.advance(4 * MINUTE - 1)
    expect(seen.compacts).toBe(0)
    await clock.advance(1)
    expect(seen.compacts).toBe(1)
    expect(seen.toasts).toEqual(['Idle near cache expiry: context compacted'])
    await clock.advance(3 * 60 * MINUTE)
    expect(seen.compacts).toBe(1)
  })

  test('a 5m cache leaves a context under 200k alone', async ($, on) => {
    const { seen, clock } = idleWorld(on, 150_000, TAIL_5M)
    await mainTurn($)
    await clock.advance(2 * 60 * MINUTE)
    expect(seen.compacts).toBe(0)
  })

  test('a 1h cache compacts a context over 100k 10 minutes before it expires', async ($, on) => {
    const { seen, clock } = idleWorld(on, 150_000, TAIL_1H)
    await mainTurn($)
    await clock.advance(50 * MINUTE - 1)
    expect(seen.compacts).toBe(0)
    await clock.advance(1)
    expect(seen.compacts).toBe(1)
  })

  test('a 1h cache leaves a context under 100k alone', async ($, on) => {
    const { seen, clock } = idleWorld(on, 99_999, TAIL_1H)
    await mainTurn($)
    await clock.advance(2 * 60 * MINUTE)
    expect(seen.compacts).toBe(0)
    expect(seen.toasts).toEqual([])
  })

  test('the cache expires from the last main step, not from the reply', async ($, on) => {
    const { seen, clock } = idleWorld(on, 250_000, TAIL_5M)
    await step($)
    await clock.advance(2 * MINUTE)
    await $.turn.complete(REPLIED)
    await $.classic.Stop({ stop_hook_active: false, transcript_path: TRANSCRIPT })
    await clock.advance(2 * MINUTE - 1)
    expect(seen.compacts).toBe(0)
    await clock.advance(1)
    expect(seen.compacts).toBe(1)
  })

  test('a turn that sent no request anchors on its own reply, not on an earlier step', async ($, on) => {
    const { seen, clock } = idleWorld(on, 150_000, TAIL_1H)
    await step($)
    await $.turn.complete(REPLIED)
    await clock.advance(30 * MINUTE)
    await $.prompt.submit(PROMPT)
    await $.turn.complete(REPLIED)
    await clock.advance(50 * MINUTE - 1)
    expect(seen.compacts).toBe(0)
    await clock.advance(1)
    expect(seen.compacts).toBe(1)
  })

  test('a subagent step does not move the anchor', async ($, on) => {
    const { seen, clock } = idleWorld(on, 250_000, TAIL_5M)
    await step($)
    await clock.advance(2 * MINUTE)
    await step($, 'a1')
    await $.turn.complete(REPLIED)
    await $.classic.Stop({ stop_hook_active: false, transcript_path: TRANSCRIPT })
    await clock.advance(2 * MINUTE)
    expect(seen.compacts).toBe(1)
  })

  test('a failed tail keeps the 1h rule', async ($, on) => {
    const { seen, clock } = idleWorld(on, 150_000, null)
    await mainTurn($)
    await clock.advance(50 * MINUTE - 1)
    expect(seen.compacts).toBe(0)
    await clock.advance(1)
    expect(seen.compacts).toBe(1)
  })

  test('no transcript path keeps the 1h rule and runs no tail', async ($, on) => {
    const { seen, clock } = idleWorld(on, 150_000, TAIL_5M)
    await mainTurn($, '')
    expect(seen.tails).toEqual([])
    await clock.advance(50 * MINUTE)
    expect(seen.compacts).toBe(1)
  })

  test('a cut first line, lines without cache writes, sidechain and partial last lines are skipped', async ($, on) => {
    const cut = reply(934, 0).slice(20)
    const { seen, clock } = idleWorld(on, 250_000, tailOf(cut, reply(0, 900), reply(0, 0), reply(934, 0, true), '{"type":"assist'))
    await mainTurn($)
    await clock.advance(4 * MINUTE)
    expect(seen.compacts).toBe(1)
  })

  test('a tail with nothing to read keeps the TTL a model switch reported', async ($, on) => {
    const { seen, clock } = idleWorld(on, 250_000, tailOf(reply(934, 0).slice(20), reply(0, 0)))
    await $.classic.PostModelSwitch(switched('5m'))
    await mainTurn($)
    await clock.advance(4 * MINUTE)
    expect(seen.compacts).toBe(1)
  })

  test('a 5m TTL from a model switch uses the 5m rule', async ($, on) => {
    const { seen, clock } = idleWorld(on, 250_000)
    await $.classic.PostModelSwitch(switched('5m'))
    await step($)
    await $.turn.complete(REPLIED)
    await clock.advance(4 * MINUTE - 1)
    expect(seen.compacts).toBe(0)
    await clock.advance(1)
    expect(seen.compacts).toBe(1)
  })

  test('a subagent Stop with a 5m tail keeps the 1h rule', async ($, on) => {
    const { seen, clock } = idleWorld(on, 250_000, TAIL_5M)
    await step($)
    await $.turn.complete(REPLIED)
    await $.classic.Stop({ stop_hook_active: false, transcript_path: TRANSCRIPT, agent_id: 'a1' } as never)
    await clock.advance(4 * MINUTE)
    expect(seen.compacts).toBe(0)
    await clock.advance(46 * MINUTE)
    expect(seen.compacts).toBe(1)
  })

  test('a subagent model switch to 5m keeps the 1h rule', async ($, on) => {
    const { seen, clock } = idleWorld(on, 250_000)
    await step($)
    await $.turn.complete(REPLIED)
    await $.classic.PostModelSwitch({ ...(switched('5m') as object), agent_id: 'a1' } as never)
    await clock.advance(4 * MINUTE)
    expect(seen.compacts).toBe(0)
    await clock.advance(46 * MINUTE)
    expect(seen.compacts).toBe(1)
  })

  test('the toast follows language zh-CN', { options: { language: 'zh-CN' } }, async ($, on) => {
    const { seen, clock } = idleWorld(on, 150_000)
    await mainTurn($)
    await clock.advance(50 * MINUTE)
    expect(seen.toasts).toEqual([ZH_TOAST])
  })

  test('a prompt before the moment cancels it', async ($, on) => {
    const { seen, clock } = idleWorld(on, 150_000)
    await mainTurn($)
    await clock.advance(30 * MINUTE)
    await $.prompt.submit(PROMPT)
    await clock.advance(2 * 60 * MINUTE)
    expect(seen.compacts).toBe(0)
  })

  for (const source of ['resume', 'clear', 'fork'] as const) {
    test(`a main-thread SessionStart from ${source} cancels the previous conversation's timer`, async ($, on) => {
      const { seen, clock } = idleWorld(on, 150_000)
      await mainTurn($)
      await clock.advance(30 * MINUTE)
      await $.classic.SessionStart({ source })
      await clock.advance(2 * 60 * MINUTE)
      expect(seen.compacts).toBe(0)
    })
  }

  test('session.end cancels the timer', async ($, on) => {
    const { seen, clock } = idleWorld(on, 150_000)
    await mainTurn($)
    await clock.advance(30 * MINUTE)
    await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(2 * 60 * MINUTE)
    expect(seen.compacts).toBe(0)
  })

  test('a subagent SessionStart keeps the timer', async ($, on) => {
    const { seen, clock } = idleWorld(on, 150_000)
    await mainTurn($)
    await clock.advance(30 * MINUTE)
    await $.classic.SessionStart({ source: 'resume', agent_id: 'a1' })
    await clock.advance(20 * MINUTE - 1)
    expect(seen.compacts).toBe(0)
    await clock.advance(1)
    expect(seen.compacts).toBe(1)
  })

  test('a subagent turn sets no timer', async ($, on) => {
    const { seen, clock } = idleWorld(on, 150_000)
    await step($, 'a1')
    await $.turn.complete({ ...REPLIED, agentId: 'a1' })
    await clock.advance(2 * 60 * MINUTE)
    expect(seen.compacts).toBe(0)
  })

  test('idleCompact off registers nothing', { options: { idleCompact: false } }, async ($, on) => {
    const { seen, clock } = idleWorld(on, 250_000, TAIL_5M)
    await mainTurn($)
    await clock.advance(2 * 60 * MINUTE)
    expect(seen.compacts).toBe(0)
    expect(seen.tails).toEqual([])
  })
})
