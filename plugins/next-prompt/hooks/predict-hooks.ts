import type { EngineInterface, HookFailure, Register } from 'claude-code'
import { pickLang } from './i18n'
import type { Lang } from './i18n'
import { strings } from './predict-i18n'
import { NO_PREDICTION, editDistance, predictionPrompt, promptSamples } from './predict-prompt'
import type { TypedPrompt } from './predict-prompt'

const TYPED_PROMPTS_KEY = 'typedPrompts'
// Enough history for habits to repeat; 300 entries of 300 characters stay far under the store's 4 MiB.
const TYPED_PROMPTS_KEPT = 300
const TYPED_PROMPT_CHARS = 300
// Prompts the person typed: at a terminal, through Remote Control, or in the desktop app (an SDK host).
const TYPED_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])
// A reply this long ignored the prompt's length rule, so it is not a message the person would send.
const PREDICTION_MAX_CHARS = 600
const PREDICTION_LOG_KEY = 'predictionLog'
const PREDICTION_LOG_KEPT = 500
const PREDICTION_LOG_CHARS = 300
// An outcome whose edit distance is at most this share of the suggestion's length counts as near-taken.
const NEAR_TAKEN_SHARE = 0.3
const PREDICTION_ABSTAINED_KEY = 'predictionAbstained'
const STATS_COMMAND = 'prediction-stats'

/**
 * One shown suggestion and the typed prompt after it: `at` epoch ms, `forkMs` the fork's time,
 * `chars` the suggestion's length, `inputTokens` the fork's whole input (uncached, cache read and cache write), `cachedTokens` the part
 * read from cache. `editDistance` is between the suggestion and the typed prompt cut to its length; `retainedChars` the suggestion's
 * length less that distance.
 */
type PredictionOutcome = {
  at: number
  forkMs: number
  chars: number
  isAccepted: boolean
  inputTokens: number
  cachedTokens: number
  suggestion: string
  actual: string
  editDistance: number
  retainedChars: number
}

// The suggestion in the prompt box now; any submitted prompt ends it, and a reload drops it unlogged.
let shownPrediction: { text: string; forkMs: number; inputTokens: number; cachedTokens: number } | null = null

// Lives here, not in i18n.ts: validate only follows $ into functions declared in the same file.
async function resolveLang($: EngineInterface, option: unknown): Promise<Lang> {
  const settings = await $.settings.read()
  return pickLang(option, settings.language, (await $.env.get('LC_ALL')) || (await $.env.get('LANG')))
}

function logFailure($: EngineInterface, event: string, error: HookFailure): void {
  $.ui.log(`next-prompt: ${event} hook failed (${error.kind}): ${error.message ?? 'no message'}`, { to: 'debug' })
}

async function typedPrompts($: EngineInterface): Promise<TypedPrompt[]> {
  const stored = await $.store.get(TYPED_PROMPTS_KEY)
  return Array.isArray(stored)
    ? stored.filter((p): p is TypedPrompt => typeof p?.text === 'string' && typeof p?.cwd === 'string')
    : []
}

/**
 * Asks a fork of the main thread for the person's next message and proposes it as the prompt box's suggestion;
 * a reply that is NONE, empty or too long counts an abstention.
 */
async function suggestNext($: EngineInterface): Promise<void> {
  // A plain -p run has no prompt box to show it in, so the fork would be paid for nothing.
  if ((await $.session.surfaces()).length === 0) return
  const samples = promptSamples(await typedPrompts($), await $.session.cwd())
  const started = await $.clock.now()
  const reply = await $.model.fork({ prompt: predictionPrompt(samples) })
  const forkMs = (await $.clock.now()) - started
  if (!reply.isAnswered) return
  const text = reply.text.trim().replace(/^["“「]+|["”」]+$/g, '').trim()
  if (text === '' || text === NO_PREDICTION || text.length > PREDICTION_MAX_CHARS) {
    const abstained = await $.store.get(PREDICTION_ABSTAINED_KEY)
    await $.store.set(PREDICTION_ABSTAINED_KEY, (typeof abstained === 'number' ? abstained : 0) + 1)
    return
  }
  const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens } = reply.usage
  const inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
  if ((await $.prompt.suggest({ text })).isShown) shownPrediction = { text, forkMs, inputTokens, cachedTokens: cache_read_input_tokens }
}

async function predictionLog($: EngineInterface): Promise<PredictionOutcome[]> {
  const stored = await $.store.get(PREDICTION_LOG_KEY)
  return Array.isArray(stored) ? (stored as PredictionOutcome[]) : []
}

async function predictionStats($: EngineInterface, language: unknown): Promise<string> {
  const t = strings[await resolveLang($, language)]
  const log = await predictionLog($)
  if (log.length === 0) return t.predictionStatsEmpty
  const ms = log.map(o => o.forkMs).sort((a, b) => a - b)
  const median = ms.length % 2 === 1 ? (ms[(ms.length - 1) / 2] ?? 0) : ((ms[ms.length / 2 - 1] ?? 0) + (ms[ms.length / 2] ?? 0)) / 2
  const taken = log.filter(o => o.isAccepted).length
  // Entries logged before token counts were recorded lack them.
  const counted = log.filter(o => typeof o.inputTokens === 'number' && typeof o.cachedTokens === 'number')
  const input = counted.reduce((sum, o) => sum + o.inputTokens, 0)
  const cached = counted.reduce((sum, o) => sum + o.cachedTokens, 0)
  const cachePercent = input === 0 ? null : Math.round((100 * cached) / input)
  // Entries logged before edit distances were recorded lack them, and their turns counted no abstentions.
  const edited = log.filter(o => typeof o.editDistance === 'number' && typeof o.retainedChars === 'number')
  const near = edited.filter(o => o.editDistance <= NEAR_TAKEN_SHARE * o.chars).length
  const edits = edited.length === 0 ? null : {
    near,
    counted: edited.length,
    nearPercent: Math.round((100 * near) / edited.length),
    meanRetained: (edited.reduce((sum, o) => sum + o.retainedChars, 0) / edited.length).toFixed(1),
  }
  const stored = await $.store.get(PREDICTION_ABSTAINED_KEY)
  const abstained = typeof stored === 'number' ? stored : 0
  const decisions = abstained + edited.length
  const abstainPercent = decisions === 0 ? null : Math.round((100 * abstained) / decisions)
  return t.predictionStats(taken, log.length, Math.round((100 * taken) / log.length), (median / 1000).toFixed(1), cachePercent, edits, abstained, abstainPercent)
}

export const register: Register = (on, options) => {
  // A matcher on every hook: in the source tree register.tsx holds the matcher-less one on each of these events, and the engine refuses a second.
  // The fork answers only after the turn has ended, so it runs on a timer: a dispatch's own work stops with it.
  on('turn.complete', { turnId: /^/ }, async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') {
      $.clock.after(0, () => void suggestNext($).catch(error => $.ui.log(`next-prompt: prediction failed: ${String(error)}`, { to: 'debug' })))
    }
    return done
  }).catch(($, e, next) => {
    logFailure($, 'turn.complete', next.error)
    return next(e)
  })

  // The plugin's prediction replaces the engine's own; a desktop session never runs this hook (anthropics/claude-code#99876).
  on('prompt.suggest', { origin: { kind: 'suggestion' } }, () => ({ isShown: false }))

  on('prompt.submit', { wait: [true, false] }, async ($, e, next) => {
    const entered = await next(e)
    const shown = shownPrediction
    shownPrediction = null
    // A -p run is an SDK host too, so only a session something draws on holds typed prompts.
    if (!('drop' in entered) && TYPED_ORIGINS.has(e.origin.kind) && (await $.session.surfaces()).length > 0) {
      if (shown !== null) {
        const { text, ...measured } = shown
        const distance = editDistance(text, e.text.slice(0, text.length))
        const outcome: PredictionOutcome = {
          at: await $.clock.now(),
          ...measured,
          chars: text.length,
          isAccepted: e.text.startsWith(text),
          suggestion: text.slice(0, PREDICTION_LOG_CHARS),
          actual: e.text.slice(0, PREDICTION_LOG_CHARS),
          editDistance: distance,
          retainedChars: Math.max(0, text.length - distance),
        }
        await $.store.set(PREDICTION_LOG_KEY, [...(await predictionLog($)), outcome].slice(-PREDICTION_LOG_KEPT))
      }
      if (!e.text.startsWith('/')) {
        const typed = [...(await typedPrompts($)), { text: e.text.slice(0, TYPED_PROMPT_CHARS), cwd: await $.session.cwd() }]
        await $.store.set(TYPED_PROMPTS_KEY, typed.slice(-TYPED_PROMPTS_KEPT))
      }
    }
    return entered
  }).catch(($, e, next) => {
    logFailure($, 'prompt.submit', next.error)
    return next(e)
  })

  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    await $.command.register({ name: STATS_COMMAND, description: 'Show how often next-prompt predictions were taken and the median fork time' })
    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'session.start', next.error)
    return next(e)
  })

  on('command.run', { command: STATS_COMMAND }, async $ => ({ text: await predictionStats($, options.language) }))
}
