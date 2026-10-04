import { describe, expect, test } from 'claude-code/testing'

import { widthOf } from '../hooks/agent-model'
import type { Line } from '../hooks/board'
import { setLang } from '../hooks/i18n'
import { drawHotspotsDesktop, drawTimelineDesktop, hotspotLines, latestMainTurnId, timelineLines } from '../hooks/timeline-view'
import type { TimelineStep, TimelineTool, TimelineTurn } from '../types'
import { FILL, TRACK } from '../hooks/desktop-svg'

const T0 = 1_790_000_000_000
const NOW = T0 + 96_000
const BAR_CHARS = /[░█▏▎▍▌▋▊▉┄]/
// Host types, so a drawn tree is plain data to walk.
const EL = { Box: 'Box', Text: 'Text', Button: 'Button', Svg: 'Svg', Markdown: 'Markdown' } as never

const usage = (inTokens: number, output: number) => ({ input: 2_000, output, cacheRead: inTokens - 12_000, cacheWrite: 10_000 })

const step = (index: number, more: Partial<TimelineStep>): TimelineStep => ({
  turnId: 't1',
  index,
  model: 'claude-opus-5-5',
  messageCount: 3,
  sentAt: T0,
  toolUseIds: [],
  ...more,
})

const tool = (toolUseId: string, name: string, endAt: number, durationMs: number | undefined): TimelineTool => ({
  toolUseId,
  name,
  turnId: 't1',
  requestedAt: endAt - (durationMs ?? 0) - 10,
  endedAt: endAt,
  ...(durationMs !== undefined && { durationMs }),
  outcome: 'ok',
})

/** #0 ends with Read ×3 and a longer Grep; #1 with a 41.2s Bash and a background worker still running; a compaction; #2 running 22s. */
const FIXTURE: TimelineTurn[] = [
  {
    turnId: 't1',
    startedAt: T0,
    steps: [
      step(0, { sentAt: T0, ttftMs: 3_000, stepMs: 12_400, endedAt: T0 + 12_400, stopReason: 'tool_use', usage: usage(182_000, 1_200), toolUseIds: ['r1', 'r2', 'r3', 'g1'] }),
      step(1, { sentAt: T0 + 13_000, ttftMs: 4_000, stepMs: 18_000, endedAt: T0 + 31_000, stopReason: 'tool_use', usage: usage(184_000, 2_000), toolUseIds: ['b1', 'ag1'] }),
      step(2, { sentAt: T0 + 74_000 }),
    ],
    tools: [
      tool('r1', 'Read', T0 + 12_600, 100),
      tool('r2', 'Read', T0 + 12_700, 200),
      tool('r3', 'Read', T0 + 12_650, 150),
      tool('g1', 'Grep', T0 + 12_900, 500),
      tool('b1', 'Bash', T0 + 72_400, 41_200),
      { toolUseId: 'ag1', name: 'Agent', turnId: 't1', requestedAt: T0 + 31_000 },
    ],
    forks: [{ toolUseId: 'ag1', childAgentId: 'c1', background: true, at: T0 + 31_500, subagentType: 'worker', description: '实现 X' }],
    compactions: [{ at: T0 + 73_000, trigger: 'auto', tokensBefore: 182_000, tokensAfter: 41_000 }],
  },
  {
    turnId: 'tc',
    agentId: 'c1',
    startedAt: T0 + 31_500,
    steps: [{ ...step(0, { sentAt: T0 + 31_500 }), turnId: 'tc', agentId: 'c1' }],
    tools: [],
    forks: [],
  },
]

/** FIXTURE's turn ended at 100s, its subagent's turn, then a second main turn still open. */
const FIXTURE_ENDED: TimelineTurn[] = [
  { ...FIXTURE[0]!, endedAt: T0 + 100_000, durationMs: 100_000 },
  FIXTURE[1]!,
  { turnId: 't2', startedAt: T0 + 100_000, steps: [step(0, { turnId: 't2', sentAt: T0 + 100_000 })], tools: [], forks: [] },
]

/** The agents atom with FIXTURE's subagent still running. */
const RUNNING_C1 = [{ agentId: 'c1', state: 'running' as const }]

const textOf = (line: Line) => line.map(seg => seg.text).join('')

const rowWith = (lines: Line[], part: string) => lines.find(line => textOf(line).includes(part))!

/** Terminal column of the first bar character in the line. */
function barColumn(line: Line): number {
  const text = textOf(line)
  const at = text.search(BAR_CHARS)

  return widthOf(text.slice(0, at))
}

const colorOf = (line: Line, char: string) => line.find(seg => seg.text.includes(char))?.color

/** A finished turn of two steps: #0 at 0 for 10s, #1 at 50s for 50s. */
function twoSteps(): TimelineTurn[] {
  return [
    {
      turnId: 't1',
      startedAt: T0,
      endedAt: T0 + 100_000,
      durationMs: 100_000,
      steps: [
        step(0, { sentAt: T0, ttftMs: 3_000, stepMs: 10_000, endedAt: T0 + 10_000, stopReason: 'tool_use', usage: usage(50_000, 500) }),
        step(1, { sentAt: T0 + 50_000, ttftMs: 15_000, stepMs: 50_000, endedAt: T0 + 100_000, stopReason: 'end_turn', usage: usage(60_000, 900) }),
      ],
      tools: [],
      forks: [],
    },
  ]
}

describe('timeline view, terminal', () => {
  test('bars share one time scale: a step half way through the turn starts half way along the bar', () => {
    setLang('zh-CN')

    const lines = timelineLines(twoSteps(), 't1', NOW, 100)
    const first = barColumn(rowWith(lines, '#0'))
    const second = barColumn(rowWith(lines, '#1'))
    const cells = 100 - first - 1

    expect(Math.abs(second - first - Math.round(cells / 2))).toBeLessThanOrEqual(1)

    for (const line of lines) {
      expect(widthOf(textOf(line))).toBeLessThanOrEqual(100)
    }
  })

  test('the wait for the first token is drawn ░ in subtle, the rest █ in text', () => {
    setLang('zh-CN')

    const row = rowWith(timelineLines(twoSteps(), 't1', NOW, 100), '#1')
    const text = textOf(row)

    expect(text.indexOf('░')).toBeGreaterThan(0)
    expect(text.indexOf('░')).toBeLessThan(text.indexOf('█'))
    expect(colorOf(row, '░')).toBe('subtle')
    expect(colorOf(row, '█')).toBe('text')
    expect(text).toContain('50.0s')
  })

  test('a running step: ● and the elapsed time with …, its bar ends at now with ▶, no end or duration made up', () => {
    setLang('zh-CN')

    const lines = timelineLines(FIXTURE, 't1', NOW, 100)
    const row = rowWith(lines, '#2')
    const text = textOf(row)

    expect(text).toContain('● 22s…')
    expect(text.trimEnd().endsWith('▶')).toBe(true)
    expect(colorOf(row, '●')).toBe('permission')
    expect(colorOf(row, '▶')).toBe('permission')
    expect(text).toContain('—/—')
    expect(text).not.toMatch(/\d+\.\d+s/)
    expect(textOf(lines[0]!)).toContain('关键路径 —')
  })

  test('a step with no response is ✗ in error, and the turn API error heads the view', () => {
    setLang('zh-CN')

    const turns: TimelineTurn[] = [
      {
        turnId: 't1',
        startedAt: T0,
        endedAt: T0 + 6_000,
        durationMs: 6_000,
        steps: [step(0, { sentAt: T0, stepMs: 5_000, endedAt: T0 + 5_000, stopReason: null, usage: null })],
        tools: [],
        forks: [],
        apiError: { error: 'overloaded' },
      },
    ]
    const lines = timelineLines(turns, 't1', NOW, 100)
    const row = rowWith(lines, '#0')

    expect(textOf(row)).toContain('✗')
    expect(colorOf(row, '✗')).toBe('error')
    expect(colorOf(row, '█')).toBe('error')
    expect(textOf(lines[0]!)).toContain('✗ overloaded')
    expect(colorOf(lines[0]!, '✗')).toBe('error')
  })

  test('a tool still running in an open turn: ● and its time so far with … in permission, its bar from the request to now ending ▶', () => {
    setLang('zh-CN')

    const turns: TimelineTurn[] = [
      {
        turnId: 't1',
        startedAt: T0,
        steps: [step(0, { sentAt: T0, ttftMs: 1_000, stepMs: 9_000, endedAt: T0 + 9_000, stopReason: 'tool_use', usage: usage(50_000, 500), toolUseIds: ['b1'] })],
        tools: [{ toolUseId: 'b1', name: 'Bash', turnId: 't1', stepIndex: 0, requestedAt: T0 + 9_000 }],
        forks: [],
      },
    ]
    const now = T0 + 21_000
    const row = rowWith(timelineLines(turns, 't1', now, 100), 'Bash')
    const text = textOf(row)

    expect(text).toContain('● 12s…')
    expect(colorOf(row, '●')).toBe('permission')
    expect(colorOf(row, '█')).toBe('permission')
    expect(text.trimEnd().endsWith('▶')).toBe(true)
    expect(colorOf(row, '▶')).toBe('permission')
    expect(textOf(rowWith(timelineLines(turns, 't1', now, 50), 'Bash'))).toContain('Bash 12s…')

    const ended = textOf(rowWith(timelineLines([{ ...turns[0]!, endedAt: T0 + 30_000, durationMs: 30_000 }], 't1', now, 100), 'Bash'))

    expect(ended, 'a turn that ended runs nothing').not.toMatch(/[●…▶]/)
  })

  test('adjacent calls of one tool fold into one row with the longest time; the longest tool of a step is marked ◆', () => {
    setLang('zh-CN')

    const lines = timelineLines(FIXTURE, 't1', NOW, 100)
    const read = textOf(rowWith(lines, 'Read'))

    expect(lines.filter(line => textOf(line).includes('Read'))).toHaveLength(1)
    expect(read).toContain('Read ×3')
    expect(read).toContain('0.2s')
    expect(read).not.toContain('◆')
    expect(textOf(rowWith(lines, 'Grep'))).toContain('◆')
    expect(textOf(rowWith(lines, 'Bash'))).toContain('41.2s ◆')
    expect(colorOf(rowWith(lines, 'Bash'), '█')).toBe('text')
    expect(colorOf(rowWith(lines, 'Read'), '▏')).toBe('subtle')
  })

  test('a fork is one row: ▸ type · description, 后台, ┄ to now with ▶ while the subagent runs', () => {
    setLang('zh-CN')

    const lines = timelineLines(FIXTURE, 't1', NOW, 100, RUNNING_C1)
    const text = textOf(rowWith(lines, '▸'))

    expect(text).toContain('▸ worker · 实现 X')
    expect(text).toContain('后台')
    expect(text).toContain('┄')
    expect(text.trimEnd().endsWith('▶')).toBe(true)
    expect(lines.filter(line => textOf(line).startsWith('#0'))).toHaveLength(1)
  })

  test('a compaction is a divider in time order; without numbers it says only ⤺ compact', () => {
    setLang('zh-CN')

    const texts = timelineLines(FIXTURE, 't1', NOW, 100).map(textOf)
    const at = texts.indexOf('── ⤺ compact 182k→41k ──')

    expect(at).toBeGreaterThan(texts.findIndex(text => text.includes('Bash')))
    expect(at).toBeLessThan(texts.findIndex(text => text.includes('#2')))

    const bare = [{ ...FIXTURE[0]!, compactions: [{ at: T0 + 73_000, trigger: 'manual' as const }] }]

    expect(timelineLines(bare, 't1', NOW, 100).map(textOf)).toContain('── ⤺ compact ──')
  })

  test('the header: steps, turn time, critical path, input with its cache-read share, output, tools, subagents', () => {
    setLang('zh-CN')

    const lines = timelineLines(twoSteps(), 't1', NOW, 100)

    expect(textOf(lines[0]!)).toBe('时间线 · 2步 · 1m40s · 关键路径 1m00s')
    expect(textOf(lines[1]!)).toBe('in 110k(缓存读78%) · out 1.4k · 工具0 · 子agent 0')

    setLang('en')
    expect(textOf(timelineLines(twoSteps(), 't1', NOW, 100)[0]!)).toBe('Timeline · 2 steps · 1m40s · critical path 1m00s')
  })

  test('below 60 columns: no bars, one summary line per step', () => {
    setLang('zh-CN')

    const lines = timelineLines(FIXTURE, 't1', NOW, 50)
    const texts = lines.map(textOf)

    expect(texts.some(text => BAR_CHARS.test(text))).toBe(false)
    expect(texts).toContain('#1 opus-5-5 18.0s 184k/2k → Bash 41.2s ◆ · worker…')
    expect(timelineLines(FIXTURE, 't1', NOW, 59).map(textOf)).toContain('#1 opus-5-5 18.0s 184k/2k → Bash 41.2s ◆ · worker(后台)')

    for (const text of texts) {
      expect(widthOf(text)).toBeLessThanOrEqual(50)
    }
  })

  test('no step yet: one dim line', () => {
    setLang('zh-CN')

    const empty: TimelineTurn[] = [{ turnId: 't1', startedAt: T0, steps: [], tools: [], forks: [] }]

    for (const lines of [timelineLines(empty, 't1', NOW, 100), timelineLines([], 'none', NOW, 100)]) {
      expect(lines).toEqual([[{ text: '从本次加载起记录；还没有模型请求', dim: true }]])
    }
  })

  test('a field the step never got reads —, never 0', () => {
    setLang('zh-CN')

    const turns: TimelineTurn[] = [
      { turnId: 't1', startedAt: T0, endedAt: T0 + 9_000, durationMs: 9_000, steps: [step(0, { sentAt: T0 + 1_000 })], tools: [], forks: [] },
    ]
    const lines = timelineLines(turns, 't1', NOW, 100)
    const row = textOf(rowWith(lines, '#0'))

    expect(row).toContain('—')
    expect(row).toContain('—/—')
    expect(row).not.toMatch(/\b0(\.0)?s\b|\b0\/|\/0\b/)
    expect(row).not.toContain('●')
    expect(BAR_CHARS.test(row)).toBe(false)
    expect(textOf(lines[1]!)).toContain('in — · out —')
  })

  test('a Chinese description takes 2 columns a character: the fork bar starts under its step bar', () => {
    setLang('zh-CN')

    const turns: TimelineTurn[] = [
      {
        turnId: 't1',
        startedAt: T0,
        endedAt: T0 + 20_000,
        durationMs: 20_000,
        steps: [step(0, { sentAt: T0 + 5_000, ttftMs: 1_000, stepMs: 10_000, endedAt: T0 + 15_000, stopReason: 'tool_use', usage: usage(50_000, 500), toolUseIds: ['ag'] })],
        tools: [{ toolUseId: 'ag', name: 'Agent', turnId: 't1', endedAt: T0 + 20_000, durationMs: 15_000, outcome: 'ok' }],
        forks: [{ toolUseId: 'ag', childAgentId: 'c9', background: false, at: T0 + 5_000, subagentType: 'worker', description: '把时间线页画成共享刻度的瀑布图并补齐测试' }],
      },
      { turnId: 'tc9', agentId: 'c9', startedAt: T0 + 5_000, endedAt: T0 + 20_000, steps: [], tools: [], forks: [] },
    ]
    const lines = timelineLines(turns, 't1', NOW, 80)
    const fork = rowWith(lines, '▸')

    expect(barColumn(fork)).toBe(barColumn(rowWith(lines, '#0')))
    expect(textOf(fork).trimEnd().endsWith('▶')).toBe(false)
    expect(textOf(fork)).not.toContain('后台')

    for (const line of lines) {
      expect(widthOf(textOf(line))).toBeLessThanOrEqual(80)
    }
  })

  test('hotspots: tools by total time in aligned columns, the model time split, the slowest turns', () => {
    setLang('zh-CN')

    const texts = hotspotLines(FIXTURE_ENDED, 100).map(textOf)

    expect(texts[0]).toBe('热点 · 主线程 2轮')
    expect(texts).toContain('按工具')
    expect(texts.filter(text => /^(Bash|Grep|Read) /.test(text)).map(text => text.split(/ +/))).toEqual([
      ['Bash', '1', '41.2s', '41.2s'],
      ['Grep', '1', '0.5s', '0.5s'],
      ['Read', '3', '0.5s', '0.2s'],
    ])

    // Where each word ends, in columns: the number columns end where their heads do.
    const ends = (text: string) => [...text.matchAll(/\S+/g)].map(match => widthOf(text.slice(0, match.index! + match[0].length)))

    expect(ends(texts.find(text => text.startsWith('工具'))!).slice(1)).toEqual(ends(texts.find(text => text.startsWith('Bash'))!).slice(1))
    expect(ends(texts.find(text => text.startsWith('工具'))!).slice(1)).toEqual(ends(texts.find(text => text.startsWith('Read'))!).slice(1))
    expect(texts.some(text => text.startsWith('Agent')), 'a call without a duration is no sample').toBe(false)
    expect(texts).toContain('模型时间')
    expect(texts.find(text => text.startsWith('等首 token'))?.split(/ +/).slice(-2)).toEqual(['7.0s', '23%'])
    expect(texts.find(text => text.startsWith('生成'))?.split(/ +/).slice(-2)).toEqual(['23.4s', '77%'])
    expect(texts).toContain('最慢的回合')
    expect(texts.filter(text => text.startsWith('第')).map(text => text.split(/ +/))).toEqual([['第1轮', '1m40s', '#1', '18.0s']])

    for (const text of texts) {
      expect(widthOf(text)).toBeLessThanOrEqual(100)
    }

    setLang('en')
    expect(hotspotLines(FIXTURE_ENDED, 100).map(textOf)[0]).toBe('Hotspots · main thread, 2 turns')
  })

  test('hotspots below 60 columns: the name and the total time alone', () => {
    setLang('zh-CN')

    const texts = hotspotLines(FIXTURE_ENDED, 40).map(textOf)

    expect(texts.filter(text => /^(工具|Bash|Read) /.test(text)).map(text => text.split(/ +/))).toEqual([
      ['工具', '总耗时'],
      ['Bash', '41.2s'],
      ['Read', '0.5s'],
    ])
    expect(texts.find(text => text.startsWith('生成'))?.split(/ +/)).toEqual(['生成', '23.4s'])
    expect(texts.filter(text => text.startsWith('第')).map(text => text.split(/ +/))).toEqual([['第1轮', '1m40s']])

    for (const text of texts) {
      expect(widthOf(text)).toBeLessThanOrEqual(40)
    }
  })

  test('hotspots with nothing that ended: one dim line', () => {
    setLang('zh-CN')

    for (const turns of [[], [FIXTURE[1]!], [{ ...FIXTURE[0]!, steps: [FIXTURE[0]!.steps[2]!], tools: [FIXTURE[0]!.tools[5]!] }]]) {
      expect(hotspotLines(turns, 100)).toEqual([[{ text: '还没有结束的工具调用或模型请求', dim: true }]])
    }
  })

  test('latestMainTurnId skips subagent turns', () => {
    expect(latestMainTurnId(FIXTURE)).toBe('t1')
    expect(latestMainTurnId([FIXTURE[1]!])).toBe(undefined)
  })
})

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

function nodesOf(node: unknown, type: string, out: Node[] = []): Node[] {
  if (Array.isArray(node)) {
    node.forEach(one => nodesOf(one, type, out))
  } else if (node !== null && typeof node === 'object') {
    const el = node as Node

    if (el.type === type) {
      out.push(el)
    }

    nodesOf(el.children ?? [], type, out)
  }

  return out
}

function stringsOf(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node)
  } else if (Array.isArray(node)) {
    node.forEach(one => stringsOf(one, out))
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'source') {
        stringsOf(value, out)
      }
    }
  }

  return out
}

describe('timeline view, desktop', () => {
  test('the head, a legend and an axis, then a lane per step, tool group, fork and compaction on one scale', () => {
    setLang('zh-CN')

    const drawn = drawTimelineDesktop(EL, FIXTURE, 't1', NOW, 100, RUNNING_C1, { disclosures: new Set(['timeline-tools:t1:0']) })
    const svgs = nodesOf(drawn, 'Svg')
    const text = stringsOf(drawn).join('\n')

    expect(svgs, 'the axis; #0, Read ×3, Grep; #1, Bash, the fork; the compaction; #2').toHaveLength(9)

    for (const svg of svgs) {
      const colors = String(svg.props!.source).match(/#[0-9A-Fa-f]{6}/g) ?? []

      expect(colors.every(color => color === TRACK || Object.values(FILL).includes(color))).toBe(true)
      expect(svg.props!.isInteractive).toBe(undefined)
      expect(String(svg.props!.alt)).not.toBe('')
    }

    expect(String(laneOf(drawn, '#2')!.props!.source)).toContain(FILL.running)
    expect(new Set(svgs.map(svg => svg.props!.width)).size).toBe(1)

    for (const part of ['3步', '输入 366k', '缓存读', '#0 · opus-5-5', 'Read ×3', 'Bash', '41.2s', '关键', '▸ worker · 实现 X', '后台', '压缩 182k → 41k', '● 运行']) {
      expect(text).toContain(part)
    }

    const closed = drawTimelineDesktop(EL, FIXTURE, 't1', NOW, 100, RUNNING_C1)

    expect(stringsOf(closed).join('\n'), 'a tool off the critical path waits behind its button').not.toContain('Read ×3')
    expect(nodesOf(closed, 'Button').map(button => button.props!.label)).toContain('显示工具（1）')
  })

  test('hotspots: a card per ranking, an Svg bar per tool, the model split and each slow turn, in FILL and TRACK alone', () => {
    setLang('zh-CN')

    const drawn = drawHotspotsDesktop(EL, FIXTURE_ENDED, 100)
    const svgs = nodesOf(drawn, 'Svg')
    const text = stringsOf(drawn).join('\n')

    expect(svgs, 'Bash, Grep, Read; the model; the one ended turn').toHaveLength(5)

    for (const svg of svgs) {
      const colors = String(svg.props!.source).match(/#[0-9A-Fa-f]{6}/g) ?? []

      expect(colors.length).toBeGreaterThan(0)
      expect(colors.every(color => color === TRACK || Object.values(FILL).includes(color))).toBe(true)
      expect(svg.props!.isInteractive).toBe(undefined)
      expect(String(svg.props!.alt)).not.toBe('')
    }

    for (const part of ['热点 · 主线程 2轮', '工具执行时间', 'Bash', '41.2s', 'Read', '3次', '最长 0.2s', '模型请求时间', '等首 token', '7.0s', '23%', '生成', '77%', '最慢的回合', '第1轮', '1m40s', '#1 18.0s']) {
      expect(text).toContain(part)
    }

    expect(text).not.toContain('Agent')
    const widths = (columns: number) => nodesOf(drawHotspotsDesktop(EL, FIXTURE_ENDED, columns), 'Svg').map(svg => svg.props!.width)

    expect(widths(50), 'narrow').toEqual([328, 328, 328, 328, 328])
    expect(widths(80), 'standard').toEqual([498, 498, 498, 498, 498])
    expect(widths(100), 'wide: the tools and the model side by side, the turns under them').toEqual([328, 328, 328, 328, 572])
    expect(nodesOf(drawn, 'Button').map(button => button.props!.label)).toEqual(['打开这一轮'])
  })

  test('hotspots with nothing that ended: the dim line alone', () => {
    setLang('zh-CN')

    const drawn = drawHotspotsDesktop(EL, [], 100)

    expect(nodesOf(drawn, 'Svg')).toHaveLength(0)
    expect(stringsOf(drawn)).toContain('还没有结束的工具调用或模型请求')
  })

  test('no step yet: the dim line alone', () => {
    setLang('zh-CN')

    const drawn = drawTimelineDesktop(EL, [], 'none', NOW, 100)

    expect(nodesOf(drawn, 'Svg')).toHaveLength(0)
    expect(stringsOf(drawn)).toContain('从本次加载起记录；还没有模型请求')
  })
})

/** The Text nodes whose own strings hold `part`. */
const textsWith = (drawn: unknown, part: string) => nodesOf(drawn, 'Text').filter(node => (node.children ?? []).some(one => typeof one === 'string' && one.includes(part)))

/** The lane Svg whose alt names `part`. */
const laneOf = (drawn: unknown, part: string) => nodesOf(drawn, 'Svg').find(svg => String(svg.props!.alt).includes(part))

describe('timeline bugs', () => {
  test('missing-result-as-success: a step that ended without a result is its own state in warning, never done', () => {
    setLang('zh-CN')

    const turns: TimelineTurn[] = [
      {
        turnId: 't1',
        startedAt: T0,
        endedAt: T0 + 20_000,
        durationMs: 20_000,
        steps: [
          step(0, { sentAt: T0, ttftMs: 1_000, stepMs: 5_000, endedAt: T0 + 5_000 }),
          step(1, { sentAt: T0 + 6_000, stepMs: 4_000, endedAt: T0 + 10_000, stopReason: null, usage: null }),
        ],
        tools: [],
        forks: [],
      },
    ]
    const row = rowWith(timelineLines(turns, 't1', NOW, 100), '#0')

    expect(textOf(row)).toContain('无结果')
    expect(colorOf(row, '无结果')).toBe('warning')
    expect(colorOf(row, '█')).toBe('warning')
    expect(textOf(rowWith(timelineLines(turns, 't1', NOW, 50), '#0'))).toContain('无结果')
    expect(colorOf(rowWith(timelineLines(turns, 't1', NOW, 100), '#1'), '✗'), 'a null stop reason stays failed').toBe('error')

    const drawn = drawTimelineDesktop(EL, turns, 't1', NOW, 80)

    expect(textsWith(drawn, '无结果').map(node => node.props!.color)).toEqual(['warning'])
    expect(String(laneOf(drawn, '#0')!.props!.source)).toContain(FILL.stale)
    expect(String(laneOf(drawn, '#0')!.props!.source)).not.toContain(FILL.done)
    expect(String(laneOf(drawn, '#0')!.props!.alt)).toContain('无结果')

    setLang('en')
    expect(textOf(rowWith(timelineLines(turns, 't1', NOW, 100), '#0'))).toContain('no result')
  })

  test('discarded-tool-outcome: a failed, denied or interrupted call is drawn in error or warning with its word, never as done', () => {
    setLang('zh-CN')

    const turns: TimelineTurn[] = [
      {
        turnId: 't1',
        startedAt: T0,
        endedAt: T0 + 40_000,
        durationMs: 40_000,
        steps: [step(0, { sentAt: T0, ttftMs: 1_000, stepMs: 5_000, endedAt: T0 + 5_000, stopReason: 'tool_use', usage: usage(50_000, 500), toolUseIds: ['b1', 'r1', 'r2', 'e1'] })],
        tools: [
          { ...tool('b1', 'Bash', T0 + 30_000, 25_000), outcome: 'error' },
          tool('r1', 'Read', T0 + 6_000, 100),
          { ...tool('r2', 'Read', T0 + 6_500, 200), outcome: 'denied' },
          { ...tool('e1', 'Edit', T0 + 7_000, 300), outcome: 'interrupted' },
        ],
        forks: [],
      },
    ]
    const lines = timelineLines(turns, 't1', NOW, 100)

    expect(textOf(rowWith(lines, 'Bash'))).toContain('失败')
    expect(colorOf(rowWith(lines, 'Bash'), '失败')).toBe('error')
    expect(colorOf(rowWith(lines, 'Bash'), '█')).toBe('error')
    expect(textOf(rowWith(lines, 'Read'))).toContain('被拒')
    expect(colorOf(rowWith(lines, 'Read'), '被拒'), 'the worst outcome of the group').toBe('error')
    expect(textOf(rowWith(lines, 'Edit'))).toContain('已中断')
    expect(colorOf(rowWith(lines, 'Edit'), '已中断')).toBe('warning')
    expect(textOf(rowWith(timelineLines(turns, 't1', NOW, 50), '#0'))).toContain('Bash ✗ 失败')

    const drawn = drawTimelineDesktop(EL, turns, 't1', NOW, 80)

    for (const [name, word, color, fill] of [['Bash', '失败', 'error', FILL.failed], ['Read', '被拒', 'error', FILL.failed], ['Edit', '已中断', 'warning', FILL.stale]] as const) {
      const source = String(laneOf(drawn, name)!.props!.source)

      expect(textsWith(drawn, word).map(node => node.props!.color), name).toEqual([color])
      expect(source, name).toContain(fill)
      expect(source, name).not.toContain(FILL.done)
      expect(String(laneOf(drawn, name)!.props!.alt), name).toContain(word)
    }
  })

  test('inferred-fork-liveness: a fork ends with its first child turn, else with the agent; only a running agent keeps it open', () => {
    setLang('zh-CN')

    const parent = (forkAt: number): TimelineTurn => ({
      turnId: 't1',
      startedAt: T0,
      endedAt: T0 + 100_000,
      durationMs: 100_000,
      steps: [step(0, { sentAt: T0, ttftMs: 1_000, stepMs: 5_000, endedAt: T0 + 5_000, stopReason: 'tool_use', usage: usage(50_000, 500), toolUseIds: ['ag'] })],
      tools: [{ toolUseId: 'ag', name: 'Agent', turnId: 't1', requestedAt: T0 + 5_000 }],
      forks: [{ toolUseId: 'ag', childAgentId: 'c1', background: true, at: forkAt, subagentType: 'worker', description: 'Fix X' }],
    })
    const child = (turnId: string, from: number, to?: number): TimelineTurn => ({
      turnId,
      agentId: 'c1',
      startedAt: from,
      ...(to !== undefined && { endedAt: to, durationMs: to - from }),
      steps: [],
      tools: [],
      forks: [],
    })
    const forkBar = (lines: Line[]) => textOf(rowWith(lines, '▸')).trimEnd()
    // Where the fork's bar ends, as a share of the bar cells after the turn's start (#0 starts there).
    const forkEnd = (lines: Line[]) => {
      const origin = barColumn(rowWith(lines, '#0'))

      return (widthOf(forkBar(lines)) - origin) / (100 - origin - 1)
    }
    const killed = [parent(T0 + 5_000), child('tc', T0 + 5_000)]
    const run = { agentId: 'c1', state: 'aborted' as const, endedAt: T0 + 40_000 }

    expect(forkBar(timelineLines(killed, 't1', NOW, 100, [run])).endsWith('▶'), 'a killed child has no turn.complete').toBe(false)
    expect(Math.abs(forkEnd(timelineLines(killed, 't1', NOW, 100, [run])) - 0.4), 'it ends at the agent end: 40s of 100s').toBeLessThan(0.03)
    expect(forkBar(timelineLines(killed, 't1', NOW, 100, [])).endsWith('▶'), 'a child no agent record says runs').toBe(false)
    expect(forkBar(timelineLines(killed, 't1', NOW, 100, [{ agentId: 'c1', state: 'running' }])).endsWith('▶')).toBe(true)

    // A later turn of the same agent leaves the fork at its first turn's end: 20s, not 90s.
    const resumed = [parent(T0 + 5_000), child('tc', T0 + 5_000, T0 + 20_000), child('tc2', T0 + 50_000, T0 + 90_000)]

    expect(Math.abs(forkEnd(timelineLines(resumed, 't1', NOW, 100, [{ agentId: 'c1', state: 'done', endedAt: T0 + 90_000 }])) - 0.2)).toBeLessThan(0.03)

    const open = drawTimelineDesktop(EL, killed, 't1', NOW, 80, [{ agentId: 'c1', state: 'running' as const }])
    const closed = drawTimelineDesktop(EL, killed, 't1', NOW, 80, [run])

    expect(String(laneOf(open, 'worker')!.props!.source)).toContain(FILL.running)
    expect(String(laneOf(closed, 'worker')!.props!.source)).not.toContain(FILL.running)
    expect(String(laneOf(closed, 'worker')!.props!.alt)).toContain('已结束')
    expect(stringsOf(closed).join('\n')).not.toContain('运行')
  })
})
