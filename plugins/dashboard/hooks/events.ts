import type { AgentRun, AgentRunState, MmRun, MmSnapshot } from '../types'
import { isFailedModel, runLabel } from './runs'
import type { TestSummary } from './summarize-tests'
import { lastDays } from './usage'

// The event ledger: one JSONL file per session and local day, each line an OTel-style event. No prompt text, no command output.

export const COMMAND_CHARS = 120
export const MAX_BYTES = 2 * 1024 * 1024
export const KEEP_DAYS = 30

export type Severity = 'INFO' | 'WARN' | 'ERROR'
export type Attributes = Record<string, string | number | boolean | null>
export type LedgerEvent = { name: string; severity: Severity; attributes: Attributes }

const DAY = /^\d{4}-\d{2}-\d{2}$/
const ENDS: Partial<Record<AgentRunState, Severity>> = { done: 'INFO', aborted: 'WARN', error: 'ERROR', refusal: 'ERROR' }

export const eventsDir = (home: string, project: string) => `${home}/.claude/harness/events/${project}`

export const eventsPath = (home: string, project: string, day: string, session: string) => `${eventsDir(home, project)}/${day}/${session}.jsonl`

export const cutCommand = (command: string) => command.trim().replace(/\s+/g, ' ').slice(0, COMMAND_CHARS)

/** One event as read back: `at` epoch ms, `session` the session it belongs to. */
export type LedgerRecord = { at: number; name: string; severity: string; session: string; attributes: Attributes }

/** A session's events, oldest first. */
export type SessionEvents = { session: string; events: LedgerRecord[] }

/** What the events view shows: this session's events, and every other session's, the latest to start first. */
export type EventsRead = { session: string; own: LedgerRecord[]; others: SessionEvents[] }

const isScalar = (value: unknown) => value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

/** The session a file's lines belong to when they do not say: its name up to the first `.`. */
export const sessionOfFile = (name: string) => name.split('.')[0]!

/** The events of one file's text; a line that is not an event is skipped. */
export function parseLedger(text: string, fallbackSession: string): LedgerRecord[] {
  return text.split('\n').flatMap(line => {
    let raw: unknown

    try {
      raw = JSON.parse(line)
    } catch {
      return []
    }

    if (typeof raw !== 'object' || raw === null) {
      return []
    }

    const { timestamp, event_name: name, severity_text: severity, attributes } = raw as Record<string, unknown>
    const at = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN

    if (!Number.isFinite(at) || typeof name !== 'string' || name === '') {
      return []
    }

    const attrs: Attributes =
      typeof attributes === 'object' && attributes !== null && !Array.isArray(attributes) ? Object.fromEntries(Object.entries(attributes).filter(([, value]) => isScalar(value))) : {}
    const id = attrs['session.id']

    return [{ at, name, severity: typeof severity === 'string' ? severity : 'INFO', session: typeof id === 'string' && id !== '' ? id : fallbackSession, attributes: attrs }]
  })
}

/** Events of any number of files grouped by session and sorted by time; a session's lines may come from several writers' files. */
export function groupEvents(records: readonly LedgerRecord[], session: string): EventsRead {
  const by = new Map<string, LedgerRecord[]>()

  for (const one of records) {
    const list = by.get(one.session) ?? []

    list.push(one)
    by.set(one.session, list)
  }

  const all = [...by].map(([id, events]): SessionEvents => ({ session: id, events: events.sort((a, b) => a.at - b.at) }))

  return {
    session,
    own: all.find(one => one.session === session)?.events ?? [],
    others: all.filter(one => one.session !== session).sort((a, b) => b.events[0]!.at - a.events[0]!.at),
  }
}

/** One line of the file, without its newline: `session.id` leads the attributes. */
export function eventLine(at: number, session: string, event: LedgerEvent): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), event_name: event.name, severity_text: event.severity, attributes: { 'session.id': session, ...event.attributes } })
}

const bytesOf = (line: string) => new TextEncoder().encode(line).length + 1

/** `lines` with the oldest dropped until they and their newlines fit in `maxBytes`. */
export function capped(lines: readonly string[], maxBytes = MAX_BYTES): string[] {
  let total = lines.reduce((sum, line) => sum + bytesOf(line), 0)
  let start = 0

  while (total > maxBytes && start < lines.length) {
    total -= bytesOf(lines[start]!)
    start += 1
  }

  return lines.slice(start)
}

/** A runner of work one at a time: each starts once the one before has settled, and settles as its own work does. */
export function serially(): <T>(work: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve()

  return work => {
    const run = last.then(work)

    last = run.catch(() => undefined)

    return run
  }
}

/** The date directories of `names` older than KEEP_DAYS before `at`'s local day. */
export function staleDays(names: readonly string[], at: number): string[] {
  const oldest = lastDays(at, KEEP_DAYS + 1).at(-1)!

  return names.filter(name => DAY.test(name) && name < oldest)
}

/** A Bash result's text as the test gates read it: an errored call's text, else stdout and stderr. */
export function bashText(output: unknown): string | null {
  if (typeof output === 'string') {
    return output
  }

  const out = typeof output === 'object' && output !== null ? (output as { stdout?: unknown; stderr?: unknown }) : null

  if (out === null || typeof out.stdout !== 'string') {
    return null
  }

  return typeof out.stderr === 'string' ? `${out.stdout}\n${out.stderr}` : out.stdout
}

/** A test run's result; `isFailure`: the call ended in PostToolUseFailure. A failure by its exit alone has an unknown fail count. */
export function gateEvent(command: string, summary: TestSummary, isFailure: boolean): LedgerEvent {
  const failed = summary.failed || isFailure

  return {
    name: 'gate.result',
    severity: failed ? 'WARN' : 'INFO',
    attributes: { command: cutCommand(command), pass: summary.pass, fail: failed && summary.fail === 0 ? null : summary.fail, outcome: failed ? 'fail' : 'pass' },
  }
}

/** What changed between two writes of the agents: a call denied, and a running or idle agent that ended. */
export function agentEvents(before: readonly AgentRun[], after: readonly AgentRun[]): LedgerEvent[] {
  return after.flatMap(run => {
    const was = before.find(one => one.agentId === run.agentId)
    const head = { 'agent.id': run.agentId, 'agent.type': run.subagentType }
    const severity = ENDS[run.state]
    const isEnded = severity !== undefined && (was?.state === 'running' || was?.state === 'idle')

    return [
      ...((run.denied ?? 0) > (was?.denied ?? 0) ? [{ name: 'agent.denied', severity: 'WARN' as const, attributes: { ...head, tool: run.lastTool } }] : []),
      ...(isEnded ? [{ name: 'agent.end', severity, attributes: { ...head, state: run.state, duration_ms: run.durationMs ?? null } }] : []),
    ]
  })
}

const isRunning = (run: MmRun) => run.models.some(model => model.status === 'RUNNING')

/** The runs of `isOurs` that appeared or stopped running between two polls; none against no earlier poll. */
export function runEvents(before: MmSnapshot | null, after: MmSnapshot | null, isOurs: (run: MmRun) => boolean): LedgerEvent[] {
  if (before === null || after === null) {
    return []
  }

  return after.runs.filter(isOurs).flatMap(run => {
    const was = before.runs.find(one => one.runid === run.runid)
    const head = { 'run.id': run.runid, label: runLabel(run), models: run.models.map(model => model.name).join(',') }
    const isEnded = run.models.length > 0 && !isRunning(run) && (was === undefined || isRunning(was))

    return [
      ...(was === undefined ? [{ name: 'mmrun.start', severity: 'INFO' as const, attributes: { ...head, mode: run.mode } }] : []),
      ...(isEnded
        ? [{ name: 'mmrun.end', severity: run.models.some(isFailedModel) ? ('WARN' as const) : ('INFO' as const), attributes: { ...head, status: run.models.map(model => `${model.name}:${model.status}`).join(',') } }]
        : []),
    ]
  })
}
