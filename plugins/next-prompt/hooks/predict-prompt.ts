/** The fork's reply when it has no prediction worth showing. */
export const NO_PREDICTION = 'NONE'

/** A prompt the person typed, and the directory of the session it was typed in. */
export type TypedPrompt = { text: string; cwd: string }

export type PromptSamples = {
  /** This project's typed prompts, oldest first; the latest few from anywhere when the project has none. */
  recent: string[]
  /** Short messages the person sends again and again, most frequent first. */
  habits: string[]
}

const PROJECT_KEPT = 12
const FALLBACK_KEPT = 6
const HABIT_MAX_CHARS = 40
const HABIT_MIN_COUNT = 3
const HABITS_KEPT = 8

/** Picks the samples the prediction prompt shows from `history` (oldest first) for a session in `cwd`. */
export function promptSamples(history: readonly TypedPrompt[], cwd: string): PromptSamples {
  const here = history.filter(p => p.cwd === cwd).map(p => p.text)
  const recent = here.length > 0 ? here.slice(-PROJECT_KEPT) : history.slice(-FALLBACK_KEPT).map(p => p.text)
  const counts = new Map<string, number>()
  for (const { text } of history) {
    const key = text.trim().replace(/[\s.!?\u3002\uff01\uff1f]+$/u, '')
    if (key !== '' && key.length <= HABIT_MAX_CHARS) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const habits = [...counts].filter(([, n]) => n >= HABIT_MIN_COUNT).sort((a, b) => b[1] - a[1]).slice(0, HABITS_KEPT).map(([text]) => text)
  return { recent, habits }
}

const listed = (texts: readonly string[]) => (texts.length === 0 ? '(none yet)' : texts.map(text => `<message>${text}</message>`).join('\n'))

/** The question the prediction fork asks after a main-thread turn. */
export function predictionPrompt(samples: PromptSamples): string {
  return `[NEXT-MESSAGE PREDICTION. This is not a message from the user. Do not answer it, do not continue your work, do not call tools.]

Write the next message the user will send in this conversation. It goes into their prompt box as a suggestion. The goal is a message they send with Tab and Enter because it says what they were about to ask for, as fully as they would write it.

First work out where the user is taking the task:
- The overall goal: what they set out to do in this conversation, and how it has changed since.
- The progress: what is done and verified, what is still open, and what your last answer left unverified, uncertain or broken.
- Their habits in this project: the steps they take at this point (for example review, run the gates, merge, update the docs), from this conversation and from their messages below.

Then write the message:
- If your last answer ended with questions or choices, answer them in a few words, the way this user decides; they often do not take your recommendation. That is the start of the message, not the whole of it.
- The main part is the one next step that moves the task forward, with at most one follow-up after it; do not chain a list of steps. It may be something your answer did not list: an open problem, an unverified claim, the next item of the plan, or a question the user wants answered first.
- Write it as a task request someone can carry out and check: name the concrete files, components, findings and numbers from this conversation, the result they want back, and the scope (what to do now, what not yet).
- Every detail comes from this conversation. Do not add constraints or steps the user has not asked for in it.
- Do not report what the user has done or seen (installed, uploaded, restarted, configured, tested on the device, a result they got) unless the conversation already shows it. Write the request, not a report of its outcome.
- Never ask for a destructive or outward-facing action (push, deploy, publish, delete, send) that the user has not already asked for.
- Their language and voice, without filler: no sentence-final particles such as \u5427, \u5462, \u554a or \u54e6, and no politeness padding. Keep only words that carry a requirement. One or two sentences, at most 50 words or 120 Chinese characters. No preamble, no quotation marks.

Messages this user wrote earlier in this project, oldest first. Use them for voice and habits; their content may be out of date:
${listed(samples.recent)}

Short messages this user sends often:
${listed(samples.habits)}

Reply with the message alone. If you cannot tell where the user is going, reply with exactly: ${NO_PREDICTION}`
}

/** Levenshtein distance over UTF-16 code units. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution))
    }
    previous = current
  }
  return previous[b.length] ?? 0
}
