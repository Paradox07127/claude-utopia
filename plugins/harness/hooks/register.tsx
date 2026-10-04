import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookFailure, Register, Timer } from 'claude-code'
import type { HarnessIdle } from '../types'
import { pickLang, strings } from './i18n'
import type { Lang } from './i18n'

const AGENT_DEFS = ['worker.md', 'researcher.md']

const MINUTE_MS = 60_000
const CACHE_TTL_MS = { '5m': 5 * MINUTE_MS, '1h': 60 * MINUTE_MS } as const
// leadMs: the compaction request itself reads the cached prefix, so it has to land this long before the cache expires.
// minTokens: below it a compaction saves little on the next request yet loses the conversation's detail.
const COMPACT_RULE = {
  '1h': { leadMs: 10 * MINUTE_MS, minTokens: 100_000 },
  '5m': { leadMs: MINUTE_MS, minTokens: 200_000 },
} as const
// The last main-thread reply sits within this tail; $.fs.read refuses files over 4 MiB and transcripts grow past that.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024
const TAIL_TIMEOUT_MS = 5_000
// Sits in the prompt: any change to it spends the prompt cache.
const ASK_GUIDANCE =
  'Ask only what blocks you. Prefer one question per dialog, at most two. Give 2–3 distinct options, each with a one-line consequence, and mark one "(Recommended)" with its reason. Say which default you will assume for anything you do not ask. For an open-ended question, ask in plain prose instead of options.'

type CacheTtl = keyof typeof CACHE_TTL_MS
type TranscriptLine = {
  type?: string
  isSidechain?: boolean
  message?: { usage?: { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } } }
}

const idle = atom({ plugin: 'harness', key: 'idle' } as const, { lastReplyAt: null, lastStepAt: null, ttl: null } as HarnessIdle)

// Module timers die with the module on reload; session.start fires again then and re-arms it from $.state.
let idleTimer: Timer | null = null

// Lives here, not in i18n.ts: validate only follows $ into functions declared in the same file.
async function resolveLang($: EngineInterface, option: unknown): Promise<Lang> {
  const settings = await $.settings.read()
  return pickLang(option, settings.language, (await $.env.get('LC_ALL')) || (await $.env.get('LANG')))
}

function logFailure($: EngineInterface, event: string, error: HookFailure): void {
  $.ui.log(`harness: ${event} hook failed (${error.kind}): ${error.message ?? 'no message'}`, { to: 'debug' })
}

/** The rule for the stored TTL; state saved before the field existed lacks it, and unknown means 1h. */
async function compactRule($: EngineInterface): Promise<{ ttlMs: number; leadMs: number; minTokens: number }> {
  const ttl = (await read($, idle)).ttl ?? '1h'
  return { ttlMs: CACHE_TTL_MS[ttl], ...COMPACT_RULE[ttl] }
}

/** The cache TTL of the last main-thread reply that wrote the cache, or null when the tail holds none. */
function transcriptTtl(tail: string): CacheTtl | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let line: TranscriptLine | null
    try {
      line = JSON.parse(lines[i] ?? '') as TranscriptLine | null
    } catch {
      // The first line of a `tail -c` read is usually cut, the last may still be being written.
      continue
    }
    if (line?.type !== 'assistant' || line.isSidechain === true) continue
    const written = line.message?.usage?.cache_creation
    if ((written?.ephemeral_1h_input_tokens ?? 0) > 0) return '1h'
    if ((written?.ephemeral_5m_input_tokens ?? 0) > 0) return '5m'
  }
  return null
}

/** Compacts a context of at least the TTL's minTokens; a compaction refused mid-turn is not retried. */
async function compactIdle($: EngineInterface, language: unknown): Promise<void> {
  idleTimer = null
  if (((await $.session.usage()).context.tokens ?? 0) < (await compactRule($)).minTokens) return
  const done = await $.session.compact().catch(() => undefined)
  if (done === undefined || done.skip !== undefined) return
  await update($, idle, was => ({ ...was, lastReplyAt: null }))
  $.ui.toast(strings[await resolveLang($, language)].idleCompacted)
}

/** Sets the one timer for the TTL's leadMs before the cache expires. */
async function armIdle($: EngineInterface, language: unknown): Promise<void> {
  idleTimer?.cancel()
  idleTimer = null
  const { lastReplyAt } = await read($, idle)
  if (lastReplyAt === null) return
  const { ttlMs, leadMs } = await compactRule($)
  const left = Math.max(0, lastReplyAt + ttlMs - leadMs - (await $.clock.now()))
  idleTimer = $.clock.after(left, () => void compactIdle($, language))
}

export const register: Register = (on, options) => {
  const blocked = String(options.blockedSubagentModels).split(',').map(name => name.trim()).filter(name => name !== '')
  on('agent.spawn', ($, e, next) => {
    const model = e.model?.toLowerCase()
    const hit = model === undefined ? undefined : blocked.find(name => model.includes(name.toLowerCase()))
    return hit !== undefined
      ? { deny: `harness: subagents never use ${hit}. Use opus, or omit model and let the agent definition decide.` }
      : next(e)
  }).catch(($, e, next) => {
    // It cannot tell whether the model was blocked, so it fails closed: undefined would leave the hook absent and let the spawn through.
    logFailure($, 'agent.spawn', next.error)
    return { deny: 'harness: the subagent model check failed, so the spawn is refused. Retry, or omit model and let the agent definition decide.' }
  })

  // Stats per offer instead of caching at session.start: the root moves with /cd and worktree moves.
  on('agent.offer', { agent: 'general-purpose' }, async ($, e, next) => {
    const root = await $.session.root().catch(() => undefined)
    const home = await $.env.get('HOME')
    const dirs = [root, home].filter(dir => dir !== undefined).map(dir => `${dir}/.claude/agents`)
    for (const dir of dirs) {
      for (const name of AGENT_DEFS) {
        const st = await $.fs.stat(`${dir}/${name}`).catch(() => undefined)
        if (st?.kind === 'file') return { isOffered: false }
      }
    }
    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'agent.offer', next.error)
    return next(e)
  })

  on('tool.describe', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const beneath = await next(e)
    return { ...beneath, description: `${beneath.description}\n\n${ASK_GUIDANCE}` }
  }).catch(($, e, next) => {
    logFailure($, 'tool.describe', next.error)
    return next(e)
  })

  if (!options.idleCompact) return

  on('session.start', async ($, e, next) => {
    await armIdle($, options.language)
    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'session.start', next.error)
    return next(e)
  })

  // A request that reads the cache refreshes it, so the cache expires counting from when the last main request was sent.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const lastStepAt = await $.clock.now()
      await update($, idle, was => ({ ...was, lastStepAt }))
    }
    return yield* next(e)
  }).catch(async function* ($, e, next) {
    logFailure($, 'turn.step', next.error)
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, idle, was => ({ ...was, lastReplyAt: was.lastStepAt ?? now }))
      await armIdle($, options.language)
    }
    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'turn.complete', next.error)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    idleTimer?.cancel()
    idleTimer = null
    await update($, idle, was => ({ ...was, lastReplyAt: null, lastStepAt: null }))
    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'prompt.submit', next.error)
    return next(e)
  })

  // A /clear, resume or exit ends the conversation the timer was armed for; session.start does not fire for the next one.
  on('session.end', async ($, e, next) => {
    idleTimer?.cancel()
    idleTimer = null
    await update($, idle, was => ({ ...was, lastReplyAt: null, lastStepAt: null }))
    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'session.end', next.error)
    return next(e)
  })

  // A compaction keeps the conversation (compactIdle already leaves no timer); startup is left to session.start.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.agent_id !== undefined || e.source === 'compact' || e.source === 'startup') return next(e)
    idleTimer?.cancel()
    idleTimer = null
    await update($, idle, was => ({ ...was, lastReplyAt: null, lastStepAt: null }))
    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'classic.SessionStart', next.error)
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    if (e.agent_id !== undefined) return next(e)
    await update($, idle, was => ({ ...was, ttl: e.cache_ttl }))
    await armIdle($, options.language)
    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'classic.PostModelSwitch', next.error)
    return next(e)
  })

  // The transcript tells the TTL the main thread really gets (5m on an API key or past the plan limit) without a model switch.
  on('classic.Stop', async ($, e, next) => {
    if (e.agent_id !== undefined) return next(e)
    if (e.transcript_path !== '') {
      const tail = await $.process.run(['tail', '-c', String(TRANSCRIPT_TAIL_BYTES), e.transcript_path], { timeoutMs: TAIL_TIMEOUT_MS })
      const ttl = tail.exitCode === 0 ? transcriptTtl(tail.stdout) : null
      if (ttl !== null) {
        await update($, idle, was => ({ ...was, ttl }))
        await armIdle($, options.language)
      }
    }
    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'classic.Stop', next.error)
    return next(e)
  })
}
