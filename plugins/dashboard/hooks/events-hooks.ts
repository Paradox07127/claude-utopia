import type { EngineInterface, HookFailure, Register } from 'claude-code'

import type { AgentRun, MmSnapshot } from '../types'
import { agentEvents, bashText, capped, eventLine, eventsDir, eventsPath, gateEvent, runEvents, serially, staleDays } from './events'
import type { LedgerEvent } from './events'
import { failureLine } from './failures'
import { summarizeTests } from './summarize-tests'
import { dayOf, projectKey } from './usage'

// The event ledger's writer: each session rewrites only its own <project>/<day>/<session>.jsonl, whole, on one chain.

// The lines of the file last written; null until the first write of this load.
let kept: { path: string; lines: string[] } | null = null
const onChain = serially()

/** The repository's main worktree root, so a linked worktree's session shares its project; else the session root. */
async function ledgerRoot($: EngineInterface): Promise<string> {
  return (await $.session.repo().catch(() => null))?.root ?? (await $.session.root())
}

/** Adds `events` to this session's file of today. The ledger only watches: its failure is never the event's. */
async function emit($: EngineInterface, events: readonly LedgerEvent[]): Promise<void> {
  if (events.length === 0) {
    return
  }

  try {
    const at = await $.clock.now()
    const session = await $.session.id()
    const path = eventsPath((await $.env.get('HOME')) ?? '', projectKey(await ledgerRoot($)), dayOf(at), session)
    const added = events.map(one => eventLine(at, session, one))

    await onChain(async () => {
      // After a reload, or into another file, what the file holds already comes first.
      // Only a missing file reads as empty: one that exists but will not read throws, so it is never written over.
      const lines = kept?.path === path ? kept.lines : (await $.fs.exists(path)) ? String(await $.fs.read(path)).split('\n').filter(line => line !== '') : []

      // Kept before the write: a write that fails is made again by the next.
      kept = { path, lines: capped([...lines, ...added]) }
      await $.fs.write(path, `${kept.lines.join('\n')}\n`)
    })
  } catch {
    // Dropped: a missing line beats a broken event.
  }
}

/** Removes the project's date directories past the retention. */
async function prune($: EngineInterface): Promise<void> {
  const dir = eventsDir((await $.env.get('HOME')) ?? '', projectKey(await ledgerRoot($)))
  const names = (await $.fs.list(dir).catch(() => [])).filter(entry => entry.kind === 'dir').map(entry => entry.name)

  for (const name of staleDays(names, await $.clock.now())) {
    await $.process.run(['rm', '-rf', `${dir}/${name}`], { timeoutMs: 10_000 }).catch(() => null)
  }
}

/** A Bash call's test run, if it was one. */
async function noteGate($: EngineInterface, input: unknown, text: string | null, isFailure: boolean): Promise<void> {
  const command = typeof input === 'object' && input !== null ? (input as { command?: unknown }).command : undefined
  const summary = text === null ? null : summarizeTests(text)

  if (typeof command === 'string' && summary !== null) {
    await emit($, [gateEvent(command, summary, isFailure)])
  }
}

/** A hook's `.catch`: its failure to the debug log, once per hook this load. Declared per file: validate follows $ into this file's functions only. */
function hookFailed($: EngineInterface, name: string, error: HookFailure): void {
  const line = failureLine(name, error)

  if (line !== undefined) {
    $.ui.log(line, { to: 'debug' })
  }
}

export const register: Register = on => {
  // Every hook below has a matcher: another module holds the matcher-less one on each of these events, and the engine refuses a second.
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    await emit($, [{ name: 'session.start', severity: 'INFO', attributes: {} }])
    // Not awaited: removing old days must not hold the session's start.
    void prune($).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'session.start (events)', next.error)

    return next(e)
  })

  // Written before the process may exit.
  on('session.end', { reason: /^/ }, async ($, e, next) => {
    await emit($, [{ name: 'session.end', severity: 'INFO', attributes: { reason: e.reason } }])

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'session.end (events)', next.error)

    return next(e)
  })

  // Classic, never `tool.call`: a mod hooking Bash there denies every Bash call of a worktree subagent (claude-code#92533).
  on('classic.PostToolUse', { tool_name: /^Bash$/ }, async ($, e, next) => {
    await noteGate($, e.tool_input, bashText(e.tool_response), false)

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PostToolUse Bash (events)', next.error)

    return next(e)
  })

  // A nonzero exit, a failing test run among them, ends here instead of PostToolUse.
  on('classic.PostToolUseFailure', { tool_name: /^Bash$/ }, async ($, e, next) => {
    await noteGate($, e.tool_input, e.error, true)

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PostToolUseFailure Bash (events)', next.error)

    return next(e)
  })

  // A precompute installs nothing and a skip leaves the transcript: neither is a compaction.
  on('session.compact', { trigger: /^(?:manual|auto|plugin)$/ }, async ($, e, next) => {
    const r = await next(e)

    if (r.skip === undefined) {
      const attributes = { trigger: e.trigger, tokens_before: r.tokensBefore ?? null, tokens_after: r.tokensAfter ?? null, ...(e.agentId !== undefined && { 'agent.id': e.agentId }) }

      await emit($, [{ name: 'session.compact', severity: 'INFO', attributes }])
    }

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'session.compact (events)', next.error)

    return next(e)
  })

  // The workbench's own record of the agents: an end its list found (a killed agent has no turn.complete) counts as one too.
  on('state.set', { plugin: 'dashboard', key: 'agents' }, async ($, e, next) => {
    const r = await next(e)

    if (r.value?.isSet === true) {
      const before = (e.previous as { value?: AgentRun[] } | undefined)?.value ?? []
      const after = (e.value as { value?: AgentRun[] } | undefined)?.value ?? []

      await emit($, agentEvents(before, after))
    }

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'state.set agents (events)', next.error)

    return next(e)
  })

  // The mmrun runs the workbench polls, those of this project alone: ~/.claude/mmruns holds every project's.
  on('state.set', { plugin: 'dashboard', key: 'runs' }, async ($, e, next) => {
    const r = await next(e)

    if (r.value?.isSet === true) {
      const before = (e.previous as { value?: MmSnapshot | null } | undefined)?.value ?? null
      const after = (e.value as { value?: MmSnapshot | null } | undefined)?.value ?? null
      const root = await ledgerRoot($).catch(() => null)

      if (root !== null) {
        await emit($, runEvents(before, after, run => run.workdir === root || run.workdir.startsWith(`${root}/`)))
      }
    }

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'state.set runs (events)', next.error)

    return next(e)
  })
}
