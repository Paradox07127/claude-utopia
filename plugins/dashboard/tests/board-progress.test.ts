import { describe, expect, test } from 'claude-code/testing'

import type { BoardLine, BoardNode, BoardRead, BoardRequest } from '../types'
import { progressGroups, progressLines } from '../hooks/board'
import type { Line } from '../hooks/board'
import { setLang } from '../hooks/i18n'

const NOW = 1_790_922_800_000
const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
// Local midnight of NOW's day, so the day separators hold in any time zone.
const MIDNIGHT = new Date(NOW).setHours(0, 0, 0, 0)

const node = (id: string, status: BoardNode['status'], updatedAt: number, done_when = '', more: Partial<BoardNode> = {}) =>
  ({ id, title: id, summary: '', status, kind: 'feature', done_when, builds_on: [], depends_on: [], request: '', discovered_from: '', at: 0, updatedAt, commit: null, ...more }) as BoardNode

const request = (id: string, updatedAt: number, more: Partial<BoardRequest> = {}): BoardRequest => ({
  id,
  title: id,
  acceptance: [],
  status: 'open',
  resolution: null,
  line: '',
  at: updatedAt,
  updatedAt,
  session: 'other',
  pieces: [],
  done: 0,
  total: 0,
  followUps: 0,
  state: 'open',
  ...more,
})

const closed = (id: string, updatedAt: number, more: Partial<BoardRequest> = {}) => request(id, updatedAt, { status: 'closed', state: 'closed', resolution: { by: 'piece', evidence: 'done' }, ...more })

const line = (id: string, name: string, updatedAt: number): BoardLine => ({ id, name, definition: '', keys: { paths: [], scopes: [], patterns: [] }, status: 'active', merged_into: '', at: 0, updatedAt, requests: [], open: 0, closed: 0 })

const boardOf = (requests: BoardRequest[], nodes: BoardNode[] = [], lines: BoardLine[] = []): BoardRead => ({ storage: 'local', dir: '/d', name: 'harness', nodes, requests, lines, current: null })

const textOf = (line: Line) => line.map(seg => seg.text).join('')
const pad2 = (n: number) => String(n).padStart(2, '0')
const monthDay = (at: number) => `${pad2(new Date(at).getMonth() + 1)}-${pad2(new Date(at).getDate())}`
const clock = (at: number) => `${pad2(new Date(at).getHours())}:${pad2(new Date(at).getMinutes())}`

/** The terminal page's lines for this board, in Chinese, at `columns`. */
const pageOf = (board: BoardRead, columns = 100) => {
  setLang('zh-CN')

  return progressLines(board, columns, NOW)
}
/** The terminal page's lines for these nodes, in Chinese, at 100 columns. */
const linesFor = (nodes: BoardNode[]) => pageOf(boardOf([], nodes))
/** The node's title line and the indented lines under it. */
const blockOf = (lines: Line[], title: string) => {
  const at = lines.findIndex(line => line.some(seg => seg.text === ` ${title}`))
  const end = lines.findIndex((line, i) => i > at && !textOf(line).startsWith('  '))

  return lines.slice(at, end === -1 ? undefined : end)
}
/** The line whose text holds `title` as a word. */
const rowOf = (lines: Line[], title: string) => lines.find(line => new RegExp(`(^|\\s)${title}(\\s|$)`).test(textOf(line)))!

describe('the progress page groups', () => {
  test('dropped nodes are left out; the others in their groups, newest first', () => {
    const groups = progressGroups([node('a', 'done', 1), node('b', 'dropped', 2), node('c', 'doing', 3), node('d', 'done', 4)])

    expect(groups.map(group => [group.status, group.nodes.map(one => one.id)])).toEqual([
      ['doing', ['c']],
      ['done', ['d', 'a']],
    ])
  })
})

describe('the terminal progress page', () => {
  test('an open node with done_when has a 完成条件 line under its metadata; a done node and one with none have none', () => {
    const lines = linesFor([node('open', 'todo', NOW - HOUR, 'tests pass'), node('closed', 'done', NOW - HOUR, 'a commit on main'), node('bare', 'doing', NOW - HOUR)])

    const open = blockOf(lines, 'open')

    expect(open).toHaveLength(3)
    expect(textOf(open[1]!)).toContain('功能')
    expect(open[2]).toEqual([{ text: '  完成条件：tests pass', dim: true }])
    expect(blockOf(lines, 'closed')).toHaveLength(2)
    expect(blockOf(lines, 'bare')).toHaveLength(2)
    expect(lines.map(textOf).join('\n')).not.toContain('a commit on main')
  })

  test('a doing node 25h without an update: status and title inactive, `25 小时无更新`; 23h, or a todo node 48h old, as before', () => {
    const lines = linesFor([node('stale', 'doing', NOW - 25 * HOUR), node('fresh', 'doing', NOW - 23 * HOUR), node('waiting', 'todo', NOW - 48 * HOUR)])
    const [stale, fresh, waiting] = ['stale', 'fresh', 'waiting'].map(title => blockOf(lines, title))

    expect(stale![0]!.map(seg => seg.color)).toEqual(['inactive', 'inactive'])
    expect(textOf(stale![1]!)).toMatch(/ · 25 小时无更新$/)
    expect(fresh![0]!.map(seg => seg.color)).toEqual(['permission', undefined])
    expect(textOf(fresh![1]!)).not.toContain('小时无更新')
    expect(waiting![0]!.map(seg => seg.color)).toEqual(['inactive', undefined])
    expect(textOf(waiting![1]!)).not.toContain('小时无更新')
  })

  test('requests newest first under 今天 / 昨天 / MM-DD separators; the head names the project, counts them by state and gives the time', () => {
    const old = MIDNIGHT - 2 * DAY - HOUR
    const lines = pageOf(
      boardOf([
        request('older', old),
        request('fresh', NOW - 2 * MINUTE),
        request('yesterday', MIDNIGHT - HOUR, { state: 'ready', total: 1, done: 1 }),
        closed('shipped', MIDNIGHT - 2 * HOUR),
      ]),
    )
    const texts = lines.map(textOf)
    const at = (pattern: RegExp) => texts.findIndex(text => pattern.test(text))
    const order = [/^-- 今天 -+$/, /^\S\s+fresh\s/, /^-- 昨天 -+$/, /^\S\s+yesterday\s/, /^\S\s+shipped\s/, new RegExp(`^-- ${monthDay(old)} -+$`), /^\S\s+older\s/].map(at)

    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(texts[0]).toMatch(new RegExp(`^harness\\s+▸2 \\?1 ✓1\\s+${monthDay(NOW)} ${clock(NOW)}$`))
    expect(texts.every(text => text.length <= 100)).toBe(true)
  })

  test('the three lines with the newest activity get a lane each, their letters in the legend; the others share the ~ lane', () => {
    const lines = [line('l1', 'dashboard', NOW - MINUTE), line('l2', 'docs', NOW - 2 * MINUTE), line('l3', 'mm', NOW - 3 * MINUTE), line('l4', 'api', NOW - 4 * MINUTE), line('l5', 'misc', NOW - 5 * MINUTE)]
    const page = pageOf(
      boardOf(
        [
          request('rD1', NOW - MINUTE, { line: 'l1' }),
          request('rA', NOW - 2 * MINUTE, { line: 'l2' }),
          request('rM', NOW - 3 * MINUTE, { line: 'l3' }),
          request('rX', NOW - 4 * MINUTE, { line: 'l4' }),
          request('rY', NOW - 5 * MINUTE, { line: 'l5' }),
          request('rD2', NOW - 6 * MINUTE, { line: 'l1' }),
        ],
        [],
        lines,
      ),
    )
    const texts = page.map(textOf)

    expect(texts[1]).toBe('D=dashboard  A=docs  M=mm  ~ 另有 2 项')
    expect(['rD1', 'rA', 'rM', 'rX', 'rY', 'rD2'].map(title => textOf(rowOf(page, title)).slice(0, 8))).toEqual(['◌       ', '| ◌     ', '|   ◌   ', '|     ◌ ', '|     ◌ ', '◌       '])
  })

  test('an open request lists its pieces oldest first with time, glyph and sha, the newest 4 after a count of the rest; a closed one lists none', () => {
    const piece = (id: string, status: BoardNode['status'], at: number, request: string, commit: string | null = null) => node(id, status, at, '', { at, request, commit })
    const updated = MIDNIGHT + HOUR + 20 * MINUTE
    const nodes = [
      piece('n2', 'doing', NOW - MINUTE, 'r1'),
      piece('n1', 'done', updated, 'r1', '9c8d7e6'),
      piece('n3', 'todo', NOW - MINUTE, 'r1'),
      piece('n4', 'done', NOW - HOUR, 'r2', 'abc1234'),
      ...[1, 2, 3, 4, 5, 6].map(n => piece(`m${n}`, 'todo', NOW - 10 * MINUTE + n, 'r3')),
    ]
    const page = pageOf(
      boardOf(
        [
          request('r1', NOW - MINUTE, { pieces: ['n1', 'n2', 'n3'], total: 3, done: 1 }),
          closed('r2', NOW - HOUR, { pieces: ['n4'], total: 1, done: 1 }),
          request('r3', NOW - 2 * HOUR, { pieces: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'], total: 6 }),
        ],
        nodes,
      ),
    )
    const texts = page.map(textOf)
    const r1 = texts.findIndex(text => /^▸ r1\s/.test(text))
    const r2 = texts.findIndex(text => /^✓ r2\s/.test(text))
    const r3 = texts.findIndex(text => /^◌ r3\s/.test(text))

    expect(texts.slice(r1 + 1, r1 + 4)).toEqual([expect.stringMatching(new RegExp(`^  ↳ ✓ ${clock(updated)} n1 +9c8d7e6$`)), expect.stringMatching(/^ {2}↳ ▸ \d\d:\d\d n2$/), '  ↳ ◌       n3'])
    expect(page[r1 + 1]!.find(seg => seg.text === '✓')?.color).toBe('success')
    expect(texts[r2 + 1]).not.toContain('↳')
    expect(texts.slice(r3 + 1, r3 + 6)).toEqual(['  ↳ … 另有 2 项', '  ↳ ◌       m3', '  ↳ ◌       m4', '  ↳ ◌       m5', '  ↳ ◌       m6'])
  })

  test('a ready request reads 待验收 in warning, its glyph ?; a stale one ends in 3d!', () => {
    const page = pageOf(
      boardOf([
        request('ready', NOW - HOUR, { state: 'ready', total: 3, done: 3 }),
        request('stale', NOW - 3 * DAY - HOUR, { state: 'stale', total: 2, done: 0 }),
      ]),
    )
    const ready = rowOf(page, 'ready')
    const stale = rowOf(page, 'stale')

    expect(ready[0]).toEqual({ text: '?', color: 'warning' })
    expect(ready.find(seg => seg.text.includes('待验收'))?.color).toBe('warning')
    expect(textOf(ready)).toMatch(/▰▰▰ 3\/3 +待验收 +1h$/)
    expect(textOf(stale)).toMatch(/ 3d!$/)
    expect(stale.at(-1)).toEqual({ text: '!', color: 'warning' })
  })

  test('the rollup: ▰ per done, ▱ per open, at most 8 cells, done/total, +N follow-ups', () => {
    const page = pageOf(boardOf([request('few', NOW - MINUTE, { total: 3, done: 2, followUps: 1 }), request('many', NOW - 2 * MINUTE, { total: 12, done: 6 })]))

    expect(textOf(rowOf(page, 'few'))).toMatch(/ ▰▰▱ 2\/3 \+1 +1m$/)
    expect(textOf(rowOf(page, 'many'))).toMatch(/ ▰▰▰▰▱▱▱▱ 6\/12 +2m$/)
  })

  test('closed requests older than 7 days fold into one dim 另有 N 个已关闭 line', () => {
    const page = pageOf(boardOf([request('open', NOW - MINUTE), closed('week-old', NOW - 8 * DAY), closed('older', NOW - 9 * DAY)]))
    const texts = page.map(textOf)

    expect(texts.join('\n')).not.toMatch(/week-old|older/)
    expect(page.find(one => textOf(one) === '另有 2 个已关闭')).toEqual([{ text: '另有 2 个已关闭', dim: true }])
  })

  test('nodes without a request come last under 未归入请求 · N, newest first, at most 10 then a count; a piece of a request is not among them', () => {
    const legacy = Array.from({ length: 12 }, (_, i) => node(`old${i}`, 'doing', NOW - (i + 1) * HOUR))
    const page = pageOf(boardOf([request('r1', NOW - MINUTE, { pieces: ['p1'], total: 1 })], [node('p1', 'todo', NOW - MINUTE, '', { request: 'r1' }), ...legacy]))
    const texts = page.map(textOf)
    const head = texts.indexOf('未归入请求 · 12')

    expect(head).toBeGreaterThan(texts.findIndex(text => /^◌ r1\s/.test(text)))
    expect(texts.slice(head).filter(text => /^进行中 old\d+$/.test(text))).toEqual(Array.from({ length: 10 }, (_, i) => `进行中 old${i}`))
    expect(texts.at(-1)).toBe('另有 2 项')
    expect(texts.slice(head)).not.toContain('待办 p1')
  })
})
