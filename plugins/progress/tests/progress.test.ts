import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { FsEntry, ModelCompleteRequest, On, SessionStartInput } from 'claude-code'

import {
  canvasProject,
  canvasWrites,
  closeEvents,
  CONSOLIDATE_SYSTEM,
  consolidatePrompt,
  foldBoard,
  foldLines,
  foldRequests,
  growKeys,
  isStrong,
  lineCandidates,
  listText,
  parseBoardEvents,
  parseNodesReply,
  pathKeys,
  planConsolidation,
  planNodes,
  scopeOf,
  titlePattern,
  RECORD_SYSTEM,
} from '../hooks/progress'
import { dayOf } from '../hooks/usage'
import type { BoardEvent, LineEvent, LineFields, LineKeys, NodeEvent, RelinkEvent, RequestEvent, RequestFields } from '../types'

const NOW = 1_790_922_800_000
const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/r' }
const BOTTOM = { type: 'Text', props: {}, children: ['engine'] }
// The project is the main worktree's root as `$.session.repo()` gives it; the session root is a linked worktree's.
const ROOT = '/r/.claude/worktrees/agent-x'
const BOARD = '/h/.claude/progress/-r'
const CONFIG = `${BOARD}/config.json`
const CANVAS = '/h/.claude/progress/canvas.json'
const URL = 'https://claude.ai/artifact/abc'
const LOCAL_EVENTS = `${BOARD}/events`
const GIT_EVENTS = `${ROOT}/.notes/board/events`
const ID = /^n\d{8}-[0-9a-f]{4}$/
const RID = /^r\d{8}-[0-9a-f]{4}$/
const HOUR = 3_600_000
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const DAY = dayOf(NOW)

const TOOL_NODE = { title: 'Progress hook', summary: 'The plugin records each typed turn that changed something.', status: 'done', kind: 'feature', done_when: 'the hook is committed on main' }
const PAGE_NODE = { title: 'Progress page', summary: 'A seventh tab lists the board by status.', status: 'doing', kind: 'feature', done_when: 'the page test suite passes' }
const REQUEST = { title: 'The progress page', acceptance: ['the page test suite passes'] }

/** A reply of the model: its text, or made from the world as the request comes. */
type Reply = string | ((world: World) => string)
type Batch = { tool: string; action: string; url: string; writes: { op: string; collection: string; doc_id: string; data: Record<string, unknown> }[] }

/**
 * `replies`: the model's answers in order, none left = not answered. `head`: what `git rev-parse` prints. `storage`: the
 * person's answer to the storage question, null = dismissed. `batch`: how an ArtifactData call ends. `store`: the plugin's `$.store`.
 */
type World = {
  files: Record<string, string>
  head: string
  log: string
  replies: Reply[]
  requests: ModelCompleteRequest[]
  isSlow: boolean
  asks: string[]
  storage: string | null
  batches: Batch[]
  batch: 'ok' | 'error' | 'deny'
  runs: string[][]
  logs: string[]
  store: Record<string, unknown>
  tools: string[]
  onMain: boolean
}

/** The engine beneath the plugin, in memory: files by absolute path, HEAD as `world.head` says, the model as `world.replies`. */
function seat(on: On, clock: MockClock): World {
  const world: World = { files: {}, head: 'abc1234', log: '', replies: [], requests: [], isSlow: false, asks: [], storage: 'local', batches: [], batch: 'ok', runs: [], logs: [], store: {}, tools: [], onMain: false }

  mock.env(on, { HOME: '/h' })
  on('session.id', () => ({ value: 'sa' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: { root: '/r', remote: null, internal: false, name: null } }))
  on('fs.write', ($, e) => {
    world.files[e.path] = e.text

    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = world.files[e.path]

    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.list', ($, e) => {
    const entries = Object.entries(world.files)
      .filter(([path]) => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
      .map(([path, text]) => ({ name: path.slice(e.path.length + 1), kind: 'file', size: text.length, mtimeMs: NOW, isLink: false }) as FsEntry)

    return entries.length > 0 ? { value: entries } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', ($, e) => ({ deny: `ENOENT ${e.path}` }))
  on('store.get', ($, e) => ({ value: world.store[e.key] }))
  on('store.set', ($, e) => {
    world.store[e.key] = JSON.parse(JSON.stringify(e.value))

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete world.store[e.key]

    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(world.store) }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => {
    world.tools.push(e.name)

    return { value: { tool: `mcp__dashboard__${e.name}` } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    world.logs.push(e.text)

    return { value: undefined }
  })
  on('process.run', ($, e) => {
    world.runs.push([...e.argv])

    const stdout = e.argv.includes('rev-parse') ? `${world.head}\n` : e.argv.includes('log') ? world.log : ''
    const exitCode = e.argv.includes('merge-base') && !world.onMain ? 1 : 0

    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', async ($, e) => {
    world.requests.push(e)

    if (world.isSlow) {
      await clock.sleep(1_000)
    }

    const reply = world.replies.shift()
    const text = typeof reply === 'function' ? reply(world) : reply

    return { value: text === undefined ? { isAnswered: false, reason: 'empty-reply', usage: USAGE } : { isAnswered: true, text, usage: USAGE } } as never
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]!.question

    world.asks.push(question)

    return (world.storage === null ? { deny: 'dismissed' } : { result: { answers: { [question]: world.storage } } }) as never
  })
  on('tool.call', { tool: 'ArtifactData' }, ($, e) => {
    world.batches.push(e as unknown as Batch)

    return (world.batch === 'ok' ? { result: 'ok' } : world.batch === 'error' ? { isError: true, result: 'no such artifact', text: 'no such artifact' } : { deny: 'not allowed' }) as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('settings.read', () => ({ value: {} }))
  on('ui.render', () => BOTTOM as never)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.PostToolUse', () => ({}))

  return world
}

type Turn = { text?: string; origin?: string; edits?: { path: string; agentId?: string }[]; head?: string; isAborted?: boolean; turnId?: string; answer?: string }

/** The main loop's turn from its prompt to its end: the edits run in it, HEAD moves to `head` before it ends. */
async function turn($: Engine, clock: MockClock, world: World, { text = 'Add the progress page', origin = 'composer', edits = [{ path: `${ROOT}/hooks/page.ts` }], head, isAborted = false, turnId = 't1', answer = 'The page is in.' }: Turn = {}) {
  await $.prompt.submit({ text, wait: false, origin: { kind: origin } } as never)
  await $.turn.start({ text, turnId })

  for (const one of edits) {
    await $.classic.PostToolUse({
      tool_name: 'Edit',
      tool_input: { file_path: one.path, old_string: 'a', new_string: 'b' },
      tool_response: {},
      tool_use_id: 'toolu_e',
      ...(one.agentId !== undefined && { agent_id: one.agentId }),
    } as never)
  }

  world.head = head ?? world.head
  await $.turn.complete({ answer, durationMs: 1_000, isAborted, turnId, reason: isAborted ? 'aborted' : 'answer' } as never)
  await clock.settle()
}

/** The board's files written: its config, events and the canvas file; not the recorder's usage file. */
const written = (world: World) => Object.keys(world.files).filter(path => (path.startsWith('/h/.claude/progress/') || path.includes('/.notes/')) && !path.endsWith('/recorder-usage.jsonl'))

/** A session's events file whole, request events included. */
const allOf = (world: World, dir: string, session = 'sa') => JSON.parse(world.files[`${dir}/${session}.json`] ?? 'null') as BoardEvent[] | null

/** A session's node events. */
const eventsOf = (world: World, dir: string, session = 'sa') => allOf(world, dir, session)?.filter((one): one is NodeEvent => one.type === 'add' || one.type === 'update') ?? null

const requestsOf = (world: World, dir: string, session = 'sa') => allOf(world, dir, session)?.filter((one): one is RequestEvent => one.type === 'request') ?? null

/** The board canvasWrites reads, folded from `events`. */
const boardFor = (events: readonly BoardEvent[]) => ({ nodes: foldBoard(events), requests: foldRequests(events, NOW), lines: foldLines(events) })

/** A reply naming its nodes; with no current request its request object makes one. */
const reply = (...nodes: object[]) => JSON.stringify({ nodes, request: REQUEST })

const command = (name: string, args = '') => ({ command: name, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 180 } })

const event = (over: Partial<NodeEvent> & Pick<NodeEvent, 'type' | 'node' | 'at'>): NodeEvent => ({ session: 'sb', commit: null, fields: {}, ...over })
const added = (node: string, at: number, title: string, status = 'todo') =>
  event({ type: 'add', node, at, fields: { title, summary: 's', status: status as never, kind: 'fix', builds_on: [], depends_on: [] } })
const requested = (request: string, at: number, fields: RequestFields): RequestEvent => ({ type: 'request', request, at, session: 'sb', commit: null, fields })
/** A piece of `request`, added by session sb. */
const piece = (node: string, at: number, title: string, status: string, request: string, over: Partial<NodeEvent['fields']> = {}) =>
  event({ type: 'add', node, at, fields: { title, summary: 's', status: status as never, kind: 'fix', done_when: `${title} works`, builds_on: [], depends_on: [], request, ...over } })

/** A world with the board kept locally and already consolidated today, the session started. */
async function local($: Engine, on: On, now = NOW) {
  const clock = mock.clock(on, { now })
  const world = seat(on, clock)

  world.files[CONFIG] = JSON.stringify({ storage: 'local', consolidatedDay: dayOf(now) })
  await $.session.start(SESSION)

  return { clock, world }
}

describe('recording a turn on the progress board', () => {
  test("a typed turn that edited a file asks sonnet for the nodes and writes them to the session's own events file", async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = [reply(PAGE_NODE)]
    await turn($, clock, world)

    expect(world.requests.length).toBe(1)
    expect(world.requests[0]).toMatchObject({ model: 'sonnet', effort: 'low', maxTokens: 2000, timeoutMs: 120_000 })
    expect(world.requests[0]!.system).toContain('{"nodes": []}')
    expect(world.requests[0]!.prompt).toContain('Add the progress page')
    expect(world.requests[0]!.prompt).toContain('The page is in.')
    expect(world.requests[0]!.prompt, 'relative to the session root').toMatch(/^hooks\/page\.ts$/m)

    const events = eventsOf(world, LOCAL_EVENTS)

    expect(events?.length).toBe(1)
    expect(events?.[0]).toMatchObject({ type: 'add', at: NOW, session: 'sa', commit: 'abc1234', fields: PAGE_NODE })
    expect(events?.[0]?.node).toMatch(ID)
    expect(events?.[0]?.node.slice(1, 9)).toBe(dayOf(NOW).replace(/-/g, ''))
  })

  test("an event the session wrote while the model answered, as the progress page's Done does, is kept", async ($, on) => {
    const { clock, world } = await local($, on)
    const closed = event({ type: 'update', node: 'n1', at: NOW, session: 'sa', fields: { status: 'done' } })

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([added('n1', NOW - 1, 'Open work', 'doing')])
    world.replies = [
      w => {
        w.files[`${LOCAL_EVENTS}/sa.json`] = JSON.stringify([closed])

        return reply(PAGE_NODE)
      },
    ]
    await turn($, clock, world)

    expect(eventsOf(world, LOCAL_EVENTS)?.map(one => one.type)).toEqual(['update', 'add'])
  })

  test('a typed turn with no edit and HEAD where it was asks no model', async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = [reply(PAGE_NODE)]
    await turn($, clock, world, { edits: [] })

    expect(world.requests).toEqual([])
    expect(written(world)).toEqual([CONFIG])
  })

  test('a commit alone, no edit: recorded, the new commits in the prompt, the node on the new HEAD', async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = [reply(PAGE_NODE)]
    world.log = 'def5678 Add the progress page\n'
    await turn($, clock, world, { edits: [], head: 'def5678' })

    expect(world.requests.length).toBe(1)
    expect(world.requests[0]!.prompt).toContain('def5678 Add the progress page')
    expect(world.runs.find(argv => argv.includes('log'))).toContain('abc1234..def5678')
    expect(eventsOf(world, LOCAL_EVENTS)?.[0]?.commit).toBe('def5678')
  })

  test('a turn the person did not type, with edits only, asks no model: a task notification', async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = [reply(PAGE_NODE)]
    await turn($, clock, world, { origin: 'task-notification' })

    expect(world.requests).toEqual([])
    expect(eventsOf(world, LOCAL_EVENTS)).toBeNull()
  })

  test('a turn the person did not type that moved HEAD is recorded, its typed_prompt fact saying so', async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = [reply(PAGE_NODE)]
    world.log = 'def5678 Merge the progress page\n'
    await turn($, clock, world, { origin: 'task-notification', edits: [], head: 'def5678' })

    expect(world.requests.length).toBe(1)
    expect(world.requests[0]!.prompt).toContain('<typed_prompt>\n(not typed: a notification, a queued or a plugin prompt)\n</typed_prompt>')
    expect(world.requests[0]!.prompt).toContain('def5678 Merge the progress page')
    expect(eventsOf(world, LOCAL_EVENTS)?.length).toBe(1)
  })

  test('the turn under way is kept in $.store from turn.start, its edits added, and deleted at its turn.complete', async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = [reply(PAGE_NODE)]
    await $.prompt.submit({ text: 'Add the page', wait: false, origin: { kind: 'composer' } } as never)
    await $.turn.start({ text: 'Add the page', turnId: 't1' })
    expect(world.store['turn:sa']).toEqual({ id: 't1', typed: 'Add the page', head: 'abc1234', edits: [] })

    await $.classic.PostToolUse({ tool_name: 'Edit', tool_input: { file_path: `${ROOT}/hooks/page.ts`, old_string: 'a', new_string: 'b' }, tool_response: {}, tool_use_id: 'toolu_e' } as never)
    expect(world.store['turn:sa']).toEqual({ id: 't1', typed: 'Add the page', head: 'abc1234', edits: [`${ROOT}/hooks/page.ts`] })

    await $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.settle()
    expect(world.store['turn:sa']).toBeUndefined()
    expect(eventsOf(world, LOCAL_EVENTS)?.length).toBe(1)
  })

  test('a reload mid-turn: the stored turn is recorded when its turn.complete arrives with no turn.start in this load', async ($, on) => {
    const { clock, world } = await local($, on)

    world.store['turn:sa'] = { id: 't1', typed: 'Edit the plugin', head: 'abc1234', edits: [`${ROOT}/hooks/page.ts`] }
    world.replies = [reply(PAGE_NODE)]
    await $.turn.complete({ answer: 'The plugin is edited.', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.settle()

    expect(world.requests[0]?.prompt).toContain('Edit the plugin')
    expect(world.requests[0]?.prompt).toMatch(/^hooks\/page\.ts$/m)
    expect(eventsOf(world, LOCAL_EVENTS)?.length).toBe(1)
    expect(world.store['turn:sa']).toBeUndefined()
  })

  test("a subagent's turn.complete is ignored; its Edit counts for the main turn", async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = [reply(PAGE_NODE)]
    await $.prompt.submit({ text: 'Delegate the page', wait: false, origin: { kind: 'composer' } } as never)
    await $.turn.start({ text: 'Delegate the page', turnId: 't1' })
    await $.classic.PostToolUse({ tool_name: 'Write', tool_input: { file_path: `${ROOT}/hooks/sub.ts`, content: 'x' }, tool_response: {}, tool_use_id: 'toolu_s', agent_id: 'a1' } as never)
    await $.turn.complete({ answer: 'sub done', durationMs: 1_000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' } as never)
    await clock.settle()
    expect(world.requests).toEqual([])

    await $.turn.complete({ answer: 'main done', durationMs: 2_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.settle()
    expect(world.requests.length).toBe(1)
    expect(world.requests[0]!.prompt).toMatch(/^hooks\/sub\.ts$/m)
    expect(eventsOf(world, LOCAL_EVENTS)?.length).toBe(1)
  })

  test('an interrupted turn asks no model', async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = [reply(PAGE_NODE)]
    await turn($, clock, world, { isAborted: true })

    expect(world.requests).toEqual([])
  })

  test('a reply not JSON, one planNodes refuses, {"nodes": []} and no answer: nothing written, a debug line for each failure', async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = ['Here are the nodes you asked for.', reply({ ...PAGE_NODE, title: 'x'.repeat(61) }), '{"nodes": []}']

    for (const turnId of ['t1', 't2', 't3', 't4']) {
      await turn($, clock, world, { turnId })
    }

    expect(world.requests.length).toBe(4)
    expect(written(world)).toEqual([CONFIG])
    expect(world.logs.filter(line => line.startsWith('progress:')).length).toBe(3)
  })

  test('two sessions\' files fold together and a broken one is skipped: the other session\'s node is listed and may be linked', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, clock)

    world.files[CONFIG] = JSON.stringify({ storage: 'local', consolidatedDay: DAY })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([added('n20261001-aaaa', NOW - 9_000, 'Older work', 'doing'), event({ type: 'update', node: 'n20261001-aaaa', at: NOW - 1_000, fields: { status: 'blocked' } })])
    world.files[`${LOCAL_EVENTS}/sc.json`] = '[{"type":"add","node":"n2026'
    world.replies = [reply({ ...TOOL_NODE, builds_on: ['n20261001-aaaa'] })]
    await $.session.start(SESSION)
    await turn($, clock, world)

    expect(eventsOf(world, LOCAL_EVENTS)?.[0]?.fields.builds_on).toEqual(['n20261001-aaaa'])
  })

  test("an update by id changes the status; this session's own node and its summary are in the next prompt", async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = [reply(PAGE_NODE), w => reply({ id: eventsOf(w, LOCAL_EVENTS)![0]!.node, status: 'done' })]
    await turn($, clock, world)

    const id = eventsOf(world, LOCAL_EVENTS)![0]!.node

    await clock.advance(60_000)
    await turn($, clock, world, { turnId: 't2', text: 'Finish it' })

    const events = eventsOf(world, LOCAL_EVENTS) ?? []

    expect(world.requests[1]!.prompt).toContain(`${id} · Progress page · doing · done when: ${PAGE_NODE.done_when}`)
    expect(events[1]).toMatchObject({ type: 'update', node: id, at: NOW + 60_000, fields: { status: 'done' } })
    expect(Object.keys(events[1]!.fields)).toEqual(['status'])
    expect(foldBoard(events)).toMatchObject([{ id, title: 'Progress page', status: 'done', at: NOW, updatedAt: NOW + 60_000 }])
  })

  test("two turns ending back to back are recorded in order; the second prompt lists the first's node", async ($, on) => {
    const { clock, world } = await local($, on)

    world.isSlow = true
    world.replies = [reply(PAGE_NODE), reply(TOOL_NODE)]
    await turn($, clock, world, { turnId: 't1' })
    await turn($, clock, world, { turnId: 't2', text: 'And the hook' })
    expect(world.requests.length, 'the second waits for the first').toBe(1)

    await clock.advance(1_000)
    expect(world.requests.length).toBe(2)

    const [page] = eventsOf(world, LOCAL_EVENTS) ?? []

    expect(world.requests[1]!.prompt).toContain(`${page!.node} · Progress page`)

    await clock.advance(1_000)
    expect((eventsOf(world, LOCAL_EVENTS) ?? []).map(one => one.fields.title)).toEqual(['Progress page', 'Progress hook'])
  })
})

describe('recording a turn: where the board is kept', () => {
  test('no storage chosen: the person is asked once; local writes the choice and the events under the home directory', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, clock)

    world.replies = [reply(PAGE_NODE), reply(TOOL_NODE)]
    await $.session.start(SESSION)
    await turn($, clock, world)

    expect(world.asks.length).toBe(1)
    expect(world.asks[0]).toContain('~/.claude/progress/-r/events/')
    expect(world.asks[0]).toContain(`${GIT_EVENTS}/`)
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local' })
    expect(eventsOf(world, LOCAL_EVENTS)?.length).toBe(1)
    expect(Object.keys(world.files).filter(path => path.startsWith('/r/'))).toEqual([])

    await turn($, clock, world, { turnId: 't2' })
    expect(world.asks.length, 'no question the second time').toBe(1)
    expect(eventsOf(world, LOCAL_EVENTS)?.length).toBe(2)
  })

  test('storage git: the events in <session root>/.notes/board/events/<session>.json', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, clock)

    world.storage = 'git'
    world.replies = [reply(PAGE_NODE)]
    await $.session.start(SESSION)
    await turn($, clock, world)

    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'git' })
    expect(eventsOf(world, GIT_EVENTS)?.length).toBe(1)
  })

  test('the question dismissed: nothing written, no model asked, and the next turn does not ask again', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, clock)

    world.storage = null
    world.replies = [reply(PAGE_NODE), reply(PAGE_NODE)]
    await $.session.start(SESSION)
    await turn($, clock, world)
    await turn($, clock, world, { turnId: 't2' })

    expect(world.asks.length).toBe(1)
    expect(world.requests).toEqual([])
    expect(written(world)).toEqual([])
  })

  test('off: the choice is kept, nothing written, no model asked, and the next turn does not ask again', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, clock)

    world.storage = 'off'
    world.replies = [reply(PAGE_NODE), reply(PAGE_NODE)]
    await $.session.start(SESSION)
    await turn($, clock, world)
    await turn($, clock, world, { turnId: 't2' })

    expect(world.asks.length).toBe(1)
    expect(world.asks[0]).toContain(CONFIG.replace(/^\/h/, '~'))
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'off' })
    expect(world.requests).toEqual([])
    expect(written(world)).toEqual([CONFIG])
  })

  test('a config of storage off: no question, no progress_plan tool, no consolidation, nothing recorded', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, clock)

    world.files[CONFIG] = JSON.stringify({ storage: 'off' })
    world.replies = [reply(PAGE_NODE)]
    await $.session.start(SESSION)
    await turn($, clock, world)

    expect(world.asks).toEqual([])
    expect(world.tools).not.toContain('progress_plan')
    expect(world.requests).toEqual([])
    expect(written(world)).toEqual([CONFIG])
  })
})

describe('recording a turn: the canvas', () => {
  test('with a canvas the plugin submits one ArtifactData batch of the writes; canvasBackfilled is set once it went through', async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[CANVAS] = JSON.stringify({ url: URL })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([added('n20261001-aaaa', NOW - 9_000, 'Older work')])
    world.replies = [reply(TOOL_NODE, { ...PAGE_NODE, builds_on: ['#0'], depends_on: [{ id: 'n20261001-aaaa', confirmed: false }] }), w => reply({ id: eventsOf(w, LOCAL_EVENTS)![0]!.node, status: 'blocked' })]
    await turn($, clock, world)

    const mine = allOf(world, LOCAL_EVENTS) ?? []
    const [tool, page] = (eventsOf(world, LOCAL_EVENTS) ?? []).map(one => one.node)
    const rid = world.store['request:sa'] as string
    const all = [...mine, added('n20261001-aaaa', NOW - 9_000, 'Older work')]

    expect(world.batches.length).toBe(1)
    expect(world.batches[0]).toMatchObject({ tool: 'ArtifactData', action: 'batch', url: URL })
    expect(world.batches[0]!.writes).toEqual(canvasWrites(mine, boardFor(all), { url: URL, project: '-r', name: 'r', at: NOW, isBackfill: true }))
    expect(world.batches[0]!.writes.map(one => [one.collection, one.doc_id])).toEqual([
      ['projectIndex', `-r~e${NOW}`],
      ['projects/-r/events', `q${NOW}-${rid}`],
      ['projects/-r/events', `e${NOW}-${tool}`],
      ['projects/-r/events', `e${NOW}-${page}`],
      ['projects/-r/events', `b${NOW}-${rid}`],
      ['projects/-r/events', `b${NOW}-n20261001-aaaa`],
    ])
    expect(world.batches[0]!.writes[3]!.data).toEqual({
      type: 'add',
      node: page,
      at: NOW,
      commit: 'abc1234',
      session: 'sa',
      fields: { ...PAGE_NODE, builds_on: [tool], depends_on: [{ id: 'n20261001-aaaa', confirmed: false }], request: rid, discovered_from: '' },
      seq: 3,
    })
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local', consolidatedDay: DAY, canvasBackfilled: true })

    await clock.advance(60_000)
    await turn($, clock, world, { turnId: 't2' })

    const first = new Set(world.batches[0]!.writes.map(one => one.doc_id))

    expect(world.batches[1]!.writes.map(one => [one.collection, one.doc_id])).toEqual([
      ['projectIndex', `-r~e${NOW + 60_000}`],
      ['projects/-r/events', `s${NOW + 60_000}-${tool}`],
      ['projects/-r/events', `e${NOW + 60_000}-${tool}`],
    ])
    expect(world.batches[1]!.writes.filter(one => first.has(one.doc_id)), 'no write targets a doc an earlier batch made').toEqual([])
  })

  test('a batch that failed leaves canvasBackfilled unset, so the next recording backfills; a refused one too', async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[CANVAS] = JSON.stringify({ url: URL })
    world.replies = [reply(TOOL_NODE), reply(PAGE_NODE), reply({ ...PAGE_NODE, title: 'Third' })]
    world.batch = 'error'
    await turn($, clock, world)

    const [tool] = (eventsOf(world, LOCAL_EVENTS) ?? []).map(one => one.node)

    expect(world.batches.length).toBe(1)
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local', consolidatedDay: DAY })
    expect(world.logs.filter(line => line.startsWith('progress: the canvas')).length).toBe(1)

    world.batch = 'deny'
    await clock.advance(60_000)
    await turn($, clock, world, { turnId: 't2' })
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local', consolidatedDay: DAY })

    world.batch = 'ok'
    await clock.advance(60_000)
    await turn($, clock, world, { turnId: 't3' })
    expect(world.batches[2]!.writes.map(one => one.doc_id)).toContain(`b${NOW + 120_000}-${tool}`)
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local', consolidatedDay: DAY, canvasBackfilled: true })
  })

  test('backfill of a board of 60 nodes: the newest ones, the batch at 50 writes', async ($, on) => {
    const { clock, world } = await local($, on)
    const ids = Array.from({ length: 60 }, (_, i) => `n20261001-${i.toString(16).padStart(4, '0')}`)

    world.files[CANVAS] = JSON.stringify({ url: URL })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify(ids.map((id, i) => added(id, NOW - 100_000 + i, `Work ${i}`)))
    world.replies = [reply(TOOL_NODE)]
    await turn($, clock, world)

    const writes = world.batches[0]?.writes ?? []

    expect(writes.length).toBe(50)
    // The index, the request, the piece, the request closed by its one piece, the request's snapshot; then the nodes.
    expect(writes.slice(5).map(one => one.data.node)).toEqual([...ids].reverse().slice(0, 45))
  })

  test("an update doc carries only its event's fields, not the node as a stale fold had it, beside a snapshot of the node under a new doc; an add carries the whole node", () => {
    const sync = { url: URL, project: '-r', name: 'r', at: NOW, isBackfill: false }
    const open = added('n1', NOW - 9_000, 'Open work', 'doing')
    const update = event({ type: 'update', node: 'n1', at: NOW, fields: { summary: 'More done.' } })
    const add = added('n2', NOW, 'New work')
    // The fold was made before another session set n1 to done.
    const writes = canvasWrites([update, add], boardFor([open, update, add]), sync)
    const node = { kind: 'fix', done_when: '', builds_on: [], depends_on: [], request: '', discovered_from: '' }

    expect(writes.map(one => one.data)).toEqual([
      { project: '-r', name: 'r', seq: 0 },
      { type: 'add', node: 'n1', at: NOW - 9_000, updatedAt: NOW, commit: null, fields: { ...node, title: 'Open work', summary: 'More done.', status: 'doing' }, seq: 1 },
      { type: 'update', node: 'n1', at: NOW, commit: null, session: 'sb', fields: { summary: 'More done.' }, seq: 2 },
      { type: 'add', node: 'n2', at: NOW, commit: null, session: 'sb', fields: { ...node, title: 'New work', summary: 's', status: 'todo' }, seq: 3 },
    ])
    // The snapshot is named by this call's time: the node's own add is already mirrored under `e<at>-<id>`.
    expect(writes.map(one => one.doc_id)).toEqual([`-r~e${NOW}`, `s${NOW}-n1`, `e${NOW}-n1`, `e${NOW}-n2`])
  })

  test('a project root with characters a database path refuses gets them as -', () => {
    expect(canvasProject('-Users-me-My Project (old)')).toBe('-Users-me-My-Project--old-')
  })
})

describe('the board: nodes checked, events folded, the reply read', () => {
  const board = foldBoard([added('n20261001-aaaa', NOW - 9_000, 'Older work')])

  test('a title too long, a bad status or kind, an unknown id, a missing summary, an index past the call: each refused', () => {
    const cases: [object[], RegExp][] = [
      [[PAGE_NODE, { ...TOOL_NODE, title: 'x'.repeat(61) }], /nodes\[1\]\.title.*60/],
      [[{ ...TOOL_NODE, status: 'wip' }], /nodes\[0\]\.status.*wip/],
      [[{ ...TOOL_NODE, kind: 'chore' }], /nodes\[0\]\.kind.*chore/],
      [[{ ...TOOL_NODE, builds_on: ['n20990101-ffff'] }], /n20990101-ffff/],
      [[{ ...TOOL_NODE, depends_on: [{ id: 'n20990101-eeee', confirmed: false }] }], /n20990101-eeee/],
      [[{ title: 'No summary', status: 'todo', kind: 'docs' }], /nodes\[0\]\.summary/],
      [[{ ...TOOL_NODE, builds_on: ['#3'] }], /#3/],
      [[{ id: 'n20990101-dddd', status: 'done' }], /n20990101-dddd/],
      [[], /nodes/],
    ]

    for (const [nodes, why] of cases) {
      const plan = planNodes(nodes, board, NOW, 'sa', null)

      expect('error' in plan ? plan.error : '', JSON.stringify(nodes)).toMatch(why)
    }
  })

  test('done_when: an add without it or over 120 characters is refused; an update may leave it out', () => {
    const { done_when: _, ...bare } = TOOL_NODE
    const missing = planNodes([bare], board, NOW, 'sa', null)
    const long = planNodes([{ ...TOOL_NODE, done_when: 'x'.repeat(121) }], board, NOW, 'sa', null)
    const update = planNodes([{ id: 'n20261001-aaaa', status: 'done' }], board, NOW, 'sa', null)

    expect('error' in missing ? missing.error : '').toMatch(/nodes\[0\]\.done_when: missing/)
    expect('error' in long ? long.error : '').toMatch(/nodes\[0\]\.done_when.*120/)
    expect('events' in update ? update.events[0]!.fields : null).toEqual({ status: 'done' })
    expect(foldBoard([added('n1', 10, 'Old')])[0]!.done_when, 'an event before done_when').toBe('')
  })

  test('the list the model reads: done_when on open nodes, not on done ones; dropped nodes left out', () => {
    const text = listText(
      foldBoard([
        added('n1', 10, 'Open work', 'doing'),
        event({ type: 'update', node: 'n1', at: 11, fields: { done_when: 'a commit on main' } }),
        added('n2', 20, 'Finished work', 'done'),
        event({ type: 'update', node: 'n2', at: 21, fields: { done_when: 'the suite passes' } }),
        added('n3', 30, 'Abandoned work', 'dropped'),
      ]),
    )

    expect(text).toContain('n1 · Open work · doing · done when: a commit on main')
    expect(text).toContain('n2 · Finished work · done')
    expect(text).not.toContain('the suite passes')
    expect(text).not.toContain('Abandoned work')
  })

  test('a node may build on another of the same call by its index; an update gives only what changes', () => {
    const plan = planNodes([{ ...PAGE_NODE, builds_on: ['#1'] }, TOOL_NODE, { id: 'n20261001-aaaa', status: 'done' }], board, NOW, 'sa', 'abc1234')
    const events = 'events' in plan ? plan.events : []

    expect(events.map(one => [one.type, one.fields.title])).toEqual([
      ['add', 'Progress page'],
      ['add', 'Progress hook'],
      ['update', undefined],
    ])
    expect(events[0]?.fields.builds_on).toEqual([events[1]!.node])
    expect(events[2]).toMatchObject({ node: 'n20261001-aaaa', session: 'sa', commit: 'abc1234', fields: { status: 'done' } })
  })

  test('the fold: sorted by time across files, the latest update wins per field, an update of an unknown node is left out', () => {
    const a = [added('n1', 10, 'One'), event({ type: 'update', node: 'n1', at: 30, fields: { status: 'done' } })]
    const b = [event({ type: 'update', node: 'n1', at: 20, fields: { status: 'blocked', title: 'One, renamed' } }), added('n2', 15, 'Two'), event({ type: 'update', node: 'n9', at: 40, fields: { status: 'done' } })]

    expect(foldBoard([...a, ...b]).map(one => [one.id, one.title, one.status, one.updatedAt])).toEqual([
      ['n1', 'One, renamed', 'done', 30],
      ['n2', 'Two', 'todo', 15],
    ])
    expect(parseBoardEvents('[{"type":"add","node":"n2026')).toBeNull()
    expect(parseBoardEvents('{"type":"add"}'), 'not an array').toBeNull()
    expect(parseBoardEvents(JSON.stringify(a))).toEqual(a)
  })

  test('the reply: a {"nodes": [...]} object, bare or in a json fence; anything else an error', () => {
    expect(parseNodesReply(reply(PAGE_NODE))).toEqual({ nodes: [PAGE_NODE], request: REQUEST })
    expect(parseNodesReply('```json\n{"nodes": []}\n```')).toEqual({ nodes: [] })
    expect(parseNodesReply(' {"nodes": []}\n')).toEqual({ nodes: [] })

    for (const text of ['Nothing to record.', '[]', '{"node": []}', '{"nodes": {}}', 'Sure:\n```json\n{"nodes": []}\n```']) {
      expect('error' in parseNodesReply(text), text).toBe(true)
    }
  })
})

describe('/progress-close', () => {
  test("<id> done: one update event in this session's file, one ArtifactData batch, a line naming the node", async ($, on) => {
    const { world } = await local($, on)

    world.files[CANVAS] = JSON.stringify({ url: URL })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([added('n20261001-aaaa', NOW - 9_000, 'Older work', 'doing')])

    const r = await $.command.run(command('progress-close', 'n20261001-aaaa done'))

    expect(eventsOf(world, LOCAL_EVENTS)).toEqual([{ type: 'update', node: 'n20261001-aaaa', at: NOW, session: 'sa', commit: 'abc1234', fields: { status: 'done' } }])
    expect(world.batches.length).toBe(1)
    expect(world.batches[0]!.writes.map(one => one.doc_id)).toContain(`e${NOW}-n20261001-aaaa`)
    expect(r.text).toContain('Older work')
    expect(r.text).toContain('done')
  })

  test('an id not on the board, a bad status or none: nothing written, the answer says why', async ($, on) => {
    const { world } = await local($, on)

    world.files[CANVAS] = JSON.stringify({ url: URL })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([added('n20261001-aaaa', NOW - 9_000, 'Older work', 'doing')])

    const missing = await $.command.run(command('progress-close', 'n20990101-ffff done'))
    const bad = await $.command.run(command('progress-close', 'n20261001-aaaa doing'))
    const none = await $.command.run(command('progress-close', 'n20261001-aaaa'))

    expect(missing.text).toContain('n20990101-ffff')
    expect(bad.text).toContain('done|dropped')
    expect(none.text).toContain('done|dropped')
    expect(eventsOf(world, LOCAL_EVENTS)).toBeNull()
    expect(world.batches).toEqual([])
  })
})

const R1 = 'r20261001-aaaa'
const R2 = 'r20261001-cccc'
const P1 = 'n20261001-a001'
const P2 = 'n20261001-a002'
const PLAN = { title: 'Requests on the board', acceptance: ['the progress suite passes'], steps: ['Types', 'Fold', 'Recorder'] }
const NO_FACTS = { onMain: null, passedTests: null }

type ToolAnswer = { result?: { type: string; text: string }[]; deny?: string }

const callPlan = ($: Engine, input: object, tool = 'mcp__dashboard__progress_plan') => $.tool.call({ tool, tool_use_id: 'toolu_p', ...input } as never) as Promise<ToolAnswer>

/** Every session's events of the local board. */
const boardOf = (world: World) =>
  Object.entries(world.files)
    .filter(([path]) => path.startsWith(`${LOCAL_EVENTS}/`))
    .flatMap(([, text]) => JSON.parse(text) as BoardEvent[])

/** R1 open with Types done and Fold doing, beside a node in no request; all by session sb. */
const seeded = () => [
  requested(R1, NOW - 9_000, { title: 'Requests on the board', acceptance: ['the suite passes'], status: 'open' }),
  piece(P1, NOW - 9_000, 'Types', 'done', R1),
  piece(P2, NOW - 8_000, 'Fold', 'doing', R1),
  added('n20261001-bbbb', NOW - 7_000, 'Other work'),
]

describe('progress_plan: the main model puts a request on the board', () => {
  test("one request event and one todo piece per step in this session's file, the session's current request, the ids in the answer; no model call", async ($, on) => {
    const { world } = await local($, on)

    world.files[CANVAS] = JSON.stringify({ url: URL })

    const r = await callPlan($, PLAN)
    const [request, ...adds] = allOf(world, LOCAL_EVENTS) ?? []
    const id = (request as RequestEvent | undefined)?.request ?? ''
    const ids = adds.map(one => (one as NodeEvent).node)

    expect(world.tools).toContain('progress_plan')
    expect(request).toMatchObject({ type: 'request', at: NOW, session: 'sa', commit: 'abc1234', fields: { title: PLAN.title, acceptance: PLAN.acceptance, status: 'open' } })
    expect(id).toMatch(RID)
    expect(adds.map(one => [one.type, (one as NodeEvent).fields])).toEqual(PLAN.steps.map(step => ['add', { title: step, status: 'todo', kind: 'feature', done_when: step, request: id }]))
    expect(world.store['request:sa']).toBe(id)
    expect(r.result?.[0]?.text).toBe(`Request ${id} is on the progress board with 3 steps: ${ids.join(', ')}`)
    expect(foldRequests(boardOf(world), NOW)).toMatchObject([{ id, state: 'open', total: 3, done: 0, pieces: ids }])
    expect(world.batches[0]?.writes.slice(1).map(one => one.doc_id), 'the request and the pieces mirrored, then the backfill').toEqual([`q${NOW}-${id}`, ...ids.map(one => `e${NOW}-${one}`), `b${NOW}-${id}`])
    expect(world.batches[0]?.writes[1]?.data).toEqual({ type: 'request', request: id, at: NOW, commit: 'abc1234', session: 'sa', fields: { title: PLAN.title, acceptance: PLAN.acceptance, status: 'open' }, seq: 1 })
    expect(world.requests).toEqual([])
  })

  test('no steps, seven steps, a title over 60, an unknown request, drop without request: nothing written, the answer says why', async ($, on) => {
    const { world } = await local($, on)
    const cases: [object, RegExp][] = [
      [{ ...PLAN, steps: [] }, /steps/],
      [{ ...PLAN, steps: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, /steps/],
      [{ ...PLAN, title: 'x'.repeat(61) }, /title.*60/],
      [{ ...PLAN, request: 'r20990101-ffff' }, /r20990101-ffff/],
      [{ ...PLAN, drop: [P1] }, /drop/],
    ]

    for (const [input, why] of cases) {
      const r = await callPlan($, input)

      expect(r.deny ?? '', JSON.stringify(input)).toMatch(why)
    }

    expect(written(world)).toEqual([CONFIG])
    expect(world.store['request:sa']).toBeUndefined()
  })

  test("request and drop, by the split release's tool name: the steps appended to that request, the named pieces dropped", async ($, on) => {
    const { world } = await local($, on)

    await callPlan($, { ...PLAN, steps: ['Types', 'Fold'] })

    const id = world.store['request:sa'] as string
    const [types, fold] = (eventsOf(world, LOCAL_EVENTS) ?? []).map(one => one.node)
    const stray = await callPlan($, { ...PLAN, request: id, steps: ['Recorder'], drop: ['n20990101-ffff'] }, 'mcp__progress__progress_plan')
    const r = await callPlan($, { ...PLAN, request: id, steps: ['Recorder'], drop: [fold] }, 'mcp__progress__progress_plan')
    const nodes = foldBoard(boardOf(world))

    expect(stray.deny ?? '').toMatch(/n20990101-ffff/)
    expect(nodes.map(one => [one.title, one.status, one.request])).toEqual([
      ['Types', 'todo', id],
      ['Fold', 'dropped', id],
      ['Recorder', 'todo', id],
    ])
    expect(foldRequests(boardOf(world), NOW)).toMatchObject([{ id, total: 2, pieces: [types, fold, nodes[2]!.id], state: 'open' }])
    expect(r.result?.[0]?.text).toContain(nodes[2]!.id)
  })

  test('continuing a closed request reopens it and makes it current', async ($, on) => {
    const { world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([
      requested(R1, NOW - 9_000, { title: 'Old request', acceptance: ['done'], status: 'open' }),
      piece(P1, NOW - 9_000, 'Old piece', 'done', R1),
      requested(R1, NOW - 8_000, { status: 'closed', resolution: { by: 'piece', evidence: 'its one piece is done' } }),
    ])

    await callPlan($, { ...PLAN, request: R1, steps: ['More'] })

    expect(foldRequests(boardOf(world), NOW)).toMatchObject([{ id: R1, title: PLAN.title, status: 'open', state: 'open', resolution: null, total: 2, done: 1 }])
    expect(world.store['request:sa']).toBe(R1)
  })
})

describe('recording a turn: requests', () => {
  test("a session with a current request: the model's new pieces carry its id; the prompt has <current_request> and no board-wide list", async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify(seeded())
    world.store['request:sa'] = R1
    world.replies = [reply(PAGE_NODE)]
    await turn($, clock, world)

    const prompt = world.requests[0]!.prompt

    expect(prompt).toContain('<current_request>')
    expect(prompt).toContain(R1)
    expect(prompt).toContain('Requests on the board')
    expect(prompt).toContain('the suite passes')
    expect(prompt).toContain(`${P1} · Types · done`)
    expect(prompt).not.toContain('Types works')
    expect(prompt).toContain(`${P2} · Fold · doing · done when: Fold works`)
    expect(prompt).not.toContain('Other work')
    expect(prompt).not.toContain('<open_requests>')
    expect(eventsOf(world, LOCAL_EVENTS)?.map(one => one.fields.request)).toEqual([R1])
    expect(requestsOf(world, LOCAL_EVENTS)).toEqual([])
    expect(world.store['request:sa']).toBe(R1)
  })

  test('no current request (the stored one closed): the prompt lists the open requests; a reply naming one attaches to it and makes it current', async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([
      ...seeded(),
      requested(R2, NOW - 6_000, { title: 'Finished request', acceptance: ['x'], status: 'open' }),
      requested(R2, NOW - 5_000, { status: 'closed', resolution: { by: 'person', evidence: 'closed by the person' } }),
    ])
    world.store['request:sa'] = R2
    world.replies = [JSON.stringify({ nodes: [PAGE_NODE], request: R1 })]
    await turn($, clock, world)

    const prompt = world.requests[0]!.prompt

    expect(prompt).toContain('<open_requests>')
    expect(prompt).toContain(`${R1} · Requests on the board`)
    expect(prompt).not.toContain('<current_request>')
    expect(prompt).not.toContain('Finished request')
    expect(eventsOf(world, LOCAL_EVENTS)?.map(one => one.fields.request)).toEqual([R1])
    expect(world.store['request:sa']).toBe(R1)
  })

  test('no current request: a reply with a request object creates it, open, and it becomes current', async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = [reply(PAGE_NODE)]
    await turn($, clock, world)

    const [request] = requestsOf(world, LOCAL_EVENTS) ?? []

    expect(request).toMatchObject({ type: 'request', at: NOW, session: 'sa', commit: 'abc1234', fields: { ...REQUEST, status: 'open' } })
    expect(request?.request).toMatch(RID)
    expect(eventsOf(world, LOCAL_EVENTS)?.map(one => one.fields.request)).toEqual([request?.request])
    expect(world.store['request:sa']).toBe(request?.request)
  })

  test('no current request: real work with no request in the reply, a request not open, a request object with a status: nothing written', async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = [
      JSON.stringify({ nodes: [PAGE_NODE] }),
      JSON.stringify({ nodes: [PAGE_NODE], request: 'r20990101-ffff' }),
      JSON.stringify({ nodes: [PAGE_NODE], request: { ...REQUEST, status: 'closed' } }),
    ]

    for (const turnId of ['t1', 't2', 't3']) {
      await turn($, clock, world, { turnId })
    }

    expect(world.requests.length).toBe(3)
    expect(written(world)).toEqual([CONFIG])
    expect(world.logs.filter(line => line.startsWith('progress:')).length).toBe(3)
    expect(world.store['request:sa']).toBeUndefined()
  })

  test("the model's reply cannot close a request: a request status in the reply is refused, with a current request too", async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify(seeded())
    world.store['request:sa'] = R1
    world.replies = [JSON.stringify({ nodes: [{ id: P2, summary: 'More of the fold.' }], request: { id: R1, status: 'closed' } })]
    await turn($, clock, world)

    expect(allOf(world, LOCAL_EVENTS)).toBeNull()
    expect(foldRequests(boardOf(world), NOW)).toMatchObject([{ id: R1, status: 'open' }])
  })

  test('node events carry the turn id, its new commits and the top-level directories of its edits', async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = [reply(PAGE_NODE)]
    world.log = 'def5678 Add the page\nccc0000 Start the page\n'
    await turn($, clock, world, {
      edits: [{ path: `${ROOT}/hooks/page.ts` }, { path: `${ROOT}/hooks/more.ts` }, { path: `${ROOT}/tests/page.test.ts` }, { path: `${ROOT}/README.md` }],
      head: 'def5678',
    })

    expect(eventsOf(world, LOCAL_EVENTS)?.[0]).toMatchObject({ turn: 't1', commits: ['def5678', 'ccc0000'], dirs: ['hooks', 'tests', '.'] })
  })
})

describe('recording a turn: a request closes by rule', () => {
  /** The main loop's turn: an Edit and a Bash test run that passed, in `order`; what $.store held of the turn before it ended. */
  async function testedTurn($: Engine, clock: MockClock, world: World, order: ('edit' | 'pass')[]) {
    await $.prompt.submit({ text: 'Finish the fold', wait: false, origin: { kind: 'composer' } } as never)
    await $.turn.start({ text: 'Finish the fold', turnId: 't1' })

    for (const step of order) {
      await (step === 'edit'
        ? $.classic.PostToolUse({ tool_name: 'Edit', tool_input: { file_path: `${ROOT}/hooks/fold.ts`, old_string: 'a', new_string: 'b' }, tool_response: {}, tool_use_id: 'toolu_e' } as never)
        : $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'claude  plugin test\n  plugins/dashboard' }, tool_response: { stdout: ' 12 pass\n 0 fail\n', stderr: '' }, tool_use_id: 'toolu_b' } as never))
    }

    const stored = world.store['turn:sa']

    await $.turn.complete({ answer: 'The fold is in.', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.settle()

    return stored
  }

  test("its last piece done and the turn's commit on main: closed by check, no longer the session's current request", async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify(seeded())
    world.store['request:sa'] = R1
    world.onMain = true
    world.log = 'def5678 Finish the fold\n'
    world.replies = [reply({ id: P2, status: 'done' })]
    await turn($, clock, world, { edits: [], head: 'def5678' })

    expect(requestsOf(world, LOCAL_EVENTS)).toEqual([
      { type: 'request', request: R1, at: NOW, session: 'sa', commit: 'def5678', fields: { status: 'closed', resolution: { by: 'check', evidence: 'commit def5678 on main' } } },
    ])
    expect(world.runs).toContainEqual(['git', '-C', ROOT, 'merge-base', '--is-ancestor', 'def5678', 'main'])
    expect(world.store['request:sa']).toBeUndefined()
  })

  test('its last piece done and a test run that passed after the last edit: closed by check; the run kept on the stored turn', async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify(seeded())
    world.store['request:sa'] = R1
    world.replies = [reply({ id: P2, status: 'done' })]

    const stored = await testedTurn($, clock, world, ['edit', 'pass'])

    expect(stored).toMatchObject({ passed: { command: 'claude plugin test plugins/dashboard', at: NOW } })
    expect(requestsOf(world, LOCAL_EVENTS)).toEqual([
      { type: 'request', request: R1, at: NOW, session: 'sa', commit: 'abc1234', fields: { status: 'closed', resolution: { by: 'check', evidence: 'tests passed: claude plugin test plugins/dashboard' } } },
    ])
  })

  test('a passing run followed by an edit, no commit on main: no close event, the request ready and still current', async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify(seeded())
    world.store['request:sa'] = R1
    world.replies = [reply({ id: P2, status: 'done' })]

    const stored = await testedTurn($, clock, world, ['pass', 'edit'])

    expect(stored).toMatchObject({ id: 't1' })
    expect(stored).not.toHaveProperty('passed')
    expect(requestsOf(world, LOCAL_EVENTS)).toEqual([])
    expect(foldRequests(boardOf(world), NOW)).toMatchObject([{ id: R1, state: 'ready' }])
    expect(world.store['request:sa']).toBe(R1)
  })
})

describe('recorder usage', () => {
  test('a line per model call in <board dir>/recorder-usage.jsonl; a call not answered has failed', async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = [reply(PAGE_NODE)]
    await turn($, clock, world)
    await turn($, clock, world, { turnId: 't2' })

    const lines = (world.files[`${BOARD}/recorder-usage.jsonl`] ?? '')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as unknown)

    expect(lines).toEqual([
      { at: NOW, session: 'sa', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      { at: NOW, session: 'sa', failed: 'empty-reply' },
    ])
  })
})

describe('requests: folded, planned against, closed', () => {
  const opened = (at: number) => requested(R1, at, { title: 'R', acceptance: ['a'], status: 'open' })

  test('foldRequests: pieces in add order; counts leave out dropped pieces and follow-ups, counted apart', () => {
    const events = [
      opened(10),
      piece('a', 11, 'A', 'done', R1),
      piece('b', 12, 'B', 'todo', R1),
      piece('c', 13, 'C', 'dropped', R1),
      piece('d', 14, 'D', 'todo', R1, { discovered_from: 'a' }),
      piece('e', 15, 'E', 'done', ''),
    ]

    expect(foldRequests(events, 20)).toEqual([
      { id: R1, title: 'R', acceptance: ['a'], status: 'open', resolution: null, line: '', at: 10, updatedAt: 14, session: 'sb', pieces: ['a', 'b', 'c', 'd'], done: 1, total: 2, followUps: 1, state: 'open', closedAt: null },
    ])
  })

  test('state: ready once every counted piece is done; stale at 72 hours without an event, not at 71; closed and dropped as stored; newest first', () => {
    const open = [opened(NOW), piece('a', NOW, 'A', 'done', R1), piece('b', NOW, 'B', 'doing', R1)]
    const state = (events: BoardEvent[], now: number) => foldRequests(events, now).find(one => one.id === R1)?.state

    expect(state(open, NOW + 71 * HOUR)).toBe('open')
    expect(state(open, NOW + 72 * HOUR)).toBe('stale')
    expect(state([...open, event({ type: 'update', node: 'b', at: NOW, fields: { status: 'done' } })], NOW + 100 * HOUR)).toBe('ready')
    expect(state([opened(NOW)], NOW), 'no piece: not ready').toBe('open')
    expect(state([...open, requested(R1, NOW + 1, { status: 'closed', resolution: { by: 'person', evidence: 'closed by the person' } })], NOW)).toBe('closed')
    expect(state([...open, requested(R1, NOW + 1, { status: 'dropped' })], NOW)).toBe('dropped')
    expect(foldRequests([...open, requested(R2, NOW + 5, { title: 'Newer', acceptance: ['b'], status: 'open' })], NOW).map(one => one.id)).toEqual([R2, R1])
  })

  test('closeEvents: one piece done closes by piece; two done close by a commit on main, else by a passing test, else not at all', () => {
    const at = NOW + 1
    const close = (events: BoardEvent[], facts: Parameters<typeof closeEvents>[2]) => closeEvents(foldRequests(events, at), foldBoard(events), facts, at, 'sa', 'abc1234')
    const closed = (by: string, evidence: string) => [{ type: 'request', request: R1, at, session: 'sa', commit: 'abc1234', fields: { status: 'closed', resolution: { by, evidence } } }]
    const two = [opened(NOW), piece('a', NOW, 'A', 'done', R1), { ...piece('b', NOW, 'B', 'done', R1), commit: 'def5678' }]

    expect(close([opened(NOW), piece('a', NOW, 'A', 'done', R1)], NO_FACTS)).toEqual(closed('piece', 'its one piece is done'))
    expect(close(two, { onMain: { shas: ['def5678'], branch: 'main' }, passedTests: 'bun test' })).toEqual(closed('check', 'commit def5678 on main'))
    expect(close(two, { onMain: { shas: ['0000000'], branch: 'main' }, passedTests: 'bun test' })).toEqual(closed('check', 'tests passed: bun test'))
    expect(close(two, NO_FACTS), 'ready, awaiting the person').toEqual([])
    expect(close([opened(NOW), piece('a', NOW, 'A', 'done', R1), piece('b', NOW, 'B', 'doing', R1)], { onMain: { shas: ['def5678'], branch: 'main' }, passedTests: 'bun test' })).toEqual([])
    expect(close([opened(NOW), piece('a', NOW, 'A', 'done', R1), requested(R1, NOW, { status: 'dropped' })], NO_FACTS)).toEqual([])
  })

  test('planNodes: an add carries the request; an update of a dropped piece and a discovered_from naming no node are refused; #index allowed', () => {
    const board = foldBoard([added('n1', 10, 'Open'), added('n2', 11, 'Dropped', 'dropped')])
    const plan = planNodes([TOOL_NODE, { ...PAGE_NODE, discovered_from: '#0' }, { ...PAGE_NODE, discovered_from: 'n1' }], board, NOW, 'sa', null, R1)
    const events = 'events' in plan ? plan.events : []
    const refused = (nodes: object[]) => {
      const one = planNodes(nodes, board, NOW, 'sa', null, R1)

      return 'error' in one ? one.error : ''
    }

    expect(events.map(one => one.fields.request)).toEqual([R1, R1, R1])
    expect(events.map(one => one.fields.discovered_from)).toEqual([undefined, events[0]?.node, 'n1'])
    expect(refused([{ id: 'n2', status: 'todo' }])).toMatch(/n2.*dropped/)
    expect(refused([{ ...PAGE_NODE, discovered_from: 'n20990101-ffff' }])).toMatch(/discovered_from.*n20990101-ffff/)
    expect(refused([{ ...PAGE_NODE, discovered_from: '#4' }])).toMatch(/#4/)
  })
})

describe('/progress-close: requests', () => {
  const opened = () => requested(R1, NOW - 9_000, { title: 'Requests on the board', acceptance: ['the suite passes'], status: 'open' })

  test('<request id> done closes it by the person, dropped drops it; its pieces left as they are', async ($, on) => {
    const { world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify(seeded())

    const done = await $.command.run(command('progress-close', `${R1} done`))
    const dropped = await $.command.run(command('progress-close', `${R1} dropped`))

    expect(requestsOf(world, LOCAL_EVENTS)).toEqual([
      { type: 'request', request: R1, at: NOW, session: 'sa', commit: 'abc1234', fields: { status: 'closed', resolution: { by: 'person', evidence: 'closed by the person' } } },
      { type: 'request', request: R1, at: NOW, session: 'sa', commit: 'abc1234', fields: { status: 'dropped' } },
    ])
    expect(eventsOf(world, LOCAL_EVENTS)).toEqual([])
    expect(done.text).toContain('Requests on the board')
    expect(done.text).toContain('closed')
    expect(dropped.text).toContain('dropped')
  })

  test("Done on a request's only piece closes the request by piece", async ($, on) => {
    const { world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([opened(), piece(P1, NOW - 9_000, 'Types', 'doing', R1)])

    await $.command.run(command('progress-close', `${P1} done`))

    expect(allOf(world, LOCAL_EVENTS)).toEqual([
      { type: 'update', node: P1, at: NOW, session: 'sa', commit: 'abc1234', fields: { status: 'done' } },
      { type: 'request', request: R1, at: NOW, session: 'sa', commit: 'abc1234', fields: { status: 'closed', resolution: { by: 'piece', evidence: 'its one piece is done' } } },
    ])
  })
})

const LID = /^l\d{8}-[0-9a-f]{4}$/
const L1 = 'l20261001-aaaa'
const L2 = 'l20261001-bbbb'
const NO_SIGNALS = { paths: [], scopes: [], pattern: '', lastLine: '' }
const keysOf = (paths: string[] = [], scopes: string[] = [], patterns: string[] = []): LineKeys => ({ paths, scopes, patterns })
const lined = (line: string, at: number, fields: LineFields): LineEvent => ({ type: 'line', line, at, session: 'sb', commit: null, fields })
const linesOf = (world: World) => allOf(world, LOCAL_EVENTS)?.filter((one): one is LineEvent => one.type === 'line') ?? null

describe('lines: keys, candidates, the fold', () => {
  test('titlePattern: versions, digit runs and #refs fold, so two releases share a pattern', () => {
    expect(titlePattern('发布 0.8.5 并上线')).toBe(titlePattern('发布 0.8.6 并上线'))
    expect(titlePattern('发布 0.8.5 并上线')).toBe('发布 <ver> 并上线')
    expect(titlePattern('审查 PR #141')).toBe('审查 pr #<n>')
    expect(titlePattern('  Release  v1.2.3 in   3 steps ')).toBe('release <ver> in <n> steps')
  })

  test('scopeOf: the text before the first colon of a commit subject, 1 to 24 characters of [\\w./-]', () => {
    expect(scopeOf('dashboard: x')).toBe('dashboard')
    expect(scopeOf('fix the bug: y')).toBeNull()
    expect(scopeOf(`${'a'.repeat(30)}: z`)).toBeNull()
    expect(scopeOf('no colon')).toBeNull()
  })

  test('pathKeys: the first two directory segments, the one of a one-segment directory; distinct; root files and outside paths give none', () => {
    expect(pathKeys(['plugins/dashboard/hooks/a.ts', 'plugins/dashboard/b.ts', 'hooks/page.ts', 'README.md', '/tmp/x.ts'])).toEqual(['plugins/dashboard', 'hooks'])
  })

  test('lineCandidates: path and scope outrank a pattern alone; a retired line is never one; at most 5, highest first', () => {
    const board = foldLines([
      lined(L1, 10, { name: 'Pattern only', definition: 'd', status: 'active', keys: keysOf([], [], ['release <ver> cleanup']) }),
      lined(L2, 11, { name: 'Paths and scope', definition: 'd', status: 'active', keys: keysOf(['plugins/dashboard'], ['dashboard'], []) }),
      lined('l20261001-cccc', 12, { name: 'Retired', definition: 'd', status: 'retired', keys: keysOf(['plugins/dashboard'], ['dashboard'], ['release <ver> cleanup']) }),
    ])
    const found = lineCandidates(board, { paths: ['plugins/dashboard'], scopes: ['dashboard'], pattern: 'release <ver> cleanup', lastLine: '' })

    expect(found.map(one => [one.line.id, one.score, one.shared])).toEqual([
      [L2, 6, ['path plugins/dashboard', 'scope dashboard']],
      [L1, 4, ['pattern release <ver> cleanup']],
    ])

    const many = foldLines(Array.from({ length: 7 }, (_, i) => lined(`l20261001-000${i}`, i, { name: `L${i}`, definition: 'd', status: 'active', keys: keysOf(['hooks']) })))

    expect(lineCandidates(many, { ...NO_SIGNALS, paths: ['hooks'] }).length).toBe(5)
    expect(lineCandidates(many, NO_SIGNALS)).toEqual([])
  })

  test('lineCandidates: a pattern sharing half its words scores 2, the last line 2; strong at 6 and twice the second', () => {
    const board = foldLines([
      lined(L1, 10, { name: 'Releases', definition: 'd', status: 'active', keys: keysOf([], [], ['release <ver> cleanup notes']) }),
      lined(L2, 11, { name: 'Board', definition: 'd', status: 'active', keys: keysOf(['hooks']) }),
    ])
    const similar = lineCandidates(board, { ...NO_SIGNALS, pattern: 'release <ver> cleanup' })
    const both = lineCandidates(board, { paths: ['hooks'], scopes: [], pattern: 'release <ver> cleanup', lastLine: L2 })

    expect(similar.map(one => [one.line.id, one.score])).toEqual([[L1, 2]])
    expect(lineCandidates(board, { ...NO_SIGNALS, pattern: 'release <ver>' }), 'one word of three').toEqual([])
    expect(both.map(one => [one.line.id, one.score, one.shared])).toEqual([
      [L2, 5, ['path hooks', 'last line']],
      [L1, 2, ['similar pattern release <ver> cleanup notes']],
    ])
    expect(isStrong(both), '5 is under 6').toBe(false)
    expect(isStrong([{ ...both[0]!, score: 6 }]), 'no second').toBe(true)
    expect(isStrong([{ ...both[0]!, score: 7 }, { ...both[1]!, score: 4 }]), 'not twice the second').toBe(false)
    expect(isStrong([{ ...both[0]!, score: 8 }, { ...both[1]!, score: 4 }])).toBe(true)
    expect(isStrong([])).toBe(false)
  })

  test('growKeys: new keys first, distinct, capped at 8 paths, 5 scopes, 5 patterns', () => {
    const grown = growKeys(keysOf(['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['s1'], ['p1']), { paths: ['h', 'a', 'i'], scopes: ['s2', 's1'], pattern: 'p2', lastLine: '' })

    expect(grown).toEqual({ paths: ['h', 'a', 'i', 'b', 'c', 'd', 'e', 'f'], scopes: ['s2', 's1'], patterns: ['p2', 'p1'] })
    expect(growKeys(keysOf(), NO_SIGNALS), 'an empty pattern is no key').toEqual(keysOf())
  })

  test('foldLines: newest first, its requests newest first with open and closed counts; a retired line kept; line and relink events parse', () => {
    const relink: RelinkEvent = { type: 'relink', request: R1, from: L2, to: L1, at: 45, session: 'sa', commit: null, keys: keysOf(['hooks']) }
    const events: BoardEvent[] = [
      lined(L1, 10, { name: 'One', definition: 'd1', status: 'active', keys: keysOf() }),
      lined(L2, 20, { name: 'Two', definition: 'd2', status: 'active', keys: keysOf() }),
      lined(L2, 30, { status: 'retired' }),
      requested(R1, 40, { title: 'A', acceptance: ['a'], status: 'open', line: L1 }),
      relink,
      requested(R2, 50, { title: 'B', acceptance: ['b'], status: 'open', line: L1 }),
      requested(R2, 60, { status: 'closed', resolution: { by: 'person', evidence: 'closed by the person' } }),
    ]

    expect(foldLines(events)).toEqual([
      { id: L1, name: 'One', definition: 'd1', keys: keysOf(), status: 'active', merged_into: '', at: 10, updatedAt: 60, requests: [R2, R1], open: 1, closed: 1 },
      { id: L2, name: 'Two', definition: 'd2', keys: keysOf(), status: 'retired', merged_into: '', at: 20, updatedAt: 30, requests: [], open: 0, closed: 0 },
    ])
    expect(foldRequests(events, 60).map(one => one.line)).toEqual([L1, L1])
    expect(foldBoard(events)).toEqual([])
    expect(parseBoardEvents(JSON.stringify(events))).toEqual(events)
  })

  test('the real case: "发布 0.8.6" over the same paths as "发布 0.8.5 并上线 Sparkle appcast" gets its line as a strong candidate', () => {
    const paths = pathKeys(['StatusKit/Sources/App.swift', 'docs/appcast.xml'])
    const first = { paths, scopes: [], pattern: titlePattern('发布 0.8.5 并上线 Sparkle appcast'), lastLine: '' }
    const events = [
      lined(L1, 10, { name: 'StatusKit releases', definition: 'Each StatusKit version shipped through the Sparkle appcast.', status: 'active', keys: keysOf() }),
      lined(L1, 11, { keys: growKeys(keysOf(), first) }),
      requested(R1, 11, { title: '发布 0.8.5 并上线 Sparkle appcast', acceptance: ['the appcast lists 0.8.5'], status: 'open', line: L1 }),
      lined(L2, 12, { name: 'Translations', definition: 'Translating the settings page.', status: 'active', keys: keysOf(['docs']) }),
    ]
    const found = lineCandidates(foldLines(events), { paths, scopes: [], pattern: titlePattern('发布 0.8.6 并上线 Sparkle appcast'), lastLine: '' })

    expect(found.map(one => one.line.id)).toEqual([L1, L2])
    expect(isStrong(found)).toBe(true)
  })
})

describe('lines: the recorder', () => {
  const boardLine = () => lined(L1, NOW - 20_000, { name: 'Board work', definition: 'The progress board recorder and its requests.', status: 'active', keys: keysOf(['hooks'], [], ['requests on the board']) })
  const lineReply = (line: unknown) => JSON.stringify({ nodes: [PAGE_NODE], line, line_why: 'it shares the path hooks' })
  /** A closed request of L1, so the candidate lists a recent title. */
  const pastRequest = () => [
    requested(R2, NOW - 19_000, { title: 'Board fold', acceptance: ['x'], status: 'open', line: L1 }),
    requested(R2, NOW - 18_000, { status: 'closed', resolution: { by: 'person', evidence: 'closed by the person' } }),
  ]

  test('progress_plan: a strongly matching line is assigned and its keys grow; only weak matches leave the line empty', async ($, on) => {
    const { world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([boardLine()])
    world.store['line:sa'] = L1
    await callPlan($, PLAN)

    const strong = world.store['request:sa'] as string

    expect(requestsOf(world, LOCAL_EVENTS)?.[0]).toMatchObject({ request: strong, fields: { title: PLAN.title, status: 'open', line: L1 } })
    expect(linesOf(world)).toEqual([{ type: 'line', line: L1, at: NOW, session: 'sa', commit: 'abc1234', fields: { keys: keysOf(['hooks'], [], ['requests on the board']) } }])
    expect(world.store['line:sa']).toBe(L1)
    expect(world.requests).toEqual([])

    delete world.store['line:sa']
    await callPlan($, PLAN)

    const weak = world.store['request:sa'] as string

    expect(weak).not.toBe(strong)
    expect(foldRequests(boardOf(world), NOW).find(one => one.id === weak)?.line, 'pattern alone: 4 points').toBe('')
    expect(linesOf(world)?.length).toBe(1)
  })

  test('record, the current request with no line: <line_candidates> with shared keys; a reply naming a candidate assigns it and sets line:<session>', async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([...seeded(), boardLine(), ...pastRequest()])
    world.store['request:sa'] = R1
    world.replies = [lineReply(L1)]
    await turn($, clock, world)

    const prompt = world.requests[0]!.prompt

    expect(prompt, 'the line rules ride with the candidates').toContain('Lines:\n- A line is a stream of requests')
    expect(RECORD_SYSTEM).not.toContain('Lines:')
    expect(prompt).toContain(`<line_candidates>\n${L1} · Board work · The progress board recorder and its requests. · shared: path hooks, pattern requests on the board · recent: Board fold\n</line_candidates>`)
    expect(prompt).not.toContain('<past_corrections>')
    expect(world.requests[0]!.system).toContain('line_why')
    expect(eventsOf(world, LOCAL_EVENTS)?.length).toBe(1)
    expect(requestsOf(world, LOCAL_EVENTS)).toEqual([{ type: 'request', request: R1, at: NOW, session: 'sa', commit: 'abc1234', fields: { line: L1 } }])
    expect(linesOf(world)).toEqual([{ type: 'line', line: L1, at: NOW, session: 'sa', commit: 'abc1234', fields: { keys: keysOf(['hooks'], [], ['requests on the board']) } }])
    expect(world.store['line:sa']).toBe(L1)
    expect(foldLines(boardOf(world))[0]).toMatchObject({ id: L1, requests: [R1, R2], open: 1, closed: 1 })
  })

  test('record, no line yet: a reply naming a line not among the candidates writes nothing; a reply without a line records the nodes alone', async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([...seeded(), boardLine()])
    world.store['request:sa'] = R1
    world.replies = [lineReply('l20990101-ffff'), JSON.stringify({ nodes: [PAGE_NODE] })]
    await turn($, clock, world)

    expect(allOf(world, LOCAL_EVENTS)).toBeNull()
    expect(world.logs.filter(line => line.startsWith('progress:')).length).toBe(1)
    expect(world.logs.find(line => line.startsWith('progress:'))).toContain('l20990101-ffff')

    await turn($, clock, world, { turnId: 't2' })

    expect(eventsOf(world, LOCAL_EVENTS)?.length).toBe(1)
    expect(requestsOf(world, LOCAL_EVENTS)).toEqual([])
    expect(linesOf(world)).toEqual([])
    expect(foldRequests(boardOf(world), NOW).find(one => one.id === R1)?.line).toBe('')
    expect(world.logs.filter(line => line.startsWith('progress:')).length).toBe(2)
    expect(world.store['line:sa']).toBeUndefined()
  })

  test('record, no line yet: a reply opening a new line writes the line, then its grown keys, and assigns it', async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([...seeded(), boardLine()])
    world.store['request:sa'] = R1
    world.replies = [lineReply({ name: 'Progress recorder', definition: 'The recorder that writes the progress board.' })]
    await turn($, clock, world)

    const [made, grown] = linesOf(world) ?? []
    const id = made?.line ?? ''

    expect(id).toMatch(LID)
    expect(id).not.toBe(L1)
    expect(made).toEqual({ type: 'line', line: id, at: NOW, session: 'sa', commit: 'abc1234', fields: { name: 'Progress recorder', definition: 'The recorder that writes the progress board.', status: 'active', keys: keysOf() } })
    expect(grown).toEqual({ type: 'line', line: id, at: NOW, session: 'sa', commit: 'abc1234', fields: { keys: keysOf(['hooks'], [], ['requests on the board']) } })
    expect(requestsOf(world, LOCAL_EVENTS)).toEqual([{ type: 'request', request: R1, at: NOW, session: 'sa', commit: 'abc1234', fields: { line: id } }])
    expect(world.store['line:sa']).toBe(id)
  })

  test('record, the current request in a line: no <line_candidates>; its keys grow only when the turn adds one', async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([...seeded(), boardLine(), requested(R1, NOW - 8_500, { line: L1 })])
    world.store['request:sa'] = R1
    world.replies = [reply(PAGE_NODE), reply(TOOL_NODE)]
    await turn($, clock, world, { edits: [{ path: `${ROOT}/hooks/page.ts` }, { path: `${ROOT}/tests/page.test.ts` }] })

    expect(world.requests[0]!.prompt).not.toContain('<line_candidates>')
    expect(world.requests[0]!.prompt, 'the line rules ride only with candidates').not.toContain('Lines:')
    expect(linesOf(world)).toEqual([{ type: 'line', line: L1, at: NOW, session: 'sa', commit: 'abc1234', fields: { keys: keysOf(['hooks', 'tests'], [], ['requests on the board']) } }])

    await turn($, clock, world, { turnId: 't2' })

    expect(eventsOf(world, LOCAL_EVENTS)?.length).toBe(2)
    expect(linesOf(world)?.length).toBe(1)
    expect(requestsOf(world, LOCAL_EVENTS)).toEqual([])
  })

  test('/progress-line <request> <line>: the request event and a relink; the next prompt with overlapping keys lists the correction', async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([
      boardLine(),
      lined(L2, NOW - 20_000, { name: 'Releases', definition: 'Shipping each version.', status: 'active', keys: keysOf() }),
      requested(R1, NOW - 9_000, { title: 'Requests on the board', acceptance: ['the suite passes'], status: 'open', line: L1 }),
      { ...piece(P1, NOW - 9_000, 'Types', 'done', R1), dirs: ['hooks', '.'] },
    ])

    const r = await $.command.run(command('progress-line', `${R1} ${L2}`))

    expect(allOf(world, LOCAL_EVENTS)).toEqual([
      { type: 'request', request: R1, at: NOW, session: 'sa', commit: 'abc1234', fields: { line: L2 } },
      { type: 'relink', request: R1, from: L1, to: L2, at: NOW, session: 'sa', commit: null, keys: keysOf(['hooks'], [], ['requests on the board']) },
    ])
    expect(r.text).toContain('Requests on the board')
    expect(r.text).toContain('Releases')

    world.replies = [reply(PAGE_NODE)]
    await turn($, clock, world)

    expect(world.requests[0]!.prompt).toContain('<past_corrections>\n"Requests on the board" moved from Board work to Releases\n</past_corrections>')
  })

  test('/progress-line <request> new <name>: a new line named so; a missing request or line, or bad arguments, write nothing', async ($, on) => {
    const { world } = await local($, on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([boardLine(), requested(R1, NOW - 9_000, { title: 'Requests on the board', acceptance: ['the suite passes'], status: 'open' })])

    const missingRequest = await $.command.run(command('progress-line', `r20990101-ffff ${L1}`))
    const missingLine = await $.command.run(command('progress-line', `${R1} l20990101-ffff`))
    const bad = await $.command.run(command('progress-line', R1))

    expect(missingRequest.text).toContain('r20990101-ffff')
    expect(missingLine.text).toContain('l20990101-ffff')
    expect(bad.text).toContain('Usage')
    expect(allOf(world, LOCAL_EVENTS)).toBeNull()

    const r = await $.command.run(command('progress-line', `${R1} new Translation work`))
    const [made, request, relink] = allOf(world, LOCAL_EVENTS) ?? []
    const id = (made as LineEvent | undefined)?.line ?? ''

    expect(id).toMatch(LID)
    expect(made).toEqual({ type: 'line', line: id, at: NOW, session: 'sa', commit: 'abc1234', fields: { name: 'Translation work', definition: '', status: 'active', keys: keysOf() } })
    expect(request).toEqual({ type: 'request', request: R1, at: NOW, session: 'sa', commit: 'abc1234', fields: { line: id } })
    expect(relink).toEqual({ type: 'relink', request: R1, from: '', to: id, at: NOW, session: 'sa', commit: null, keys: keysOf([], [], ['requests on the board']) })
    expect(r.text).toContain('Translation work')
  })
})

const R3 = 'r20261001-dddd'
const O1 = 'n20260901-0001'
const O2 = 'n20260901-0002'
const O3 = 'n20260901-0003'

/** Two active lines about the board: L1 with an open request, L2 with a closed one. */
const linePair = (): BoardEvent[] => [
  lined(L1, 10, { name: 'Board', definition: 'Board work.', status: 'active', keys: keysOf(['hooks'], [], ['board fold']) }),
  lined(L2, 11, { name: 'Board again', definition: 'More board work.', status: 'active', keys: keysOf(['tests'], ['dashboard'], ['board page']) }),
  requested(R1, 20, { title: 'Board fold', acceptance: ['a'], status: 'open', line: L1 }),
  requested(R2, 21, { title: 'Board page', acceptance: ['b'], status: 'closed', resolution: { by: 'person', evidence: 'closed by the person' }, line: L2 }),
]

describe('daily consolidation: when it runs', () => {
  /** A world with the board kept locally and `config` beside the storage, the session not started yet. */
  function unstarted(on: On, config: object = {}) {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, clock)

    world.files[CONFIG] = JSON.stringify({ storage: 'local', ...config })

    return { clock, world }
  }

  test('the first session start of a day asks sonnet once; consolidatedDay and backfilled written once it answered; another start that day asks none', async ($, on) => {
    const { clock, world } = unstarted(on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([added(O1, NOW - 9_000, 'Old work', 'done')])
    world.replies = ['{"ops": []}', '{"ops": []}']
    await $.session.start(SESSION)
    await clock.settle()

    expect(world.requests.length).toBe(1)
    expect(world.requests[0]).toMatchObject({ model: 'sonnet', system: CONSOLIDATE_SYSTEM, effort: 'low', maxTokens: 6000, timeoutMs: 120_000 })
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local', consolidatedDay: DAY, backfilled: true })
    expect(world.logs).toContain('progress: consolidated 0 ops, refused 0')
    expect(world.files[`${BOARD}/recorder-usage.jsonl`]).toContain('"input":1')

    await $.session.start(SESSION)
    await clock.settle()

    expect(world.requests.length).toBe(1)
  })

  test('a board with nothing to consolidate asks no model and still marks the day', async ($, on) => {
    const { clock, world } = unstarted(on, { backfilled: true })

    world.replies = ['{"ops": []}']
    await $.session.start(SESSION)
    await clock.settle()

    expect(world.requests).toEqual([])
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local', backfilled: true, consolidatedDay: DAY })
  })

  test('a board consolidated today asks no model', async ($, on) => {
    const { clock, world } = unstarted(on, { consolidatedDay: DAY })

    world.replies = ['{"ops": []}']
    await $.session.start(SESSION)
    await clock.settle()

    expect(world.requests).toEqual([])
  })

  test('a board consolidated the day before asks again; backfilled stays as it was', async ($, on) => {
    const { clock, world } = unstarted(on, { consolidatedDay: dayOf(NOW - 24 * HOUR), backfilled: true })

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([{ type: 'request', request: 'r20261001-aaaa', at: NOW - 9_000, session: 'sb', commit: null, fields: { title: 'Asked', acceptance: ['it works'], status: 'open' } }])
    world.replies = ['{"ops": []}']
    await $.session.start(SESSION)
    await clock.settle()

    expect(world.requests.length).toBe(1)
    expect(world.requests[0]!.prompt).not.toContain('<old_pieces>')
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local', consolidatedDay: DAY, backfilled: true })
  })

  test('a model call that does not answer leaves consolidatedDay unset and writes no event', async ($, on) => {
    const { clock, world } = unstarted(on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([added(O1, NOW - 9_000, 'Old work', 'done')])
    await $.session.start(SESSION)
    await clock.settle()

    expect(world.requests.length).toBe(1)
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local' })
    expect(allOf(world, LOCAL_EVENTS)).toBeNull()
    expect(world.logs.some(line => line.startsWith('progress: nothing consolidated'))).toBe(true)
  })

  test('a reply that does not parse leaves consolidatedDay unset', async ($, on) => {
    const { clock, world } = unstarted(on)

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([added(O1, NOW - 9_000, 'Old work', 'done')])
    world.replies = ['Here are the ops.']
    await $.session.start(SESSION)
    await clock.settle()

    expect(world.requests.length).toBe(1)
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local' })
  })

  test('no storage chosen: no model call and no question', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, clock)

    world.replies = ['{"ops": []}']
    await $.session.start(SESSION)
    await clock.settle()

    expect(world.requests).toEqual([])
    expect(world.asks).toEqual([])
    expect(written(world)).toEqual([])
  })
})

describe('daily consolidation: the prompt', () => {
  const board = (): BoardEvent[] => [
    lined(L1, 10, { name: 'Board work', definition: 'The progress board recorder.', status: 'active', keys: keysOf(['hooks'], ['dashboard'], ['requests on the board']) }),
    lined(L2, 11, { name: 'Translation work', definition: '', status: 'active', keys: keysOf() }),
    lined('l20261001-cccc', 12, { name: 'Retired work', definition: 'd', status: 'retired', keys: keysOf() }),
    requested(R1, 20, { title: 'Requests on the board', acceptance: ['a'], status: 'open', line: L1 }),
    requested(R2, 30, { title: 'Release 0.8.5 cleanup', acceptance: ['b'], status: 'open' }),
    { ...piece(P1, 31, 'Notes', 'done', R2), dirs: ['docs', '.'] },
    { ...added(O1, 5, 'Old work', 'done'), dirs: ['hooks'] },
    added(O2, 6, 'Dropped old work', 'dropped'),
    { type: 'relink', request: R1, from: L2, to: L1, at: 40, session: 'sa', commit: null, keys: keysOf(['hooks']) },
  ]

  test('lines with keys and request titles, an empty definition as (none); unassigned requests with their paths; <old_pieces> only before the backfill; corrections', () => {
    const before = consolidatePrompt(board(), false)
    const after = consolidatePrompt(board(), true)

    expect(before).toContain(
      `<lines>\n${L1} · Board work · The progress board recorder. · keys: paths hooks; scopes dashboard; patterns requests on the board · requests: Requests on the board\n${L2} · Translation work · (none) · keys: paths (none); scopes (none); patterns (none) · requests: (none)\n</lines>`,
    )
    expect(before).toContain(`<unassigned_requests>\n${R2} · Release 0.8.5 cleanup · release <ver> cleanup · docs\n</unassigned_requests>`)
    expect(before).toContain(`<old_pieces>\n${O1} · Old work · done · ${dayOf(5)} · hooks\n</old_pieces>`)
    expect(before).toContain('<past_corrections>\n"Requests on the board" moved from Translation work to Board work\n</past_corrections>')
    expect(after).not.toContain('<old_pieces>')
    expect(after).toContain('<unassigned_requests>')
    expect(CONSOLIDATE_SYSTEM).toContain('A line is a stream of requests about one subject')
  })
})

describe('daily consolidation: the ops checked and applied', () => {
  const at = NOW
  const plan = (ops: unknown, events: BoardEvent[]) => planConsolidation(ops, events, at, 'sa')
  const lineEvent = (line: string, fields: LineFields) => ({ type: 'line', line, at, session: 'sa', commit: null, fields })
  const requestEvent = (request: string, fields: RequestFields) => ({ type: 'request', request, at, session: 'sa', commit: null, fields })

  test('merge: from retired with merged_into, its requests moved into into, into keeping both key sets', () => {
    const r = plan([{ op: 'merge', from: L2, into: L1, why: 'both edit the board' }], linePair())
    const after = [...linePair(), ...r.events]

    expect(r.refused).toEqual([])
    expect(r.events).toEqual([
      lineEvent(L2, { status: 'retired', merged_into: L1 }),
      requestEvent(R2, { line: L1 }),
      lineEvent(L1, { keys: keysOf(['hooks', 'tests'], ['dashboard'], ['board fold', 'board page']) }),
    ])
    expect(foldLines(after).map(one => [one.id, one.status, one.merged_into, one.requests])).toEqual([
      [L1, 'active', '', [R2, R1]],
      [L2, 'retired', L1, []],
    ])
  })

  test('merge into itself or into a retired line is refused', () => {
    const r = plan(
      [
        { op: 'merge', from: L1, into: L1, why: 'x' },
        { op: 'merge', from: L2, into: L1, why: 'x' },
        { op: 'merge', from: L1, into: L2, why: 'x' },
      ],
      linePair(),
    )

    expect(r.refused.length).toBe(2)
    expect(r.refused[0]).toMatch(/^ops\[0\].*itself/)
    expect(r.refused[1]).toMatch(/^ops\[2\].*retired/)
    expect(r.events.length).toBe(3)
  })

  test('define fills a definition, a name optional; retire a line with no open request; a line with one, and texts over their limits, refused', () => {
    const r = plan(
      [
        { op: 'define', line: L2, definition: 'The board page.' },
        { op: 'define', line: L1, name: 'Board fold', definition: 'Folding the board.' },
        { op: 'retire', line: L2, why: 'its one request is closed' },
        { op: 'retire', line: L1, why: 'x' },
        { op: 'define', line: L1, definition: 'x'.repeat(121) },
        { op: 'define', line: L1, name: 'x'.repeat(41), definition: 'Fine.' },
        { op: 'merge', from: L1, into: L2, why: 'x'.repeat(161) },
      ],
      linePair(),
    )

    expect(r.events).toEqual([lineEvent(L2, { definition: 'The board page.' }), lineEvent(L1, { name: 'Board fold', definition: 'Folding the board.' }), lineEvent(L2, { status: 'retired' })])
    expect(r.refused.length).toBe(4)
    expect(r.refused[0]).toMatch(/^ops\[3\].*open request/)
    expect(r.refused[1]).toMatch(/^ops\[4\].*definition.*120/)
    expect(r.refused[2]).toMatch(/^ops\[5\].*name.*40/)
    expect(r.refused[3]).toMatch(/^ops\[6\].*why.*160/)
  })

  test('new_line then assign through #0: the line made, the request in it, its keys grown with the paths and pattern; #1 before any new_line and an assigned request refused', () => {
    const events = [...linePair(), requested(R3, 30, { title: 'Release 0.8.5 cleanup', acceptance: ['c'], status: 'open' }), { ...piece(P1, 31, 'Notes', 'done', R3), dirs: ['docs', '.'] }]
    const r = plan(
      [
        { op: 'assign', request: R3, line: '#1', why: 'x' },
        { op: 'new_line', ref: '#0', name: 'Releases', definition: 'Each release shipped.' },
        { op: 'assign', request: R3, line: '#0', why: 'the pattern release <ver> cleanup' },
        { op: 'assign', request: R1, line: '#0', why: 'x' },
      ],
      events,
    )
    const id = (r.events[0] as LineEvent | undefined)?.line ?? ''

    expect(id).toMatch(LID)
    expect(r.events).toEqual([
      lineEvent(id, { name: 'Releases', definition: 'Each release shipped.', status: 'active', keys: keysOf() }),
      requestEvent(R3, { line: id }),
      lineEvent(id, { keys: keysOf(['docs'], [], ['release <ver> cleanup']) }),
    ])
    expect(r.refused.length).toBe(2)
    expect(r.refused[0]).toMatch(/^ops\[0\].*#1/)
    expect(r.refused[1]).toMatch(new RegExp(`^ops\\[3\\].*${R1}`))
    expect(foldRequests([...events, ...r.events], NOW).find(one => one.id === R3)?.line).toBe(id)
  })

  test("group: a closed request when every piece is done, an open one otherwise, each piece's request set; a piece in two groups, a piece not old, an unknown id refuse only their op", () => {
    const events = [
      ...linePair(),
      { ...added(O1, 5, 'Ship 0.8.3', 'done'), dirs: ['StatusKit'] },
      added(O2, 6, 'Notes for 0.8.3', 'done'),
      added(O3, 7, 'Ship 0.8.4', 'doing'),
      piece(P1, 8, 'Not old', 'done', R1),
    ]
    const r = plan(
      [
        { op: 'group', pieces: [O1, O2], title: 'Ship 0.8.3', line: L1 },
        { op: 'group', pieces: [O3], title: 'Ship 0.8.4', line: L1 },
        { op: 'group', pieces: [O2], title: 'Again', line: L1 },
        { op: 'group', pieces: [P1], title: 'Not old', line: L1 },
        { op: 'assign', request: 'r20990101-ffff', line: L1, why: 'x' },
        { op: 'retire', line: 'l20990101-ffff', why: 'x' },
      ],
      events,
    )
    const after = [...events, ...r.events]
    const requests = foldRequests(after, NOW)
    const shipped = requests.find(one => one.title === 'Ship 0.8.3')

    expect(r.refused.length).toBe(4)
    expect(r.refused[0]).toMatch(new RegExp(`^ops\\[2\\].*${O2}`))
    expect(r.refused[1]).toMatch(new RegExp(`^ops\\[3\\].*${P1}`))
    expect(r.refused[2]).toMatch(/^ops\[4\].*r20990101-ffff/)
    expect(r.refused[3]).toMatch(/^ops\[5\].*l20990101-ffff/)
    expect(shipped?.id).toMatch(RID)
    expect(r.events[0]).toEqual(requestEvent(shipped?.id ?? '', { title: 'Ship 0.8.3', acceptance: [], line: L1, status: 'closed', resolution: { by: 'backfill', evidence: 'all its pieces were done' } }))
    expect(shipped).toMatchObject({ status: 'closed', line: L1, pieces: [O1, O2] })
    expect(requests.find(one => one.title === 'Ship 0.8.4')).toMatchObject({ status: 'open', resolution: null, line: L1, pieces: [O3] })
    expect(foldBoard(after).map(one => [one.id, requests.find(request => request.id === one.request)?.title])).toEqual([
      [O1, 'Ship 0.8.3'],
      [O2, 'Ship 0.8.3'],
      [O3, 'Ship 0.8.4'],
      [P1, 'Board fold'],
    ])
    expect(foldLines(after).find(one => one.id === L1)?.keys).toEqual(keysOf(['StatusKit', 'hooks'], [], ['ship <ver>', 'board fold']))
  })

  test('a reply that is not a list, an op of no known kind, and ops past 120 are refused', () => {
    expect(plan({ op: 'merge' }, linePair())).toEqual({ events: [], refused: ['ops: not a list'] })
    expect(plan([{ op: 'split', line: L1 }], linePair()).refused[0]).toMatch(/^ops\[0\].*split/)

    const many = plan(
      Array.from({ length: 121 }, () => ({ op: 'define', line: L1, definition: 'Board work.' })),
      linePair(),
    )

    expect(many.events.length).toBe(120)
    expect(many.refused.length).toBe(1)
    expect(many.refused[0]).toMatch(/^ops\[120\].*120/)
  })

  test('foldBoard: a later update sets request on a node recorded before requests', () => {
    const nodes = foldBoard([added(O1, 10, 'Old work', 'done'), event({ type: 'update', node: O1, at: 20, fields: { request: R1 } })])

    expect(nodes.map(one => [one.id, one.title, one.status, one.request])).toEqual([[O1, 'Old work', 'done', R1]])
  })
})

describe('daily consolidation: the board', () => {
  test('the real case: four old release pieces and a reply grouping them under one new line make four requests in it, each piece in its own; backfilled', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, clock)
    const titles = ['发布 0.8.3 并上线 Sparkle appcast', '按冻结范围收尾 0.8.4 发版前事项', '发布 0.8.5 并上线 Sparkle appcast', '发布 0.8.6 并上线 Sparkle appcast']
    const ids = titles.map((_, i) => `n20260920-000${i}`)

    world.files[CONFIG] = JSON.stringify({ storage: 'local' })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify(titles.map((title, i) => ({ ...added(ids[i]!, NOW - (10 - i) * 24 * HOUR, title, 'done'), dirs: ['StatusKit', 'docs'] })))
    world.replies = [
      JSON.stringify({
        ops: [
          { op: 'new_line', ref: '#0', name: 'StatusKit releases', definition: 'Each StatusKit version shipped through the Sparkle appcast.' },
          ...ids.map((id, i) => ({ op: 'group', pieces: [id], title: titles[i], line: '#0' })),
        ],
      }),
    ]
    await $.session.start(SESSION)
    await clock.settle()

    const board = boardOf(world)
    const lines = foldLines(board)
    const requests = foldRequests(board, NOW)

    for (const id of ids) {
      expect(world.requests[0]!.prompt).toContain(id)
    }

    expect(lines.map(one => [one.name, one.status, one.closed, one.open])).toEqual([['StatusKit releases', 'active', 4, 0]])
    expect(lines[0]!.keys).toEqual(keysOf(['StatusKit', 'docs'], [], ['发布 <ver> 并上线 sparkle appcast', '按冻结范围收尾 <ver> 发版前事项']))
    expect(requests.map(one => [one.line, one.status, one.resolution?.by])).toEqual(titles.map(() => [lines[0]!.id, 'closed', 'backfill']))
    expect(foldBoard(board).map(one => [one.id, requests.find(request => request.id === one.request)?.title])).toEqual(ids.map((id, i) => [id, titles[i]]))
    expect(allOf(world, LOCAL_EVENTS)?.every(one => one.session === 'sa' && one.commit === null && one.at === NOW)).toBe(true)
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local', consolidatedDay: DAY, backfilled: true })
    expect(world.logs).toContain('progress: consolidated 5 ops, refused 0')
  })

  test('backfilled is set even when a group is refused; the refused piece stays old and each reason is logged', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, clock)

    world.files[CONFIG] = JSON.stringify({ storage: 'local' })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([...linePair(), added(O1, 5, 'Old work', 'done'), added(O2, 6, 'More old work', 'todo')])
    world.replies = [
      JSON.stringify({
        ops: [
          { op: 'group', pieces: [O1], title: 'Old work', line: L1 },
          { op: 'group', pieces: [O2], title: 'x'.repeat(61), line: L1 },
        ],
      }),
    ]
    await $.session.start(SESSION)
    await clock.settle()

    const nodes = foldBoard(boardOf(world))

    expect(nodes.find(one => one.id === O2)?.request).toBe('')
    expect(nodes.find(one => one.id === O1)?.request).toMatch(RID)
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local', consolidatedDay: DAY, backfilled: true })
    expect(world.logs).toContain('progress: consolidated 1 ops, refused 1')
    expect(world.logs.some(line => /^progress: refused ops\[1\].*title.*60/.test(line))).toBe(true)
  })

  test('more old pieces than one prompt lists: backfilled stays unset, so the next day lists the rest', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, clock)
    const ids = Array.from({ length: 81 }, (_, i) => `n20260901-${String(i).padStart(4, '0')}`)

    world.files[CONFIG] = JSON.stringify({ storage: 'local' })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([...linePair(), ...ids.map((id, i) => added(id, 10 + i, `Old ${i}`, 'done'))])
    world.replies = [JSON.stringify({ ops: ids.slice(1).map(id => ({ op: 'group', pieces: [id], title: 'Old', line: L1 })) })]
    await $.session.start(SESSION)
    await clock.settle()

    expect(world.requests[0]!.prompt, 'the oldest piece is past the prompt').not.toContain(ids[0])
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local', consolidatedDay: DAY })
  })

  test('/progress-line after a merge moves a request back to the merged line: the relink undoes the merge for it', async ($, on) => {
    const { world } = await local($, on)
    const merged = planConsolidation([{ op: 'merge', from: L2, into: L1, why: 'both edit the board' }], linePair(), NOW - 1_000, 'sb').events

    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([...linePair(), ...merged])
    expect(foldRequests(boardOf(world), NOW).find(one => one.id === R2)?.line).toBe(L1)

    await $.command.run(command('progress-line', `${R2} ${L2}`))

    expect(foldRequests(boardOf(world), NOW).find(one => one.id === R2)?.line).toBe(L2)
    expect(foldLines(boardOf(world)).find(one => one.id === L1)?.requests).toEqual([R1])
  })
})

describe('the canvas: requests, lines and relinks mirrored', () => {
  /** A local board already backfilled to the canvas, so a batch holds only the call's own writes. */
  async function mirrored($: Engine, on: On, events: readonly BoardEvent[]) {
    const { clock, world } = await local($, on)

    world.files[CONFIG] = JSON.stringify({ storage: 'local', consolidatedDay: DAY, canvasBackfilled: true })
    world.files[CANVAS] = JSON.stringify({ url: URL })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify(events)

    return { clock, world }
  }

  const docsOf = (world: World) => world.batches.flatMap(one => one.writes.filter(write => write.collection === 'projects/-r/events'))

  test('record opening a new line: the line, the request event and the grown keys as l… and q… docs; two events of one doc id at one time kept apart', async ($, on) => {
    const boardLine = lined(L1, NOW - 20_000, { name: 'Board work', definition: 'd', status: 'active', keys: keysOf(['hooks']) })
    const { clock, world } = await mirrored($, on, [...seeded(), boardLine])

    world.store['request:sa'] = R1
    world.replies = [JSON.stringify({ nodes: [PAGE_NODE], line: { name: 'Progress recorder', definition: 'The recorder.' }, line_why: 'no candidate edits the recorder' })]
    await turn($, clock, world)

    const node = eventsOf(world, LOCAL_EVENTS)![0]!.node
    const id = linesOf(world)![0]!.line
    const docs = docsOf(world)

    expect(world.batches.length).toBe(1)
    expect(docs.map(one => one.doc_id)).toEqual([`e${NOW}-${node}`, `l${NOW}-${id}`, `q${NOW}-${R1}`, `l${NOW}-${id}-2`])
    expect(docs[1]!.data).toEqual({ type: 'line', line: id, at: NOW, session: 'sa', fields: { name: 'Progress recorder', definition: 'The recorder.', status: 'active', keys: keysOf() }, seq: 2 })
    expect(docs[2]!.data).toEqual({ type: 'request', request: R1, at: NOW, commit: 'abc1234', session: 'sa', fields: { line: id }, seq: 3 })
    expect(docs[3]!.data).toMatchObject({ type: 'line', line: id, fields: { keys: keysOf(['hooks'], [], ['requests on the board']) } })
  })

  test('/progress-line: the request event and the relink as q… and k… docs', async ($, on) => {
    const { world } = await mirrored($, on, [
      lined(L1, NOW - 20_000, { name: 'Board work', definition: 'd', status: 'active', keys: keysOf() }),
      lined(L2, NOW - 20_000, { name: 'Releases', definition: 'd', status: 'active', keys: keysOf() }),
      requested(R1, NOW - 9_000, { title: 'Requests on the board', acceptance: ['the suite passes'], status: 'open', line: L1 }),
    ])

    await $.command.run(command('progress-line', `${R1} ${L2}`))

    expect(docsOf(world).map(one => one.doc_id)).toEqual([`q${NOW}-${R1}`, `k${NOW}-${R1}`])
    expect(docsOf(world)[1]!.data).toEqual({ type: 'relink', request: R1, from: L1, to: L2, at: NOW, session: 'sa', seq: 2 })
  })

  test('/progress-close <request id> done: the request event as a q… doc', async ($, on) => {
    const { world } = await mirrored($, on, seeded())

    await $.command.run(command('progress-close', `${R1} done`))

    expect(docsOf(world).map(one => [one.doc_id, one.data.type, (one.data.fields as RequestFields).status])).toEqual([[`q${NOW}-${R1}`, 'request', 'closed']])
  })

  test('a consolidation of 70 events goes in two batches of at most 50, in order, the project indexed once, no doc id twice', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, clock)
    const ids = Array.from({ length: 35 }, (_, i) => `r20261001-${i.toString(16).padStart(4, '0')}`)
    const before: BoardEvent[] = [
      lined(L1, 10, { name: 'Board', definition: 'Board work.', status: 'active', keys: keysOf() }),
      ...ids.map((id, i) => requested(id, 20 + i, { title: `Board work ${i}`, acceptance: ['a'], status: 'open' })),
    ]

    world.files[CONFIG] = JSON.stringify({ storage: 'local', backfilled: true, canvasBackfilled: true })
    world.files[CANVAS] = JSON.stringify({ url: URL })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify(before)
    world.replies = [JSON.stringify({ ops: ids.map(request => ({ op: 'assign', request, line: L1, why: 'board work' })) })]
    await $.session.start(SESSION)
    await clock.settle()

    const events = allOf(world, LOCAL_EVENTS) ?? []
    const writes = world.batches.flatMap(one => one.writes)

    expect(events.length).toBe(70)
    expect(world.batches.map(one => one.writes.length)).toEqual([50, 21])
    expect(world.batches[1]!.writes.some(one => one.collection === 'projectIndex')).toBe(false)
    expect(writes).toEqual(canvasWrites(events, boardFor([...before, ...events]), { url: URL, project: '-r', name: 'r', at: NOW, isBackfill: false }))
    expect(new Set(writes.map(one => one.doc_id)).size).toBe(71)
  })

  test('the backfill: every request and line first, then the nodes newest first, within 50 writes; a session cut to 8 characters', () => {
    const olds = Array.from({ length: 60 }, (_, i) => added(`n20261001-${i.toString(16).padStart(4, '0')}`, NOW - 100_000 + i, `Work ${i}`))
    const lineEvent = lined(L1, NOW - 200_000, { name: 'Board', definition: 'Board work.', status: 'active', keys: keysOf(['hooks']) })
    const asked = requested(R1, NOW - 150_000, { title: 'Asked', acceptance: ['a'], status: 'open', line: L1 })
    const fresh = event({ type: 'add', node: 'n20261010-ffff', at: NOW, session: 'abcdefghijkl', fields: { title: 'New', status: 'todo' } })
    const all = [lineEvent, asked, ...olds, fresh]
    const writes = canvasWrites([fresh], boardFor(all), { url: URL, project: '-r', name: 'r', at: NOW, isBackfill: true })

    expect(writes.length).toBe(50)
    expect(writes[1]!.data.session).toBe('abcdefgh')
    expect(writes.slice(2, 4).map(one => [one.doc_id, one.data])).toEqual([
      [`b${NOW}-${R1}`, { type: 'request', request: R1, at: NOW - 150_000, updatedAt: NOW - 150_000, session: 'sb', fields: { title: 'Asked', acceptance: ['a'], status: 'open', resolution: null, line: L1 }, seq: 2 }],
      [`b${NOW}-${L1}`, { type: 'line', line: L1, at: NOW - 200_000, fields: { name: 'Board', definition: 'Board work.', keys: keysOf(['hooks']), status: 'active', merged_into: '' }, seq: 3 }],
    ])
    expect(writes.slice(4).map(one => one.data.node)).toEqual(olds.map(one => one.node).reverse().slice(0, 46))
  })

  test("the backfill's snapshots carry their item's last activity, and a closed request its close time", () => {
    const events: BoardEvent[] = [
      requested(R1, NOW - 100 * HOUR, { title: 'Quiet', acceptance: ['a'], status: 'open' }),
      piece('a', NOW - 100 * HOUR, 'A', 'doing', R1),
      event({ type: 'update', node: 'a', at: NOW - HOUR, fields: { summary: 'More.' } }),
      requested(R2, NOW - 50 * HOUR, { title: 'Shipped', acceptance: ['b'], status: 'open' }),
      requested(R2, NOW - 10 * HOUR, { status: 'closed', resolution: { by: 'person', evidence: 'done' } }),
      piece('b', NOW - 5 * HOUR, 'B', 'todo', R2),
    ]
    const writes = canvasWrites([], boardFor(events), { url: URL, project: '-r', name: 'r', at: NOW, isBackfill: true })
    const snap = (id: string) => writes.find(one => one.doc_id === `b${NOW}-${id}`)!.data

    expect(snap(R1)).toMatchObject({ at: NOW - 100 * HOUR, updatedAt: NOW - HOUR })
    expect(snap(R1)).not.toHaveProperty('closedAt')
    expect(snap(R2)).toMatchObject({ updatedAt: NOW - 5 * HOUR, closedAt: NOW - 10 * HOUR })
    expect(snap('a')).toMatchObject({ at: NOW - 100 * HOUR, updatedAt: NOW - HOUR })
  })

  test('every write carries seq, its index in the call, the project index 0: 12 events of one line keep their order past the -10 id', () => {
    const events = Array.from({ length: 12 }, (_, i) => lined(L1, NOW, { definition: `Step ${i}` }))
    const writes = canvasWrites(events, boardFor(events), { url: URL, project: '-r', name: 'r', at: NOW, isBackfill: false })

    expect(writes.map(one => one.data.seq)).toEqual(Array.from({ length: 13 }, (_, i) => i))
    expect(writes[10]!.doc_id).toBe(`l${NOW}-${L1}-10`)
    expect([...writes.slice(1)].sort((a, b) => Number(a.data.seq) - Number(b.data.seq)).map(one => (one.data.fields as LineFields).definition)).toEqual(events.map(one => one.fields.definition))
  })
})
