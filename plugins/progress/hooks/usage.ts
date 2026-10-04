import type { AskCounts, SkillCounts, UsageCounts, UsageDay, UsageLedger, UsageRead, UsageThread } from '../types'

export const USAGE_DAYS = 7

/**
 * Each count against an uncached input token, by the API's price ratios: a weight to compare parts, never money.
 * turn.step's usage does not split cache writes into 5m (1.25×) and 1h (2×): all take the 5-minute weight.
 */
export const WEIGHTS = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 } as const

type ApiUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** How a Skill call ended; null for a fork launched in the background, whose outcome comes later. */
export type SkillOutcome = 'inline' | 'forked' | 'error' | null

export type AskOutcome = 'recommended' | 'option' | 'typed' | 'declined'

const NO_COUNTS: UsageCounts = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const NO_SKILL: SkillCounts = { invocations: 0, inline: 0, forked: 0, errors: 0 }
const NO_ASKS: AskCounts = { dialogs: 0, questions: 0, recommended: 0, option: 0, typed: 0, declined: 0, under1m: 0, under2m: 0, under5m: 0, under10m: 0, over10m: 0 }
// Each wait bucket but the last, by the ms it stays under.
const WAIT_BUCKETS = [['under1m', 60_000], ['under2m', 120_000], ['under5m', 300_000], ['under10m', 600_000]] as const
const THREADS: UsageThread[] = ['main', 'subagent']

export const emptyDay = (): UsageDay => ({ models: {}, skills: {} })

function added<T extends Record<string, number>>(a: T, b: T): T {
  return Object.fromEntries(Object.keys(a).map(key => [key, a[key]! + b[key]!])) as T
}

export const equivalentOf = (counts: UsageCounts) =>
  counts.input * WEIGHTS.input + counts.cacheRead * WEIGHTS.cacheRead + counts.cacheWrite * WEIGHTS.cacheWrite + counts.output * WEIGHTS.output

/** One request's final usage, in the bucket of the model that answered and its kind of thread. */
export function requestNoted(day: UsageDay, model: string, thread: UsageThread, usage: ApiUsage): UsageDay {
  const was = day.models[model] ?? {}
  const one = { requests: 1, input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }

  return { ...day, models: { ...day.models, [model]: { ...was, [thread]: added(was[thread] ?? NO_COUNTS, one) } } }
}

/** A Skill call's result: inline when it resolved, forked when its fork completed, else an error. */
export function skillOutcomeOf(response: unknown): SkillOutcome {
  const one = (typeof response === 'object' && response !== null ? response : {}) as Record<string, unknown>

  if (one.status === 'forked') {
    return one.background === true ? null : one.success === true ? 'forked' : 'error'
  }

  return one.success === true ? 'inline' : 'error'
}

/** The skill a Skill call named; its arguments are never read. */
export function skillNameOf(input: unknown): string {
  const skill = (typeof input === 'object' && input !== null ? input : {}) as { skill?: unknown }

  return typeof skill.skill === 'string' && skill.skill !== '' ? skill.skill : '?'
}

export function skillNoted(day: UsageDay, name: string, outcome: SkillOutcome): UsageDay {
  const was = day.skills[name] ?? NO_SKILL
  const counts = added(was, { invocations: 1, inline: outcome === 'inline' ? 1 : 0, forked: outcome === 'forked' ? 1 : 0, errors: outcome === 'error' ? 1 : 0 })

  return { ...day, skills: { ...day.skills, [name]: counts } }
}

/**
 * Per question of an AskUserQuestion input, how the tool's result answered it: its `answers` map a question's text to the
 * label chosen, a multiSelect's labels comma-joined, or the text typed. No result, or no answer to a question, is declined.
 */
export function askOutcomes(input: unknown, response: unknown): AskOutcome[] {
  const questions = isRecord(input) && Array.isArray(input.questions) ? (input.questions as unknown[]) : []
  const answers = isRecord(response) && isRecord(response.answers) ? response.answers : {}

  return questions.map(one => {
    const question = isRecord(one) ? one : {}
    const labels = (Array.isArray(question.options) ? (question.options as unknown[]) : []).map(option => (isRecord(option) ? option.label : undefined))
    const recommended = labels.find(label => typeof label === 'string' && label.includes('(Recommended)'))
    const answer = typeof question.question === 'string' ? answers[question.question] : undefined

    if (typeof answer !== 'string' || answer === '') {
      return 'declined'
    }

    if (answer === recommended) {
      return 'recommended'
    }

    return question.multiSelect === true || labels.includes(answer) ? 'option' : 'typed'
  })
}

/** One dialog that ended: its questions by outcome, its wait in its bucket. */
export function askNoted(day: UsageDay, outcomes: readonly AskOutcome[], waitMs: number): UsageDay {
  const bucket = WAIT_BUCKETS.find(([, ms]) => waitMs < ms)?.[0] ?? 'over10m'
  const count = (outcome: AskOutcome) => outcomes.filter(one => one === outcome).length
  const one = { ...NO_ASKS, dialogs: 1, questions: outcomes.length, recommended: count('recommended'), option: count('option'), typed: count('typed'), declined: count('declined'), [bucket]: 1 }

  return { ...day, asks: added(day.asks ?? NO_ASKS, one) }
}

export function daySum(a: UsageDay, b: UsageDay): UsageDay {
  const models = { ...a.models }
  const skills = { ...a.skills }

  for (const [model, threads] of Object.entries(b.models)) {
    const was = models[model] ?? {}

    models[model] = Object.fromEntries(
      THREADS.filter(thread => was[thread] !== undefined || threads[thread] !== undefined).map(thread => [thread, added(was[thread] ?? NO_COUNTS, threads[thread] ?? NO_COUNTS)]),
    )
  }

  for (const [name, counts] of Object.entries(b.skills)) {
    skills[name] = added(skills[name] ?? NO_SKILL, counts)
  }

  const isAsked = a.asks !== undefined || b.asks !== undefined

  return { models, skills, ...(isAsked && { asks: added(a.asks ?? NO_ASKS, b.asks ?? NO_ASKS) }) }
}

const isCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const hasCounts = (value: unknown, keys: readonly string[]) => isRecord(value) && keys.every(key => isCount(value[key]))

/** A ledger file's day; null for one cut mid-write, or not of this shape. */
export function parseUsageDay(text: string): UsageDay | null {
  let raw: unknown

  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  if (!isRecord(raw) || !isRecord(raw.models) || !isRecord(raw.skills)) {
    return null
  }

  const isModels = Object.values(raw.models).every(threads => isRecord(threads) && THREADS.every(thread => threads[thread] === undefined || hasCounts(threads[thread], Object.keys(NO_COUNTS))))
  const isSkills = Object.values(raw.skills).every(counts => hasCounts(counts, Object.keys(NO_SKILL)))
  // A file written before the asks were kept has none.
  const isAsks = raw.asks === undefined || hasCounts(raw.asks, Object.keys(NO_ASKS))

  return isModels && isSkills && isAsks
    ? { models: raw.models as UsageDay['models'], skills: raw.skills as UsageDay['skills'], ...(raw.asks !== undefined && { asks: raw.asks as AskCounts }) }
    : null
}

/** Claude's own spelling of a project folder: the root with every `/` a `-`. */
export const projectKey = (root: string) => root.replace(/\//g, '-')

export const ledgerDir = (home: string, project: string, day: string) => `${home}/.claude/dashboard/usage/${project}/${day}`

const pad2 = (n: number) => String(n).padStart(2, '0')

/** The local day of `at`, `YYYY-MM-DD`. */
export function dayOf(at: number): string {
  const date = new Date(at)

  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** The `count` local days ending on `at`'s, newest first; each taken at its noon, so a daylight-saving shift keeps the day. */
export function lastDays(at: number, count = USAGE_DAYS): string[] {
  const date = new Date(at)

  return Array.from({ length: count }, (_, i) => dayOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() - i, 12).getTime()))
}

/** Per day, the other sessions' files and this session's own: its ledger where it holds the day, else its file. */
export function daysOf(read: UsageRead | null, own: UsageLedger | null): Record<string, UsageDay> {
  const isSame = read !== null && own !== null && read.session === own.session
  const days = new Set([...Object.keys(read?.others ?? {}), ...Object.keys(read?.own ?? {}), ...Object.keys(own?.days ?? {})])

  return Object.fromEntries(
    [...days].map(day => {
      const mine = own?.days[day]
      const filed = read?.own[day]
      const parts = [read?.others[day], ...(isSame ? [mine ?? filed] : [filed, mine])].filter((one): one is UsageDay => one !== undefined)

      return [day, parts.reduce(daySum, emptyDay())]
    }),
  )
}

export type UsageTotal = { counts: UsageCounts; equivalent: number }

/** What the usage page shows: each of `days` newest first, the main thread against the subagents, the skills by calls, the question dialogs. */
export type UsageWeek = {
  days: ({ day: string } & UsageTotal)[]
  threads: ({ thread: UsageThread } & UsageTotal)[]
  skills: ({ name: string } & SkillCounts)[]
  asks: AskCounts
}

const totalOf = (counts: UsageCounts): UsageTotal => ({ counts, equivalent: Math.round(equivalentOf(counts)) })

export function weekOf(byDay: Record<string, UsageDay>, days: readonly string[]): UsageWeek {
  const shown = days.map(day => byDay[day] ?? emptyDay())
  const threadSum = (day: UsageDay, thread: UsageThread) => Object.values(day.models).reduce((sum, one) => added(sum, one[thread] ?? NO_COUNTS), NO_COUNTS)
  const skills = shown.reduce((sum, day) => daySum(sum, { models: {}, skills: day.skills }), emptyDay()).skills

  return {
    days: shown.map((day, i) => ({ day: days[i]!, ...totalOf(added(threadSum(day, 'main'), threadSum(day, 'subagent'))) })),
    threads: THREADS.map(thread => ({ thread, ...totalOf(shown.reduce((sum, day) => added(sum, threadSum(day, thread)), NO_COUNTS)) })),
    skills: Object.entries(skills)
      .map(([name, counts]) => ({ name, ...counts }))
      .sort((a, b) => b.invocations - a.invocations || a.name.localeCompare(b.name)),
    asks: shown.reduce((sum, day) => added(sum, day.asks ?? NO_ASKS), NO_ASKS),
  }
}

export const isEmptyWeek = (week: UsageWeek) => week.skills.length === 0 && week.asks.dialogs === 0 && week.days.every(one => one.counts.requests === 0)
