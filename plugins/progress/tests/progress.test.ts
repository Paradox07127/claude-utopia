import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { FsEntry, ModelCompleteRequest, On, SessionStartInput } from 'claude-code'

import { canvasProject, canvasWrites, foldBoard, parseBoardEvents, parseNodesReply, planNodes } from '../hooks/progress'
import { dayOf } from '../hooks/usage'
import type { BoardEvent } from '../types'

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
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const TOOL_NODE = { title: 'Progress hook', summary: 'The plugin records each typed turn that changed something.', status: 'done', kind: 'feature' }
const PAGE_NODE = { title: 'Progress page', summary: 'A seventh tab lists the board by status.', status: 'doing', kind: 'feature' }

/** A reply of the model: its text, or made from the world as the request comes. */
type Reply = string | ((world: World) => string)
type Batch = { tool: string; action: string; url: string; writes: { op: string; collection: string; doc_id: string; data: Record<string, unknown> }[] }

/**
 * `replies`: the model's answers in order, none left = not answered. `head`: what `git rev-parse` prints. `storage`: the
 * person's answer to the storage question, null = dismissed. `batch`: how an ArtifactData call ends.
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
}

/** The engine beneath the plugin, in memory: files by absolute path, HEAD as `world.head` says, the model as `world.replies`. */
function seat(on: On, clock: MockClock): World {
  const world: World = { files: {}, head: 'abc1234', log: '', replies: [], requests: [], isSlow: false, asks: [], storage: 'local', batches: [], batch: 'ok', runs: [], logs: [] }

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
  on('command.register', ($, e) => ({ value: { command: e.name } }))
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

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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

/** The board's files written: its config, events and the canvas file. */
const written = (world: World) => Object.keys(world.files).filter(path => path.startsWith('/h/.claude/progress/') || path.includes('/.notes/'))

const eventsOf = (world: World, dir: string, session = 'sa') => JSON.parse(world.files[`${dir}/${session}.json`] ?? 'null') as BoardEvent[] | null

const reply = (...nodes: object[]) => JSON.stringify({ nodes })

const event = (over: Partial<BoardEvent> & Pick<BoardEvent, 'type' | 'node' | 'at'>): BoardEvent => ({ session: 'sb', commit: null, fields: {}, ...over })
const added = (node: string, at: number, title: string, status = 'todo') =>
  event({ type: 'add', node, at, fields: { title, summary: 's', status: status as never, kind: 'fix', builds_on: [], depends_on: [] } })

/** A world with the board kept locally, the session started. */
async function local($: Engine, on: On, now = NOW) {
  const clock = mock.clock(on, { now })
  const world = seat(on, clock)

  world.files[CONFIG] = JSON.stringify({ storage: 'local' })
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

  test('a turn the person did not type asks no model: a task notification', async ($, on) => {
    const { clock, world } = await local($, on)

    world.replies = [reply(PAGE_NODE)]
    await turn($, clock, world, { origin: 'task-notification' })

    expect(world.requests).toEqual([])
    expect(eventsOf(world, LOCAL_EVENTS)).toBeNull()
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

    world.files[CONFIG] = JSON.stringify({ storage: 'local' })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([added('n20261001-aaaa', NOW - 9_000, 'Older work', 'doing'), event({ type: 'update', node: 'n20261001-aaaa', at: NOW - 1_000, fields: { status: 'blocked' } })])
    world.files[`${LOCAL_EVENTS}/sc.json`] = '[{"type":"add","node":"n2026'
    world.replies = [reply({ ...TOOL_NODE, builds_on: ['n20261001-aaaa'] })]
    await $.session.start(SESSION)
    await turn($, clock, world)

    expect(world.requests[0]!.prompt).toMatch(/n20261001-aaaa · Older work · blocked · fix/)
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

    expect(world.requests[1]!.prompt).toContain(id)
    expect(world.requests[1]!.prompt).toContain(PAGE_NODE.summary)
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
})

describe('recording a turn: the canvas', () => {
  test('with a canvas the plugin submits one ArtifactData batch of the writes; canvasBackfilled is set once it went through', async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[CANVAS] = JSON.stringify({ url: URL })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([added('n20261001-aaaa', NOW - 9_000, 'Older work')])
    world.replies = [reply(TOOL_NODE, { ...PAGE_NODE, builds_on: ['#0'], depends_on: [{ id: 'n20261001-aaaa', confirmed: false }] }), w => reply({ id: eventsOf(w, LOCAL_EVENTS)![0]!.node, status: 'blocked' })]
    await turn($, clock, world)

    const own = eventsOf(world, LOCAL_EVENTS) ?? []
    const [tool, page] = own.map(one => one.node)
    const all = [...own, added('n20261001-aaaa', NOW - 9_000, 'Older work')]

    expect(world.batches.length).toBe(1)
    expect(world.batches[0]).toMatchObject({ tool: 'ArtifactData', action: 'batch', url: URL })
    expect(world.batches[0]!.writes).toEqual(canvasWrites(own, foldBoard(all), { url: URL, project: '-r', name: 'r', at: NOW, isBackfill: true }))
    expect(world.batches[0]!.writes.map(one => [one.collection, one.doc_id])).toEqual([
      ['projectIndex', `-r~e${NOW}`],
      ['projects/-r/events', `e${NOW}-${tool}`],
      ['projects/-r/events', `e${NOW}-${page}`],
      ['projects/-r/events', `b${NOW}-n20261001-aaaa`],
    ])
    expect(world.batches[0]!.writes[2]!.data).toEqual({
      type: 'add',
      node: page,
      at: NOW,
      commit: 'abc1234',
      fields: { ...PAGE_NODE, builds_on: [tool], depends_on: [{ id: 'n20261001-aaaa', confirmed: false }] },
    })
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local', canvasBackfilled: true })

    await clock.advance(60_000)
    await turn($, clock, world, { turnId: 't2' })

    expect(world.batches[1]!.writes.map(one => [one.collection, one.doc_id])).toEqual([
      ['projectIndex', `-r~e${NOW + 60_000}`],
      ['projects/-r/events', `e${NOW + 60_000}-${tool}`],
    ])
  })

  test('a batch that failed leaves canvasBackfilled unset, so the next recording backfills; a refused one too', async ($, on) => {
    const { clock, world } = await local($, on)

    world.files[CANVAS] = JSON.stringify({ url: URL })
    world.replies = [reply(TOOL_NODE), reply(PAGE_NODE), reply({ ...PAGE_NODE, title: 'Third' })]
    world.batch = 'error'
    await turn($, clock, world)

    const [tool] = (eventsOf(world, LOCAL_EVENTS) ?? []).map(one => one.node)

    expect(world.batches.length).toBe(1)
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local' })
    expect(world.logs.filter(line => line.startsWith('progress:')).length).toBe(1)

    world.batch = 'deny'
    await clock.advance(60_000)
    await turn($, clock, world, { turnId: 't2' })
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local' })

    world.batch = 'ok'
    await clock.advance(60_000)
    await turn($, clock, world, { turnId: 't3' })
    expect(world.batches[2]!.writes.map(one => one.doc_id)).toContain(`b${NOW + 120_000}-${tool}`)
    expect(JSON.parse(world.files[CONFIG] ?? 'null')).toEqual({ storage: 'local', canvasBackfilled: true })
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
    expect(writes.slice(2).map(one => one.data.node)).toEqual([...ids].reverse().slice(0, 48))
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
    expect(parseNodesReply(reply(PAGE_NODE))).toEqual({ nodes: [PAGE_NODE] })
    expect(parseNodesReply('```json\n{"nodes": []}\n```')).toEqual({ nodes: [] })
    expect(parseNodesReply(' {"nodes": []}\n')).toEqual({ nodes: [] })

    for (const text of ['Nothing to record.', '[]', '{"node": []}', '{"nodes": {}}', 'Sure:\n```json\n{"nodes": []}\n```']) {
      expect('error' in parseNodesReply(text), text).toBe(true)
    }
  })
})
