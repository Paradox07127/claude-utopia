import { describe, expect, test } from 'claude-code/testing'

import type { AgentRun, MmRun, SessionPresence } from '../types'
import { widthOf } from '../hooks/agent-model'
import { agentTable, bandLines, boardOf, HOTKEY_COLUMNS, runningLine, runTable, sessionLine } from '../hooks/board'
import type { Line, ShownPeer } from '../hooks/board'
import { setLang } from '../hooks/i18n'

const NOW = 1_000_000
const NONE_SEEN = { agents: 0, runs: 0 }
const WIDTHS = Array.from({ length: 111 }, (_, i) => 10 + i)
const textOf = (line: Line) => line.map(seg => seg.text).join('')

const agent = (over: Partial<AgentRun>): AgentRun => ({
  agentId: 'a1',
  description: '构建一个很长很长的插件任务描述 with a long English tail too',
  subagentType: 'general-purpose-with-a-long-type',
  model: 'claude-some-extremely-long-model-name-20261231-preview',
  background: true,
  startedAt: NOW - 192_000,
  tools: 41,
  lastTool: 'Bash bun test --watch plugins/dashboard',
  state: 'running',
  lastActivityAt: NOW - 1_000,
  ...over,
})

// Running, running quiet and denied, ended with a failure: every tail the band and the table draw.
const AGENTS = [
  agent({ agentId: 'a1' }),
  agent({ agentId: 'a2', lastActivityAt: NOW - 180_000, denied: 3 }),
  agent({ agentId: 'a3', state: 'error', denied: 2, endedAt: NOW - 5_000, durationMs: 187_000, outputTokens: 12_000 }),
]

const RUN: MmRun = {
  runid: '20261002-010000-aaaa',
  tag: 'a-review-tag-that-is-rather-long',
  workdir: '/work/some/project-directory-name',
  mode: 'review',
  createdAt: NOW - 400_000,
  models: [
    { name: 'some-extremely-long-model-name-that-goes-on-and-on', status: 'RUNNING', startedAt: NOW - 255_000 },
    { name: 'grok', status: 'DONE', startedAt: NOW - 400_000, endedAt: NOW - 10_000, secs: 302, outputTokens: 25_835 },
  ],
}

const PEER: ShownPeer = {
  id: 'p1',
  name: 'a-session-root-with-a-long-name',
  title: '修复一个很长的标题 that keeps going past forty columns',
  state: 'permission',
  since: NOW - 185_000,
  updatedAt: NOW,
} satisfies SessionPresence

describe('terminal rows stay within their width', () => {
  test('band agent rows: at most `columns` cells, the glyph and the time kept', () => {
    setLang('zh-CN')

    for (const columns of WIDTHS) {
      // With two rows the first is a compact agent row, the second the summary.
      for (const rows of [5, 2]) {
        const lines = bandLines(boardOf(AGENTS, null, NONE_SEEN, NOW), rows, columns).slice(0, rows === 2 ? 1 : undefined)

        for (const line of lines) {
          expect(widthOf(textOf(line)), `${columns} columns, ${rows} rows: ${textOf(line)}`).toBeLessThanOrEqual(columns)
        }
      }

      const lines = bandLines(boardOf(AGENTS, null, NONE_SEEN, NOW), 5, columns).map(textOf)

      expect(lines, `${columns} columns`).toHaveLength(3)
      expect(lines[0], `${columns} columns`).toMatch(/^● .*3m12s/)
      expect(lines[1], `${columns} columns`).toMatch(/^✗ .*3m07s/)
    }
  })

  test('Agents table: the status, hotkey, label and tails at most `columns` cells, the head too; the time kept', () => {
    setLang('zh-CN')

    for (const columns of WIDTHS) {
      const table = agentTable(AGENTS, NOW, columns, new Map([['a1', { name: 'Bash', requestedAt: NOW - 60_000 }]]))

      expect(widthOf(table.head), `${columns} columns: ${table.head}`).toBeLessThanOrEqual(columns)

      for (const row of table.rows) {
        const width = widthOf(textOf(row.before)) + HOTKEY_COLUMNS + widthOf(row.label) + widthOf(textOf(row.after))

        expect(width, `${columns} columns: ${textOf(row.before)}|${row.label}|${textOf(row.after)}`).toBeLessThanOrEqual(columns)
      }

      expect(table.rows[0]!.label, `${columns} columns`).toContain('3m12s')
      expect(table.rows[0]!.before[0]).toMatchObject({ text: '●' })
    }
  })

  test('Reviews table: the head and every model row at most `columns` cells; the time kept while the status fits', () => {
    for (const columns of WIDTHS) {
      const [block] = runTable([RUN], NOW, columns)

      expect(widthOf(textOf(block!.head)), `${columns} columns`).toBeLessThanOrEqual(columns)

      for (const row of block!.rows) {
        expect(widthOf(textOf(row)), `${columns} columns: ${textOf(row)}`).toBeLessThanOrEqual(columns)
      }

      if (columns >= 18) {
        expect(textOf(block!.rows[0]!), `${columns} columns`).toContain('4m15s')
      }
    }
  })

  test('overview running rows: at most `columns` cells, the time kept', () => {
    setLang('zh-CN')
    const model = RUN.models[0]!

    for (const columns of WIDTHS) {
      for (const run of AGENTS.slice(0, 2)) {
        const line = textOf(runningLine({ kind: 'agent', run }, NOW, NOW, columns))

        expect(widthOf(line), `${columns} columns: ${line}`).toBeLessThanOrEqual(columns)
        expect(line, `${columns} columns`).toMatch(/3m12s$/)
      }

      const line = textOf(runningLine({ kind: 'model', run: RUN, model }, NOW, NOW, columns))

      expect(widthOf(line), `${columns} columns: ${line}`).toBeLessThanOrEqual(columns)
      expect(line, `${columns} columns`).toMatch(/4m15s$/)
    }
  })

  test('overview other-session rows: at most `columns` cells, the time kept', () => {
    setLang('zh-CN')

    for (const columns of WIDTHS) {
      const line = textOf(sessionLine(PEER, NOW, columns))

      expect(widthOf(line), `${columns} columns: ${line}`).toBeLessThanOrEqual(columns)
      expect(line, `${columns} columns`).toMatch(/3m05s$/)
    }

    for (let columns = 1; columns < 10; columns += 1) {
      expect(widthOf(textOf(sessionLine(PEER, NOW, columns))), `${columns} columns`).toBeLessThanOrEqual(columns)
      expect(widthOf(textOf(runningLine({ kind: 'agent', run: AGENTS[0]! }, NOW, NOW, columns))), `${columns} columns`).toBeLessThanOrEqual(columns)
    }
  })
})

describe('band tails', () => {
  test('a long last tool is cut to its budget: the denied and quiet tails stay on the row', () => {
    setLang('zh-CN')
    const run = agent({ subagentType: 'worker', description: 'Build mm plugin', tools: 5, lastTool: `Bash ${'x'.repeat(30)}`, denied: 2, lastActivityAt: NOW - 180_000 })
    const [line] = bandLines(boardOf([run], null, NONE_SEEN, NOW), 5, 90).map(textOf)

    expect(line).toMatch(/^● worker  Build mm plugin {3}3m12s  5 tools  Bash x+…  ✗ 被拒2  静默 3m00s$/)
    expect(widthOf(line!)).toBe(90)
  })
})
