import type { SessionRateLimit } from 'claude-code'

import type { AgentRun, AgentUsage, AskCounts, BoardNode, BoardRead, BoardStatus, DashSeen, DashUsage, GateRun, MmModel, MmRun, MmSnapshot, SessionPresence, UsageCounts, WorktreeInfo } from '../types'
import { bandText, elapsedOf, fit, fmtDuration, fmtTokens, glyphOf, widthOf } from './agent-model'
import { t } from './i18n'
import { elapsedSecs, fmtRunTokens, fmtSecs, isFailedModel, runLabel } from './runs'
import type { Flight } from './timeline'
import { dayOf, isEmptyWeek } from './usage'
import type { UsageWeek } from './usage'

/** How long a finished item stays on the band, in ms. */
export const FRESH_MS = 20_000
export const MAX_BAND_ROWS = 5
/** How long a command's failing gate stays pending unless the same command passes. */
export const GATE_PENDING_MS = 30 * 60_000
export const GATE_COMMAND_COLUMNS = 60
export const RECENT_GATES = 5
export const OVERVIEW_GATES = 3
export const OVERVIEW_TREES = 5
/** A running agent with no tool call ending for this long is marked quiet, unless a call it began is still running. */
export const STALL_MS = 120_000
/** Items the idle overview lists under its gray line. */
const IDLE_RECENT = 3
/** A session replying after a turn at least this long toasts. */
export const LONG_TURN_MS = 120_000
/** A session replied this long ago counts as idle: left open, not waiting on the person. */
export const REPLIED_STALE_MS = 30 * 60_000
const PEER_TITLE_COLUMNS = 40
/** A rate-limit window used this much or more goes on the band. */
export const LIMIT_WARN_PERCENT = 80
/** Rate-limit crossings whose band line ended, kept so they do not come back. */
const LIMITS_KEPT = 20
const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
/** Other sessions' states kept as seen, so one back from silence does not toast again. */
const PEER_TOAST_KEYS = 200
// Band agent rows: the type column at most this wide, the time column this wide, a last tool kept this wide before the tool columns go.
const TYPE_COLUMNS = 16
const TIME_COLUMNS = 6
const LAST_TOOL_COLUMNS = 12
// Group ids; groupWord turns them into the band's words.
const SESSIONS_GROUP = 'sessions'
export const CACHE_GROUP = 'cache'
export const LIMITS_GROUP = 'limits'
const GATES_GROUP = 'gates'

const ERROR = 'error'
const INACTIVE = 'inactive'
const PERMISSION = 'permission'
const SUCCESS = 'success'
const WARNING = 'warning'

export type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean }
export type Line = Seg[]

/** 1 failed or denied and not yet seen, 2 ended within FRESH_MS, 3 running; null when off the band. */
export type Tier = 1 | 2 | 3

export type Counts = { pending: number; running: number; unread: number }

/** Per tier, and apart the aborted agents (⊘ in the summary, not ✓) and the failed other sessions (✗, not !). */
type Tally = Record<Tier, number> & { aborted: number; failed: number }

/** `run`: an agent, drawn on the band in columns lined up with the other agents shown; `flight`, its call still running. */
type Entry = { tier: Tier; startedAt: number; group: string; full: Line; compact: Line; counts: Tally; run?: AgentRun; flight?: Flight }

/** Other sessions working, replied, and waiting on the person (asking a permission, failed or replied). */
export type PeerCounts = { working: number; replied: number; waiting: number }

export type Board = { entries: Entry[]; counts: Counts; peers: PeerCounts; now: number }

const isFailedAgent = (run: AgentRun) => run.state === 'error' || run.state === 'refusal' || (run.denied ?? 0) > 0

const isUnseen = (endedAt: number | undefined, seenAt: number) => endedAt === undefined || endedAt > seenAt

const isFresh = (endedAt: number | undefined, now: number) => endedAt !== undefined && now - endedAt < FRESH_MS

function agentTier(run: AgentRun, seen: DashSeen, now: number): Tier | null {
  if (isFailedAgent(run) && (run.state === 'running' || isUnseen(run.endedAt, seen.agents))) {
    return 1
  }

  if (run.state === 'running') {
    return 3
  }

  return isFresh(run.endedAt, now) ? 2 : null
}

function modelTier(model: MmRun['models'][number], seen: DashSeen, now: number): Tier | null {
  if (isFailedModel(model) && isUnseen(model.endedAt, seen.runs)) {
    return 1
  }

  if (model.status === 'RUNNING') {
    return 3
  }

  return isFresh(model.endedAt, now) ? 2 : null
}

type Bucket = keyof Counts

export function agentBucket(run: AgentRun, seen: DashSeen, now: number): Bucket | null {
  if (agentTier(run, seen, now) === 1) {
    return 'pending'
  }

  if (run.state === 'running') {
    return 'running'
  }

  return isUnseen(run.endedAt, seen.agents) ? 'unread' : null
}

export function modelBucket(model: MmRun['models'][number], seen: DashSeen, now: number): Bucket | null {
  if (modelTier(model, seen, now) === 1) {
    return 'pending'
  }

  if (model.status === 'RUNNING') {
    return 'running'
  }

  return !isFailedModel(model) && isUnseen(model.endedAt, seen.runs) ? 'unread' : null
}

/** Quiet: running with no call ended for STALL_MS and, when the timeline knows, none in `flight`. */
export const isStalled = (run: AgentRun, now: number, flight?: Flight) => flight === undefined && run.state === 'running' && now - run.lastActivityAt >= STALL_MS

/** `Bash 3m…`: the call still running and for how long. */
export const flightText = (flight: Flight, now: number) => `${flight.name} ${fmtAge(now - flight.requestedAt)}…`

/**
 * `● worker  Build mm plugin  3m12s  41 tools  Edit register.tsx`, ending in `✗ denied N` once a call was denied, then `quiet 2m00s` once quiet;
 * a call in `flight` reads `Bash 3m…` in the last tool's place.
 */
export function agentLine(run: AgentRun, now: number, isCompact = false, flight?: Flight): Line {
  const { glyph, color } = glyphOf(run.state)
  const word = t().agentStates[run.state]
  const line: Line = [{ text: glyph, color }, { text: ` ${bandText(run, now, isCompact, flight === undefined ? undefined : flightText(flight, now))}${word === '' ? '' : `  ${word}`}` }]

  if ((run.denied ?? 0) > 0) {
    line.push({ text: '  ' }, { text: t().denied(run.denied ?? 0), color: ERROR })
  }

  if (isStalled(run, now, flight)) {
    line.push({ text: '  ' }, { text: t().quiet(fmtDuration(now - run.lastActivityAt)), color: WARNING })
  }

  return line
}

/** `review-ui · codex ● 7m12s · grok ✓ 5m02s · agy ✗ FAIL:1`, durations drawn against `polledAt`. */
export function runLine(run: MmRun, polledAt: number): Line {
  const line: Line = [{ text: runLabel(run) }]

  for (const model of run.models) {
    const secs = elapsedSecs(model, polledAt)
    const time = secs === undefined ? '' : ` ${fmtSecs(secs)}`

    if (model.status === 'RUNNING') {
      line.push({ text: ` · ${model.name} ` }, { text: '●', color: PERMISSION }, { text: time })
    } else if (model.status === 'DONE') {
      line.push({ text: ` · ${model.name} ` }, { text: '✓', color: SUCCESS }, { text: time })
    } else {
      line.push({ text: ` · ${model.name} ` }, { text: '✗', color: ERROR }, { text: ` ${model.status}` })
    }
  }

  return line
}

const noCounts = (): Tally => ({ 1: 0, 2: 0, 3: 0, aborted: 0, failed: 0 })

/** A run with failing tests, or one its summary or exit called failed whatever it counted. */
export const isFailedGate = (gate: GateRun) => (gate.fail ?? 0) > 0 || gate.failed === true

/** `packages · ` before the counts of go packages. */
const unitPrefix = (gate: GateRun) => (gate.unit === 'packages' ? `${t().packagesUnit} · ` : '')

/** `22 pass · 2 fail`; `— pass` when no line gave a total, `failed` in place of a failure count none gave. */
export const gateCounts = (gate: GateRun) => `${unitPrefix(gate)}${gate.pass ?? '—'} pass · ${gate.fail === null ? t().gateFailed : `${gate.fail} fail`}`

/** The newest `count` runs, newest first. */
export const recentGates = (gates: readonly GateRun[], count = RECENT_GATES) => gates.slice(-count).reverse()

/**
 * Each command's latest run in each tree, where that run failed within GATE_PENDING_MS, no edit in its tree came after,
 * and its tree is the main one or still in `trees` (any while `trees` is null, before the first collection).
 */
export function pendingGates(gates: readonly GateRun[], now: number, trees: readonly WorktreeInfo[] | null = null): GateRun[] {
  const latest = new Map(gates.map(gate => [`${gate.where}\n${gate.key ?? gate.command}`, gate]))
  const isListed = (gate: GateRun) => gate.where === 'main' || trees === null || trees.some(tree => tree.name === gate.where)

  return [...latest.values()].filter(gate => isFailedGate(gate) && gate.stale !== true && now - gate.at < GATE_PENDING_MS && isListed(gate))
}

// A leading `cd <dir> &&` (or `;`), or a `NAME=value` assignment, before the command proper.
const COMMAND_LEAD = /^(?:cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*(?:&&|;)|[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S*?)(?:\s*;|\s+))\s*/

/** `bun test` of `cd /x && S=1; bun test`: the first line, the leading cd and assignments dropped, whitespace folded. */
export function commandHead(command: string): string {
  const [first = '', ...body] = command.trim().split('\n')
  // A heredoc's opener alone reads the same for every script: its body's first line tells them apart.
  const opened = /<<-?\s*['"]?\w+/.test(first) ? body.find(line => line.trim() !== '') : undefined
  let head = `${first.trim()}${opened === undefined ? '' : ` ${opened.trim()}`}`

  for (let lead = COMMAND_LEAD.exec(head); lead !== null && lead[0].length < head.length; lead = COMMAND_LEAD.exec(head)) {
    head = head.slice(lead[0].length)
  }

  return head.replace(/\s+/g, ' ')
}

/** `2 fail`; `failed` when the run failed with nothing counted failing; else `186 pass`, `— pass` when no line gave a total. */
export const gateOutcome = (gate: GateRun) => unitPrefix(gate) + ((gate.fail ?? 0) > 0 ? `${gate.fail} fail` : gate.failed === true ? t().gateFailed : `${gate.pass ?? '—'} pass`)

/** `✗ gate claude plugin test plugins/dashboard · 2 fail`, then ` · agent-x` when it ran in a worktree. */
function gateLine(gate: GateRun): Line {
  const where = gate.where === 'main' ? '' : ` · ${gate.where}`

  return [{ text: '✗', color: ERROR }, { text: ` ${t().gateLine(fit(gate.command, GATE_COMMAND_COLUMNS), gateOutcome(gate))}${where}` }]
}

/** The overview's needs-you row: `✗ gate claude plugin test plugins/dashboard · agent-x · 2 fail`, or `· failed` as gateOutcome words it. */
export const pendingGateLine = (gate: GateRun): Line => [{ text: '✗', color: ERROR }, { text: ` ${t().gatePending(fit(gate.command, GATE_COMMAND_COLUMNS), gate.where, gateOutcome(gate))}` }]

type PeerState = Exclude<SessionPresence['state'], 'idle' | 'ended'>

export const PEER_WORDS: Record<PeerState, { glyph: string; color: string }> = {
  permission: { glyph: '!', color: WARNING },
  failed: { glyph: '✗', color: ERROR },
  replied: { glyph: '?', color: WARNING },
  working: { glyph: '●', color: PERMISSION },
}

/** Another session the overview lists. */
export type ShownPeer = SessionPresence & { state: PeerState }

const isShownPeer = (peer: SessionPresence): peer is ShownPeer => peer.state in PEER_WORDS

const isStaleReply = (peer: SessionPresence, now: number) => peer.state === 'replied' && now - peer.since >= REPLIED_STALE_MS

/** `! harness needs approval Bash · 3m05s`, or `✗ harness errored · 3m05s`. */
function peerLine(peer: SessionPresence & { state: 'permission' | 'failed' }, now: number): Line {
  const { glyph, color } = PEER_WORDS[peer.state]

  return [{ text: glyph, color }, { text: ` ${[peer.name, t().peerWords[peer.state], peer.detail ?? ''].filter(part => part !== '').join(' ')} · ${fmtDuration(now - peer.since)}` }]
}

/** The main thread idle past the prompt cache's TTL: for how long, and the context tokens the next message rewrites when known. */
export type ColdCache = { idleMs: number; tokens: number | null }

/** `~ cache cold · idle 1h12m · next message rewrites ~182k tokens`. */
function cacheLine(cold: ColdCache): Line {
  return [{ text: t().cacheCold, color: WARNING }, { text: ` · ${t().cacheIdle(fmtDuration(cold.idleMs))}${cold.tokens === null ? '' : ` · ${t().cacheRewrite(fmtTokens(cold.tokens))}`}` }]
}

const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

const limitKey = (limit: SessionRateLimit) => `${limit.kind}@${limit.resetsAt ?? ''}`

/** `2h10m`, `3d4h` past a day. */
// Whole minutes under an hour: the band wakes only as a minute passes (nextBandChange), so seconds would stand still.
const fmtReset = (ms: number) =>
  ms < 60_000 ? '<1m' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : ms < DAY_MS ? fmtDuration(ms) : `${Math.floor(ms / DAY_MS)}d${Math.floor((ms % DAY_MS) / 3_600_000)}h`

/** `5h 42% · resets in 2h10m`; the kind as the engine names it when not a known window, no reset when it gave none. */
export function limitText(limit: SessionRateLimit, now: number): string {
  const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
  const name = `${LIMIT_NAMES[limit.kind] ?? limit.kind} ${limit.percentUsed}%`

  return Number.isNaN(resetsAt) ? name : `${name} · ${t().limitReset(fmtReset(Math.max(0, resetsAt - now)))}`
}

/** The windows the band warns of: used LIMIT_WARN_PERCENT or more, their crossing's line not ended before. */
export const warnedLimits = (usage: DashUsage) => usage.rateLimits.filter(limit => limit.percentUsed >= LIMIT_WARN_PERCENT && !usage.limitsGone.includes(limitKey(limit)))

/** `limitsGone` once a measurement gave `rateLimits`: a window warned of that is under the mark now, or not read, ends its crossing's line until it resets. */
export function goneLimits(was: DashUsage, rateLimits: readonly SessionRateLimit[]): string[] {
  const warned = new Set(rateLimits.filter(limit => limit.percentUsed >= LIMIT_WARN_PERCENT).map(limitKey))
  const ended = warnedLimits(was)
    .map(limitKey)
    .filter(key => !warned.has(key))

  return ended.length === 0 ? was.limitsGone : [...was.limitsGone, ...ended].slice(-LIMITS_KEPT)
}

/** `~ limit 5h 82% · resets in 2h10m`. */
function limitLine(limit: SessionRateLimit, now: number): Line {
  return [{ text: t().limitWarn, color: WARNING }, { text: ` ${limitText(limit, now)}` }]
}

/** When the band's pending gates or limit countdowns next change with time alone: a gate's expiry, a countdown's next minute; null when none will. */
export function nextBandChange(gates: readonly GateRun[], limits: readonly SessionRateLimit[], now: number, trees: readonly WorktreeInfo[] | null = null): number | null {
  const times = [
    ...pendingGates(gates, now, trees).map(gate => gate.at + GATE_PENDING_MS),
    // A countdown drops a minute 1 ms past each whole minute left.
    ...limits
      .map(limit => Date.parse(limit.resetsAt ?? '') - now)
      .filter(left => left > 0)
      .map(left => now + (left % MINUTE_MS) + 1),
  ]

  return times.length === 0 ? null : Math.min(...times)
}

/**
 * What the band and the overview draw from; `peers` are the other sessions, `cold` this one's cold prompt cache, `flights` the agents' calls still running,
 * `limits` the rate-limit windows warnedLimits gives, `trees` the worktrees pendingGates keeps gates of.
 */
export function boardOf(
  agents: readonly AgentRun[],
  snap: MmSnapshot | null,
  seen: DashSeen,
  now: number,
  gates: readonly GateRun[] = [],
  peers: readonly SessionPresence[] = [],
  cold: ColdCache | null = null,
  flights: ReadonlyMap<string, Flight> = new Map(),
  limits: readonly SessionRateLimit[] = [],
  trees: readonly WorktreeInfo[] | null = null,
): Board {
  const entries: Entry[] = []
  const counts: Counts = { pending: 0, running: 0, unread: 0 }
  const tally: PeerCounts = { working: 0, replied: 0, waiting: 0 }

  for (const peer of peers) {
    // A failed turn waits on the person until that session's next prompt: no staleness, unlike a reply.
    if (peer.state === 'permission' || peer.state === 'failed') {
      const line = peerLine({ ...peer, state: peer.state }, now)

      tally.waiting += 1
      entries.push({ tier: 1, startedAt: peer.since, group: SESSIONS_GROUP, full: line, compact: line, counts: peer.state === 'failed' ? { ...noCounts(), failed: 1 } : { ...noCounts(), 1: 1 } })
    } else if (peer.state === 'working') {
      counts.running += 1
      tally.working += 1
    } else if (peer.state === 'replied' && !isStaleReply(peer, now)) {
      tally.replied += 1
      tally.waiting += 1
    }
  }

  for (const gate of pendingGates(gates, now, trees)) {
    const line = gateLine(gate)

    counts.pending += 1
    entries.push({ tier: 1, startedAt: gate.at, group: GATES_GROUP, full: line, compact: line, counts: { ...noCounts(), 1: 1 } })
  }

  for (const run of agents) {
    const tier = agentTier(run, seen, now)
    const bucket = agentBucket(run, seen, now)

    if (bucket !== null) {
      counts[bucket] += 1
    }

    if (tier !== null) {
      const tally = tier === 2 && run.state === 'aborted' ? { ...noCounts(), aborted: 1 } : { ...noCounts(), [tier]: 1 }
      const flight = flights.get(run.agentId)

      entries.push({ tier, startedAt: run.startedAt, group: 'agents', full: agentLine(run, now, false, flight), compact: agentLine(run, now, true, flight), counts: tally, run, ...(flight !== undefined && { flight }) })
    }
  }

  for (const run of snap?.runs ?? []) {
    const tally = noCounts()
    let best: Tier | null = null

    for (const model of run.models) {
      const tier = modelTier(model, seen, now)
      const bucket = modelBucket(model, seen, now)

      if (bucket !== null) {
        counts[bucket] += 1
      }

      if (tier !== null) {
        tally[tier] += 1
        best = best === null ? tier : (Math.min(best, tier) as Tier)
      }
    }

    if (best !== null) {
      const line = runLine(run, snap?.polledAt ?? now)

      entries.push({ tier: best, startedAt: run.createdAt, group: run.mode || 'mmrun', full: line, compact: line, counts: tally })
    }
  }

  entries.sort((a, b) => a.tier - b.tier || a.startedAt - b.startedAt)

  // Counted in no bucket nor tier: it is no work item, only a heads-up, so it comes last and is the first group dropped; so do the rate limits.
  if (cold !== null) {
    const line = cacheLine(cold)

    entries.push({ tier: 2, startedAt: now - cold.idleMs, group: CACHE_GROUP, full: line, compact: line, counts: noCounts() })
  }

  for (const limit of limits) {
    const line = limitLine(limit, now)

    entries.push({ tier: 2, startedAt: now, group: LIMITS_GROUP, full: line, compact: line, counts: noCounts() })
  }

  return { entries, counts, peers: tally, now }
}

/** The counts joined by ` · ` within `columns`: running dropped first, then unread, then waiting; the last one left is cut. */
function summaryLine(counts: Counts, waiting: number, columns: number): Line {
  // `keep`: the higher, the longer it stays; the counts that need the person stay longest.
  let parts = [
    { keep: 3, line: counts.pending > 0 ? [{ text: t().pendingCount(counts.pending), color: ERROR }] : [] },
    { keep: 0, line: counts.running > 0 ? [{ text: '●', color: PERMISSION }, { text: t().runCount(counts.running) }] : [] },
    { keep: 1, line: counts.unread > 0 ? [{ text: t().unreadCount(counts.unread), bold: true }] : [] },
    { keep: 2, line: waiting > 0 ? [{ text: t().waitingCount(waiting), color: WARNING }] : [] },
  ].filter(part => part.line.length > 0)
  const joined = () => parts.flatMap((part, i) => (i === 0 ? part.line : [{ text: ' · ' }, ...part.line]))

  while (parts.length > 1 && lineWidth(joined()) > columns) {
    const least = Math.min(...parts.map(part => part.keep))

    parts = parts.filter(part => part.keep !== least)
  }

  return fitLine(joined(), columns)
}

const groupWord = (group: string) =>
  group === SESSIONS_GROUP ? t().sessionsGroup : group === CACHE_GROUP ? t().cacheGroup : group === LIMITS_GROUP ? t().limitsGroup : group === GATES_GROUP ? t().gatesGroup : group

/** `agents ✗1 ●2 ✓1 ⊘1` per group, in the order its first entry comes, with the color of its worst tier; other sessions as `sessions ✗1 !1 ●2 ?1`. */
function groupLines(entries: readonly Entry[], peers: PeerCounts): { line: Line; color: string }[] {
  const groups = new Map<string, Tally>()

  for (const entry of entries) {
    const tally = groups.get(entry.group) ?? noCounts()

    for (const key of [1, 2, 3, 'aborted', 'failed'] as const) {
      tally[key] += entry.counts[key]
    }

    groups.set(entry.group, tally)
  }

  if (peers.working + peers.replied > 0) {
    const tally = groups.get(SESSIONS_GROUP) ?? noCounts()

    tally[3] += peers.working
    groups.set(SESSIONS_GROUP, tally)
  }

  return [...groups].map(([group, tally]) => {
    const line: Line = [{ text: groupWord(group) }]
    const isSessions = group === SESSIONS_GROUP
    let color: string | null = null

    for (const [key, glyph, tone] of [['failed', '✗', ERROR], [1, isSessions ? '!' : '✗', isSessions ? WARNING : ERROR], [3, '●', PERMISSION], [2, '✓', SUCCESS], ['aborted', '⊘', WARNING]] as const) {
      if (tally[key] > 0) {
        line.push({ text: ' ' }, { text: glyph, color: tone }, { text: `${tally[key]}` })
        color ??= tone
      }
    }

    if (group === CACHE_GROUP || group === LIMITS_GROUP) {
      line.push({ text: ' ' }, { text: '~', color: WARNING })
      color ??= WARNING
    }

    if (isSessions && peers.replied > 0) {
      line.push({ text: ' ' }, { text: '?', color: WARNING }, { text: `${peers.replied}` })
      color ??= WARNING
    }

    return { line, color: color ?? SUCCESS }
  })
}

/** The groups joined by ` · ` within `columns`: whole groups dropped from the right, each leaving a `•`; the counts when not even one fits. */
function summaryOf(entries: readonly Entry[], counts: Counts, peers: PeerCounts, columns: number): Line {
  const groups = groupLines(entries, peers)

  for (let kept = groups.length; kept >= 1; kept -= 1) {
    const line: Line = groups.slice(0, kept).flatMap((group, i) => (i === 0 ? group.line : [{ text: ' · ' }, ...group.line]))

    for (const dropped of groups.slice(kept)) {
      line.push({ text: ' ' }, { text: '•', color: dropped.color })
    }

    if (widthOf(line.map(seg => seg.text).join('')) <= columns) {
      return line
    }
  }

  return summaryLine(counts, peers.waiting, columns)
}

/**
 * The band's lines within `rows`: up to three entries whole; else failures alone in `rows - 1`
 * and the rest on one summary line `columns` wide; with a single row, the counts.
 */
export function bandLines(board: Board, rows: number, columns: number): Line[] {
  const { entries, counts, peers, now } = board

  if (entries.length <= Math.min(rows, 3)) {
    return entryLines(entries, now, columns, false)
  }

  if (rows <= 1) {
    return [summaryLine(counts, peers.waiting, columns)]
  }

  const alone = entries.filter(entry => entry.tier === 1).slice(0, rows - 1)
  const rest = entries.filter(entry => !alone.includes(entry))

  return [...entryLines(alone, now, columns, true), ...(rest.length === 0 ? [] : [summaryOf(rest, counts, peers, columns)])]
}

/** The entries' lines, the agents among them in columns lined up with each other. */
function entryLines(entries: readonly Entry[], now: number, columns: number, isCompact: boolean): Line[] {
  const rows = agentRows(
    entries.flatMap(entry => (entry.run === undefined ? [] : [{ run: entry.run, flight: entry.flight }])),
    now,
    columns,
    isCompact,
  )

  return entries.map(entry => (entry.run === undefined ? (isCompact ? entry.compact : entry.full) : rows.get(entry.run)!))
}

type AgentCells = { glyph: Seg; type: string; title: string; time: string; tools: string; last: string; tail: Line }

function cellsOf(run: AgentRun, now: number, flight: Flight | undefined): AgentCells {
  const { glyph, color } = glyphOf(run.state)
  const word = t().agentStates[run.state]
  const isRunning = run.state === 'running'
  const tail: Line = [
    ...(word === '' ? [] : [{ text: `  ${word}` }]),
    ...((run.denied ?? 0) > 0 ? [{ text: '  ' }, { text: t().denied(run.denied ?? 0), color: ERROR }] : []),
    ...(isStalled(run, now, flight) ? [{ text: '  ' }, { text: t().quiet(fmtDuration(now - run.lastActivityAt)), color: WARNING }] : []),
  ]

  return {
    glyph: { text: glyph, color },
    type: run.subagentType,
    title: run.description,
    time: fmtDuration(elapsedOf(run, now)),
    tools: isRunning ? `${run.tools} tools` : run.outputTokens === undefined ? '' : `${fmtTokens(run.outputTokens)} out`,
    last: !isRunning ? '' : flight === undefined ? run.lastTool : flightText(flight, now),
    tail,
  }
}

const lineWidth = (line: Line) => widthOf(line.map(seg => seg.text).join(''))

export const padTo = (text: string, columns: number) => text + ' '.repeat(Math.max(0, columns - widthOf(text)))

export const alignRight = (text: string, columns: number) => ' '.repeat(Math.max(0, columns - widthOf(text))) + text

/**
 * `● worker  Build mm plugin   3m12s  41 tools  Edit register.tsx` per run: type and title padded to the widest shown,
 * the time right-aligned in TIME_COLUMNS. When not all fits, the tools and last-tool columns go first, then the title is cut,
 * then the type, a name left no cells going with its gap; then the tail is cut, the glyph and the time going last.
 */
function agentRows(shown: readonly { run: AgentRun; flight?: Flight | undefined }[], now: number, columns: number, isCompact: boolean): Map<AgentRun, Line> {
  const runs = shown.map(one => one.run)
  const cells = shown.map(one => cellsOf(one.run, now, one.flight))
  const typeMax = Math.min(TYPE_COLUMNS, Math.max(0, ...cells.map(one => widthOf(one.type))))
  const titleMax = Math.max(0, ...cells.map(one => widthOf(one.title)))
  const toolsW = Math.max(0, ...cells.map(one => widthOf(one.tools)))
  // The glyph and its space, the type, the gaps either side of the title, the time.
  const fixed = 2 + typeMax + 2 + 2 + TIME_COLUMNS
  const wideTail = (one: AgentCells) => (one.tools === '' ? 0 : 2 + toolsW) + (one.last === '' ? 0 : 2 + Math.min(widthOf(one.last), LAST_TOOL_COLUMNS)) + lineWidth(one.tail)
  const isWide = !isCompact && fixed + titleMax + Math.max(0, ...cells.map(wideTail)) <= columns
  const tailW = Math.max(0, ...cells.map(one => (isWide ? wideTail(one) : lineWidth(one.tail))))
  // Cells for the names and the gap after each, between the glyph's and the time's.
  const room = columns - 2 - TIME_COLUMNS - tailW
  const typeW = Math.max(0, Math.min(typeMax, room - 2))
  const titleW = Math.max(0, Math.min(titleMax, room - (typeW > 0 ? typeW + 2 : 0) - 2))

  return new Map(
    runs.map((run, i) => {
      const one = cells[i]!
      const hasMore = one.last !== '' || one.tail.length > 0
      const names = [...(typeW > 0 ? [padTo(fit(one.type, typeW), typeW)] : []), ...(titleW > 0 ? [padTo(fit(one.title, titleW), titleW)] : [])]
      const head: Line = [
        one.glyph,
        { text: ` ${[...names, alignRight(one.time, TIME_COLUMNS)].join('  ')}` },
        ...(isWide && one.tools !== '' ? [{ text: `  ${hasMore ? padTo(one.tools, toolsW) : one.tools}` }] : []),
      ]
      // The last tool takes what the row leaves it, so the tail after it stays whole.
      const lastW = columns - lineWidth(head) - 2 - lineWidth(one.tail)
      const line: Line = [...head, ...(isWide && one.last !== '' ? [{ text: '  ' }, { text: fit(one.last, lastW), dim: true }] : []), ...one.tail]

      return [run, fitLine(line, columns)]
    }),
  )
}

export type OverviewItem = { kind: 'agent'; run: AgentRun } | { kind: 'model'; run: MmRun; model: MmModel }

export type Overview = {
  /** Needs you: the pending bucket. */
  pending: OverviewItem[]
  /** Needs you too: the gates pendingGates gives. */
  gates: GateRun[]
  running: OverviewItem[]
  /** Done: unread agents and unread mmrun models; an agent the person cancelled counts in `aborted` instead. */
  returned: number
  aborted: number
  reviewed: number
  /** The last IDLE_RECENT that ended, newest first. */
  recent: OverviewItem[]
  /** Other sessions: those asking a permission, then failed, then replied, then working, each oldest first. */
  sessions: ShownPeer[]
}

const endedAtOf = (item: OverviewItem) => (item.kind === 'agent' ? item.run.endedAt : item.model.endedAt)

/** The overview page's items, sorted into its sections. */
export function overviewOf(
  agents: readonly AgentRun[],
  snap: MmSnapshot | null,
  seen: DashSeen,
  now: number,
  peers: readonly SessionPresence[] = [],
  gates: readonly GateRun[] = [],
  trees: readonly WorktreeInfo[] | null = null,
): Overview {
  const order = Object.keys(PEER_WORDS)
  const sessions = peers.filter(isShownPeer).filter(peer => !isStaleReply(peer, now)).sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.since - b.since)
  const overview: Overview = { pending: [], gates: pendingGates(gates, now, trees), running: [], returned: 0, aborted: 0, reviewed: 0, recent: [], sessions }
  const ended: OverviewItem[] = []
  const sort = (item: OverviewItem, bucket: Bucket | null) => {
    if (bucket === 'unread') {
      overview[item.kind === 'model' ? 'reviewed' : item.run.state === 'aborted' ? 'aborted' : 'returned'] += 1
    } else if (bucket !== null) {
      overview[bucket].push(item)
    }

    if (endedAtOf(item) !== undefined) {
      ended.push(item)
    }
  }

  for (const run of agents) {
    sort({ kind: 'agent', run }, agentBucket(run, seen, now))
  }

  for (const run of snap?.runs ?? []) {
    for (const model of run.models) {
      sort({ kind: 'model', run, model }, modelBucket(model, seen, now))
    }
  }

  overview.recent = ended.sort((a, b) => (endedAtOf(b) ?? 0) - (endedAtOf(a) ?? 0)).slice(0, IDLE_RECENT)

  return overview
}

/** `worker · Build mm plugin` or `design / codex`. */
export const itemTitle = (item: OverviewItem) => (item.kind === 'agent' ? `${item.run.subagentType} · ${item.run.description}` : `${runLabel(item.run)} / ${item.model.name}`)

/** itemTail's two parts, either may be empty: the tools or a model's output tokens, and the time. */
function tailParts(item: OverviewItem, now: number, polledAt: number): [string, string] {
  if (item.kind === 'agent') {
    return [`${item.run.tools} tools`, fmtDuration(elapsedOf(item.run, now))]
  }

  const secs = elapsedSecs(item.model, polledAt)

  return [item.model.outputTokens === undefined ? '' : fmtRunTokens(item.model.outputTokens), secs === undefined ? '' : fmtSecs(secs)]
}

/** The running row's right end: `41 tools  3m12s`, or a model's output tokens and time. */
export function itemTail(item: OverviewItem, now: number, polledAt: number): string {
  return tailParts(item, now, polledAt)
    .filter(part => part !== '')
    .join('  ')
}

/**
 * `status title` … `tail`, the tail ending at `columns`: the title is cut first, then the tail goes down to its last part;
 * the status and that part go last.
 */
function edgeLine(status: Line, title: string, tail: readonly string[], columns: number): Line {
  const statusW = lineWidth(status)
  const whole = tail.filter(part => part !== '').join('  ')
  const right = statusW + 1 + widthOf(whole) <= columns ? whole : (tail.at(-1) ?? '')
  const room = columns - widthOf(right) - 1
  // Under two cells, ` …` would stand for the title: the status goes on alone.
  const head = fitLine(room >= statusW + 2 ? [...status, { text: ` ${title}` }] : status, room)
  const gap = columns - lineWidth(head) - widthOf(right)

  return fitLine([...head, { text: `${' '.repeat(Math.max(1, gap))}${right}` }], columns)
}

/** A needs-you row: the agent's compact band line, or the model's run line. */
export const pendingLine = (item: OverviewItem, now: number, polledAt: number): Line =>
  item.kind === 'agent' ? agentLine(item.run, now, true) : runLine({ ...item.run, models: [item.model] }, polledAt)

/** `● running worker · Build mm plugin` … `41 tools  3m12s`, the tail ending at `columns`; a quiet agent, none of its calls in `flight`, reads `◐ quiet 2m00s`. */
export function runningLine(item: OverviewItem, now: number, polledAt: number, columns: number, flight?: Flight): Line {
  const status: Line =
    item.kind === 'agent' && isStalled(item.run, now, flight)
      ? [{ text: `◐ ${t().quiet(fmtDuration(now - item.run.lastActivityAt))}`, color: WARNING }]
      : [{ text: '●', color: PERMISSION }, { text: ` ${t().runWord}` }]

  return edgeLine(status, itemTitle(item), tailParts(item, now, polledAt), columns)
}

/** `harness · fix the band`, the title cut to 40 columns. */
export const peerTitle = (peer: SessionPresence) => (peer.title === undefined ? peer.name : `${peer.name} · ${fit(peer.title, PEER_TITLE_COLUMNS)}`)

/** An other-sessions row: `! needs approval harness · fix the band` … `3m05s`, the time ending at `columns`. */
export function sessionLine(peer: ShownPeer, now: number, columns: number): Line {
  const { glyph, color } = PEER_WORDS[peer.state]

  return edgeLine([{ text: glyph, color }, { text: ` ${t().peerWords[peer.state]}` }], peerTitle(peer), [fmtDuration(now - peer.since)], columns)
}

const peerKey = (peer: SessionPresence) => `${peer.id}:${peer.state}:${peer.since}`

/** A toast for another session: `ask` when it asks a permission or failed, `reply` when it replied. */
export type PeerToast = { text: string; kind: 'ask' | 'reply' }

/**
 * Toasts for other sessions in `prev` that newly asked a permission, failed, or replied after a turn of LONG_TURN_MS or more,
 * and `toasted` with every state of `next` added; a session not in `prev` (first read, or back from silence) only adds its state.
 * `toasted` comes back null when nothing was added.
 */
export function peerToasts(toasted: readonly string[], prev: readonly SessionPresence[], next: readonly SessionPresence[]): { toasts: PeerToast[]; toasted: string[] | null } {
  const known = new Set(toasted)
  const fresh = next.filter(peer => !known.has(peerKey(peer)))
  const toasts = fresh
    .filter(peer => prev.some(was => was.id === peer.id))
    .flatMap((peer): PeerToast[] => {
      if (peer.state === 'permission') {
        return [{ text: t().peerPermissionToast(peerTitle(peer), peer.detail ?? ''), kind: 'ask' }]
      }

      if (peer.state === 'failed') {
        return [{ text: t().peerFailedToast(peerTitle(peer)), kind: 'ask' }]
      }

      const turn = peer.turnStartedAt === undefined ? 0 : peer.since - peer.turnStartedAt

      return peer.state === 'replied' && turn >= LONG_TURN_MS ? [{ text: t().peerRepliedToast(peerTitle(peer), fmtDuration(turn), peer.detail ?? ''), kind: 'reply' }] : []
    })

  return { toasts, toasted: fresh.length === 0 ? null : [...toasted, ...fresh.map(peerKey)].slice(-PEER_TOAST_KEYS) }
}

/** `12m` of 12m40s: the idle line's coarse age. */
function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))

  if (s < 60) {
    return `${s}s`
  }

  if (s < 3600) {
    return `${Math.floor(s / 60)}m`
  }

  return s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`
}

/** An ended item's glyph in its state's color, and its words: `worker returned`, `ui / kimi STALE`. */
function endedOf(item: OverviewItem): { glyph: Seg; words: string } {
  if (item.kind === 'agent') {
    const { glyph, color } = glyphOf(item.run.state)

    return { glyph: { text: glyph, color }, words: `${item.run.subagentType} ${t().agentStates[item.run.state]}` }
  }

  const { status } = item.model
  const glyph: Seg = status === 'DONE' ? { text: '✓', color: SUCCESS } : status === 'STALE' ? { text: '~', color: WARNING } : { text: '✗', color: ERROR }

  return { glyph, words: `${runLabel(item.run)} / ${item.model.name} ${status === 'DONE' ? t().agentStates.done : status}` }
}

/** The band with nothing on it, dim: `idle · last ✓ worker returned 12m ago · gate ✓ 186 pass 3m ago`, each part only when there is one. */
export function idleLine(recent: OverviewItem | undefined, gate: GateRun | undefined, now: number): Line {
  const line: Line = [{ text: t().idleBand, dim: true }]

  if (recent !== undefined) {
    const { glyph, words } = endedOf(recent)

    line.push({ text: ` · ${t().idleLast} `, dim: true }, glyph, { text: ` ${words} ${t().gateAgo(fmtAge(now - (endedAtOf(recent) ?? now)))}`, dim: true })
  }

  if (gate !== undefined) {
    const glyph: Seg = { text: isFailedGate(gate) ? '✗' : '✓', color: gate.stale === true ? INACTIVE : isFailedGate(gate) ? ERROR : SUCCESS }
    const stale = gate.stale === true ? ` · ${t().gateStale}` : ''

    line.push({ text: ` · ${t().gateWord} `, dim: true }, glyph, { text: ` ${gateOutcome(gate)}${stale} ${t().gateAgo(fmtAge(now - gate.at))}`, dim: true })
  }

  return line
}

/** `✓ worker · Build mm plugin · 12m00s ago`. */
export function endedText(item: OverviewItem, now: number): string {
  const glyph = item.kind === 'agent' ? glyphOf(item.run.state).glyph : item.model.status === 'DONE' ? '✓' : '✗'

  return `${glyph} ${itemTitle(item)} · ${t().ago(fmtDuration(now - (endedAtOf(item) ?? now)))}`
}

/** Cuts a line of segments to `columns` cells, ending in `…` when cut. */
export function fitLine(line: Line, columns: number): Line {
  if (widthOf(line.map(seg => seg.text).join('')) <= columns) {
    return line
  }

  const out: Line = []
  let left = columns

  for (const seg of line) {
    const width = widthOf(seg.text)

    if (width < left) {
      out.push(seg)
      left -= width
      continue
    }

    // The trailing `…` forces a cut even when this segment alone fits exactly, since more text follows it.
    out.push({ ...seg, text: fit(`${seg.text}…`, left) })
    break
  }

  return out
}

/** `! needs you 2 · ● running 1 · 3 unread · ⊘ aborted 1 · ✗ gates 1 · updated 3s ago`, the zero counts left out; empty when all are zero. */
export function overviewCounts(overview: Overview, now: number, polledAt: number | undefined): Line {
  const needsYou = overview.pending.length + overview.gates.length
  const unread = overview.returned + overview.reviewed
  const parts: Line[] = [
    needsYou > 0 ? [{ text: '!', color: WARNING }, { text: ` ${t().countNeedsYou(needsYou)}` }] : [],
    overview.running.length > 0 ? [{ text: '●', color: PERMISSION }, { text: ` ${t().countRunning(overview.running.length)}` }] : [],
    unread > 0 ? [{ text: t().unreadCount(unread), bold: true }] : [],
    overview.aborted > 0 ? [{ text: '⊘', color: WARNING }, { text: ` ${t().countAborted(overview.aborted)}` }] : [],
    overview.gates.length > 0 ? [{ text: '✗', color: ERROR }, { text: ` ${t().countGates(overview.gates.length)}` }] : [],
  ].filter(part => part.length > 0)

  if (parts.length > 0 && polledAt !== undefined) {
    parts.push([{ text: t().overviewUpdated(fmtDuration(now - polledAt)), dim: true }])
  }

  return parts.flatMap((part, i) => (i === 0 ? part : [{ text: ' · ' }, ...part]))
}

/** Cells a plain Button's hotkey takes before its label: `1: `. */
export const HOTKEY_COLUMNS = 3

/** A row drawn as `before`, a plain Button labelled `label`, then `after`. */
export type ButtonRow = { before: Line; label: string; after: Line }

const isPlainSeg = (seg: Seg) => seg.color === undefined && seg.dim !== true && seg.bold !== true

/** The line's first run of unstyled text becomes the label, its edge spaces kept outside; the styled segments stay as they are. */
export function splitRow(line: Line): ButtonRow {
  const start = line.findIndex(seg => isPlainSeg(seg) && seg.text.trim() !== '')
  let end = start

  while (end < line.length && isPlainSeg(line[end]!)) {
    end += 1
  }

  const text = line
    .slice(start, end)
    .map(seg => seg.text)
    .join('')
  const lead = text.slice(0, text.length - text.trimStart().length)
  const trail = text.slice(text.trimEnd().length)

  return {
    before: [...line.slice(0, start), ...(lead === '' ? [] : [{ text: lead }])],
    label: text.trim(),
    after: [...(trail === '' ? [] : [{ text: trail }]), ...line.slice(end)],
  }
}

// Tables: the gap between columns. On the Agents page, below TASK_MIN_COLUMNS task cells the tokens, model, call-in-flight, tools
// and denied columns go, in that order.
const GAP = '  '
const TASK_MIN_COLUMNS = 12

export type AgentRow = ButtonRow & { run: AgentRun; isDim: boolean }

/** Input tokens all told: uncached, read from the cache, written to it. */
const inputOf = (usage: AgentUsage) => usage.input + usage.cacheRead + usage.cacheWrite

/** The Agents page's tokens: in plus out, `191k`; `—` with no usage known. */
export const tokensText = (usage: AgentUsage | undefined) => fmtTokens(usage && inputOf(usage) + usage.output)

/** `in 182k · cache read 91% · out 9.4k`. */
export const usageText = (usage: AgentUsage) =>
  t().usageLine(fmtTokens(inputOf(usage)), inputOf(usage) === 0 ? 0 : Math.round((usage.cacheRead / inputOf(usage)) * 100), fmtTokens(usage.output))

/**
 * The Agents page: a header `state  type  task  model  time  tokens  tools  denied`, then per run the status cell, a label from
 * the type to the tools, the denied cell and a call still running (`Bash 3m…`, dim); columns line up by display width,
 * the hotkey's cells kept after the status.
 */
export function agentTable(runs: readonly AgentRun[], now: number, columns: number, flights: ReadonlyMap<string, Flight> = new Map()): { head: string; rows: AgentRow[] } {
  const heads = t().agentColumns
  const cells = runs.map(run => {
    const flight = run.state === 'running' ? flights.get(run.agentId) : undefined

    return {
      glyph: glyphOf(run.state),
      word: run.state === 'running' ? t().runWord : t().agentStates[run.state],
      type: run.subagentType,
      task: run.description,
      model: run.model.replace(/^claude-/, ''),
      time: fmtDuration(elapsedOf(run, now)),
      tokens: tokensText(run.usage),
      tools: `${run.tools}`,
      denied: (run.denied ?? 0) > 0 ? `✗${run.denied}` : '',
      flight: flight === undefined ? '' : flightText(flight, now),
    }
  })
  const widest = (head: string, of: (one: (typeof cells)[number]) => string) => Math.max(widthOf(head), ...cells.map(one => widthOf(of(one))))
  const stateW = widest(heads.state, one => `${one.glyph.glyph} ${one.word}`)
  const typeW = Math.min(TYPE_COLUMNS, widest(heads.type, one => one.type))
  const taskMax = widest(heads.task, one => one.task)
  const timeW = widest(heads.time, one => one.time)
  const optional = {
    tokens: widest(heads.tokens, one => one.tokens),
    model: widest(heads.model, one => one.model),
    // No head: the column is there only while a call runs.
    flight: widest('', one => one.flight),
    tools: widest(heads.tools, one => one.tools),
    denied: widest(heads.denied, one => one.denied),
  }
  const shown = { tokens: true, model: true, flight: true, tools: true, denied: true }
  const keys = ['tokens', 'model', 'flight', 'tools', 'denied'] as const
  // The state, the gap and hotkey, the type, the gaps either side of the task, the time, and each optional column shown with its gap.
  const fixed = () =>
    stateW + GAP.length + HOTKEY_COLUMNS + typeW + 2 * GAP.length + timeW + keys.reduce((sum, key) => sum + (shown[key] && optional[key] > 0 ? GAP.length + optional[key] : 0), 0)

  for (const key of keys) {
    if (columns - fixed() >= TASK_MIN_COLUMNS) {
      break
    }

    shown[key] = false
  }

  const taskW = Math.max(0, Math.min(taskMax, columns - fixed()))
  // Past the task the type gives up its cells, then the state word; a column left no cells goes with its gap.
  const typeFit = Math.max(0, Math.min(typeW, columns - fixed() + typeW + (taskW > 0 ? 0 : GAP.length)))
  const isWord = typeFit > 0 || stateW + GAP.length + HOTKEY_COLUMNS + timeW <= columns
  // Without the word: the glyph and a space.
  const beforeW = isWord ? stateW + GAP.length : 2
  const timeFit = Math.max(0, Math.min(timeW, columns - beforeW - HOTKEY_COLUMNS))
  const labelOf = (type: string, task: string, model: string, time: string, tokens: string, tools: string) =>
    [
      ...(typeFit > 0 ? [padTo(fit(type, typeFit), typeFit)] : []),
      ...(taskW > 0 ? [padTo(fit(task, taskW), taskW)] : []),
      ...(shown.model ? [padTo(model, optional.model)] : []),
      alignRight(fit(time, timeFit), timeFit),
      ...(shown.tokens ? [alignRight(tokens, optional.tokens)] : []),
      ...(shown.tools ? [alignRight(tools, optional.tools)] : []),
    ].join(GAP)
  const head = `${padTo(isWord ? heads.state : '', beforeW - GAP.length)}${GAP}${' '.repeat(HOTKEY_COLUMNS)}${[
    labelOf(heads.type, heads.task, heads.model, heads.time, heads.tokens, heads.tools),
    ...(shown.denied ? [heads.denied] : []),
  ].join(GAP)}`

  return {
    head,
    rows: runs.map((run, i) => {
      const one = cells[i]!
      const isDim = run.state === 'done'
      const dim = isDim ? { dim: true } : {}
      const label = labelOf(one.type, one.task, one.model, one.time, one.tokens, one.tools)
      const isFlight = shown.flight && one.flight !== ''
      // The flight cell lines up after the denied column, blank or not.
      const pad = isFlight ? ' '.repeat(optional.denied - widthOf(one.denied)) : ''
      const denied: Line = !shown.denied ? [] : one.denied !== '' ? [{ text: GAP }, { text: one.denied, color: ERROR, ...dim }, ...(pad === '' ? [] : [{ text: pad }])] : isFlight ? [{ text: `${GAP}${pad}` }] : []

      return {
        run,
        isDim,
        before: [
          { text: one.glyph.glyph, color: one.glyph.color, ...dim },
          { text: isWord ? `${padTo(` ${one.word}`, stateW - widthOf(one.glyph.glyph))}${GAP}` : ' ', ...dim },
        ],
        label,
        after: [...denied, ...(isFlight ? [{ text: GAP }, { text: one.flight, dim: true }] : [])],
      }
    }),
  }
}

/** The Agents page's rows: running, failed and unread (ended after `seenAt`) listed; the rest that ended folded. */
export function agentFold(runs: readonly AgentRun[], seenAt: number): { listed: AgentRun[]; folded: AgentRun[] } {
  const isListed = (run: AgentRun) => run.state === 'running' || isFailedAgent(run) || isUnseen(run.endedAt, seenAt)

  return { listed: runs.filter(isListed), folded: runs.filter(run => !isListed(run)) }
}

/** The folded row: `✓4 done`, then `⊘1 aborted` when one was cancelled. */
export function foldText(folded: readonly AgentRun[]): string {
  const aborted = folded.filter(run => run.state === 'aborted').length
  const done = folded.length - aborted

  return [done > 0 ? t().foldDone(done) : '', aborted > 0 ? `⊘${aborted} ${t().agentStates.aborted}` : ''].filter(part => part !== '').join(' · ')
}

/** A model's glyph in its state's color: running, returned, lost contact, failed. */
function modelGlyph(model: MmModel): Seg {
  if (model.status === 'RUNNING') {
    return { text: '●', color: PERMISSION }
  }

  return model.status === 'DONE' ? { text: '✓', color: SUCCESS } : model.status === 'STALE' ? { text: '~', color: WARNING } : { text: '✗', color: ERROR }
}

/**
 * The Reviews page per run: a head `design · review  aaaa  proj`, then `  ● codex  RUNNING  4m15s  25.8k tok` per model, the columns
 * lined up across every run shown; a returned model's row dim. All within `columns`: the model name is cut first, then the tokens go.
 */
export function runTable(runs: readonly MmRun[], polledAt: number, columns: number): { run: MmRun; head: Line; rows: Line[] }[] {
  const models = runs.flatMap(run => run.models)
  const timeOf = (model: MmModel) => {
    const secs = elapsedSecs(model, polledAt)

    return secs === undefined ? '' : fmtSecs(secs)
  }
  const tokOf = (model: MmModel) => fmtRunTokens(model.outputTokens)
  const widest = (of: (model: MmModel) => string) => Math.max(0, ...models.map(model => widthOf(of(model))))
  const nameW = widest(model => model.name)
  const statusW = widest(model => model.status)
  const timeW = widest(timeOf)
  const tokW = widest(tokOf)
  // The indent, the glyph and its space, the status, the time.
  const base = GAP.length + 2 + statusW + GAP.length + timeW
  const isTok = tokW > 0 && base + GAP.length + tokW <= columns
  const nameFit = Math.max(0, Math.min(nameW, columns - base - (isTok ? GAP.length + tokW : 0) - GAP.length))

  return runs.map(run => {
    const dir = run.workdir.split('/').filter(Boolean).pop() ?? run.workdir

    return {
      run,
      head: fitLine([{ text: `${run.tag || '-'} · ${run.mode}`, bold: true }, { text: `${GAP}${run.runid.slice(-4)}${GAP}${dir}`, dim: true }], columns),
      rows: run.models.map(model => {
        const dim = model.status === 'DONE' ? { dim: true } : {}
        const text = [
          ...(nameFit > 0 ? [padTo(fit(model.name, nameFit), nameFit)] : []),
          padTo(model.status, statusW),
          alignRight(timeOf(model), timeW),
          ...(isTok ? [alignRight(tokOf(model), tokW)] : []),
        ].join(GAP)

        return fitLine([{ text: GAP, ...dim }, { ...modelGlyph(model), ...dim }, { text: ` ${text}`.trimEnd(), ...dim }], columns)
      }),
    }
  })
}

// Below this many columns each usage table keeps its name, its main figure and one more.
const USAGE_WIDE_COLUMNS = 60

/** Rows of cells as aligned columns within `columns`: the first left-aligned and cut to the room the others leave, the rest right-aligned. */
function cellLines(rows: readonly string[][], columns: number): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(row => widthOf(row[i]!))))
  const first = Math.max(1, Math.min(widths[0]!, columns - widths.slice(1).reduce((sum, one) => sum + GAP.length + one, 0)))

  return rows.map(row => fit([padTo(fit(row[0]!, first), first), ...row.slice(1).map((cell, i) => alignRight(cell, widths[i + 1]!))].join(GAP), columns))
}

/** The usage page's question lines: dialogs and questions, the share of questions by answer, the dialogs by wait. */
export function askLines(asks: AskCounts): string[] {
  const share = (n: number) => (asks.questions === 0 ? '—' : `${Math.round((n * 100) / asks.questions)}%`)

  return [
    t().usageAsks(asks.dialogs, asks.questions),
    t().usageAskAnswers(share(asks.recommended), share(asks.option), share(asks.typed), share(asks.declined)),
    t().usageAskWaits(asks.under1m, asks.under2m, asks.under5m, asks.under10m, asks.over10m),
  ]
}

/** The usage page as tables: the last 7 days newest first, the main thread against the subagents, the question dialogs, the skills by calls; then what it leaves out. */
export function usageLines(week: UsageWeek, columns: number): Line[] {
  if (isEmptyWeek(week)) {
    return [[{ text: fit(t().usageEmpty, columns), dim: true }]]
  }

  const isWide = columns >= USAGE_WIDE_COLUMNS
  const heads = t().usageColumns
  const total = week.threads.reduce((sum, one) => sum + one.equivalent, 0)
  const share = (n: number) => (total > 0 ? `${Math.round((n * 100) / total)}%` : '—')
  // A day without a request recorded is unknown, not 0.
  const cells = (one: { counts: UsageCounts; equivalent: number }) =>
    [one.equivalent, ...(isWide ? [one.counts.input, one.counts.cacheRead, one.counts.cacheWrite] : []), one.counts.output].map(n => (one.counts.requests === 0 ? '—' : fmtTokens(n)))
  const plain = (text: string): Line => [{ text: fit(text, columns), dim: true }]
  const section = (title: string, rows: string[][]): Line[] => [
    [{ text: fit(title, columns), bold: true }],
    ...cellLines(rows, columns).map((text, i): Line => [{ text, ...(i === 0 && { dim: true }) }]),
  ]

  return [
    ...section(t().usageWeekTitle, [
      isWide ? [heads.day, heads.equivalent, heads.input, heads.cacheRead, heads.cacheWrite, heads.output] : [heads.day, heads.equivalent, heads.output],
      ...week.days.map(one => [one.day.slice(5), ...cells(one)]),
    ]),
    ...t().usageWeights.map(plain),
    ...section(t().usageThreadsTitle, [
      [heads.thread, heads.requests, heads.equivalent, heads.share],
      ...week.threads.map(one => [t().usageThreads[one.thread], String(one.counts.requests), fmtTokens(one.equivalent), share(one.equivalent)]),
    ]),
    ...(week.asks.dialogs === 0 ? [] : [[{ text: fit(t().usageAsksTitle, columns), bold: true }], ...askLines(week.asks).map((text): Line => [{ text: fit(text, columns) }])]),
    ...(week.skills.length === 0
      ? []
      : section(`${t().usageSkillsTitle} · ${week.skills.length}`, [
          isWide ? [heads.skill, heads.calls, heads.inline, heads.forked, heads.errors] : [heads.skill, heads.calls, heads.errors],
          ...week.skills.map(one => [one.name, ...(isWide ? [one.invocations, one.inline, one.forked, one.errors] : [one.invocations, one.errors]).map(String)]),
        ])),
    ...t().usageCoverage.map(plain),
  ]
}

/** Each status's theme key on the progress page. */
export const PROGRESS_COLORS: Record<BoardStatus, string> = { doing: PERMISSION, blocked: ERROR, todo: INACTIVE, done: SUCCESS }

/** The progress page's groups in order, the empty ones left out; each newest first. */
export function progressGroups(nodes: readonly BoardNode[]): { status: BoardStatus; nodes: BoardNode[] }[] {
  const newest = [...nodes].sort((a, b) => b.updatedAt - a.updatedAt)

  return (['doing', 'blocked', 'todo', 'done'] as const).map(status => ({ status, nodes: newest.filter(one => one.status === status) })).filter(group => group.nodes.length > 0)
}

/** `feature · 2026-10-03 · builds on: Usage page, Ask reminder`: a node's kind, the day it last changed and what it extends. */
export function progressMeta(node: BoardNode, nodes: readonly BoardNode[]): string {
  const titles = node.builds_on.map(id => nodes.find(one => one.id === id)?.title ?? id)

  return [t().progressKinds[node.kind], dayOf(node.updatedAt), ...(titles.length === 0 ? [] : [t().progressBuildsOn(titles)])].join(' · ')
}

/** The progress page as lines: per group its head and count, then per node its status and title, its metadata dim beneath. */
export function progressLines(board: BoardRead | null, columns: number): Line[] {
  const nodes = board?.nodes ?? []

  if (nodes.length === 0) {
    return [[{ text: fit(t().progressEmpty(board?.dir ?? null), columns), dim: true }]]
  }

  return progressGroups(nodes).flatMap(group => [
    [{ text: fit(`${t().progressStatuses[group.status]} · ${group.nodes.length}`, columns), bold: true }],
    ...group.nodes.flatMap((node): Line[] => [
      fitLine([{ text: t().progressStatuses[node.status], color: PROGRESS_COLORS[node.status], bold: true }, { text: ` ${node.title}` }], columns),
      [{ text: fit(`  ${progressMeta(node, nodes)}`, columns), dim: true }],
    ]),
  ])
}
