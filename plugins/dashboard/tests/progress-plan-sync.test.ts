import { describe, expect, test } from 'claude-code/testing'

import { foldBoard, planSyncEvents } from '../hooks/progress'
import type { BoardNode, BoardStatus, NodeEvent } from '../types'

const NOW = 1_790_922_800_000
const REQUEST = 'r20261001-aaaa'
const ID = /^n\d{8}-[0-9a-f]{4}$/

/** One piece of `request` as the board folds it. */
const piece = (node: string, title: string, status: BoardStatus, request = REQUEST): BoardNode =>
  foldBoard([{ type: 'add', node, at: NOW - 1_000, session: 'sa', commit: null, fields: { title, status, kind: 'feature', done_when: title, request } }])[0]!

const sync = (items: readonly unknown[], nodes: readonly BoardNode[], taken: ReadonlySet<string> = new Set(nodes.map(one => one.id))) =>
  planSyncEvents(items, nodes, REQUEST, taken, NOW, 'sb', 'abc1234')

const update = (node: string, status: BoardStatus): NodeEvent => ({ type: 'update', node, at: NOW, session: 'sb', commit: 'abc1234', fields: { status } })

describe("the desktop app's task list synced into the session's request", () => {
  test('pending, in_progress and completed become todo, doing and done', () => {
    const nodes = [piece('n1', 'Write the hook', 'doing'), piece('n2', 'Write the tests', 'todo'), piece('n3', 'Ship it', 'doing')]

    expect(
      sync(
        [
          { content: 'Write the hook', status: 'completed' },
          { content: 'Write the tests', status: 'in_progress' },
          { content: 'Ship it', status: 'pending' },
        ],
        nodes,
      ),
    ).toEqual([update('n1', 'done'), update('n2', 'doing'), update('n3', 'todo')])
  })

  test('an item names a piece whatever its case and spacing; the first unmatched piece of the same words wins', () => {
    const nodes = [piece('n1', 'Write  the Hook', 'todo'), piece('n2', 'write the hook', 'todo')]

    expect(
      sync(
        [
          { content: '  WRITE the\thook ', status: 'in_progress' },
          { content: 'write the hook', status: 'completed' },
        ],
        nodes,
      ),
    ).toEqual([update('n1', 'doing'), update('n2', 'done')])
  })

  test('an item over the title length names the piece it added, whose title was cut', () => {
    const long = `Write the hook ${'x'.repeat(80)}`
    const nodes = [piece('n1', long.slice(0, 60), 'doing')]

    expect(sync([{ content: long, status: 'completed' }], nodes)).toEqual([update('n1', 'done')])
  })

  test('a done piece is never moved back', () => {
    const nodes = [piece('n1', 'Write the hook', 'done')]

    expect(sync([{ content: 'Write the hook', status: 'pending' }], nodes)).toEqual([])
    expect(sync([{ content: 'Write the hook', status: 'in_progress' }], nodes)).toEqual([])
  })

  test('a blocked piece stays blocked against todo, and moves on doing', () => {
    const nodes = [piece('n1', 'Write the hook', 'blocked')]

    expect(sync([{ content: 'Write the hook', status: 'pending' }], nodes)).toEqual([])
    expect(sync([{ content: 'Write the hook', status: 'in_progress' }], nodes)).toEqual([update('n1', 'doing')])
  })

  test("an item no piece names is added to the request with a new id; a dropped piece or another request's does not name it", () => {
    const nodes = [piece('n1', 'Write the hook', 'dropped'), piece('n2', 'Write the docs', 'todo', 'r20261001-bbbb')]
    const taken = new Set(['n1', 'n2', REQUEST])
    const long = `Write the hook ${'x'.repeat(80)}`
    const events = sync(
      [
        { content: 'Write the hook', status: 'in_progress' },
        { content: 'Write the docs', status: 'pending' },
        { content: long, status: 'pending' },
      ],
      nodes,
      taken,
    )

    expect(events.map(one => [one.type, one.fields])).toEqual([
      ['add', { title: 'Write the hook', status: 'doing', kind: 'feature', done_when: 'Write the hook', request: REQUEST }],
      ['add', { title: 'Write the docs', status: 'todo', kind: 'feature', done_when: 'Write the docs', request: REQUEST }],
      ['add', { title: long.slice(0, 60), status: 'todo', kind: 'feature', done_when: long.slice(0, 60), request: REQUEST }],
    ])
    expect(events.every(one => ID.test(one.node) && !taken.has(one.node))).toBe(true)
    expect(new Set(events.map(one => one.node)).size).toBe(3)
    expect(events.every(one => one.at === NOW && one.session === 'sb' && one.commit === 'abc1234')).toBe(true)
  })

  test('items that are not an object with content and a known status are skipped', () => {
    const nodes = [piece('n1', 'Write the hook', 'todo')]

    expect(
      sync(
        [
          null,
          'Write the hook',
          { content: 'Write the hook' },
          { content: 'Write the hook', status: 'wip' },
          { content: 'Write the hook', status: 'constructor' },
          { content: '', status: 'pending' },
          { content: '   ', status: 'pending' },
          { content: 7, status: 'completed' },
        ],
        nodes,
      ),
    ).toEqual([])
  })

  test('a list that changes nothing gives no event; a piece no item names is left alone', () => {
    const nodes = [piece('n1', 'Write the hook', 'doing'), piece('n2', 'Write the tests', 'todo'), piece('n3', 'Ship it', 'todo')]

    expect(
      sync(
        [
          { content: 'Write the hook', status: 'in_progress', session: 'x' },
          { content: 'Write the tests', status: 'pending' },
        ],
        nodes,
      ),
    ).toEqual([])
  })
})
