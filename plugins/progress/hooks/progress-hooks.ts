import type { EngineInterface, HookFailure, ModelCompleteRequest, ModelCompleteResult, Register } from 'claude-code'

import type { BoardEvent, LineEvent, LineKeys, NodeEvent, RequestEvent } from '../types'
import { failureLine } from './failures'
import {
  boardDir,
  canvasPath,
  canvasBatches,
  canvasProject,
  canvasWrites,
  closeEvents,
  CONSOLIDATE_SYSTEM,
  consolidatePrompt,
  hasConsolidationWork,
  eventsDir,
  foldBoard,
  foldLines,
  foldRequests,
  growKeys,
  isStrong,
  LINE_NAME_CHARS,
  lineCandidates,
  NEW_COMMITS,
  newLineId,
  NO_CHECKS,
  OLD_PIECES,
  oldPieces,
  noKeys,
  parseBoardEvents,
  parseNodesReply,
  parseOpsReply,
  parseStorage,
  pastCorrections,
  pathKeys,
  planConsolidation,
  planNodes,
  planRequest,
  RECORD_SYSTEM,
  recordPrompt,
  replyLine,
  replyRequest,
  scopeOf,
  titlePattern,
} from './progress'
import type { BoardStorage, CanvasSync, CloseFacts, LineSignals } from './progress'
import { summarizeTests } from './summarize-tests'
import { dayOf, projectKey } from './usage'

// The progress board's recorder, alone: it imports nothing of the workbench, so a release ships it as a plugin of its own.
// Each session writes only its own <events dir>/<id>.json, whole after each recording; the board folds them all.

const GIT_TIMEOUT_MS = 10_000
const MODEL_TIMEOUT_MS = 120_000
const UNTYPED = '(not typed: a notification, a queued or a plugin prompt)'
const CLOSE_USAGE = 'Usage: /progress-close <node or request id> done|dropped'
const LINE_USAGE = 'Usage: /progress-line <request id> <line id>, or /progress-line <request id> new <name>'
const COMMAND_CHARS = 120
const MAX_DIRS = 8
const PLAN_TOOL = {
  name: 'progress_plan',
  description:
    "Records the plan for the person's request on the progress board: a title, 1 to 3 checkable acceptance items and 1 to 6 steps. Call it once the plan is settled and before making changes. Call it again with request when the plan changes: the new steps join that request, and drop names its steps the new plan no longer needs. Not for questions or chat. It records the plan on the progress board and costs nothing else.",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 60, description: 'The outcome the person asked for.' },
      acceptance: { type: 'array', items: { type: 'string', maxLength: 120 }, minItems: 1, maxItems: 3, description: 'Checkable conditions that show the request is met.' },
      steps: { type: 'array', items: { type: 'string', maxLength: 60 }, minItems: 1, maxItems: 6, description: 'The steps of the plan, each a piece of work on the board.' },
      request: { type: 'string', description: 'An existing request id: continue it, adding the steps; a closed one is reopened.' },
      drop: { type: 'array', items: { type: 'string' }, description: 'Piece ids of that request the new plan no longer needs.' },
    },
    required: ['title', 'acceptance', 'steps'],
  },
}

/**
 * The main loop's turn under way: the prompt the person typed to start it, null for any other start; HEAD as it began; the
 * paths any agent edited in it; the last test run that passed after its last edit, null when none.
 */
type MainTurn = { id: string; typed: string | null; head: string | null; edits: Set<string>; passed: { command: string; at: number } | null }

// The turn under way is also kept in $.store (not $.state: its refs name the plugin, which the split release renames), so a reload mid-turn loses none of it.
const turnKey = async ($: EngineInterface) => `turn:${await $.session.id()}`

// The session's current request, the one new pieces join.
const requestKey = async ($: EngineInterface) => `request:${await $.session.id()}`

// The line of this session's last assigned request.
const lineKey = async ($: EngineInterface) => `line:${await $.session.id()}`

async function storedLine($: EngineInterface): Promise<string> {
  const line: unknown = await $.store.get(await lineKey($))

  return typeof line === 'string' ? line : ''
}

/** `grown` holds a key `keys` lacks. */
const isGrown = (keys: LineKeys, grown: LineKeys) => (['paths', 'scopes', 'patterns'] as const).some(kind => grown[kind].some(one => !keys[kind].includes(one)))

async function storeTurn($: EngineInterface, turn: MainTurn): Promise<void> {
  await $.store.set(await turnKey($), { id: turn.id, typed: turn.typed, head: turn.head, edits: [...turn.edits], ...(turn.passed !== null && { passed: turn.passed }) })
}

/** The turn kept in $.store, when there is one of that shape and, given `id`, of that id. */
async function storedTurn($: EngineInterface, id?: string): Promise<MainTurn | null> {
  const raw = (await $.store.get(await turnKey($))) as Partial<Record<keyof MainTurn, unknown>> | undefined

  if (typeof raw !== 'object' || raw === null || typeof raw.id !== 'string' || (id !== undefined && raw.id !== id) || !Array.isArray(raw.edits)) {
    return null
  }

  const passed = raw.passed as { command?: unknown; at?: unknown } | undefined

  return {
    id: raw.id,
    typed: typeof raw.typed === 'string' ? raw.typed : null,
    head: typeof raw.head === 'string' ? raw.head : null,
    edits: new Set(raw.edits.filter((one): one is string => typeof one === 'string')),
    passed: typeof passed?.command === 'string' && typeof passed.at === 'number' ? { command: passed.command, at: passed.at } : null,
  }
}

// A typed prompt, from its prompt.submit until the turn.start it begins.
let typedPrompt: string | null = null
let current: MainTurn | null = null
// One recording at a time, so each one sees the nodes of the one before.
let recording: Promise<unknown> = Promise.resolve()
// The person dismissed the storage question: not asked again this session.
let isStorageDeclined = false
// The daily consolidation is queued at most once per load.
let isConsolidationQueued = false

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

/** The commits of `shas` on the main branch (`main` when it exists, else `master`), with its name; null when none is. */
async function onMain($: EngineInterface, root: string, shas: readonly string[]): Promise<CloseFacts['onMain']> {
  if (shas.length === 0) {
    return null
  }

  const branch = (await gitOut($, root, ['rev-parse', '--verify', 'main'])) !== null ? 'main' : 'master'
  const found: string[] = []

  for (const sha of shas) {
    const run = await $.process.run(['git', '-C', root, 'merge-base', '--is-ancestor', sha, branch], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)

    if (run?.exitCode === 0) {
      found.push(sha)
    }
  }

  return found.length === 0 ? null : { shas: found, branch }
}

/** A Bash result's text as the workbench's test gates read it: an errored call's text, else stdout and stderr. */
function bashOutput(output: unknown): string | null {
  if (typeof output === 'string') {
    return output
  }

  const out = typeof output === 'object' && output !== null ? (output as { stdout?: unknown; stderr?: unknown }) : null

  if (out === null || typeof out.stdout !== 'string') {
    return null
  }

  return typeof out.stderr === 'string' ? `${out.stdout}\n${out.stderr}` : out.stdout
}

/** The person's choice of where the project's board lives, kept in its config; null when dismissed, answered otherwise, or dismissed before. */
async function askStorage($: EngineInterface, project: string, root: string): Promise<BoardStorage | null> {
  if (isStorageDeclined) {
    return null
  }

  const question = `Each typed turn that changes files, and each turn that makes a commit, is recorded on this project's progress board. local keeps it in ${boardDir('~', project)}/events/, private to this machine; git keeps it in ${root}/.notes/board/events/, committed with the project. Where should it be kept?`
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

/**
 * Mirrors the written events to the canvas when it has a url, folding the board from `after`: the writes in batches, in order,
 * up to the first that fails. The backfill is marked done only once every batch went through.
 */
async function syncCanvas($: EngineInterface, home: string, project: string, events: readonly BoardEvent[], after: readonly BoardEvent[], now: number): Promise<void> {
  const url = jsonOf(await $.fs.read(canvasPath(home)).catch(() => '')).url

  if (typeof url !== 'string' || url === '') {
    return
  }

  const configPath = `${boardDir(home, project)}/config.json`
  const isBackfill = jsonOf(await $.fs.read(configPath).catch(() => '')).canvasBackfilled !== true
  const sync: CanvasSync = { url, project: canvasProject(project), name: (await ledgerRoot($)).split('/').pop() ?? project, at: now, isBackfill }
  const board = { nodes: foldBoard(after), requests: foldRequests(after, now), lines: foldLines(after) }

  for (const writes of canvasBatches(canvasWrites(events, board, sync))) {
    const r: { deny?: string; isError?: true; text?: string } = await $.tool.call({ tool: 'ArtifactData', action: 'batch', url, writes } as never).catch((error: unknown) => ({ deny: String(error) }))

    if (r.deny !== undefined || r.isError === true) {
      $.ui.log(`progress: the canvas batch failed: ${r.deny ?? r.text ?? 'an error result'}`, { to: 'debug' })

      return
    }
  }

  if (isBackfill) {
    await $.fs.write(configPath, JSON.stringify({ ...jsonOf(await $.fs.read(configPath).catch(() => '')), canvasBackfilled: true }))
  }
}

/** $.model.complete, one line of its usage, or of why it did not answer, appended to the project's <board dir>/recorder-usage.jsonl. */
async function complete($: EngineInterface, home: string, project: string, request: ModelCompleteRequest): Promise<ModelCompleteResult> {
  const reply = await $.model.complete(request)
  const at = await $.clock.now()
  const session = await $.session.id()
  const { usage } = reply
  const line = reply.isAnswered
    ? { at, session, input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }
    : { at, session, failed: reply.reason }
  const path = `${boardDir(home, project)}/recorder-usage.jsonl`

  await $.fs.write(path, `${String(await $.fs.read(path).catch(() => ''))}${JSON.stringify(line)}\n`)

  return reply
}

/**
 * Records a typed turn that edited a file or moved HEAD, or another turn that moved HEAD: the model names its nodes from the
 * turn's facts, they join the session's current request (or the one the reply names), the events go to this session's file
 * with any request the rules close.
 */
async function record($: EngineInterface, turn: MainTurn, answer: string): Promise<void> {
  const root = await $.session.root()
  const head = await gitOut($, root, ['rev-parse', 'HEAD'])
  const isMoved = head !== null && head !== turn.head

  if (!isMoved && (turn.typed === null || turn.edits.size === 0)) {
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
  const requests = foldRequests(before, await $.clock.now())
  const stored: unknown = await $.store.get(await requestKey($))
  const open = requests.find(one => one.id === stored && one.status === 'open') ?? null
  const ownIds = new Set((files[`${session}.json`] ?? []).flatMap(one => (one.type === 'add' || one.type === 'update' ? [one.node] : [])))
  const log = isMoved && turn.head !== null ? await gitOut($, root, ['log', '--format=%h %s', '-n', String(NEW_COMMITS), `${turn.head}..${head}`]) : null
  const commits = log?.split('\n') ?? []
  const edits = [...turn.edits].map(path => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path))
  const lines = foldLines(before)
  const signals: LineSignals = {
    paths: pathKeys(edits),
    scopes: [...new Set(commits.flatMap(line => scopeOf(line.slice(line.indexOf(' ') + 1)) ?? []))],
    pattern: open === null ? '' : titlePattern(open.title),
    lastLine: await storedLine($),
  }
  const isLineAsked = open === null || open.line === ''
  const candidates = isLineAsked ? lineCandidates(lines, signals) : []
  const prompt = recordPrompt({
    prompt: turn.typed ?? UNTYPED,
    answer,
    edits,
    commits,
    current: open === null ? null : { request: open, pieces: board.filter(one => one.request === open.id) },
    requests,
    own: board.filter(one => ownIds.has(one.id) && one.request === ''),
    candidates,
    corrections: isLineAsked ? pastCorrections(before, requests, lines, signals) : [],
  })
  const reply = await complete($, place.home, place.project, { model: 'sonnet', system: RECORD_SYSTEM, prompt, effort: 'low', maxTokens: 2000, timeoutMs: MODEL_TIMEOUT_MS })

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
  const joined = open !== null ? { request: open.id, events: [] } : replyRequest(parsed.request, requests, new Set(requests.map(one => one.id)), now, session, commit)

  if ('error' in joined) {
    $.ui.log(`progress: nothing recorded, ${joined.error}`, { to: 'debug' })

    return
  }

  const plan = planNodes(parsed.nodes, board, now, session, commit, joined.request)

  if ('error' in plan) {
    $.ui.log(`progress: nothing recorded, ${plan.error}`, { to: 'debug' })

    return
  }

  const request = foldRequests([...before, ...joined.events], now).find(one => one.id === joined.request)
  const chosen = request?.line === '' && parsed.line !== undefined ? replyLine(parsed.line, parsed.line_why, candidates, lines, now, session, commit) : null

  if (chosen !== null && 'error' in chosen) {
    $.ui.log(`progress: nothing recorded, ${chosen.error}`, { to: 'debug' })

    return
  }

  if (request?.line === '' && chosen === null) {
    $.ui.log(`progress: the reply gives no line, request ${joined.request} stays without one`, { to: 'debug' })
  }

  const lineId = chosen?.line ?? request?.line ?? ''
  const keys = lines.find(one => one.id === lineId)?.keys ?? noKeys()
  const grown = growKeys(keys, { ...signals, pattern: titlePattern(request?.title ?? '') })
  const lineEvents: BoardEvent[] =
    lineId === ''
      ? []
      : [
          ...(chosen?.events ?? []),
          ...(chosen === null ? [] : [{ type: 'request' as const, request: joined.request, at: now, session, commit, fields: { line: lineId } }]),
          ...(chosen === null && !isGrown(keys, grown) ? [] : [{ type: 'line' as const, line: lineId, at: now, session, commit, fields: { keys: grown } }]),
        ]
  const shas = commits.map(line => line.split(' ')[0]!).filter(sha => sha !== '')
  // Top-level directories; `.` for a file at the root.
  const dirs = [...new Set(edits.filter(path => !path.startsWith('/')).map(path => (path.includes('/') ? path.split('/')[0]! : '.')))].slice(0, MAX_DIRS)
  const nodeEvents = plan.events.map(one => ({ ...one, turn: turn.id, commits: shas, dirs }))
  const after = [...before, ...joined.events, ...nodeEvents, ...lineEvents]
  const nodes = foldBoard(after)
  // Only the requests this turn's pieces belong to: its commits and test runs say nothing of the others.
  const touched = new Set(nodes.filter(node => nodeEvents.some(one => one.node === node.id)).map(node => node.request))
  const facts: CloseFacts = { onMain: await onMain($, root, shas), passedTests: turn.passed?.command ?? null }
  const closing = closeEvents(foldRequests(after, now).filter(one => touched.has(one.id)), nodes, facts, now, session, commit)
  // Read again: the progress page's Done / Drop may have written this file while the model answered.
  const own = parseBoardEvents(String(await $.fs.read(`${dir}/${session}.json`).catch(() => ''))) ?? files[`${session}.json`] ?? []

  await $.fs.write(`${dir}/${session}.json`, JSON.stringify([...own, ...joined.events, ...nodeEvents, ...lineEvents, ...closing]))

  if (closing.some(one => one.request === joined.request)) {
    await $.store.delete(await requestKey($))
  } else if (open === null) {
    await $.store.set(await requestKey($), joined.request)
  }

  if (chosen !== null) {
    await $.store.set(await lineKey($), chosen.line)
  }

  await syncCanvas($, place.home, place.project, [...joined.events, ...nodeEvents, ...lineEvents, ...closing], [...after, ...closing], now)
}

/**
 * progress_plan: the plan's request and steps written to this session's file, the request made the session's current one. A
 * request with no line joins a strong candidate line, scored on its title pattern and the session's last line, and grows its keys.
 */
async function plan($: EngineInterface, input: Readonly<Record<string, unknown>>): Promise<{ text: string } | { error: string }> {
  const place = await boardPlace($)
  const storage = place.storage ?? (await askStorage($, place.project, place.root))

  if (storage === null) {
    return { error: 'the person has not chosen where this project keeps its progress board' }
  }

  const dir = eventsDir(storage, place.home, place.project, place.root)
  const files = await readEvents($, dir)
  const session = await $.session.id()
  const before = Object.values(files).flat()
  const now = await $.clock.now()
  const commit = await gitOut($, place.root, ['rev-parse', '--short', 'HEAD'])
  const planned = planRequest(input, before, now, session, commit)

  if ('error' in planned) {
    return planned
  }

  const isLined = foldRequests(before, now).some(one => one.id === planned.request && one.line !== '')
  const signals: LineSignals = { paths: [], scopes: [], pattern: titlePattern(input.title as string), lastLine: await storedLine($) }
  const found = isLined ? [] : lineCandidates(foldLines(before), signals)
  const line = isStrong(found) ? found[0]!.line : null
  const events: BoardEvent[] =
    line === null
      ? planned.events
      : [
          ...planned.events.map(one => (one.type === 'request' ? { ...one, fields: { ...one.fields, line: line.id } } : one)),
          { type: 'line', line: line.id, at: now, session, commit, fields: { keys: growKeys(line.keys, signals) } },
        ]
  await $.fs.write(`${dir}/${session}.json`, JSON.stringify([...(files[`${session}.json`] ?? []), ...events]))
  await $.store.set(await requestKey($), planned.request)

  if (line !== null) {
    await $.store.set(await lineKey($), line.id)
  }

  await syncCanvas($, place.home, place.project, events, [...before, ...events], now)

  return { text: `Request ${planned.request} is on the progress board with ${planned.steps.length} steps: ${planned.steps.join(', ')}` }
}

/**
 * /progress-close: a request closed by the person or dropped, or a node set to done or dropped, in one event in this session's
 * file; a node's request closed too when that was its one piece. The events are mirrored to the canvas.
 */
async function close($: EngineInterface, args: string): Promise<{ text: string }> {
  const [id, status, ...rest] = args.trim().split(/\s+/)

  if (id === undefined || id === '' || (status !== 'done' && status !== 'dropped') || rest.length > 0) {
    return { text: CLOSE_USAGE }
  }

  const place = await boardPlace($)

  if (place.storage === null) {
    return { text: 'progress-close: this project has no progress board yet' }
  }

  const dir = eventsDir(place.storage, place.home, place.project, place.root)
  const files = await readEvents($, dir)
  const before = Object.values(files).flat()
  const session = await $.session.id()
  const now = await $.clock.now()
  const request = foldRequests(before, now).find(one => one.id === id)
  const node = foldBoard(before).find(one => one.id === id)
  const commit = await gitOut($, place.root, ['rev-parse', '--short', 'HEAD'])
  const own = files[`${session}.json`] ?? []

  if (request !== undefined) {
    const event: RequestEvent = {
      type: 'request',
      request: id,
      at: now,
      session,
      commit,
      fields: status === 'done' ? { status: 'closed', resolution: { by: 'person', evidence: 'closed by the person' } } : { status: 'dropped' },
    }

    await $.fs.write(`${dir}/${session}.json`, JSON.stringify([...own, event]))
    await syncCanvas($, place.home, place.project, [event], [...before, event], now)

    return { text: `"${request.title}" is now ${event.fields.status}.` }
  }

  if (node === undefined) {
    return { text: `progress-close: no node or request ${id} on the board` }
  }

  const event: NodeEvent = { type: 'update', node: id, at: now, session, commit, fields: { status } }
  const after = [...before, event]
  const closing = closeEvents(foldRequests(after, now), foldBoard(after), NO_CHECKS, now, session, commit)

  await $.fs.write(`${dir}/${session}.json`, JSON.stringify([...own, event, ...closing]))
  await syncCanvas($, place.home, place.project, [event, ...closing], [...after, ...closing], now)

  return { text: `"${node.title}" is now ${status}.` }
}

/**
 * /progress-line: the person puts a request in a line, an existing one or a new one by name, with a relink event carrying the
 * request's keys (its pieces' directories, its title pattern) so the recorder shows the correction again. The line becomes the
 * session's last when the request is its current one.
 */
async function relink($: EngineInterface, args: string): Promise<{ text: string }> {
  const [id, target, ...rest] = args.trim().split(/\s+/)
  const name = rest.join(' ')

  if (id === undefined || id === '' || target === undefined || (target === 'new' ? name === '' : rest.length > 0)) {
    return { text: LINE_USAGE }
  }

  if ([...name].length > LINE_NAME_CHARS) {
    return { text: `progress-line: the name has ${[...name].length} characters, at most ${LINE_NAME_CHARS}` }
  }

  const place = await boardPlace($)

  if (place.storage === null) {
    return { text: 'progress-line: this project has no progress board yet' }
  }

  const dir = eventsDir(place.storage, place.home, place.project, place.root)
  const files = await readEvents($, dir)
  const before = Object.values(files).flat()
  const session = await $.session.id()
  const now = await $.clock.now()
  const request = foldRequests(before, now).find(one => one.id === id)
  const lines = foldLines(before)
  const line = lines.find(one => one.id === target)

  if (request === undefined) {
    return { text: `progress-line: no request ${id} on the board` }
  }

  if (target !== 'new' && line === undefined) {
    return { text: `progress-line: no line ${target} on the board` }
  }

  const commit = await gitOut($, place.root, ['rev-parse', '--short', 'HEAD'])
  const made: LineEvent[] =
    target === 'new' ? [{ type: 'line', line: newLineId(now, new Set(lines.map(one => one.id))), at: now, session, commit, fields: { name, definition: '', status: 'active', keys: noKeys() } }] : []
  const to = made[0]?.line ?? target
  const pieces = new Set(foldBoard(before).filter(one => one.request === id).map(one => one.id))
  const dirs = before.flatMap(one => ((one.type === 'add' || one.type === 'update') && pieces.has(one.node) ? (one.dirs ?? []) : []))
  const keys: LineKeys = { paths: [...new Set(dirs.filter(one => one !== '.'))], scopes: [], patterns: [titlePattern(request.title)] }
  const events: BoardEvent[] = [
    ...made,
    { type: 'request', request: id, at: now, session, commit, fields: { line: to } },
    { type: 'relink', request: id, from: request.line, to, at: now, session, commit: null, keys },
  ]

  await $.fs.write(`${dir}/${session}.json`, JSON.stringify([...(files[`${session}.json`] ?? []), ...events]))

  if ((await $.store.get(await requestKey($))) === id) {
    await $.store.set(await lineKey($), to)
  }

  await syncCanvas($, place.home, place.project, events, [...before, ...events], now)

  return { text: `"${request.title}" is now in line "${line?.name ?? name}" (${to}).` }
}

/**
 * The daily consolidation, once the project's storage is chosen and its config names no consolidatedDay of today: the model's
 * ops on the lines, and until the backfill is done on the old pieces, written to this session's file. consolidatedDay (and
 * backfilled) are written only once the model answered a reply that parses, so a failed call is tried again at the next start.
 */
async function consolidate($: EngineInterface): Promise<void> {
  const place = await boardPlace($)
  const configPath = `${boardDir(place.home, place.project)}/config.json`
  const config = jsonOf(await $.fs.read(configPath).catch(() => ''))
  const day = dayOf(await $.clock.now())

  if (place.storage === null || config.consolidatedDay === day) {
    return
  }

  const dir = eventsDir(place.storage, place.home, place.project, place.root)
  const files = await readEvents($, dir)
  const before = Object.values(files).flat()
  const isBackfill = config.backfilled !== true

  if (!hasConsolidationWork(before, !isBackfill, await $.clock.now())) {
    await $.fs.write(configPath, JSON.stringify({ ...config, consolidatedDay: day }))

    return
  }

  const prompt = consolidatePrompt(before, !isBackfill)
  const reply = await complete($, place.home, place.project, { model: 'sonnet', system: CONSOLIDATE_SYSTEM, prompt, effort: 'low', maxTokens: 6000, timeoutMs: MODEL_TIMEOUT_MS })

  if (!reply.isAnswered) {
    $.ui.log(`progress: nothing consolidated, the model did not answer (${reply.reason})`, { to: 'debug' })

    return
  }

  const parsed = parseOpsReply(reply.text)

  if ('error' in parsed) {
    $.ui.log(`progress: nothing consolidated, ${parsed.error}`, { to: 'debug' })

    return
  }

  const session = await $.session.id()
  const now = await $.clock.now()
  const planned = planConsolidation(parsed.ops, before, now, session)

  if (planned.events.length > 0) {
    // Read again: a recording or the progress page may have written this file while the model answered.
    const own = parseBoardEvents(String(await $.fs.read(`${dir}/${session}.json`).catch(() => ''))) ?? files[`${session}.json`] ?? []

    await $.fs.write(`${dir}/${session}.json`, JSON.stringify([...own, ...planned.events]))
  }

  // Past OLD_PIECES the prompt listed only the newest: the rest wait for the next day's backfill.
  const isBackfilled = isBackfill && oldPieces(foldBoard(before)).length <= OLD_PIECES

  await $.fs.write(configPath, JSON.stringify({ ...jsonOf(await $.fs.read(configPath).catch(() => '')), consolidatedDay: day, ...(isBackfilled && { backfilled: true }) }))
  $.ui.log(`progress: consolidated ${parsed.ops.length - planned.refused.length} ops, refused ${planned.refused.length}`, { to: 'debug' })

  for (const reason of planned.refused) {
    $.ui.log(`progress: refused ${reason}`, { to: 'debug' })
  }

  if (planned.events.length > 0) {
    await syncCanvas($, place.home, place.project, planned.events, [...before, ...planned.events], now)
  }
}

/** Runs `work` on the recording chain, so the progress page's Done / Drop never interleaves with a recording or another close; settles as `work` does. */
export function onRecording<T>(work: () => Promise<T>): Promise<T> {
  const done = recording.then(work)

  recording = done.catch(() => undefined)

  return done
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

  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    await $.command.register({ name: 'progress-close', description: 'Close a node or a request of the progress board: done or dropped', argumentHint: '<node or request id> done|dropped' }).catch((error: unknown) =>
      $.ui.log(`progress: cannot register /progress-close: ${String(error)}`, { to: 'debug' }),
    )
    await $.command
      .register({ name: 'progress-line', description: 'Put a request of the progress board in a line, or in a new line by name', argumentHint: '<request id> <line id> | <request id> new <name>' })
      .catch((error: unknown) => $.ui.log(`progress: cannot register /progress-line: ${String(error)}`, { to: 'debug' }))
    await $.tool.register(PLAN_TOOL).catch((error: unknown) => $.ui.log(`progress: cannot register the ${PLAN_TOOL.name} tool: ${String(error)}`, { to: 'debug' }))

    // Queued, not awaited: the model call must not hold the session's start.
    if (!isConsolidationQueued) {
      isConsolidationQueued = true
      onRecording(() => consolidate($)).catch((error: unknown) => $.ui.log(`progress: consolidating failed: ${String(error)}`, { to: 'debug' }))
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'session.start (progress)', next.error)

    return next(e)
  })

  // Only the main loop raises turn.start.
  on('turn.start', { text: /^/ }, async ($, e, next) => {
    const typed = typedPrompt

    typedPrompt = null

    const turn: MainTurn = { id: e.turnId, typed, head: await gitOut($, await $.session.root(), ['rev-parse', 'HEAD']), edits: new Set(), passed: null }

    current = turn
    await storeTurn($, turn)

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'turn.start (progress)', next.error)

    return next(e)
  })

  // Every agent's edits, subagents' included, count for the main turn under way; an edit makes a test run before it stale.
  on('classic.PostToolUse', { tool_name: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] }, async ($, e, next) => {
    const input = typeof e.tool_input === 'object' && e.tool_input !== null ? (e.tool_input as Record<string, unknown>) : {}
    const path = input.file_path ?? input.notebook_path

    // After a reload mid-turn the module holds no turn: the stored one is the one under way.
    current ??= await storedTurn($)

    if (typeof path === 'string' && current !== null) {
      current.edits.add(path)
      current.passed = null
      await storeTurn($, current)
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PostToolUse (progress)', next.error)

    return next(e)
  })

  // Classic, never `tool.call`: a mod hooking Bash there denies every Bash call of a worktree subagent.
  on('classic.PostToolUse', { tool_name: ['Bash'] }, async ($, e, next) => {
    const input = typeof e.tool_input === 'object' && e.tool_input !== null ? (e.tool_input as Record<string, unknown>) : {}
    const text = bashOutput(e.tool_response)
    const summary = text === null ? null : summarizeTests(text)

    current ??= await storedTurn($)

    if (typeof input.command === 'string' && summary !== null && !summary.failed && current !== null) {
      current.passed = { command: input.command.trim().replace(/\s+/g, ' ').slice(0, COMMAND_CHARS), at: await $.clock.now() }
      await storeTurn($, current)
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PostToolUse Bash (progress)', next.error)

    return next(e)
  })

  on('turn.complete', { turnId: /^/ }, async ($, e, next) => {
    const turn = e.agentId !== undefined ? null : current?.id === e.turnId ? current : await storedTurn($, e.turnId)

    if (turn !== null) {
      if (current?.id === e.turnId) {
        current = null
      }

      await $.store.delete(await turnKey($))

      if (!e.isAborted) {
        recording = recording.then(() => record($, turn, e.answer)).catch((error: unknown) => $.ui.log(`progress: recording failed: ${String(error)}`, { to: 'debug' }))
      }
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'turn.complete (progress)', next.error)

    return next(e)
  })

  // On the recording chain, so a close and a recording never interleave.
  on('command.run', { command: 'progress-close' }, async ($, e) => {
    const answer = recording.then(() => close($, e.args))

    recording = answer.then(
      () => undefined,
      (error: unknown) => $.ui.log(`progress: closing failed: ${String(error)}`, { to: 'debug' }),
    )

    return answer
  }).catch(($, e, next) => {
    hookFailed($, 'command.run progress-close (progress)', next.error)

    return next(e)
  })

  on('command.run', { command: 'progress-line' }, async ($, e) => onRecording(() => relink($, e.args))).catch(($, e, next) => {
    hookFailed($, 'command.run progress-line (progress)', next.error)

    return next(e)
  })

  // On the recording chain too, so a plan never interleaves with a recording.
  // Its full name in the source tree, and in the split release where the recorder is plugin `progress`.
  on('tool.call', { tool: ['mcp__dashboard__progress_plan', 'mcp__progress__progress_plan'] }, async ($, e) => {
    const answer = await onRecording(() => plan($, e as unknown as Readonly<Record<string, unknown>>))

    return 'error' in answer ? { deny: `progress_plan: nothing recorded: ${answer.error}` } : { result: [{ type: 'text' as const, text: answer.text }] }
  }).catch(($, e, next) => {
    hookFailed($, 'tool.call progress_plan (progress)', next.error)

    return next(e)
  })
}
