import type { EngineInterface, HookFailure, Register } from 'claude-code'

import type { BoardEvent } from '../types'
import { failureLine } from './failures'
import { boardDir, canvasPath, canvasProject, eventsDir, foldBoard, listText, parseBoardEvents, parseStorage, planNodes, PROGRESS_TOOL, recordedText, storageQuestion } from './progress'
import type { BoardStorage, CanvasSync } from './progress'
import { projectKey } from './usage'

// The progress board's tool, alone: it imports nothing of the workbench, so a release ships it as a plugin of its own.
// Each session writes only its own <events dir>/<id>.json, whole after each call; the board folds them all.

const GIT_TIMEOUT_MS = 10_000

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

/** Serves the progress tool: the storage question, the recent nodes, or the call's events written after every node checked. */
async function progressCall($: EngineInterface, input: Record<string, unknown>): Promise<{ result: string } | { deny: string }> {
  const place = await boardPlace($)
  const chosen = input.storage === 'local' || input.storage === 'git' ? input.storage : null

  if (input.storage !== undefined && chosen === null) {
    return { deny: `Nothing recorded: storage: ${JSON.stringify(input.storage)} is not one of local, git` }
  }

  const storage = chosen ?? place.storage

  if (storage === null) {
    return { result: storageQuestion(place.project, place.root) }
  }

  const dir = eventsDir(storage, place.home, place.project, place.root)
  const files = await readEvents($, dir)
  const before = Object.values(files).flat()

  if (input.nodes === undefined && input.list === true) {
    return { result: listText(foldBoard(before)) }
  }

  const session = await $.session.id()
  const head = await $.process.run(['git', '-C', place.root, 'rev-parse', '--short', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
  const commit = head?.exitCode === 0 && head.stdout.trim() !== '' ? head.stdout.trim() : null
  const now = await $.clock.now()
  const plan = planNodes(input.nodes, foldBoard(before), now, session, commit)

  if ('error' in plan) {
    return { deny: `Nothing recorded: ${plan.error}` }
  }

  const path = `${dir}/${session}.json`
  const nodes = foldBoard([...before, ...plan.events])
  const configPath = `${boardDir(place.home, place.project)}/config.json`
  const config = jsonOf(await $.fs.read(configPath).catch(() => ''))
  const url = jsonOf(await $.fs.read(canvasPath(place.home)).catch(() => '')).url
  const sync: CanvasSync | null =
    typeof url === 'string' && url !== ''
      ? { url, project: canvasProject(place.project), name: (await ledgerRoot($)).split('/').pop() ?? place.project, at: now, isBackfill: config.canvasBackfilled !== true }
      : null

  if ((chosen !== null && chosen !== place.storage) || sync?.isBackfill === true) {
    await $.fs.write(configPath, JSON.stringify({ ...config, storage, ...(sync !== null && { canvasBackfilled: true }) }))
  }

  await $.fs.write(path, JSON.stringify([...(files[`${session}.json`] ?? []), ...plan.events]))

  return { result: recordedText(plan.events, nodes, path, sync) }
}

/** The tool's full name for the plugin this module loads in: dashboard in the source tree, progress once released. */
const toolOf = ($: EngineInterface) => `mcp__${$.plugin.name}__${PROGRESS_TOOL.name}`

/** A hook's `.catch`: its failure to the debug log, once per hook this load. Declared per file: validate follows $ into this file's functions only. */
function hookFailed($: EngineInterface, name: string, error: HookFailure): void {
  const line = failureLine(name, error)

  if (line !== undefined) {
    $.ui.log(line, { to: 'debug' })
  }
}

export const register: Register = on => {
  // Beside register.tsx's matcher-less session.start in the source tree, where the engine refuses a second: this matcher selects every start.
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    await $.tool.register(PROGRESS_TOOL)

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'session.start (progress)', next.error)

    return next(e)
  })

  // Literal names, never Bash: the tool in the source tree and once released; the other plugin's call passes on.
  on('tool.call', { tool: ['mcp__dashboard__progress', 'mcp__progress__progress'] }, async ($, e, next) => (e.tool === toolOf($) ? progressCall($, e as unknown as Record<string, unknown>) : next(e))).catch(($, e, next) => {
    if (e.tool !== toolOf($)) {
      return next(e)
    }

    hookFailed($, 'tool.call (progress)', next.error)

    return { deny: `The progress tool failed: ${next.error.message ?? next.error.kind}` }
  })
}
