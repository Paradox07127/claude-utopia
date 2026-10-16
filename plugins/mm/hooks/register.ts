import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookFailure, PromptSubmitResult, Register, Timer } from 'claude-code'

import type { MmWatch } from '../types'
import { cutOutputs, doneMessage, isFlagForm, splitArgs } from './args'
import type { ModelResult } from './args'
import { register as registerGuard } from './guard'

const POLL_MS = 5000
const RUN_LINE = /^RUN (\S+)/m
const RUN_MODE = /\bmode=(\S+)/
const REPORT = /\bmmrun\s+report\b/
const READ_LATEST = /\bmmrun\s+(result|report)\b/
const OUT_OPTION = /\s(-o|--out)\b/
const RID_SHAPED = /\d{8}-\d{6}-[0-9a-f]+/
const SEGMENT_END = /&&|\|\||[;|\n]/
const FOLLOW_UP = /^(NEXT|THEN) /
const MMRUN_START = /\bmmrun\s+(review|run|start|ask)\b/
const EXHAUSTIVE_TAG = /^tag=.*:(full|exhaustive)$/m
const GROUP_LINE = /^group=(.*)$/m
const CONTEXT_MAX = 32_000
const MESSAGE_MAX = 16_000
const RESULT_TRIES = 3
// Finished runs took at most 2972 s (codex), p95 1904 s.
const REMIND_MS = 60 * 60_000

/** `parts`: the watches of a split review's runs, when this one stands for all of them. */
type Waiting = MmWatch & { message: string; parts?: Waiting[] }

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
// Reminders waiting for the next prompt; kept out of `watches` so taking one claims no run and touches no mark.
const reminders: string[] = []

function logFailure($: EngineInterface, event: string, error: HookFailure): void {
  $.ui.log(`mm: ${event} hook failed (${error.kind}): ${error.message ?? 'no message'}`, { to: 'debug' })
}

/** Runs work no hook awaits (a timer tick, a submit in flight), logging its failure. */
function detach($: EngineInterface, what: string, work: () => Promise<unknown>): void {
  void work().catch((error: unknown) => $.ui.log(`mm: ${what} failed: ${String(error)}`, { to: 'debug' }))
}

/** Whether the run's message can go: a part of a split review waits until every watched part has its message. */
function isReady(one: MmWatch, list: MmWatch[]): one is Waiting {
  return (
    one.message !== undefined &&
    (one.group ?? []).every(rid => {
      const part = list.find(other => other.rid === rid)

      return part === undefined || part.message !== undefined
    })
  )
}

/** Claims the messages of ended runs: removed from `watches` in one write, so each is handed to one taker. The parts of a split review become one. */
async function takeMessages($: EngineInterface): Promise<Waiting[]> {
  if (!(await read($, watches)).some(one => one.message !== undefined)) {
    return []
  }

  let taken: Waiting[] = []

  await update($, watches, list => {
    taken = list.filter(one => isReady(one, list))

    return list.filter(one => !taken.includes(one as Waiting))
  })

  // Emptied before the hand-over, so a reload or exit in between cannot leave a delivered run marked.
  for (const watch of taken) {
    await mark($, watch.rid, false)
  }

  const merged: Waiting[] = []

  for (const one of taken) {
    const group = one.group ?? []

    if (group.length > 1 && one.rid === group.find(rid => taken.some(other => other.rid === rid))) {
      const parts = group.map(rid => taken.find(other => other.rid === rid)).filter(part => part !== undefined)
      const missing = group.filter(rid => !parts.some(part => part.rid === rid))
      const head =
        missing.length === 0
          ? `mm plugin: /mm:review was split by files into ${group.length} parts (${group.join(', ')}); every part has ended, each result follows.`
          : `mm plugin: /mm:review was split by files into ${group.length} parts (${group.join(', ')}); the results of ${parts.map(part => part.rid).join(', ')} follow. Not watched by this session: ${missing.join(', ')} (\`mmrun result <model> ${missing[0]}\` reads it).`

      merged.push({ ...one, message: [head, ...parts.map(part => part.message)].join('\n\n'), parts })
    }
  }

  // A run another's group holds goes out inside that group's message, even when its own run.meta named no group.
  return [...merged, ...taken.filter(one => (one.group ?? []).length < 2 && !merged.some(group => group.parts?.includes(one)))]
}

/** Puts claimed messages back for the next poll or prompt, replacing a watch of the same run; not across a /clear since `at`. */
async function putBack($: EngineInterface, taken: Waiting[], at: number): Promise<void> {
  if (taken.length > 0 && at === clears) {
    const back = taken.flatMap(one => one.parts ?? [one])

    await update($, watches, list => [...list.filter(one => !back.some(other => other.rid === one.rid)), ...back])

    for (const watch of back) {
      await mark($, watch.rid, true)
    }
  }
}

/** Puts taken reminders back for the next poll or prompt; not across a /clear since `at`. */
function putBackReminders(taken: string[], at: number): void {
  if (at === clears) {
    reminders.push(...taken)
  }
}

/** Submits the text as a prompt of its own, without waiting for its turn; `back` runs when it is not accepted. */
function submitAlone($: EngineInterface, what: string, text: string, back: (at: number) => Promise<void>): void {
  detach($, what, async () => {
    const at = clears
    let r: PromptSubmitResult

    try {
      r = await $.prompt.submit({ text })
    } catch (error) {
      await back(at)
      throw error
    }

    if (r.drop !== undefined) {
      await back(at)
    }
  })
}

/** Submits each waiting message as a prompt of its own; one not accepted goes back. Reminders wait for a prompt: alone they would wake an idle session. */
async function flush($: EngineInterface): Promise<void> {
  for (const watch of await takeMessages($)) {
    submitAlone($, 'submitting a finished run', watch.message, at => putBack($, [watch], at))
  }
}

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}

/** The text of a `watched` mark: the session id after the word limits guard.ts's denial to this session. */
async function watchedText($: EngineInterface): Promise<string> {
  try {
    return `watched ${await $.session.id()}\n`
  } catch {
    return 'watched\n'
  }
}

/** Writes the run's `watched` mark, by which guard.ts denies a main-thread `mmrun wait` on it; empty means not watched. */
async function mark($: EngineInterface, rid: string, isWatched: boolean): Promise<void> {
  try {
    await $.fs.write(`${await home($)}/.claude/mmruns/${rid}/watched`, isWatched ? await watchedText($) : '')
  } catch (error) {
    $.ui.log(`mm: marking ${rid} failed: ${String(error)}`, { to: 'debug' })
  }
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
        .run([mmrun, 'result', model, watch.rid, ...(watch.kind === 'run' ? [] : ['--top'])])
        .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))

      isFailed ||= r.exitCode !== 0
      output =
        r.exitCode === 0
          ? r.stdout.trim()
          : `mm plugin: could not read the result of ${model} in ${watch.rid} after ${RESULT_TRIES} tries (${r.stderr.split('\n')[0] ?? ''}); \`mmrun result ${model} ${watch.rid}\` prints it.`
    }

    // mmrun writes one line saying why a model ended without a result; older runs have none.
    const reason = status === 'DONE' ? '' : ((await readText($, `${await home($)}/.claude/mmruns/${watch.rid}/${model}.reason`))?.trim().split('\n')[0] ?? '')
    // mmrun collects a run model's patch whatever its exit code.
    const patchPath = `${await home($)}/.claude/mmruns/${watch.rid}/${model}.patch`
    const patch = watch.kind === 'run' && status !== 'DONE' && ((await readText($, patchPath))?.trim() ?? '') !== '' ? patchPath : ''

    results.push({ model, status, output, ...(reason !== '' && { reason }), ...(patch !== '' && { patch }) })
  }

  const failures = isFailed ? (resultFailures.get(watch.rid) ?? 0) + 1 : 0

  if (failures > 0 && failures < RESULT_TRIES) {
    resultFailures.set(watch.rid, failures)

    return null
  }

  resultFailures.delete(watch.rid)

  return results
}

/** Whether run.meta tags the run as an exhaustive review. */
async function isExhaustiveRun($: EngineInterface, rid: string): Promise<boolean> {
  return EXHAUSTIVE_TAG.test((await readText($, `${await home($)}/.claude/mmruns/${rid}/run.meta`)) ?? '')
}

/** The runs of the split review run.meta names the run a part of; empty for an unsplit run. */
async function groupOf($: EngineInterface, rid: string): Promise<string[]> {
  const group = (GROUP_LINE.exec((await readText($, `${await home($)}/.claude/mmruns/${rid}/run.meta`)) ?? '')?.[1] ?? '').split(',').filter(one => one !== '')

  return group.length > 1 ? group : []
}

/** The results with a message within `max`: a review's read again `--top --oneline` first, then each output cut to an equal share. */
async function boundResults($: EngineInterface, mmrun: string, watch: MmWatch, results: ModelResult[], isExhaustive: boolean, max: number): Promise<ModelResult[]> {
  const fits = (list: ModelResult[]) => doneMessage(watch.kind, watch.rid, list, watch.seen, isExhaustive).length <= max

  if (fits(results)) {
    return results
  }

  let bounded = results

  if (watch.kind === 'review') {
    bounded = []

    for (const one of results) {
      const r = one.status === 'DONE' ? await $.process.run([mmrun, 'result', one.model, watch.rid, '--top', '--oneline']).catch(() => null) : null

      bounded.push(r?.exitCode === 0 ? { ...one, output: r.stdout.trim() } : one)
    }

    if (fits(bounded)) {
      return bounded
    }
  }

  return cutOutputs(watch.kind, watch.rid, bounded, watch.seen ?? [], isExhaustive, max)
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

      if (at === clears) {
        for (const one of adding) {
          await mark($, one.rid, true)
        }
      }
    }

    for (const watch of (await read($, watches)).filter(one => one.message === undefined)) {
      // A dead worker leaves RUNNING behind until `mmrun status` rewrites it to STALE.
      await $.process.run([mmrun, 'status', watch.rid])

      const models = await statusesOf($, `${await home($)}/.claude/mmruns/${watch.rid}`)
      const running = Array.isArray(models) ? models.filter(one => one.status === 'RUNNING').map(one => one.model) : []

      if (running.length > 0 && watch.reminded !== true && (await $.clock.now()) - watch.startedAt >= REMIND_MS) {
        await update($, watches, list => list.map(one => (one.rid === watch.rid ? { ...one, reminded: true } : one)))
        reminders.push(
          `mm plugin: run ${watch.rid} has run for 60 minutes; still running: ${running.join(',')}. mmrun ends a model on its own at 90 minutes. To stop it now: mmrun cancel ${watch.rid}.`,
        )
      }

      if (models === null || (models !== 'gone' && (models.length === 0 || models.some(one => one.status === 'RUNNING')))) {
        continue
      }

      const ended = models === 'gone' ? null : await resultsOf($, mmrun, watch, models)

      if (models !== 'gone' && ended === null) {
        continue
      }

      const isExhaustive = ended !== null && watch.kind === 'review' && (await isExhaustiveRun($, watch.rid))
      const group = ended !== null && watch.kind === 'review' ? await groupOf($, watch.rid) : []
      // The parts of a split review go out as one message: each gets its share, less room for the joined message's header.
      const max = group.length > 1 ? Math.floor(MESSAGE_MAX / group.length) - 300 : MESSAGE_MAX
      const results = ended === null ? null : await boundResults($, mmrun, watch, ended, isExhaustive, max)

      await update($, watches, list =>
        results === null
          ? list.filter(one => one.rid !== watch.rid)
          : list.map(one =>
              one.rid === watch.rid
                ? { ...one, results, message: doneMessage(one.kind, one.rid, results, one.seen, isExhaustive), ...(group.length > 0 && { group }) }
                : one,
            ),
      )
    }

    if (!isBusy) {
      await flush($)
    }
  } finally {
    isPolling = false
  }
}

/** Records the models of watched runs whose ended result the segments (of a Bash command, or a Read path) read, and rebuilds a waiting message without them. */
async function noteRead($: EngineInterface, segments: string[]): Promise<void> {
  const list = await read($, watches)
  const first = list[0]
  // `mmrun result`/`report` without a rid reads mmrun's latest run of the session, which may be a delivered run no longer in `watches`.
  const session =
    first !== undefined && segments.some(segment => READ_LATEST.test(segment) && !RID_SHAPED.test(segment))
      ? (/^session=(.+)$/m.exec((await readText($, `${await home($)}/.claude/mmruns/${first.rid}/run.meta`)) ?? '')?.[1] ?? '')
      : ''
  const latest = session === '' ? '' : ((await readText($, `${await home($)}/.claude/mmruns/.latest-${session}`))?.trim() ?? '')

  for (const watch of list) {
    const own = segments.filter(segment => segment.includes(watch.rid) || (watch.rid === latest && READ_LATEST.test(segment) && !RID_SHAPED.test(segment)))

    if (own.length === 0) {
      continue
    }

    const models = await statusesOf($, `${await home($)}/.claude/mmruns/${watch.rid}`)

    if (!Array.isArray(models)) {
      continue
    }

    // A read while the model runs sees partial output; `report -o` prints only the file it wrote.
    const seen = models
      .filter(
        ({ model, status }) =>
          status !== 'RUNNING' &&
          own.some(
            segment =>
              new RegExp(`\\bmmrun\\s+result\\s+${model}\\b`).test(segment) ||
              (REPORT.test(segment) && !OUT_OPTION.test(segment)) ||
              segment.includes(`${model}.json`) ||
              segment.includes(`${model}.out`),
          ),
      )
      .map(one => one.model)

    if (seen.length === 0) {
      continue
    }

    const isExhaustive = watch.kind === 'review' && (await isExhaustiveRun($, watch.rid))

    await update($, watches, list =>
      list.map(one => {
        if (one.rid !== watch.rid) {
          return one
        }

        const all = [...new Set([...(one.seen ?? []), ...seen])]

        return {
          ...one,
          seen: all,
          ...(one.message !== undefined && one.results !== undefined && { message: doneMessage(one.kind, one.rid, one.results, all, isExhaustive) }),
        }
      }),
    )
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
  const dir = words.includes('--dir') ? [] : ['--dir', await $.session.root()]
  // mmrun writes it into <model>.events.jsonl; a Bash-started mmrun has it from the engine, this child process does not.
  const sid = await $.session.id().catch(() => null)
  const r = await $.process.run([`${$.plugin.root}/bin/mmrun`, kind, ...words, ...models, ...dir], sid === null ? undefined : { env: { CLAUDE_CODE_SESSION_ID: sid } })

  if (r.exitCode !== 0) {
    return { text: `mmrun ${kind} failed: ${r.stderr.split('\n')[0] ?? ''}` }
  }

  const text = r.stdout
    .split('\n')
    .filter(line => !FOLLOW_UP.test(line))
    .join('\n')
    .trim()
  // A large review is split into parts, one run each.
  const rids = r.stdout
    .split('\n')
    .map(line => RUN_LINE.exec(line)?.[1])
    .filter(rid => rid !== undefined)

  if (rids.length === 0) {
    return { text }
  }

  const note =
    kind === 'review'
      ? `Review ${rids.join(', ')} was started by /mm:review. When ${rids.length > 1 ? 'each run' : 'it'} finishes, the mm plugin sends each model's critical/major findings; do not run \`mmrun wait\` yourself.`
      : `Run ${rids.join(', ')} was started by /mm:run. When it finishes, the mm plugin sends the results; do not run \`mmrun wait\` yourself.`

  // The run is started: a failure from here on must not reach the hook's catch, whose markdown fallback starts another.
  for (const rid of rids) {
    try {
      const watch: MmWatch = { rid, kind, startedAt: await $.clock.now() }

      await update($, watches, list => [...list, watch])
      await mark($, rid, true)
    } catch (error) {
      $.ui.log(`mm: watching ${rid} failed, the next poll tries again: ${String(error)}`, { to: 'debug' })
      unwatched.push({ rid, kind })
    }
  }

  ensurePoller($)

  return { text, context: [note] }
}

/** Whether the words start mmrun from the mod: options only, and for run both --model and --task. */
function isStartable(kind: MmWatch['kind'], words: string[]): boolean {
  return isFlagForm(words) && (kind === 'review' || (words.includes('--model') && words.includes('--task')))
}

export const register: Register = (on, options) => {
  registerGuard(on, options)
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
  // Every end empties the marks: what follows (/resume, a new process) has no watches, so nothing would send the results.
  on('session.end', async ($, e, next) => {
    let ended = await read($, watches)

    if (e.reason === 'clear') {
      clears++
      unwatched.splice(0)
      reminders.splice(0)
      resultFailures.clear()

      await update($, watches, list => {
        ended = list

        return []
      })
    }

    for (const watch of ended) {
      await mark($, watch.rid, false)
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

    if (r.context === undefined) {
      // The command's markdown loads, so the model can follow it.
      const loaded = await next(e)

      return loaded.deny !== undefined
        ? loaded
        : { ...loaded, context: [...(loaded.context ?? []), `mmrun failed to start: ${r.text}; start it with Bash as /${e.skill} describes instead`] }
    }

    // The note names the run already; mmrun's output is worth adding only for what else it says (warnings, SKIP lines).
    const isRunOnly = r.text.split('\n').every(line => RUN_LINE.test(line))

    return { result: { success: true, commandName: e.skill }, context: isRunOnly ? r.context : [...r.context, `mmrun output:\n${r.text}`] }
  }).catch(($, e, next) => {
    logFailure($, 'tool.call', next.error)

    return next(e)
  })

  // Runs the model starts through Bash, so their end is handed over as /mm:review's are.
  on('classic.PostToolUse', async ($, e, next) => {
    const input = typeof e.tool_input === 'object' && e.tool_input !== null ? (e.tool_input as Record<string, unknown>) : {}
    const output = typeof e.tool_response === 'object' && e.tool_response !== null ? (e.tool_response as Record<string, unknown>) : {}
    const verb = e.agent_id === undefined && e.tool_name === 'Bash' && typeof input.command === 'string' ? MMRUN_START.exec(input.command)?.[1] : undefined
    // One command can start several runs; `mmrun ask --from` continues a run in that run's mode.
    const lines = verb !== undefined && typeof output.stdout === 'string' ? output.stdout.split('\n').filter(line => RUN_LINE.test(line)) : []

    for (const line of lines) {
      const rid = RUN_LINE.exec(line)?.[1] ?? ''
      const mode = RUN_MODE.exec(line)?.[1]
      const kind = mode === 'review' || mode === 'run' ? mode : mode === 'start' ? 'ask' : verb === 'review' || verb === 'run' ? verb : 'ask'
      const watch: MmWatch = { rid, kind, startedAt: await $.clock.now() }

      await update($, watches, list => (list.some(one => one.rid === rid) ? list : [...list, watch]))
      await mark($, rid, true)
    }

    if (lines.length > 0) {
      ensurePoller($)
    }

    const reading =
      e.agent_id !== undefined
        ? undefined
        : e.tool_name === 'Bash' && typeof input.command === 'string'
          ? input.command.split(SEGMENT_END)
          : e.tool_name === 'Read' && typeof input.file_path === 'string'
            ? [input.file_path]
            : undefined

    if (reading !== undefined) {
      await noteRead($, reading)
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
    const waiting = await takeMessages($)
    const notes = reminders.splice(0)
    const taken: Waiting[] = []

    // Whole messages in order while the text stays within CONTEXT_MAX; the rest go back for the next poll or prompt.
    for (const one of waiting) {
      if (taken.length > 0 && [...taken, one].map(watch => watch.message).concat(notes).join('\n\n').length > CONTEXT_MAX) {
        break
      }

      taken.push(one)
    }

    await putBack($, waiting.slice(taken.length), at)

    const text = [...taken.map(one => one.message), ...notes].join('\n\n')
    let r: PromptSubmitResult

    try {
      r = await next(taken.length === 0 && notes.length === 0 ? e : { ...e, context: [...(e.context ?? []), text] })
    } catch (error) {
      await putBack($, taken, at)
      putBackReminders(notes, at)
      throw error
    }

    if (r.drop !== undefined) {
      isBusy = wasBusy
      await putBack($, taken, at)
      putBackReminders(notes, at)
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
