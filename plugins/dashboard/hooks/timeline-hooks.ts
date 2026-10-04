import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookFailure, On, Timer, TurnStepResult } from 'claude-code'

import type { TimelineTurn, UsageDay, UsageLedger, UsageRead } from '../types'
import { awaitPress, recommendedLabels } from './ask-recommended'
import { attentionChime } from './chime'
import { failureLine } from './failures'
import { t } from './i18n'
import { SHAPE } from './shapes'
import { apiFailed, compacted, forked, stepNoted, stepOf, toolEnded, turnEnded, turnStarted, watchChunk } from './timeline'
import type { StepEnd, StepWatch } from './timeline'
import { askNoted, askOutcomes, dayOf, daysOf, emptyDay, ledgerDir, parseUsageDay, projectKey, requestNoted, skillNameOf, skillNoted, skillOutcomeOf } from './usage'

const timeline = atom({ plugin: 'dashboard', key: 'timeline' } as const, [] as TimelineTurn[], { shape: SHAPE })
const ledger = atom({ plugin: 'dashboard', key: 'ledger' } as const, null as UsageLedger | null, { shape: SHAPE })
const usageRead = atom({ plugin: 'dashboard', key: 'usageRead' } as const, null as UsageRead | null, { shape: SHAPE })
// A change to the ledger is written this long after it, with whatever came meanwhile.
const LEDGER_WRITE_MS = 5_000
// A question dialog unanswered this long reminds the person once.
const ASK_REMIND_MS = 180_000
const ASK_PRESSED = 'The person pressed the use-recommended button above the question dialog: each question was answered with its option marked (Recommended).'

// The ledger days changed since their files were last written, and the timer that writes them.
let unwritten = new Set<string>()
let ledgerTimer: Timer | null = null
// The open AskUserQuestion dialogs by thread, '' the main one: PermissionRequest carries no tool_use_id, and a thread waits on one dialog at a time.
const asking = new Map<string, { at: number; input: unknown; remind: Timer }>()

/** Folds `fold` into the timeline at the clock's time. The timeline only watches: its failure is never the event's. */
async function note($: EngineInterface, fold: (turns: TimelineTurn[], now: number) => TimelineTurn[]): Promise<void> {
  try {
    const now = await $.clock.now()

    await update($, timeline, turns => fold(turns, now))
  } catch {
    // Dropped: a missing timeline entry beats a broken event.
  }
}

/** The repository's main worktree root, so a linked worktree's session shares its project; else the session root. */
async function ledgerRoot($: EngineInterface): Promise<string> {
  return (await $.session.repo().catch(() => null))?.root ?? (await $.session.root())
}

async function ledgerPath($: EngineInterface, kept: UsageLedger, day: string): Promise<string> {
  return `${ledgerDir((await $.env.get('HOME')) ?? '', kept.project, day)}/${kept.session}.json`
}

/** Folds `fold` into today's entry of this session's ledger, its file written LEDGER_WRITE_MS later. The ledger only watches: its failure is never the event's. */
async function noteUsage($: EngineInterface, fold: (day: UsageDay) => UsageDay): Promise<void> {
  try {
    const session = await $.session.id()
    const day = dayOf(await $.clock.now())
    const was = await read($, ledger)

    // The session id changed in process (/clear): the previous session's counts go to its files before its ledger is replaced,
    // and into the others of the page's last read, which a render may not read again.
    if (was !== null && was.session !== session) {
      await writeLedger($, true)
      await update($, usageRead, last => (last === null || last.session === session ? last : { session, others: daysOf(last, was), own: {} }))
    }

    const kept = was?.session === session ? was : { session, project: projectKey(await ledgerRoot($)), days: {} }
    // A resumed session finds what it counted before in its own file.
    const base = kept.days[day] ?? parseUsageDay(String(await $.fs.read(await ledgerPath($, kept, day)).catch(() => ''))) ?? emptyDay()

    await update($, ledger, now => {
      const into = now?.session === session ? now : kept

      return { ...into, days: { ...into.days, [day]: fold(into.days[day] ?? base) } }
    })
    unwritten.add(day)
    ledgerTimer ??= $.clock.after(LEDGER_WRITE_MS, () => void writeLedger($, false))
  } catch {
    // Dropped: a request left out of the ledger beats a broken event.
  }
}

/** Writes the ledger's changed days, or all of them, each its whole file; a day that fails waits for the next write. */
async function writeLedger($: EngineInterface, isAll: boolean): Promise<void> {
  ledgerTimer?.cancel()
  ledgerTimer = null

  const kept = await read($, ledger).catch(() => null)
  const days = isAll && kept !== null ? Object.keys(kept.days) : [...unwritten]

  unwritten = new Set()

  for (const day of days) {
    const usage = kept?.days[day]

    if (kept !== null && usage !== undefined) {
      await $.fs.write(await ledgerPath($, kept, day), JSON.stringify({ session: kept.session, day, ...usage })).catch(() => unwritten.add(day))
    }
  }
}

/** A thread's question dialog shows: kept until its result, a reminder set for ASK_REMIND_MS. It only watches: its failure is never the event's. */
async function askShown($: EngineInterface, agentId: string | undefined, input: unknown): Promise<void> {
  const thread = agentId ?? ''

  try {
    if (asking.has(thread)) {
      return
    }

    const at = await $.clock.now()
    const remind = $.clock.after(ASK_REMIND_MS, () => {
      void $.audio.play({ base64: attentionChime(), mime: 'audio/wav' }).catch(() => undefined)
      $.ui.toast(t().askRemind)
    })

    asking.set(thread, { at, input, remind })
  } catch {
    // Dropped: a dialog left uncounted beats a broken event.
  }
}

/** A thread's open dialog ended, `response` the tool's result or undefined: its reminder cancelled, its questions and wait into the ledger. */
async function askEnded($: EngineInterface, agentId: string | undefined, response: unknown): Promise<void> {
  const open = asking.get(agentId ?? '')

  if (open === undefined) {
    return
  }

  asking.delete(agentId ?? '')
  open.remind.cancel()

  try {
    const waitMs = (await $.clock.now()) - open.at

    await noteUsage($, day => askNoted(day, askOutcomes(open.input, response), waitMs))
  } catch {
    // Dropped: a dialog left uncounted beats a broken event.
  }
}

/** A hook's `.catch`: its failure to the debug log, once per hook this load. Declared per file: validate follows $ into this file's functions only. */
function hookFailed($: EngineInterface, name: string, error: HookFailure): void {
  const line = failureLine(name, error)

  if (line !== undefined) {
    $.ui.log(line, { to: 'debug' })
  }
}

export function registerTimeline(on: On): void {
  on('turn.start', async ($, e, next) => {
    await note($, (turns, now) => turnStarted(turns, e.turnId, now))

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'turn.start (timeline)', next.error)

    return next(e)
  })

  // Every chunk and the result pass as they came (a rewrite would change the request or the stream). The clock and the
  // writes run beside the stream, not ahead of it; two writes per step, none per chunk.
  on('turn.step', async function* ($, e, next) {
    const t0 = performance.now()
    const head = { turnId: e.turnId, index: e.index, agentId: e.agentId, model: e.model, effort: e.effort, messageCount: e.messageCount }
    const sentAt = $.clock.now().catch(() => undefined)
    const started = sentAt.then(at => (at === undefined ? undefined : update($, timeline, turns => stepNoted(turns, stepOf(head, at, { tools: [] }).step)))).catch(() => undefined)
    let watch: StepWatch = { tools: [] }
    let result: TurnStepResult | undefined

    try {
      const stream = next(e)

      for await (const chunk of stream) {
        try {
          watch = watchChunk(watch, chunk, performance.now() - t0)
        } catch {
          // Timing is never worth a chunk.
        }

        yield chunk
      }

      result = await stream.result

      return result
    } finally {
      const end: StepEnd = { ms: performance.now() - t0, ...(result !== undefined && { result: { stopReason: result.stopReason, usage: result.usage } }) }

      try {
        await started

        const at = await sentAt

        if (at !== undefined) {
          const { step, tools } = stepOf(head, at, watch, end)

          await update($, timeline, turns => stepNoted(turns, step, tools))
        }
      } catch {
        // The step stands without its timing.
      }

      const usage = result?.usage ?? null

      // The request's own final usage, counted once: turn.complete's sum of the turn is never added on top.
      if (usage !== null) {
        await noteUsage($, day => requestNoted(day, usage.model, e.agentId === undefined ? 'main' : 'subagent', usage))
      }
    }
  }).catch(async function* ($, e, next) {
    hookFailed($, 'turn.step (timeline)', next.error)

    return yield* next(e)
  })

  // register.tsx hooks these events too, and the engine refuses a second matcher-less hook on an event: the matchers
  // below select every call (session.compact's alone narrows).
  on('classic.PostToolUse', { hook_event_name: 'PostToolUse' }, async ($, e, next) => {
    await note($, (turns, now) => toolEnded(turns, { toolUseId: e.tool_use_id, name: e.tool_name, agentId: e.agent_id, endedAt: now, durationMs: e.duration_ms, outcome: 'ok' }))

    if (e.tool_name === 'Skill') {
      await noteUsage($, day => skillNoted(day, skillNameOf(e.tool_input), skillOutcomeOf(e.tool_response)))
    }

    if (e.tool_name === 'AskUserQuestion') {
      await askEnded($, e.agent_id, e.tool_response)
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PostToolUse (timeline)', next.error)

    return next(e)
  })

  on('classic.PostToolUseFailure', { hook_event_name: 'PostToolUseFailure' }, async ($, e, next) => {
    const outcome = e.is_interrupt === true ? 'interrupted' : 'error'

    await note($, (turns, now) => toolEnded(turns, { toolUseId: e.tool_use_id, name: e.tool_name, agentId: e.agent_id, endedAt: now, durationMs: e.duration_ms, outcome }))

    if (e.tool_name === 'Skill') {
      await noteUsage($, day => skillNoted(day, skillNameOf(e.tool_input), 'error'))
    }

    if (e.tool_name === 'AskUserQuestion') {
      await askEnded($, e.agent_id, undefined)
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PostToolUseFailure (timeline)', next.error)

    return next(e)
  })

  on('classic.PermissionDenied', { hook_event_name: 'PermissionDenied' }, async ($, e, next) => {
    await note($, (turns, now) => toolEnded(turns, { toolUseId: e.tool_use_id, name: e.tool_name, agentId: e.agent_id, endedAt: now, outcome: 'denied' }))

    if (e.tool_name === 'AskUserQuestion') {
      await askEnded($, e.agent_id, undefined)
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PermissionDenied (timeline)', next.error)

    return next(e)
  })

  // The hooks beneath may decide it, and then no dialog shows; register.tsx holds the matcher-less hook.
  on('classic.PermissionRequest', { tool_name: 'AskUserQuestion' }, async ($, e, next) => {
    const r = await next(e)

    if (r.decision === undefined && r.block === undefined) {
      await askShown($, e.agent_id, e.tool_input)
    }

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PermissionRequest (asks)', next.error)

    return next(e)
  })

  // The dialog races the use-recommended button (ask-recommended.tsx); returning while `next(e)` is pending aborts the dialog beneath.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const labels = recommendedLabels(e.questions)

    if (labels === null) {
      return next(e)
    }

    const wait = awaitPress()

    try {
      const answered = await Promise.race([next(e), wait.pressed])

      if (answered !== null) {
        return answered
      }

      const result = { questions: e.questions, answers: Object.fromEntries(e.questions.map((one, i) => [one.question, labels[i]!])) }

      $.ui.log('ask: answered with the recommended options', { to: 'debug' })
      // The aborted dialog may report no result of its own: the ledger counts this one first.
      await askEnded($, e.agentId, result)

      return { result, context: [ASK_PRESSED] }
    } finally {
      wait.done()
    }
  }).catch(($, e, next) => {
    hookFailed($, 'tool.call AskUserQuestion', next.error)

    return next(e)
  })

  on('agent.spawn', { fork: [true, false] }, async ($, e, next) => {
    const r = await next(e)
    const childAgentId = r.agentId

    if (childAgentId !== undefined) {
      await note($, (turns, now) =>
        forked(turns, { toolUseId: e.tool_use_id, parentAgentId: e.parentAgentId, childAgentId, background: e.background, at: now, subagentType: e.subagentType, description: e.description }),
      )
    }

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'agent.spawn (timeline)', next.error)

    return next(e)
  })

  // A precompute installs nothing and a skip leaves the transcript: neither is a boundary.
  on('session.compact', { trigger: ['manual', 'auto', 'plugin'] }, async ($, e, next) => {
    const r = await next(e)
    const trigger = e.trigger

    if (r.skip === undefined) {
      await note($, (turns, now) => compacted(turns, e.agentId, { at: now, trigger, tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter }))
    }

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'session.compact (timeline)', next.error)

    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    await note($, turns => apiFailed(turns, e.agent_id, { error: e.error, details: e.error_details }))

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.StopFailure (timeline)', next.error)

    return next(e)
  })

  // register.tsx holds the matcher-less hook; this matcher selects every end. Written before the process may exit.
  on('session.end', { sessionId: /^/ }, async ($, e, next) => {
    for (const thread of [...asking.keys()]) {
      await askEnded($, thread === '' ? undefined : thread, undefined)
    }

    await writeLedger($, true).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'session.end (ledger)', next.error)

    return next(e)
  })

  on('turn.complete', { isAborted: [true, false] }, async ($, e, next) => {
    await note($, (turns, now) => turnEnded(turns, { turnId: e.turnId, agentId: e.agentId, endedAt: now, durationMs: e.durationMs, reason: e.reason }))
    // A dialog still open as its turn ends was cancelled with it.
    await askEnded($, e.agentId, undefined)

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'turn.complete (timeline)', next.error)

    return next(e)
  })
}
