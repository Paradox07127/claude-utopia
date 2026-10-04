import type { AgentInfo, SessionMessage, TurnCompleteReason } from 'claude-code'

import type { AgentRun, AgentRunState, AgentUsage } from '../types'

export const MAX_AGENTS = 30
/** Characters of an agent's final answer kept on its record. */
export const ANSWER_CHARS = 4000

const SLOTS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

/** Running, failed, or ended after `seenAt` (unread): an agent that keeps its digit. */
const holdsSlot = (run: AgentRun, seenAt: number) =>
  run.state === 'running' || run.state === 'error' || run.state === 'refusal' || (run.denied ?? 0) > 0 || (run.endedAt ?? Infinity) > seenAt

/**
 * The new run takes the least digit no running, failed or unread agent holds (`seenAt`: when the Agents page was last
 * visited), a read return giving it up; none when all nine are held.
 */
export function noteSpawn(list: readonly AgentRun[], run: AgentRun, seenAt = 0): AgentRun[] {
  const rest = list.filter(one => one.agentId !== run.agentId)
  const held = new Set(rest.filter(one => holdsSlot(one, seenAt)).map(one => one.slot))
  const slot = SLOTS.find(digit => !held.has(digit))

  if (slot === undefined) {
    return [...rest, run].slice(-MAX_AGENTS)
  }

  const freed = rest.map(one => {
    if (one.slot !== slot) {
      return one
    }

    const { slot: _slot, ...without } = one

    return without
  })

  return [...freed, { ...run, slot }].slice(-MAX_AGENTS)
}

/** A tool call that ended, ran, failed or was denied; one of an ended agent means it was sent on and runs again. */
export function noteTool(list: readonly AgentRun[], agentId: string, label: string, now: number): AgentRun[] {
  return list.map(one => (one.agentId === agentId ? { ...resumed(one, now), tools: one.tools + 1, lastTool: label, lastActivityAt: now } : one))
}

/** A message delivered to an ended agent (`to`, its id) resumes it now, before any tool of it ends. */
export function noteResumed(list: readonly AgentRun[], to: string, now: number): AgentRun[] {
  return list.map(one => (one.agentId === to && one.state !== 'running' ? { ...resumed(one, now), lastActivityAt: now } : one))
}

/**
 * Running again from `now`, the time of its turns before kept in `activeMs`: the end and its tokens go, the last answer stays
 * readable until the next replaces it.
 */
function resumed(run: AgentRun, now: number): AgentRun {
  if (run.state === 'running') {
    return run
  }

  const { endedAt: _endedAt, durationMs, outputTokens: _outputTokens, usage: _usage, ...rest } = run

  return { ...rest, state: 'running', activeMs: durationMs ?? 0, turnAt: now }
}

export function noteDenied(list: readonly AgentRun[], agentId: string): AgentRun[] {
  return list.map(one => (one.agentId === agentId ? { ...one, denied: (one.denied ?? 0) + 1 } : one))
}

export function noteDone(
  list: readonly AgentRun[],
  agentId: string,
  done: { reason: TurnCompleteReason; durationMs: number; outputTokens?: number; endedAt: number; answer?: string; usage?: AgentUsage },
): AgentRun[] {
  return list.map(one =>
    one.agentId === agentId
      ? {
          ...one,
          state: stateOf(done.reason),
          // The engine times the latest turn alone.
          durationMs: (one.activeMs ?? 0) + done.durationMs,
          endedAt: done.endedAt,
          ...(done.outputTokens !== undefined && { outputTokens: done.outputTokens }),
          ...(done.usage !== undefined && { usage: done.usage }),
          ...(done.answer !== undefined && { answer: done.answer.slice(0, ANSWER_CHARS) }),
        }
      : one,
  )
}

/** The `$.agent.list()` statuses that mean an agent ended, as the state it ended in. */
const LISTED_ENDS: Partial<Record<string, AgentRunState>> = { completed: 'done', failed: 'error', killed: 'aborted' }

/** Closes the running agents the engine lists as ended, a killed one having no turn.complete; one it does not list stays as it was. */
export function noteListed(list: readonly AgentRun[], listed: readonly Pick<AgentInfo, 'id' | 'status'>[], now: number): AgentRun[] {
  const ends = new Map(listed.map(info => [info.id, LISTED_ENDS[info.status]]))

  return list.map(one => {
    const state = ends.get(one.agentId)

    return one.state === 'running' && state !== undefined ? { ...one, state, endedAt: now, durationMs: elapsedOf(one, now) } : one
  })
}

export function stateOf(reason: TurnCompleteReason): AgentRunState {
  return reason === 'answer' ? 'done' : reason
}

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

/** `Edit register.tsx`, `Bash git status`, or the bare tool name. */
export function toolLabel(e: { tool: string; file_path?: unknown; command?: unknown }): string {
  if ((e.tool === 'Read' || e.tool === 'Edit' || e.tool === 'Write') && typeof e.file_path === 'string') {
    return `${e.tool} ${baseName(e.file_path)}`
  }

  if (e.tool === 'Bash' && typeof e.command === 'string') {
    return `Bash ${e.command.replace(/\s+/g, ' ').trim().slice(0, 30)}`
  }

  return e.tool
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))

  if (s < 60) {
    return `${s}s`
  }

  if (s < 3600) {
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  }

  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** `950`, `9.4k`, `41k`, `182k`, `1.2M`: one decimal under 100k, none from there to a million; `—` when unknown. */
export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) {
    return '—'
  }

  if (n < 1000) {
    return `${n}`
  }

  if (n < 99_950) {
    return `${Number((n / 1000).toFixed(1))}k`
  }

  return n < 999_500 ? `${Math.round(n / 1000)}k` : `${Number((n / 1_000_000).toFixed(1))}M`
}

export function glyphOf(state: AgentRunState): { glyph: string; color: string } {
  if (state === 'running') {
    return { glyph: '●', color: 'permission' }
  }

  // Cancelled by the person: a warning, red is for failures.
  if (state === 'aborted') {
    return { glyph: '⊘', color: 'warning' }
  }

  return state === 'done' ? { glyph: '✓', color: 'success' } : { glyph: '✗', color: 'error' }
}

export function elapsedOf(run: AgentRun, now: number): number {
  return run.durationMs ?? (run.activeMs ?? 0) + now - (run.turnAt ?? run.startedAt)
}

/**
 * Text after the glyph: `worker  Build mm plugin  3m12s  41 tools  Edit register.tsx`; `isCompact` drops the tool fields.
 * `flight`, a call still running (`Bash 3m…`), stands in for the last tool.
 */
export function bandText(run: AgentRun, now: number, isCompact = false, flight?: string): string {
  const parts = [run.subagentType, run.description, fmtDuration(elapsedOf(run, now))]

  if (run.state === 'running') {
    if (!isCompact) {
      parts.push(`${run.tools} tools`)

      if ((flight ?? run.lastTool) !== '') {
        parts.push(flight ?? run.lastTool)
      }
    }
  } else if (run.outputTokens !== undefined) {
    parts.push(`${fmtTokens(run.outputTokens)} out`)
  }

  return parts.join('  ')
}

// East Asian Wide and Fullwidth ranges; emoji are told by their presentation instead.
const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1aff0, 0x1b2ff],
  [0x1f200, 0x1f2ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// Single character classes, so a grapheme of any length is scanned once.
const PLAIN_ASCII = /^[\x20-\x7e]*$/
const ZERO_WIDTH = /^[\p{M}\p{Default_Ignorable_Code_Point}]+$/u
const EMOJI = /\p{Emoji_Presentation}|\p{Emoji}️/u

const isWide = (char: string) => {
  const codePoint = char.codePointAt(0) ?? 0

  return WIDE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)
}

/** Terminal cells a grapheme takes: 0 for marks and zero-width alone, 2 for an emoji or a wide character. */
function cellsOf(grapheme: string): number {
  if (ZERO_WIDTH.test(grapheme)) {
    return 0
  }

  return EMOJI.test(grapheme) || [...grapheme].some(isWide) ? 2 : 1
}

/** Terminal cells `text` takes. */
export function widthOf(text: string): number {
  if (PLAIN_ASCII.test(text)) {
    return text.length
  }

  let sum = 0

  for (const { segment } of graphemes.segment(text)) {
    sum += cellsOf(segment)
  }

  return sum
}

/** Cuts `text` to at most `columns` cells between graphemes, ending in `…` when cut. */
export function fit(text: string, columns: number): string {
  if (widthOf(text) <= columns) {
    return text
  }

  if (columns <= 0) {
    return ''
  }

  let used = 0
  let out = ''

  for (const { segment } of graphemes.segment(text)) {
    const cells = cellsOf(segment)

    if (used + cells > columns - 1) {
      break
    }

    used += cells
    out += segment
  }

  return `${out}…`
}

/** Calls a running agent's detail lists. */
const PEEK_CALLS = 3
const CALL_CHARS = 80
// The first of these a call's input holds as a string is its summary.
const ARG_KEYS = ['file_path', 'command', 'pattern', 'path', 'url', 'query', 'description', 'prompt', 'skill', 'subagent_type']

const firstLine = (text: string) => text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''

/** `Read board.ts`, `Bash bun test --watch`, `Grep isStalled`, or the bare tool name. */
function callLine(tool: string, input: Record<string, unknown>): string {
  const key = ARG_KEYS.find(one => typeof input[one] === 'string' && (input[one] as string).trim() !== '')

  if (key === undefined) {
    return tool
  }

  const value = String(input[key])
  const arg = key === 'file_path' ? baseName(value) : value.replace(/\s+/g, ' ').trim()

  return `${tool} ${arg}`.slice(0, CALL_CHARS)
}

/** A running agent's transcript in brief: the task it was given, its last three calls, the first line of its latest text. */
export function peekOf(messages: readonly SessionMessage[]): { task: string; calls: string[]; text: string } {
  const uses = messages.filter(one => one.role === 'assistant').flatMap(one => one.toolUses)

  return {
    task: firstLine(messages.find(one => one.role === 'user')?.text ?? ''),
    calls: uses.slice(-PEEK_CALLS).map(use => callLine(use.tool, use.input)),
    text: firstLine(messages.findLast(one => one.role === 'assistant' && one.text.trim() !== '')?.text ?? ''),
  }
}
