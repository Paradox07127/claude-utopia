import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookFailure, PromptSubmitResult, Register, Timer } from 'claude-code'

import type { MmWatch } from '../types'
import { doneMessage, isFlagForm, splitArgs } from './args'
import type { ModelResult } from './args'

const POLL_MS = 5000
const RUN_LINE = /^RUN (\S+)/m
const FOLLOW_UP = /^(NEXT|THEN) /
const MMRUN_START = /\bmmrun\s+(review|run)\b/
const CONTEXT_MAX = 32_000
const CUT_NOTE = `\n\n[mm plugin: cut to ${CONTEXT_MAX} characters; \`mmrun result <model> <rid>\` prints the whole result]`
const RESULT_TRIES = 3

type Waiting = MmWatch & { message: string }

const watches = atom({ plugin: 'mm', key: 'watches' } as const, [] as MmWatch[])

// Module timers die with the module on reload; session.start fires again then and restarts it.
let poller: Timer | null = null
let isPolling = false
// From a prompt entering until the main thread stops with no background task left to wake it.
let isBusy = false
// Runs started whose watch could not be written yet; the next poll writes them.
const unwatched: Pick<MmWatch, 'rid' | 'kind'>[] = []
// Ticks in a row `mmrun result` failed, by run.
const resultFailures = new Map<string, number>()
// Bumped by each /clear: work that started before one must not watch or deliver its runs.
let clears = 0

function logFailure($: EngineInterface, event: string, error: HookFailure): void {
  $.ui.log(`mm: ${event} hook failed (${error.kind}): ${error.message ?? 'no message'}`, { to: 'debug' })
}

/** Runs work no hook awaits (a timer tick, a submit in flight), logging its failure. */
function detach($: EngineInterface, what: string, work: () => Promise<unknown>): void {
  void work().catch((error: unknown) => $.ui.log(`mm: ${what} failed: ${String(error)}`, { to: 'debug' }))
}

/** Claims the messages of ended runs: removed from `watches` in one write, so each is handed to one taker. */
async function takeMessages($: EngineInterface): Promise<Waiting[]> {
  if (!(await read($, watches)).some(one => one.message !== undefined)) {
    return []
  }

  let taken: Waiting[] = []

  await update($, watches, list => {
    taken = list.filter((one): one is Waiting => one.message !== undefined)

    return list.filter(one => one.message === undefined)
  })

  return taken
}

/** Puts claimed messages back for the next poll or prompt, replacing a watch of the same run; not across a /clear since `at`. */
async function putBack($: EngineInterface, taken: Waiting[], at: number): Promise<void> {
  if (taken.length > 0 && at === clears) {
    await update($, watches, list => [...list.filter(one => !taken.some(back => back.rid === one.rid)), ...taken])
  }
}

/** Submits each waiting message as a prompt of its own, without waiting for its turn; one not accepted goes back. */
async function flush($: EngineInterface): Promise<void> {
  for (const watch of await takeMessages($)) {
    detach($, 'submitting a finished run', async () => {
      const at = clears
      let r: PromptSubmitResult

      try {
        r = await $.prompt.submit({ text: watch.message })
      } catch (error) {
        await putBack($, [watch], at)
        throw error
      }

      if (r.drop !== undefined) {
        await putBack($, [watch], at)
      }
    })
  }
}

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return String(await $.fs.read(path))
  } catch {
    return null
  }
}

/** Each model's status file in the run directory; 'gone' when the directory is, null when a listing or read failed. */
async function statusesOf($: EngineInterface, dir: string): Promise<{ model: string; status: string }[] | 'gone' | null> {
  let models: string[]

  try {
    models = (await $.fs.list(dir)).filter(entry => entry.name.endsWith('.status')).map(entry => entry.name.slice(0, -'.status'.length))
  } catch {
    return (await $.fs.exists(dir).catch(() => true)) ? null : 'gone'
  }

  const found: { model: string; status: string }[] = []

  for (const model of models.sort()) {
    const status = await readText($, `${dir}/${model}.status`)

    if (status === null) {
      return null
    }

    found.push({ model, status: status.trim() })
  }

  return found
}

/** Each model's result; null while a failed `mmrun result` is still to be tried again, a failure note after RESULT_TRIES ticks. */
async function resultsOf($: EngineInterface, mmrun: string, watch: MmWatch, models: { model: string; status: string }[]): Promise<ModelResult[] | null> {
  const results: ModelResult[] = []
  let isFailed = false

  for (const { model, status } of models) {
    let output = ''

    if (status === 'DONE') {
      const r = await $.process
        .run([mmrun, 'result', model, watch.rid, ...(watch.kind === 'review' ? ['--top'] : [])])
        .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))

      isFailed ||= r.exitCode !== 0
      output =
        r.exitCode === 0
          ? r.stdout.trim()
          : `mm plugin: could not read the result of ${model} in ${watch.rid} after ${RESULT_TRIES} tries (${r.stderr.split('\n')[0] ?? ''}); \`mmrun result ${model} ${watch.rid}\` prints it.`
    }

    results.push({ model, status, output })
  }

  const failures = isFailed ? (resultFailures.get(watch.rid) ?? 0) + 1 : 0

  if (failures > 0 && failures < RESULT_TRIES) {
    resultFailures.set(watch.rid, failures)

    return null
  }

  resultFailures.delete(watch.rid)

  return results
}

/** One pass over the watches: queues the message of each run whose models have all ended, then forgets it. */
async function pollWatches($: EngineInterface): Promise<void> {
  if (isPolling) {
    return
  }

  isPolling = true

  try {
    const mmrun = `${$.plugin.root}/bin/mmrun`

    if (unwatched.length > 0) {
      const at = clears
      const adding = unwatched.splice(0)
      const startedAt = await $.clock.now()

      try {
        await update($, watches, list =>
          at === clears ? [...list, ...adding.filter(one => !list.some(other => other.rid === one.rid)).map(one => ({ ...one, startedAt }))] : list,
        )
      } catch (error) {
        unwatched.push(...adding)
        throw error
      }
    }

    for (const watch of (await read($, watches)).filter(one => one.message === undefined)) {
      // A dead worker leaves RUNNING behind until `mmrun status` rewrites it to STALE.
      await $.process.run([mmrun, 'status', watch.rid])

      const models = await statusesOf($, `${await home($)}/.claude/mmruns/${watch.rid}`)

      if (models === null || (models !== 'gone' && (models.length === 0 || models.some(one => one.status === 'RUNNING')))) {
        continue
      }

      const results = models === 'gone' ? null : await resultsOf($, mmrun, watch, models)

      if (models !== 'gone' && results === null) {
        continue
      }

      const text = results === null ? null : doneMessage(watch.kind, watch.rid, results)

      await update($, watches, list =>
        text === null ? list.filter(one => one.rid !== watch.rid) : list.map(one => (one.rid === watch.rid ? { ...one, message: text } : one)),
      )
    }

    if (!isBusy) {
      await flush($)
    }
  } finally {
    isPolling = false
  }
}

function ensurePoller($: EngineInterface): void {
  if (poller === null) {
    poller = $.clock.every(POLL_MS, () => detach($, 'poll', () => pollWatches($)))
  }
}

/** Starts `mmrun <kind> …` in the session root and watches the run it prints; review without --models runs `reviewModels`. */
async function start($: EngineInterface, kind: MmWatch['kind'], words: string[], reviewModels: string): Promise<{ text: string; context?: string[] }> {
  const models = kind === 'review' && reviewModels !== '' && !words.includes('--models') ? ['--models', reviewModels] : []
  const r = await $.process.run([`${$.plugin.root}/bin/mmrun`, kind, ...words, ...models, '--dir', await $.session.root()])

  if (r.exitCode !== 0) {
    return { text: `mmrun ${kind} failed: ${r.stderr.split('\n')[0] ?? ''}` }
  }

  const text = r.stdout
    .split('\n')
    .filter(line => !FOLLOW_UP.test(line))
    .join('\n')
    .trim()
  const rid = RUN_LINE.exec(r.stdout)?.[1]

  if (rid === undefined) {
    return { text }
  }

  const note =
    kind === 'review'
      ? `Review ${rid} was started by /mm:review. When it finishes, the mm plugin sends each model's critical/major findings; do not run \`mmrun wait\` yourself.`
      : `Run ${rid} was started by /mm:run. When it finishes, the mm plugin sends the results; do not run \`mmrun wait\` yourself.`

  // The run is started: a failure from here on must not reach the hook's catch, whose markdown fallback starts another.
  try {
    const watch: MmWatch = { rid, kind, startedAt: await $.clock.now() }

    await update($, watches, list => [...list, watch])
  } catch (error) {
    $.ui.log(`mm: watching ${rid} failed, the next poll tries again: ${String(error)}`, { to: 'debug' })
    unwatched.push({ rid, kind })
  }

  ensurePoller($)

  return { text, context: [note] }
}

/** Whether the words start mmrun from the mod: options only, and for run both --model and --task. */
function isStartable(kind: MmWatch['kind'], words: string[]): boolean {
  return isFlagForm(words) && (kind === 'review' || (words.includes('--model') && words.includes('--task')))
}

export const register: Register = (on, options) => {
  const reviewModels = String(options.reviewModels)

  on('session.start', async ($, e, next) => {
    poller?.cancel()
    poller = null
    ensurePoller($)

    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'session.start', next.error)

    return next(e)
  })

  // /clear ends the conversation the runs would report to: forget them (they keep running, as Claude Code's background tasks do).
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      clears++
      unwatched.splice(0)
      resultFailures.clear()
      await update($, watches, () => [])
    }

    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'session.end', next.error)

    return next(e)
  })

  // Options only start mmrun here; anything with natural language goes to commands/review.md.
  on('command.run', { command: 'mm:review' }, async ($, e, next) => {
    const words = splitArgs(e.args)

    return isFlagForm(words) ? start($, 'review', words, reviewModels) : next(e)
  }).catch(($, e, next) => {
    logFailure($, 'command.run', next.error)

    return next(e)
  })

  on('command.run', { command: 'mm:run' }, async ($, e, next) => {
    const words = splitArgs(e.args)

    return isStartable('run', words) ? start($, 'run', words, reviewModels) : next(e)
  }).catch(($, e, next) => {
    logFailure($, 'command.run', next.error)

    return next(e)
  })

  // The model's own Skill call to the same commands. Never hook tool.call on Bash (claude-code#92533).
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (e.tool !== 'Skill' || e.agentId !== undefined || (e.skill !== 'mm:review' && e.skill !== 'mm:run')) {
      return next(e)
    }

    const kind = e.skill === 'mm:review' ? 'review' : 'run'
    const words = splitArgs(e.args ?? '')

    if (words.length === 0 || !isStartable(kind, words)) {
      return next(e)
    }

    const r = await start($, kind, words, reviewModels)
    const result = { success: true, commandName: e.skill }

    return r.context === undefined
      ? { result, context: [`mmrun failed to start: ${r.text}; start it with Bash as /${e.skill} describes instead`] }
      : { result, context: [...r.context, `mmrun output:\n${r.text}`] }
  }).catch(($, e, next) => {
    logFailure($, 'tool.call', next.error)

    return next(e)
  })

  // Runs the model starts through Bash, so their end is handed over as /mm:review's are.
  on('classic.PostToolUse', async ($, e, next) => {
    const input = typeof e.tool_input === 'object' && e.tool_input !== null ? (e.tool_input as Record<string, unknown>) : {}
    const output = typeof e.tool_response === 'object' && e.tool_response !== null ? (e.tool_response as Record<string, unknown>) : {}
    const kind = e.agent_id === undefined && e.tool_name === 'Bash' && typeof input.command === 'string' ? MMRUN_START.exec(input.command)?.[1] : undefined
    const rid = typeof output.stdout === 'string' ? RUN_LINE.exec(output.stdout)?.[1] : undefined

    if ((kind === 'review' || kind === 'run') && rid !== undefined) {
      const watch: MmWatch = { rid, kind, startedAt: await $.clock.now() }

      await update($, watches, list => (list.some(one => one.rid === rid) ? list : [...list, watch]))
      ensurePoller($)
    }

    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'classic.PostToolUse', next.error)

    return next(e)
  })

  // Waiting messages ride the prompt that enters first, so none is also submitted. Not prompt.context: that spends the cache.
  // A prompt that does not enter (dropped, or a hook beneath failing) puts its messages back.
  on('prompt.submit', async ($, e, next) => {
    const wasBusy = isBusy

    isBusy = true

    const at = clears
    const taken = await takeMessages($)
    const text = taken.map(one => one.message).join('\n\n')
    let r: PromptSubmitResult

    try {
      r = await next(
        taken.length === 0 ? e : { ...e, context: [...(e.context ?? []), text.length > CONTEXT_MAX ? text.slice(0, CONTEXT_MAX - CUT_NOTE.length) + CUT_NOTE : text] },
      )
    } catch (error) {
      await putBack($, taken, at)
      throw error
    }

    if (r.drop !== undefined) {
      isBusy = wasBusy
      await putBack($, taken, at)
    }

    return r
  }).catch(($, e, next) => {
    logFailure($, 'prompt.submit', next.error)

    return next(e)
  })

  // An interrupted or failed turn may end with no Stop; it leaves nothing running that would hand the messages over.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason !== 'answer') {
      isBusy = false
    }

    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'turn.complete', next.error)

    return next(e)
  })

  // Background work still in flight wakes the session again, so the messages wait for that turn. The next poll
  // submits them: the host refuses a submit from a Stop hook.
  on('classic.Stop', async ($, e, next) => {
    if (e.agent_id === undefined) {
      isBusy = (e.background_tasks ?? []).length > 0
    }

    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'classic.Stop', next.error)

    return next(e)
  })
}
