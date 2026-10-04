import type { TimelineCompaction, TimelineFork, TimelineStep, TimelineTool, TimelineToolOutcome, TimelineTurn, TimelineUsage } from '../types'

export const MAX_TURNS = 30
export const MAX_STEPS = 400

/** What a turn.step input says of the request, as a step records it. */
export type StepHead = { turnId: string; index: number; agentId?: string; model: string; effort?: string | number; messageCount: number }

/** What a step's stream showed so far, in ms since its hook was entered. */
export type StepWatch = {
  firstMs?: number
  firstKind?: 'thinking' | 'text' | 'tool'
  tools: { toolUseId: string; name: string; atMs: number }[]
}

/** A tool call a step's stream began. */
export type StepTool = { toolUseId: string; name: string; requestedAt: number }

export type ToolEnd = { toolUseId: string; name: string; agentId?: string; endedAt: number; durationMs?: number; outcome: TimelineToolOutcome }

export type TurnEnd = { turnId: string; agentId?: string; endedAt: number; durationMs: number; reason: string }

type ApiUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** The step's end: how long the stream ran, and the result when it returned one. */
export type StepEnd = { ms: number; result?: { stopReason: string | null; usage: ApiUsage | null } }

/** `value` without its undefined fields: state holds JSON, and a merge must not erase what is known. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, one]) => one !== undefined)) as T
}

/** The first thinking, text or tool chunk, and every tool chunk; the rest (engine, input, stop) is not content. */
export function watchChunk(watch: StepWatch, chunk: { kind: string; id?: string; name?: string }, atMs: number): StepWatch {
  const isContent = chunk.kind === 'thinking' || chunk.kind === 'text' || chunk.kind === 'tool'
  const isFirst = isContent && watch.firstKind === undefined
  const isTool = chunk.kind === 'tool' && chunk.id !== undefined

  if (!isFirst && !isTool) {
    return watch
  }

  return {
    ...watch,
    ...(isFirst && { firstMs: atMs, firstKind: chunk.kind as 'thinking' | 'text' | 'tool' }),
    tools: isTool ? [...watch.tools, { toolUseId: chunk.id!, name: chunk.name ?? '', atMs }] : watch.tools,
  }
}

const usageOf = (usage: ApiUsage | null): TimelineUsage | null =>
  usage === null ? null : { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }

/** The step as its hook knows it: at entry (no `end`) or once the stream ended. */
export function stepOf(head: StepHead, sentAt: number, watch: StepWatch, end?: StepEnd): { step: TimelineStep; tools: StepTool[] } {
  const step = defined({
    ...head,
    sentAt,
    ttftMs: watch.firstMs === undefined ? undefined : Math.round(watch.firstMs),
    firstKind: watch.firstKind,
    endedAt: end === undefined ? undefined : sentAt + Math.round(end.ms),
    stepMs: end === undefined ? undefined : Math.round(end.ms),
    stopReason: end?.result?.stopReason,
    usage: end?.result === undefined ? undefined : usageOf(end.result.usage),
    toolUseIds: watch.tools.map(one => one.toolUseId),
  })

  return { step, tools: watch.tools.map(one => ({ toolUseId: one.toolUseId, name: one.name, requestedAt: sentAt + Math.round(one.atMs) })) }
}

/** Drops the oldest whole turns past MAX_TURNS or MAX_STEPS; the newest stays whatever its size. */
function trim(turns: TimelineTurn[]): TimelineTurn[] {
  let from = 0
  let steps = turns.reduce((sum, one) => sum + one.steps.length, 0)

  while (turns.length - from > 1 && (turns.length - from > MAX_TURNS || steps > MAX_STEPS)) {
    steps -= turns[from]!.steps.length
    from += 1
  }

  return from === 0 ? turns : turns.slice(from)
}

const openTurn = (turnId: string, agentId: string | undefined, startedAt: number): TimelineTurn =>
  defined({ turnId, agentId, startedAt, steps: [], tools: [], forks: [] })

/** The loop's running turn, else its latest; -1 when it has none. */
function currentOf(turns: TimelineTurn[], agentId: string | undefined): number {
  const running = turns.findLastIndex(one => one.agentId === agentId && one.endedAt === undefined)

  return running >= 0 ? running : turns.findLastIndex(one => one.agentId === agentId)
}

function replaced(turns: TimelineTurn[], at: number, turn: TimelineTurn): TimelineTurn[] {
  const next = turns.slice()

  next[at] = turn

  return next
}

function withTool(tools: TimelineTool[], tool: TimelineTool): TimelineTool[] {
  const at = tools.findIndex(one => one.toolUseId === tool.toolUseId)

  return at < 0 ? [...tools, tool] : tools.map((one, i) => (i === at ? { ...one, ...tool } : one))
}

export function turnStarted(turns: TimelineTurn[], turnId: string, startedAt: number): TimelineTurn[] {
  return turns.some(one => one.turnId === turnId) ? turns : trim([...turns, openTurn(turnId, undefined, startedAt)])
}

/** Puts the step in its turn, opening the turn at the step when none has its id (a subagent's first step). */
export function stepNoted(turns: TimelineTurn[], step: TimelineStep, tools: StepTool[] = []): TimelineTurn[] {
  const found = turns.findIndex(one => one.turnId === step.turnId)
  const all = found >= 0 ? turns : [...turns, openTurn(step.turnId, step.agentId, step.sentAt)]
  const at = found >= 0 ? found : all.length - 1
  const turn = all[at]!
  const steps = turn.steps.some(one => one.index === step.index) ? turn.steps.map(one => (one.index === step.index ? step : one)) : [...turn.steps, step]
  const merged = tools.reduce(
    (list, one) => withTool(list, defined({ ...one, agentId: step.agentId, turnId: step.turnId, stepIndex: step.index })),
    turn.tools,
  )

  return trim(replaced(all, at, { ...turn, steps, tools: merged }))
}

/** A tool's end, on the turn that requested it, else on its loop's current turn; dropped when the loop has none. */
export function toolEnded(turns: TimelineTurn[], end: ToolEnd): TimelineTurn[] {
  const requested = turns.findIndex(one => one.tools.some(tool => tool.toolUseId === end.toolUseId))
  const at = requested >= 0 ? requested : currentOf(turns, end.agentId)

  if (at < 0) {
    return turns
  }

  const turn = turns[at]!

  return replaced(turns, at, { ...turn, tools: withTool(turn.tools, defined({ ...end, turnId: turn.turnId })) })
}

export function forked(turns: TimelineTurn[], fork: TimelineFork): TimelineTurn[] {
  const at = currentOf(turns, fork.parentAgentId)

  if (at < 0 || turns[at]!.forks.some(one => one.childAgentId === fork.childAgentId)) {
    return turns
  }

  const turn = turns[at]!

  return replaced(turns, at, { ...turn, forks: [...turn.forks, defined(fork)] })
}

/** Closes the turn; one never seen (no step reached a hook) is opened from its duration. */
export function turnEnded(turns: TimelineTurn[], end: TurnEnd): TimelineTurn[] {
  const found = turns.findIndex(one => one.turnId === end.turnId)
  const all = found >= 0 ? turns : [...turns, openTurn(end.turnId, end.agentId, end.endedAt - end.durationMs)]
  const at = found >= 0 ? found : all.length - 1

  return trim(replaced(all, at, { ...all[at]!, endedAt: end.endedAt, durationMs: end.durationMs, reason: end.reason }))
}

export function apiFailed(turns: TimelineTurn[], agentId: string | undefined, apiError: { error: string; details?: string }): TimelineTurn[] {
  const at = currentOf(turns, agentId)

  return at < 0 ? turns : replaced(turns, at, { ...turns[at]!, apiError: defined(apiError) })
}

export function compacted(turns: TimelineTurn[], agentId: string | undefined, marker: TimelineCompaction): TimelineTurn[] {
  const at = currentOf(turns, agentId)

  if (at < 0) {
    return turns
  }

  const turn = turns[at]!

  return replaced(turns, at, { ...turn, compactions: [...(turn.compactions ?? []), defined(marker)] })
}

/**
 * Each step's request plus the longest of its foreground tools (a background fork's call does not hold the turn);
 * undefined while a step has not ended. Tools of a step are taken to run in parallel, a tool without a duration as 0.
 */
export function criticalPathMs(turn: TimelineTurn): number | undefined {
  if (turn.steps.length === 0 || turn.steps.some(one => one.stepMs === undefined)) {
    return undefined
  }

  const background = new Set(turn.forks.filter(one => one.background).map(one => one.toolUseId))

  return turn.steps.reduce((sum, step) => {
    const tools = turn.tools.filter(one => step.toolUseIds.includes(one.toolUseId) && !background.has(one.toolUseId))

    return sum + step.stepMs! + Math.max(0, ...tools.map(one => one.durationMs ?? 0))
  }, 0)
}

export const HOTSPOT_TOOLS = 8
export const HOTSPOT_TURNS = 3

/** One tool's calls that have a duration, over every main turn kept. */
export type ToolHotspot = { name: string; count: number; totalMs: number; maxMs: number }

/** An ended main turn; `ordinal` 1 for the oldest main turn kept; `slowStep` its longest step that ended, absent when none did. */
export type TurnHotspot = { turnId: string; ordinal: number; durationMs: number; slowStep?: { index: number; ms: number } }

/** `turns`: the main turns kept; `model` absent when no step ended with a first token. */
export type Hotspots = { turns: number; tools: ToolHotspot[]; model?: { waitMs: number; genMs: number }; slowest: TurnHotspot[] }

/**
 * Where the main loop's time went: tools by their own duration, the first-token wait against the rest of each step, the slowest turns.
 * What has no sample (a call without a duration, a step or turn still open) is left out, never counted as 0; ties rank by name, or by turn order.
 */
export function hotspotsOf(turns: readonly TimelineTurn[]): Hotspots {
  const main = turns.filter(one => one.agentId === undefined)
  const tools = new Map<string, ToolHotspot>()
  let model: Hotspots['model']

  for (const turn of main) {
    for (const tool of turn.tools) {
      if (tool.durationMs === undefined) {
        continue
      }

      const was = tools.get(tool.name) ?? { name: tool.name, count: 0, totalMs: 0, maxMs: 0 }

      tools.set(tool.name, { name: tool.name, count: was.count + 1, totalMs: was.totalMs + tool.durationMs, maxMs: Math.max(was.maxMs, tool.durationMs) })
    }

    for (const step of turn.steps) {
      if (step.ttftMs === undefined || step.stepMs === undefined) {
        continue
      }

      const waitMs = Math.min(step.ttftMs, step.stepMs)

      model = { waitMs: (model?.waitMs ?? 0) + waitMs, genMs: (model?.genMs ?? 0) + step.stepMs - waitMs }
    }
  }

  const ended = main.flatMap((turn, i): TurnHotspot[] => {
    const durationMs = turn.durationMs ?? (turn.endedAt === undefined ? undefined : turn.endedAt - turn.startedAt)
    const slow = turn.steps.reduce<TimelineStep | undefined>((best, one) => (one.stepMs !== undefined && (best === undefined || one.stepMs > best.stepMs!) ? one : best), undefined)

    return durationMs === undefined ? [] : [{ turnId: turn.turnId, ordinal: i + 1, durationMs, ...(slow !== undefined && { slowStep: { index: slow.index, ms: slow.stepMs! } }) }]
  })

  return {
    turns: main.length,
    tools: [...tools.values()].sort((a, b) => b.totalMs - a.totalMs || a.name.localeCompare(b.name)).slice(0, HOTSPOT_TOOLS),
    ...(model !== undefined && { model }),
    slowest: ended.sort((a, b) => b.durationMs - a.durationMs || a.ordinal - b.ordinal).slice(0, HOTSPOT_TURNS),
  }
}

/** A subagent's tool call that began and has not ended. */
export type Flight = { name: string; requestedAt: number }

/** Per subagent with a turn still open, the call of that turn running longest; a turn that ended holds none. */
export function toolsInFlight(turns: readonly TimelineTurn[]): Map<string, Flight> {
  const flights = new Map<string, Flight>()

  for (const turn of turns) {
    if (turn.agentId === undefined || turn.endedAt !== undefined) {
      continue
    }

    const open = turn.tools.filter((one): one is typeof one & { requestedAt: number } => one.requestedAt !== undefined && one.endedAt === undefined)
    const oldest = open.reduce<(typeof open)[number] | undefined>((best, one) => (best === undefined || one.requestedAt < best.requestedAt ? one : best), undefined)

    if (oldest === undefined) {
      flights.delete(turn.agentId)
    } else {
      flights.set(turn.agentId, { name: oldest.name, requestedAt: oldest.requestedAt })
    }
  }

  return flights
}
