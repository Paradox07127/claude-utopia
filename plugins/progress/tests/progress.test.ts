import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On, SessionStartInput } from 'claude-code'

import { canvasProject, foldBoard, parseBoardEvents } from '../hooks/progress'
import { dayOf } from '../hooks/usage'
import type { BoardEvent } from '../types'

const NOW = 1_790_922_800_000
const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/r' }
const BOTTOM = { type: 'Text', props: {}, children: ['engine'] }
// The project is the main worktree's root as `$.session.repo()` gives it; the session root is a linked worktree's.
const BOARD = '/h/.claude/progress/-r'
const CANVAS = '/h/.claude/progress/canvas.json'
const LOCAL_EVENTS = `${BOARD}/events`
const GIT_EVENTS = '/r/.claude/worktrees/agent-x/.notes/board/events'
const ID = /^n\d{8}-[0-9a-f]{4}$/

const TOOL_NODE = { title: 'Progress tool', summary: 'The model records each conversation on a board.', status: 'done', kind: 'feature' }
const PAGE_NODE = { title: 'Progress page', summary: 'A seventh tab lists the board by status.', status: 'doing', kind: 'feature' }

/** `tool`: the full name the plugin under test registered, `mcp__dashboard__progress` in the dev tree, `mcp__progress__progress` released. */
type World = { files: Record<string, string>; session: string; registered: string[]; tool: string }
type Answer = { result?: string; deny?: string }

/** The engine beneath the plugin, in memory: files by absolute path, HEAD at abc1234, the session id as `world.session` says. */
function seat(on: On): World {
  const world: World = { files: {}, session: 'sa', registered: [], tool: '' }

  mock.env(on, { HOME: '/h' })
  on('session.id', () => ({ value: world.session }))
  on('session.root', () => ({ value: '/r/.claude/worktrees/agent-x' }))
  on('session.repo', () => ({ value: { root: '/r', remote: null, internal: false, name: null } }))
  on('tool.register', ($, e, next) => {
    const tool = `mcp__${next.origin.plugin}__${e.name}`

    world.registered.push(e.name)
    world.tool = tool

    return { value: { tool } }
  })
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
  on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: e.argv.includes('rev-parse') ? 'abc1234\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('settings.read', () => ({ value: {} }))
  on('ui.render', () => BOTTOM as never)

  return world
}

const call = ($: Engine, world: World, input: object) => $.tool.call({ tool: world.tool, ...input } as never) as Promise<Answer>

/** The files written but the session's own presence file. */
const written = (world: World) => Object.keys(world.files).filter(path => !path.startsWith('/h/.claude/dashboard/sessions/'))

const eventsOf = (world: World, dir: string, session = 'sa') => JSON.parse(world.files[`${dir}/${session}.json`] ?? 'null') as BoardEvent[] | null

/** The ArtifactData batch `writes` a result carries; none without a canvas. */
const batchOf = (text: string | undefined) =>
  JSON.parse(/```json\n(.*)\n```/s.exec(text ?? '')?.[1] ?? '[]') as { op: string; collection: string; doc_id: string; data: Record<string, unknown> }[]

const event = (over: Partial<BoardEvent> & Pick<BoardEvent, 'type' | 'node' | 'at'>): BoardEvent => ({ session: 'sb', commit: null, fields: {}, ...over })
const added = (node: string, at: number, title: string, status = 'todo') =>
  event({ type: 'add', node, at, fields: { title, summary: 's', status: status as never, kind: 'fix', builds_on: [], depends_on: [] } })

describe('the progress tool: where the board is kept', () => {
  test('registered at session.start; with no storage chosen it records nothing and answers the storage question', async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    expect(world.registered).toEqual(['progress'])

    const r = await call($, world, { nodes: [TOOL_NODE] })

    expect(r.deny).toBeUndefined()
    expect(r.result).toContain('AskUserQuestion')
    expect(r.result).toContain('~/.claude/progress/-r/events/')
    expect(r.result).toContain(`${GIT_EVENTS}/`)
    expect(written(world)).toEqual([])
  })

  test('storage git: the events in <session root>/.notes/board/events/<session>.json and the choice in the config, kept for the next call', async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await call($, world, { nodes: [TOOL_NODE], storage: 'git' })

    expect(JSON.parse(world.files[`${BOARD}/config.json`] ?? 'null')).toEqual({ storage: 'git' })

    const events = eventsOf(world, GIT_EVENTS)

    expect(events?.length).toBe(1)
    expect(events?.[0]).toMatchObject({ type: 'add', at: NOW, session: 'sa', commit: 'abc1234', fields: TOOL_NODE })
    expect(events?.[0]?.node).toMatch(ID)
    expect(events?.[0]?.node.slice(1, 9)).toBe(dayOf(NOW).replace(/-/g, ''))

    await call($, world, { nodes: [PAGE_NODE] })
    expect(eventsOf(world, GIT_EVENTS)?.length, 'no question the second time').toBe(2)
  })

  test('storage local: the events under the home directory, none in the project', async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await call($, world, { nodes: [TOOL_NODE], storage: 'local' })

    expect(eventsOf(world, LOCAL_EVENTS)?.length).toBe(1)
    expect(Object.keys(world.files).filter(path => path.startsWith('/r/'))).toEqual([])
  })
})

describe('the progress tool: validation', () => {
  test('a title too long, a bad status, an unknown builds_on id, a missing summary, an index past the call: each rejected, nothing written', async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)

    const tooLong = await call($, world, { nodes: [PAGE_NODE, { ...TOOL_NODE, title: 'x'.repeat(61) }], storage: 'git' })

    expect(tooLong.deny).toMatch(/nodes\[1\]\.title.*60/)
    expect(written(world), 'not even the storage choice').toEqual([])

    world.files[`${BOARD}/config.json`] = JSON.stringify({ storage: 'git' })

    const cases: [object, RegExp][] = [
      [{ ...TOOL_NODE, status: 'wip' }, /nodes\[0\]\.status.*wip/],
      [{ ...TOOL_NODE, kind: 'chore' }, /nodes\[0\]\.kind.*chore/],
      [{ ...TOOL_NODE, builds_on: ['n20990101-ffff'] }, /n20990101-ffff/],
      [{ ...TOOL_NODE, depends_on: [{ id: 'n20990101-eeee', confirmed: false }] }, /n20990101-eeee/],
      [{ title: 'No summary', status: 'todo', kind: 'docs' }, /nodes\[0\]\.summary/],
      [{ ...TOOL_NODE, builds_on: ['#3'] }, /#3/],
      [{ id: 'n20990101-dddd', status: 'done' }, /n20990101-dddd/],
    ]

    for (const [node, why] of cases) {
      const r = await call($, world, { nodes: [node] })

      expect(r.deny, JSON.stringify(node)).toMatch(why)
    }

    expect(written(world)).toEqual([`${BOARD}/config.json`])
  })

  test('a node may build on another of the same call by its index', async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)

    const r = await call($, world, { nodes: [{ ...PAGE_NODE, builds_on: ['#1'] }, TOOL_NODE], storage: 'git' })
    const events = eventsOf(world, GIT_EVENTS) ?? []

    expect(r.deny).toBeUndefined()
    expect(events.map(one => one.fields.title)).toEqual(['Progress page', 'Progress tool'])
    expect(events[0]?.fields.builds_on).toEqual([events[1]!.node])
  })
})

describe('the progress tool: the board', () => {
  test('an update by id changes the status; the fold keeps the rest and takes the latest', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await call($, world, { nodes: [PAGE_NODE], storage: 'local' })

    const id = eventsOf(world, LOCAL_EVENTS)![0]!.node

    await clock.advance(60_000)

    const r = await call($, world, { nodes: [{ id, status: 'done' }] })
    const events = eventsOf(world, LOCAL_EVENTS) ?? []

    expect(r.deny).toBeUndefined()
    expect(events[1]).toMatchObject({ type: 'update', node: id, at: NOW + 60_000, fields: { status: 'done' } })
    expect(Object.keys(events[1]!.fields)).toEqual(['status'])
    expect(foldBoard(events)).toMatchObject([{ id, title: 'Progress page', status: 'done', at: NOW, updatedAt: NOW + 60_000 }])
  })

  test("two sessions' files fold together and a broken one is skipped: the other session's node is known, listed and linked", async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    world.files[`${BOARD}/config.json`] = JSON.stringify({ storage: 'local' })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([added('n20261001-aaaa', NOW - 9_000, 'Older work', 'doing'), event({ type: 'update', node: 'n20261001-aaaa', at: NOW - 1_000, fields: { status: 'blocked' } })])
    world.files[`${LOCAL_EVENTS}/sc.json`] = '[{"type":"add","node":"n2026'
    await $.session.start(SESSION)

    const r = await call($, world, { nodes: [{ ...TOOL_NODE, builds_on: ['n20261001-aaaa'] }] })

    expect(r.deny).toBeUndefined()
    expect(eventsOf(world, LOCAL_EVENTS)?.[0]?.fields.builds_on).toEqual(['n20261001-aaaa'])

    const listed = await call($, world, { list: true })

    expect(listed.result).toMatch(/n20261001-aaaa.*Older work.*blocked.*fix/)
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

  test('list: true answers the recent nodes and writes nothing', async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    world.files[`${BOARD}/config.json`] = JSON.stringify({ storage: 'local' })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([added('n20261001-aaaa', NOW - 9_000, 'Older work'), added('n20261002-bbbb', NOW - 5_000, 'Newer work', 'done')])
    await $.session.start(SESSION)

    const before = JSON.stringify(world.files)
    const r = await call($, world, { list: true })

    expect(r.result).toMatch(/n20261002-bbbb.*Newer work.*done[\s\S]*n20261001-aaaa.*Older work.*todo/)
    expect(r.result).toContain(dayOf(NOW - 5_000))
    expect(JSON.stringify(world.files)).toBe(before)
  })

  test('without a canvas the result names the ids assigned and nothing more', async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    world.files[`${BOARD}/config.json`] = JSON.stringify({ storage: 'local' })
    await $.session.start(SESSION)

    const r = await call($, world, { nodes: [TOOL_NODE] })
    const [tool] = (eventsOf(world, LOCAL_EVENTS) ?? []).map(one => one.node)

    expect(r.result).toContain(`${tool} Progress tool`)
    expect(r.result).not.toContain('ArtifactData')
  })

  test('with a canvas the result carries one ArtifactData batch: a new projectIndex doc, then one event doc per event with the full fields', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.files[CANVAS] = JSON.stringify({ url: 'https://claude.ai/artifact/abc' })
    world.files[`${BOARD}/config.json`] = JSON.stringify({ storage: 'local', canvasBackfilled: true })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([added('n20261001-aaaa', NOW - 9_000, 'Older work')])
    await $.session.start(SESSION)

    const first = await call($, world, { nodes: [TOOL_NODE, { ...PAGE_NODE, builds_on: ['#0'], depends_on: [{ id: 'n20261001-aaaa', confirmed: false }] }] })
    const [tool, page] = (eventsOf(world, LOCAL_EVENTS) ?? []).map(one => one.node)
    const writes = batchOf(first.result)

    expect(first.result).toContain('https://claude.ai/artifact/abc')
    expect(first.result).not.toContain('already exists')
    expect(writes[0]).toEqual({ op: 'set', collection: 'projectIndex', doc_id: `-r~e${NOW}`, data: { project: '-r', name: 'r' } })
    expect(writes.slice(1).map(one => [one.collection, one.doc_id])).toEqual([
      ['projects/-r/events', `e${NOW}-${tool}`],
      ['projects/-r/events', `e${NOW}-${page}`],
    ])
    expect(writes[2]!.data).toEqual({
      type: 'add',
      node: page,
      at: NOW,
      commit: 'abc1234',
      fields: { ...PAGE_NODE, builds_on: [tool], depends_on: [{ id: 'n20261001-aaaa', confirmed: false }] },
    })

    await clock.advance(60_000)

    const again = await call($, world, { nodes: [{ id: tool, status: 'blocked' }] })

    expect(batchOf(again.result).map(one => [one.collection, one.doc_id])).toEqual([
      ['projectIndex', `-r~e${NOW + 60_000}`],
      ['projects/-r/events', `e${NOW + 60_000}-${tool}`],
    ])
  })

  test('a batch never sent: the next batch still indexes the project and carries the full fields of the node it updates', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.files[CANVAS] = JSON.stringify({ url: 'https://claude.ai/artifact/abc' })
    world.files[`${BOARD}/config.json`] = JSON.stringify({ storage: 'local' })
    await $.session.start(SESSION)
    await call($, world, { nodes: [TOOL_NODE] })

    const [tool] = (eventsOf(world, LOCAL_EVENTS) ?? []).map(one => one.node)

    await clock.advance(60_000)

    const writes = batchOf((await call($, world, { nodes: [{ id: tool, status: 'blocked' }] })).result)

    expect(writes).toEqual([
      { op: 'set', collection: 'projectIndex', doc_id: `-r~e${NOW + 60_000}`, data: { project: '-r', name: 'r' } },
      {
        op: 'set',
        collection: 'projects/-r/events',
        doc_id: `e${NOW + 60_000}-${tool}`,
        data: { type: 'update', node: tool, at: NOW + 60_000, commit: 'abc1234', fields: { ...TOOL_NODE, status: 'blocked', builds_on: [], depends_on: [] } },
      },
    ])
  })

  test('backfill: the first call with a canvas mirrors each node recorded before it as an add with its full fields, once', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.files[`${BOARD}/config.json`] = JSON.stringify({ storage: 'local' })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify([
      added('n20261001-aaaa', NOW - 9_000, 'Oldest work'),
      added('n20261001-bbbb', NOW - 8_000, 'Older work'),
      added('n20261001-cccc', NOW - 7_000, 'Old work'),
      event({ type: 'update', node: 'n20261001-aaaa', at: NOW - 1_000, fields: { status: 'blocked' } }),
    ])
    await $.session.start(SESSION)
    world.files[CANVAS] = JSON.stringify({ url: 'https://claude.ai/artifact/abc' })

    const writes = batchOf((await call($, world, { nodes: [TOOL_NODE] })).result)
    const [tool] = (eventsOf(world, LOCAL_EVENTS) ?? []).map(one => one.node)

    expect(writes.map(one => [one.collection, one.doc_id, one.data.type])).toEqual([
      ['projectIndex', `-r~e${NOW}`, undefined],
      ['projects/-r/events', `e${NOW}-${tool}`, 'add'],
      ['projects/-r/events', `b${NOW}-n20261001-aaaa`, 'add'],
      ['projects/-r/events', `b${NOW}-n20261001-cccc`, 'add'],
      ['projects/-r/events', `b${NOW}-n20261001-bbbb`, 'add'],
    ])
    expect(writes[2]!.data).toEqual({
      type: 'add',
      node: 'n20261001-aaaa',
      at: NOW - 9_000,
      commit: null,
      fields: { title: 'Oldest work', summary: 's', status: 'blocked', kind: 'fix', builds_on: [], depends_on: [] },
    })
    expect(JSON.parse(world.files[`${BOARD}/config.json`] ?? 'null')).toEqual({ storage: 'local', canvasBackfilled: true })

    await clock.advance(60_000)

    const again = batchOf((await call($, world, { nodes: [PAGE_NODE] })).result)

    expect(again.map(one => one.collection)).toEqual(['projectIndex', 'projects/-r/events'])
  })

  test('backfill of a board of 60 nodes: the newest ones, the batch at 50 writes', async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)
    const ids = Array.from({ length: 60 }, (_, i) => `n20261001-${i.toString(16).padStart(4, '0')}`)

    world.files[CANVAS] = JSON.stringify({ url: 'https://claude.ai/artifact/abc' })
    world.files[`${BOARD}/config.json`] = JSON.stringify({ storage: 'local' })
    world.files[`${LOCAL_EVENTS}/sb.json`] = JSON.stringify(ids.map((id, i) => added(id, NOW - 100_000 + i, `Work ${i}`)))
    await $.session.start(SESSION)

    const writes = batchOf((await call($, world, { nodes: [TOOL_NODE] })).result)
    const filled = writes.slice(2).map(one => one.data.node)

    expect(writes.length).toBe(50)
    expect(filled).toEqual([...ids].reverse().slice(0, 48))
  })

  test('a project root with characters a database path refuses gets them as -', () => {
    expect(canvasProject('-Users-me-My Project (old)')).toBe('-Users-me-My-Project--old-')
  })
})
