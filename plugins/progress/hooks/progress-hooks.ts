import type { EngineInterface, HookFailure, Register } from 'claude-code'

import type { BoardEvent, BoardNode } from '../types'
import { failureLine } from './failures'
import { boardDir, canvasPath, canvasProject, canvasWrites, eventsDir, foldBoard, NEW_COMMITS, parseBoardEvents, parseNodesReply, parseStorage, planNodes, RECORD_SYSTEM, recordPrompt } from './progress'
import type { BoardStorage, CanvasSync } from './progress'
import { projectKey } from './usage'

// The progress board's recorder, alone: it imports nothing of the workbench, so a release ships it as a plugin of its own.
// Each session writes only its own <events dir>/<id>.json, whole after each recording; the board folds them all.

const GIT_TIMEOUT_MS = 10_000
const MODEL_TIMEOUT_MS = 120_000

/** The main loop's turn under way: the prompt the person typed to start it, null for any other start; HEAD as it began; the paths any agent edited in it. */
type MainTurn = { id: string; typed: string | null; head: string | null; edits: Set<string> }

// A typed prompt, from its prompt.submit until the turn.start it begins.
let typedPrompt: string | null = null
let current: MainTurn | null = null
// One recording at a time, so each one sees the nodes of the one before.
let recording: Promise<void> = Promise.resolve()
// The person dismissed the storage question: not asked again this session.
let isStorageDeclined = false

/** The repository's main worktree root, so a linked worktree's session shares its project; else the session root. */
async function ledgerRoot($: EngineInterface): Promise<string> {
  return (await $.session.repo().catch(() => null))?.root ?? (await $.session.root())
}

/** The project's board: its key and config dir under the home directory, the session root, and the storage chosen, null before the person chose. */
async function boardPlace($: EngineInterface): Promise<{ home: string; project: string; root: string; storage: BoardStorage | null }> {
  const home = (await $.env.get('HOME')) ?? ''
  const project = projectKey(await ledgerRoot($))
  const storage = parseStorage(String(await $.fs.read(`${boardDir(home, project)}/config.json`).catch(() => '')))

  return { home, project, root: await $.session.root(), storage }
}

/** Every session's events in `dir` by file name; a file that does not parse is skipped. */
async function readEvents($: EngineInterface, dir: string): Promise<Record<string, BoardEvent[]>> {
  const files: Record<string, BoardEvent[]> = {}

  for (const entry of await $.fs.list(dir).catch(() => [])) {
    const events = entry.kind === 'file' && entry.name.endsWith('.json') ? parseBoardEvents(String(await $.fs.read(`${dir}/${entry.name}`).catch(() => ''))) : null

    if (events !== null) {
      files[entry.name] = events
    }
  }

  return files
}

/** A small JSON file's top-level object; empty when it is missing or of another shape. */
function jsonOf(text: unknown): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(String(text))

    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** What git prints in `root`, trimmed; null when it fails or prints nothing. */
async function gitOut($: EngineInterface, root: string, args: string[]): Promise<string | null> {
  const run = await $.process.run(['git', '-C', root, ...args], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)

  return run?.exitCode === 0 && run.stdout.trim() !== '' ? run.stdout.trim() : null
}

/** The person's choice of where the project's board lives, kept in its config; null when dismissed, answered otherwise, or dismissed before. */
async function askStorage($: EngineInterface, project: string, root: string): Promise<BoardStorage | null> {
  if (isStorageDeclined) {
    return null
  }

  const question = `Each typed turn that changes files or makes a commit is recorded on this project's progress board. local keeps it in ${boardDir('~', project)}/events/, private to this machine; git keeps it in ${root}/.notes/board/events/, committed with the project. Where should it be kept?`
  const answer = await $.ui.ask(question, { options: ['local', 'git'], header: 'Progress' }).catch(() => null)

  if (answer !== 'local' && answer !== 'git') {
    isStorageDeclined = true

    return null
  }

  const home = (await $.env.get('HOME')) ?? ''
  const configPath = `${boardDir(home, project)}/config.json`

  await $.fs.write(configPath, JSON.stringify({ ...jsonOf(await $.fs.read(configPath).catch(() => '')), storage: answer }))

  return answer
}

/** Mirrors the recorded events to the canvas when it has a url; the backfill is marked done only once a batch carrying it went through. */
async function syncCanvas($: EngineInterface, home: string, project: string, events: readonly BoardEvent[], nodes: readonly BoardNode[], now: number): Promise<void> {
  const url = jsonOf(await $.fs.read(canvasPath(home)).catch(() => '')).url

  if (typeof url !== 'string' || url === '') {
    return
  }

  const configPath = `${boardDir(home, project)}/config.json`
  const isBackfill = jsonOf(await $.fs.read(configPath).catch(() => '')).canvasBackfilled !== true
  const sync: CanvasSync = { url, project: canvasProject(project), name: (await ledgerRoot($)).split('/').pop() ?? project, at: now, isBackfill }
  const r: { deny?: string; isError?: true; text?: string } = await $.tool
    .call({ tool: 'ArtifactData', action: 'batch', url, writes: canvasWrites(events, nodes, sync) } as never)
    .catch((error: unknown) => ({ deny: String(error) }))

  if (r.deny !== undefined || r.isError === true) {
    $.ui.log(`progress: the canvas batch failed: ${r.deny ?? r.text ?? 'an error result'}`, { to: 'debug' })

    return
  }

  if (isBackfill) {
    await $.fs.write(configPath, JSON.stringify({ ...jsonOf(await $.fs.read(configPath).catch(() => '')), canvasBackfilled: true }))
  }
}

/** Records a typed turn that edited a file or moved HEAD: the model names its nodes from the turn's facts, the events go to this session's file. */
async function record($: EngineInterface, turn: MainTurn & { typed: string }, answer: string): Promise<void> {
  const root = await $.session.root()
  const head = await gitOut($, root, ['rev-parse', 'HEAD'])
  const isMoved = head !== null && head !== turn.head

  if (turn.edits.size === 0 && !isMoved) {
    return
  }

  const place = await boardPlace($)
  const storage = place.storage ?? (await askStorage($, place.project, place.root))

  if (storage === null) {
    return
  }

  const dir = eventsDir(storage, place.home, place.project, place.root)
  const files = await readEvents($, dir)
  const session = await $.session.id()
  const before = Object.values(files).flat()
  const board = foldBoard(before)
  const ownIds = new Set((files[`${session}.json`] ?? []).map(one => one.node))
  const log = isMoved && turn.head !== null ? await gitOut($, root, ['log', '--format=%h %s', '-n', String(NEW_COMMITS), `${turn.head}..${head}`]) : null
  const edits = [...turn.edits].map(path => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path))
  const prompt = recordPrompt({ prompt: turn.typed, answer, edits, commits: log?.split('\n') ?? [], board, own: board.filter(one => ownIds.has(one.id)) })
  const reply = await $.model.complete({ model: 'sonnet', system: RECORD_SYSTEM, prompt, effort: 'low', maxTokens: 2000, timeoutMs: MODEL_TIMEOUT_MS })

  if (!reply.isAnswered) {
    $.ui.log(`progress: nothing recorded, the model did not answer (${reply.reason})`, { to: 'debug' })

    return
  }

  const parsed = parseNodesReply(reply.text)

  if ('error' in parsed) {
    $.ui.log(`progress: nothing recorded, ${parsed.error}`, { to: 'debug' })

    return
  }

  if (parsed.nodes.length === 0) {
    return
  }

  const commit = await gitOut($, root, ['rev-parse', '--short', 'HEAD'])
  const now = await $.clock.now()
  const plan = planNodes(parsed.nodes, board, now, session, commit)

  if ('error' in plan) {
    $.ui.log(`progress: nothing recorded, ${plan.error}`, { to: 'debug' })

    return
  }

  await $.fs.write(`${dir}/${session}.json`, JSON.stringify([...(files[`${session}.json`] ?? []), ...plan.events]))
  await syncCanvas($, place.home, place.project, plan.events, foldBoard([...before, ...plan.events]), now)
}

/** A hook's `.catch`: its failure to the debug log, once per hook this load. Declared per file: validate follows $ into this file's functions only. */
function hookFailed($: EngineInterface, name: string, error: HookFailure): void {
  const line = failureLine(name, error)

  if (line !== undefined) {
    $.ui.log(line, { to: 'debug' })
  }
}

export const register: Register = on => {
  // A matcher on every hook: in the source tree register.tsx holds the matcher-less one on each of these events, and the engine refuses a second.
  on('prompt.submit', { wait: [true, false] }, async ($, e, next) => {
    // Set before next: the turn the prompt begins starts inside it. Only the person's own Enter is typed.
    typedPrompt = e.origin.kind === 'composer' ? e.text : null

    const r = await next(e)

    if (r.drop !== undefined) {
      typedPrompt = null
    }

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'prompt.submit (progress)', next.error)

    return next(e)
  })

  // Only the main loop raises turn.start.
  on('turn.start', { text: /^/ }, async ($, e, next) => {
    const typed = typedPrompt

    typedPrompt = null
    current = { id: e.turnId, typed, head: typed === null ? null : await gitOut($, await $.session.root(), ['rev-parse', 'HEAD']), edits: new Set() }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'turn.start (progress)', next.error)

    return next(e)
  })

  // Every agent's edits, subagents' included, count for the main turn under way.
  on('classic.PostToolUse', { tool_name: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] }, async ($, e, next) => {
    const input = typeof e.tool_input === 'object' && e.tool_input !== null ? (e.tool_input as Record<string, unknown>) : {}
    const path = input.file_path ?? input.notebook_path

    if (typeof path === 'string') {
      current?.edits.add(path)
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PostToolUse (progress)', next.error)

    return next(e)
  })

  on('turn.complete', { turnId: /^/ }, async ($, e, next) => {
    const turn = current

    if (e.agentId === undefined && turn?.id === e.turnId) {
      current = null

      if (!e.isAborted && turn.typed !== null) {
        const typed = turn.typed

        recording = recording.then(() => record($, { ...turn, typed }, e.answer)).catch((error: unknown) => $.ui.log(`progress: recording failed: ${String(error)}`, { to: 'debug' }))
      }
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'turn.complete (progress)', next.error)

    return next(e)
  })
}
