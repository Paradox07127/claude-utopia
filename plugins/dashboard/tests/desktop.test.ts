import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { FsEntry, On, RenderInput, SessionStartInput } from 'claude-code'

import { widthOf } from '../hooks/agent-model'
import { commandHead } from '../hooks/board'
import { drawDesktopPane } from '../hooks/desktop'
import type { PaneData } from '../hooks/desktop'
import { setLang } from '../hooks/i18n'
import { reportOf, reviewOf } from '../hooks/runs'
import type { AgentRun, DashTimelinePage, GateRun, MmSnapshot, TimelineTurn, WorktreeInfo } from '../types'

const PLUGIN = 'dashboard'
const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const BOTTOM = { type: 'Text', props: {}, children: ['engine band'] }
const NOW = 1_790_922_800_000
const ROOT = '/h/.claude/mmruns'
const R1 = '20261002-010000-aaaa'
const R3 = '20261002-005000-cccc'

const BAND: RenderInput<'AbovePrompt'> = {
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 19 }, view: {} },
}

const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: 'dashboard',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: { title: '工作台', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}

const command = (name: string, args = '') => ({
  command: name,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 180 },
})

const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'do it',
  description: 'Build mm plugin',
  subagentType: 'worker',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
}

const NVIDIA_RUN = ['@@NVSMI', '0, NVIDIA GeForce RTX 4090, 52, 18636, 24564, 67, 280.45', '@@APPS', '4242, /usr/bin/python3, 10240'].join('\n')

type Files = Record<string, { text: string; mtimeMs?: number }>

const runMeta = (runid: string, tag: string, models: string) =>
  `runid=${runid}\nworkdir=/work/proj\ntag=${tag}\nmodels=${models}\nmode=review\nschema=\nwt=\nsession=x\n`

/** R1 has codex running (pid 111) and grok done; R3 failed an hour ago. */
function mmruns(): Files {
  return {
    [`${R1}/run.meta`]: { text: runMeta(R1, 'design', 'codex,grok'), mtimeMs: NOW - 300_000 },
    [`${R1}/codex.status`]: { text: 'RUNNING\n' },
    [`${R1}/codex.started`]: { text: `${(NOW - 252_000) / 1000}\n` },
    [`${R1}/codex.pid`]: { text: '111\n' },
    [`${R1}/grok.status`]: { text: 'DONE\n', mtimeMs: NOW - 120_000 },
    [`${R1}/grok.started`]: { text: `${(NOW - 422_000) / 1000}\n` },
    [`${R1}/grok.meta`]: { text: 'session_id=s\nsecs=302\nexit=0\nattempts=1\nusage={"input_tokens":1,"output_tokens":25835}\n' },
    [`${R3}/run.meta`]: { text: runMeta(R3, '', 'agy'), mtimeMs: NOW - 4_000_000 },
    [`${R3}/agy.status`]: { text: 'FAIL:1\n', mtimeMs: NOW - 3_600_000 },
    [`${R3}/agy.started`]: { text: `${(NOW - 3_700_000) / 1000}\n` },
    [`${R3}/agy.meta`]: { text: 'secs=100\nexit=1\n' },
  }
}

/** The engine beneath the plugin, in memory: mmruns under ~/.claude/mmruns, pid 111 alive, an nvidia host. */
function seat(on: On, files: Files): void {
  const panes = new Set<string>()
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  let spawned = 0

  mock.env(on, { HOME: '/h' })
  on('session.root', () => ({ value: '/work' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    panes.add(e.id)

    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', ($, e) => (e.argv[0] === 'kill' ? { value: { ...ok('').value, exitCode: e.argv[2] === '111' ? 0 : 1 } } : ok('')))
  // The GPU ssh: one pass, then nothing until it is ended.
  on('process.spawn', async function* ($, e, next) {
    yield { stream: 'stdout' as const, text: `${NVIDIA_RUN}\n@@END\n` }
    await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))

    return { value: { code: null, signal: 'SIGTERM' } } as never
  })
  on('fs.list', ($, e) => {
    const rel = e.path === ROOT ? '' : e.path.slice(ROOT.length + 1)
    const names = new Map<string, FsEntry>()

    for (const [path, file] of Object.entries(files)) {
      const [dir, name] = path.split('/') as [string, string]

      if (rel === '') {
        names.set(dir, { name: dir, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
      } else if (dir === rel) {
        names.set(name, { name, kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs ?? NOW - 1000, isLink: false })
      }
    }

    return names.size > 0 ? { value: [...names.values()] } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', ($, e) => {
    const file = files[e.path.slice(ROOT.length + 1)]

    return file ? { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs ?? NOW - 1000, isLink: false } } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.read', ($, e) => {
    const file = files[e.path.slice(ROOT.length + 1)]

    return file ? { value: file.text } : { deny: `ENOENT ${e.path}` }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('settings.read', () => ({ value: {} }))
  on('agent.spawn', () => {
    spawned += 1

    return { model: 'claude-opus-5-5', agentId: `a${spawned}` }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('ui.render', () => BOTTOM as never)
}

/** A session with one running agent, the mmruns above and GPUs on `lab-box` already sampled. */
async function busy($: Engine, on: On) {
  const clock = mock.clock(on, { now: NOW })

  seat(on, mmruns())
  await $.session.start(SESSION)
  await clock.advance(3_000)
  await $.agent.spawn(SPAWN as never)
  await $.command.run(command('gpu', 'lab-box'))
  await clock.settle()

  return clock
}

describe('the desktop draws cards and charts', () => {
  test('Agents: an elapsed bar per agent', { options: { language: 'zh-CN' } }, async ($, on) => {
    await busy($, on)

    const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface: 'desktop' } as never)

    await pane.press({ key: 'page-agents' })

    const svgs = await pane.findAll({ type: 'Svg' })

    expect(svgs).toHaveLength(1)
    expect(String(svgs[0]?.props.alt)).toContain('已耗时')
    expect((await pane.find({ type: 'Text', text: 'Build mm plugin' }))?.props).toMatchObject({ bold: true, wrap: 'wrap' })
    await pane.unmount()
  })

  test('外审: a bar per model with a known time, against one scale per run', { options: { language: 'zh-CN' } }, async ($, on) => {
    await busy($, on)

    const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface: 'desktop' } as never)

    await pane.press({ key: 'page-mmrun' })

    const alts = (await pane.findAll({ type: 'Svg' })).map(one => String(one.props.alt))

    expect(alts.some(alt => alt.includes('codex') && alt.includes('运行'))).toBe(true)
    expect(alts).toHaveLength(3)
    expect(await pane.findAll({ type: 'Text', text: /共同刻度/ })).toHaveLength(1)
    await pane.unmount()
  })

  test('GPU: gauges beside the numbers', { options: { language: 'zh-CN' } }, async ($, on) => {
    await busy($, on)

    const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface: 'desktop' } as never)

    expect(await pane.findAll({ type: 'Svg' })).toHaveLength(2)
    expect(await pane.find({ type: 'Text', text: '利用率 52%' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '显存 18.2 / 24.0 GiB' })).toBeDefined()
    await pane.unmount()
  })

  test('总览: a card per non-empty section, nothing for an empty one', { options: { language: 'zh-CN' } }, async ($, on) => {
    await busy($, on)

    const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface: 'desktop' } as never)

    await pane.press({ key: 'page-overview' })
    expect(await pane.find({ type: 'Text', text: '待处理' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: '需要你  ' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: '! 需要你 0' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: '工作树' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: '运行中  2' })).toBeDefined()
    expect((await pane.findAll({ type: 'Text', text: '运行中' })).some(one => one.props.bold === true)).toBe(true)
    expect(await pane.find({ type: 'Text', text: 'worker · Build mm plugin' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'design / codex' })).toBeDefined()
    expect((await pane.find({ key: 'page-overview' }))?.props).toMatchObject({ variant: 'primary' })
    expect((await pane.find({ key: 'page-gpu' }))?.props).toMatchObject({ variant: 'secondary' })
    await pane.unmount()
  })

  test('总览: a running row is its title beside its Button, then tools plus time; a quiet agent gets a 静默 chip', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = await busy($, on)
    const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface: 'desktop' } as never)

    await pane.press({ key: 'page-overview' })

    const rows = (await pane.findAll({ type: 'Box' })).filter(box => box.props.minWidth === 0 && box.props.flexGrow === 1)

    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(await pane.find({ type: 'Text', text: '0 tools · 0s' })).toBeDefined()

    await clock.advance(120_000)
    expect(await pane.find({ type: 'Text', text: '◐ 静默 2m00s' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '需要你  ' }), 'quiet is no failure').toBeUndefined()
    await pane.unmount()
  })

  test('总览: returned work folds into one line with its buttons; idle shows the last ended', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = await busy($, on)

    await $.turn.complete({ answer: 'ok', durationMs: 5_000, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer' } as never)

    const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface: 'desktop' } as never)

    await pane.press({ key: 'page-overview' })
    expect(await pane.find({ type: 'Text', text: '✓ 已返回 1' })).toBeDefined()
    expect((await pane.find({ key: 'overview-agents' }))?.props).toMatchObject({ label: '看 Agents' })
    expect(await pane.find({ key: 'overview-mmrun' }), 'no model returned unread').toBeUndefined()

    await pane.press({ key: 'overview-agents' })
    await pane.press({ key: 'page-overview' })
    await clock.advance(1_000)
    expect(await pane.find({ type: 'Text', text: '运行中  1' }), 'codex still runs').toBeDefined()
    expect(await pane.find({ type: 'Text', text: '已返回' })).toBeUndefined()
    await pane.unmount()
  })

  test('总览 idle: a gray line, then the last ended', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on, {})
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.turn.complete({ answer: 'ok', durationMs: 5_000, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer' } as never)
    await $.command.run(command('subagents'))
    await clock.advance(60_000)

    const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface: 'desktop' } as never)

    await pane.press({ key: 'page-overview' })
    expect((await pane.find({ type: 'Text', text: '没有需要你处理或运行中的任务' }))?.props).toMatchObject({ color: 'subtle' })
    expect((await pane.find({ type: 'Text', text: '✓ worker · Build mm plugin · 1m00s 前' }))?.props).toMatchObject({ color: 'subtle' })
    await pane.unmount()
  })

  test('an aborted agent is a yellow ⊘ 已中止 chip and needs nobody; an errored one is red and 需要你', { options: { language: 'zh-CN' } }, async ($, on) => {
    await busy($, on)
    await $.agent.spawn(SPAWN as never)
    await $.turn.complete({ answer: '', durationMs: 5_000, isAborted: true, turnId: 't', agentId: 'a1', reason: 'aborted' } as never)
    await $.turn.complete({ answer: '', durationMs: 5_000, isAborted: false, turnId: 't', agentId: 'a2', reason: 'error' } as never)

    const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface: 'desktop' } as never)

    await pane.press({ key: 'page-overview' })
    expect(await pane.find({ type: 'Text', text: '需要你  1' }), 'the errored one alone').toBeDefined()

    await pane.press({ key: 'page-agents' })
    expect((await pane.find({ type: 'Text', text: '⊘ 已中止' }))?.props).toMatchObject({ color: 'warning' })
    expect((await pane.find({ type: 'Text', text: '✗ 出错' }))?.props).toMatchObject({ color: 'error' })
    await pane.unmount()
  })

  test('the band has no frame and carries the 工作台 button', { options: { language: 'zh-CN' } }, async ($, on) => {
    await busy($, on)

    const band = await $.ui.mount({ plugin: PLUGIN, ...BAND, surface: 'desktop' } as never)

    expect((await band.find({ key: 'dash-open' }))?.props).toMatchObject({ label: '工作台', variant: 'secondary' })
    expect((await band.find({ key: 'dash-open' }))?.props.hotkey).toBeUndefined()
    expect((await band.findAll({ type: 'Box' })).filter(box => box.props.borderStyle !== undefined)).toEqual([])
    await band.unmount()
  })

  test('the band drops the terminal padding: no run of more than two spaces', { options: { language: 'zh-CN' } }, async ($, on) => {
    await busy($, on)

    const band = await $.ui.mount({ plugin: PLUGIN, ...BAND, surface: 'desktop' } as never)
    const texts = (await band.findAll({ type: 'Text' })).map(one => one.text)

    expect(JSON.stringify(await $.ui.render(BAND)), 'the terminal keeps its columns').toMatch(/ {3,}/)
    expect(texts.filter(text => / {3,}/.test(text))).toEqual([])
    expect(texts.join('\n')).toContain('worker  Build mm plugin  ')
    await band.unmount()
  })

  test('the terminal draws no Svg', async ($, on) => {
    await busy($, on)

    const band = await $.ui.mount({ plugin: PLUGIN, ...BAND } as never)

    expect(await band.findAll({ type: 'Svg' })).toHaveLength(0)
    await band.unmount()

    const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    for (const key of ['page-overview', 'page-agents', 'page-mmrun', 'page-gpu']) {
      await pane.press({ key })
      expect(await pane.findAll({ type: 'Svg' }), key).toHaveLength(0)
    }

    await pane.unmount()
  })
})

// Host types, so a drawn tree is plain data to walk; a Button keeps its onPress to press.
const EL = {
  Box: 'Box',
  Text: 'Text',
  Button: (props: Record<string, unknown>) => ({ type: 'Button', props }),
  Svg: 'Svg',
  Markdown: 'Markdown',
  Code: (props: Record<string, unknown>) => ({ type: 'Code', props }),
  Input: (props: Record<string, unknown>) => ({ type: 'Input', props }),
  Select: (props: Record<string, unknown>) => ({ type: 'Select', props }),
  Link: (props: Record<string, unknown>) => ({ type: 'Link', props }),
} as never
const noop = () => {}

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

/** Every string under a node, Svg sources aside. */
function textOf(node: unknown): string {
  if (typeof node === 'string') {
    return node
  }

  if (Array.isArray(node)) {
    return node.map(textOf).join('')
  }

  if (node !== null && typeof node === 'object') {
    const el = node as Node
    const source = typeof el.props?.source === 'string' ? el.props.source : ''
    return source + textOf(el.children ?? [])
  }

  return ''
}

/** The node's own children, arrays flattened. */
const kids = (node: Node): Node[] => (node.children ?? []).flat(Infinity).filter((one): one is Node => one !== null && typeof one === 'object')

const buttonOf = (drawn: unknown, label: string) => nodesOf(drawn, 'Button').find(one => one.props?.label === label)

const runAgent = (over: Partial<AgentRun>): AgentRun => ({
  agentId: 'a1',
  description: 'Build mm plugin',
  subagentType: 'worker',
  model: 'claude-opus-5-5',
  background: true,
  startedAt: NOW - 300_000,
  tools: 4,
  lastTool: 'Edit x.ts',
  state: 'running',
  lastActivityAt: NOW - 1_000,
  ...over,
})

const ENDED = { endedAt: NOW - 5_000, durationMs: 120_000 }

const PAGES = [
  { page: 'overview', label: '总览' },
  { page: 'agents', label: 'Agents' },
  { page: 'timeline', label: '时间线' },
] as const

const paneOf = (over: Partial<PaneData>): PaneData => ({
  page: 'overview',
  pages: PAGES,
  now: NOW,
  columns: 80,
  agents: [],
  snap: null,
  seen: { agents: 0, runs: 0 },
  gpu: null,
  gates: [],
  trees: [],
  guards: [],
  peers: [],
  paneRuns: 5,
  detail: null,
  reports: {},
  onPage: noop,
  onReadAgent: noop,
  onReadRun: noop,
  onOpenItem: noop,
  onBack: noop,
  onToggleSeverity: noop,
  onCopyResume: noop,
  onCopyCd: noop,
  onClose: noop,
  ...over,
})

const turn = (turnId: string, steps: number, agentId?: string): TimelineTurn => ({
  turnId,
  ...(agentId !== undefined && { agentId }),
  startedAt: NOW - 60_000,
  steps: Array.from({ length: steps }, (_, index) => ({
    turnId,
    index,
    model: 'claude-opus-5-5',
    messageCount: 1,
    sentAt: NOW - 60_000 + index * 10_000,
    ttftMs: 1_000,
    stepMs: 5_000,
    endedAt: NOW - 55_000 + index * 10_000,
    stopReason: 'end_turn',
    toolUseIds: [],
    ...(agentId !== undefined && { agentId }),
  })),
  tools: [],
  forks: [],
})

/** Main turns t1 (1 step), t2 (2 steps), t3 (3 steps), a subagent's turn between them. */
const TURNS = [turn('t1', 1), turn('c1', 4, 'c'), turn('t2', 2), turn('t3', 3)]

const press = (button: Node | undefined) => (button?.props?.onPress as () => void)()

/** The lanes of the steps, whose alt starts `#<index> `. */
const stepLanes = (drawn: unknown) => nodesOf(drawn, 'Svg').filter(svg => /^#\d+ /.test(String(svg.props?.alt)))

/** The step indexes the lanes show, in order. */
const shownSteps = (drawn: unknown) => stepLanes(drawn).map(svg => Number(/^#(\d+)/.exec(String(svg.props?.alt))![1]))

describe('desktop: the timeline page', () => {
  test('follows the latest main turn: 上一轮 alone, no 下一轮 or 最新', () => {
    setLang('zh-CN')

    const picked: (string | undefined)[] = []
    const drawn = drawDesktopPane(EL, paneOf({ page: 'timeline', timeline: TURNS, onTimelineTurn: id => picked.push(id) }))

    expect(stepLanes(drawn), 't3 has 3 steps').toHaveLength(3)
    expect(buttonOf(drawn, '下一轮')).toBeUndefined()
    expect(buttonOf(drawn, '最新')).toBeUndefined()
    press(buttonOf(drawn, '上一轮'))
    expect(picked, 'the subagent turn is skipped').toEqual(['t2'])
    expect(textOf(drawn)).not.toContain('没有主机')
  })

  test('a picked turn: 上一轮 and 下一轮 step over subagent turns, 最新 goes back to following', () => {
    setLang('zh-CN')

    const picked: (string | undefined)[] = []
    const at = (id: string) => drawDesktopPane(EL, paneOf({ page: 'timeline', timeline: TURNS, timelineTurnId: id, onTimelineTurn: one => picked.push(one) }))
    const first = at('t1')

    expect(stepLanes(first)).toHaveLength(1)
    expect(buttonOf(first, '上一轮'), 'no turn before the first').toBeUndefined()
    press(buttonOf(first, '下一轮'))
    press(buttonOf(first, '最新'))

    const middle = at('t2')

    expect(stepLanes(middle)).toHaveLength(2)
    press(buttonOf(middle, '上一轮'))
    press(buttonOf(middle, '下一轮'))
    expect(picked).toEqual(['t2', undefined, 't1', 't3'])
    expect(buttonOf(middle, '最新')?.props).toMatchObject({ variant: 'secondary' })
  })

  test('热点 shows the hotspots of the main turns without the turn buttons; 瀑布 goes back; the current view is primary and pressing it does nothing', () => {
    setLang('zh-CN')

    let toggled = 0
    const single = drawDesktopPane(EL, paneOf({ page: 'timeline', timeline: TURNS, onTimelineView: () => (toggled += 1) }))

    expect(buttonOf(single, '瀑布')?.props).toMatchObject({ variant: 'primary' })
    expect(buttonOf(single, '热点')?.props).toMatchObject({ variant: 'secondary' })
    press(buttonOf(single, '瀑布'))
    press(buttonOf(single, '热点'))

    const hot = drawDesktopPane(EL, paneOf({ page: 'timeline', timeline: TURNS, timelineView: 'hotspots', timelineTurnId: 't2', onTimelineView: () => (toggled += 1) }))

    expect(textOf(hot)).toContain('热点 · 主线程 3轮')
    expect(['上一轮', '下一轮', '最新'].map(label => buttonOf(hot, label))).toEqual([undefined, undefined, undefined])
    expect(buttonOf(hot, '热点')?.props).toMatchObject({ variant: 'primary' })
    expect(buttonOf(hot, '瀑布')?.props).toMatchObject({ variant: 'secondary' })
    expect(buttonOf(hot, '瀑布')?.props?.hotkey).toBeUndefined()
    press(buttonOf(hot, '热点'))
    press(buttonOf(hot, '瀑布'))
    expect(toggled).toBe(2)
  })

  test('打开这一轮 on a slow turn shows that turn as a waterfall', () => {
    setLang('zh-CN')

    const picked: (string | undefined)[] = []
    let toggled = 0
    const ended = TURNS.map(one => ({ ...one, endedAt: NOW, durationMs: 60_000 }))
    const hot = drawDesktopPane(EL, paneOf({ page: 'timeline', timeline: ended, timelineView: 'hotspots', onTimelineTurn: id => picked.push(id), onTimelineView: () => (toggled += 1) }))
    const open = nodesOf(hot, 'Button').filter(one => one.props?.label === '打开这一轮')

    expect(open).toHaveLength(3)
    press(open[0])
    expect(picked).toEqual(['t1'])
    expect(toggled).toBe(1)
  })

  test('every lane of a turn and the axis share one width and one scale; only the labels indent', () => {
    setLang('zh-CN')

    const base = turn('t1', 2)
    const turns: TimelineTurn[] = [
      {
        ...base,
        steps: base.steps.map((one, i) => ({ ...one, toolUseIds: i === 0 ? ['b1', 'ag'] : [] })),
        tools: [
          { toolUseId: 'b1', name: 'Bash', turnId: 't1', endedAt: NOW - 40_000, durationMs: 10_000, outcome: 'error' },
          { toolUseId: 'ag', name: 'Agent', turnId: 't1', requestedAt: NOW - 55_000 },
        ],
        forks: [{ toolUseId: 'ag', childAgentId: 'c', background: true, at: NOW - 55_000, subagentType: 'worker', description: 'Fix X' }],
        compactions: [{ at: NOW - 52_000, trigger: 'auto', tokensBefore: 182_000, tokensAfter: 41_000 }],
      },
    ]

    for (const [columns, width] of [[50, 328], [80, 498], [95, 464], [120, 572]] as const) {
      const drawn = drawDesktopPane(EL, paneOf({ page: 'timeline', timeline: turns, columns, agents: [runAgent({ agentId: 'c' })] }))
      const svgs = nodesOf(drawn, 'Svg')

      expect(svgs.length, `${columns}: the axis, two steps, Bash, the fork, the compaction`).toBe(6)
      expect(new Set(svgs.map(svg => svg.props?.width)), String(columns)).toEqual(new Set([width]))
      expect(new Set(svgs.map(svg => /viewBox="([^"]+)"/.exec(String(svg.props?.source))?.[1])), String(columns)).toEqual(new Set([`0 0 ${width} 12`]))
      // Only labels indent: no Svg sits in a padded Box.
      expect(nodesOf(drawn, 'Box').filter(box => box.props?.paddingLeft !== undefined).flatMap(box => nodesOf(box.children, 'Svg')), String(columns)).toEqual([])
    }
  })

  test('a 23-step turn: the newest 10 steps first, 更早的步 the 10 before, 更新的步 back; the narrow tier pages by 5', () => {
    setLang('zh-CN')

    const long = [turn('t1', 2), turn('t2', 23)]
    const pages: DashTimelinePage[] = []
    const draw = (more: Partial<PaneData>) => drawDesktopPane(EL, paneOf({ page: 'timeline', timeline: long, onTimelinePage: one => pages.push(one), ...more }))
    const newest = draw({})

    expect(shownSteps(newest)).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22])
    expect(textOf(newest)).toContain('第 14–23 步，共 23 步')
    expect(buttonOf(newest, '更新的步'), 'nothing newer than the newest').toBeUndefined()
    press(buttonOf(newest, '更早的步'))
    expect(pages).toEqual([{ turnId: 't2', back: 1 }])

    const earlier = draw({ timelinePage: { turnId: 't2', back: 1 } })

    expect(shownSteps(earlier)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    press(buttonOf(earlier, '更新的步'))
    press(buttonOf(earlier, '更早的步'))
    expect(pages.slice(1)).toEqual([
      { turnId: 't2', back: 0 },
      { turnId: 't2', back: 2 },
    ])

    const oldest = draw({ timelinePage: { turnId: 't2', back: 2 } })

    expect(shownSteps(oldest)).toEqual([0, 1, 2])
    expect(buttonOf(oldest, '更早的步'), 'nothing before the first').toBeUndefined()
    expect(shownSteps(draw({ columns: 50 }))).toEqual([18, 19, 20, 21, 22])
    expect(shownSteps(draw({ columns: 50, timelinePage: { turnId: 't2', back: 1 } }))).toEqual([13, 14, 15, 16, 17])
    expect(buttonOf(draw({ timelineTurnId: 't1' }), '更早的步'), 'two steps fit one page').toBeUndefined()
  })

  test('switching turns shows the other turn from its newest page', () => {
    setLang('zh-CN')

    const long = [turn('t1', 23), turn('t2', 23)]
    const draw = (more: Partial<PaneData>) => drawDesktopPane(EL, paneOf({ page: 'timeline', timeline: long, timelinePage: { turnId: 't1', back: 1 }, ...more }))

    expect(shownSteps(draw({ timelineTurnId: 't1' })), 'the page picked on t1').toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(shownSteps(draw({ timelineTurnId: 't2' }))).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22])
    expect(shownSteps(draw({})), 'following the latest, t2').toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22])
  })

  test('no turn yet: the empty line and no buttons', () => {
    setLang('zh-CN')

    for (const timeline of [undefined, [], [turn('c1', 1, 'c')]]) {
      const drawn = drawDesktopPane(EL, paneOf({ page: 'timeline', ...(timeline !== undefined && { timeline }) }))

      expect(textOf(drawn)).toContain('从本次加载起记录；还没有模型请求')
      expect(['上一轮', '下一轮', '最新'].map(label => buttonOf(drawn, label))).toEqual([undefined, undefined, undefined])
    }
  })
})

const GATE_FAILED: GateRun = { at: NOW - 60_000, command: 'bun test', where: 'main', pass: 3, fail: 2, failures: [] }

const SNAP_ONE: MmSnapshot = {
  polledAt: NOW,
  runs: [
    {
      runid: 'r1',
      tag: 'design',
      workdir: '/work',
      mode: 'review',
      createdAt: NOW - 400_000,
      models: [
        { name: 'codex', status: 'RUNNING', startedAt: NOW - 200_000 },
        { name: 'grok', status: 'DONE', startedAt: NOW - 400_000, endedAt: NOW - 10_000, secs: 300 },
      ],
    },
  ],
}

const roundCards = (drawn: unknown) => nodesOf(drawn, 'Box').filter(box => box.props?.borderStyle === 'round')

describe('desktop: the overview count card', () => {
  test('the first card is one line of bold chips: needs you, running, unread, aborted; failed gates count in needs you', () => {
    setLang('zh-CN')

    const agents = [
      runAgent({ agentId: 'a1' }),
      runAgent({ agentId: 'a3', state: 'error', ...ENDED }),
      runAgent({ agentId: 'a4', state: 'done', answer: 'ok', ...ENDED }),
      runAgent({ agentId: 'a5', state: 'aborted', ...ENDED }),
    ]
    const drawn = drawDesktopPane(EL, paneOf({ agents, snap: SNAP_ONE, gates: [GATE_FAILED] }))
    const countRow = nodesOf(drawn, 'Box').find(box => box.props?.columnGap === 1 && box.props?.flexWrap === 'wrap')
    const chips = nodesOf(countRow, 'Text').filter(one => one.props?.bold === true)

    expect(chips.map(one => [textOf(one), one.props?.color])).toEqual([
      [' ! 需要你 2 ', 'warning'],
      [' ● 运行 2 ', 'permission'],
      [' 待读2 ', 'inactive'],
      [' ⊘ 已中止 1 ', 'warning'],
    ])
  })

  test('no aborted agent and no failed gate: those two chips are left out', () => {
    setLang('zh-CN')

    const drawn = drawDesktopPane(EL, paneOf({ agents: [runAgent({})] }))
    const countRow = nodesOf(drawn, 'Box').find(box => box.props?.columnGap === 1 && box.props?.flexWrap === 'wrap')
    const text = textOf(countRow)

    expect(text).toContain('● 运行 1')
    expect(text).not.toContain('已中止')
    expect(text).not.toContain('门禁')
  })

  test('all zero: no count card, the idle line stays', () => {
    setLang('zh-CN')

    const text = textOf(drawDesktopPane(EL, paneOf({})))

    expect(text).not.toContain('需要你 ')
    expect(text).not.toContain('待读')
    expect(text).toContain('没有需要你处理或运行中的任务')
  })
})

const HEREDOC = "python3 - <<'EOF'\np = 'hooks/register.tsx'\nEOF"
const LONG_CD = `cd /${'p'.repeat(119)} && bun test`
const ASSIGNS = 'S=/a/b; W=/c/d; bun test'

/** A failed run of `raw`, recorded as noteGate records it: the folded command cut to 120, the raw one as its key. */
const gateOf = (raw: string, over: Partial<GateRun> = {}): GateRun => ({ ...GATE_FAILED, command: raw.replace(/\s+/g, ' ').slice(0, 120), key: raw, ...over })

const wtree = (name: string, over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({ name, path: `/r/.claude/worktrees/${name}`, branch: `worktree-${name}`, dirty: 2, ahead: 1, behind: 0, merged: false, running: false, error: null, ...over })

/** Every section full past its cap, its titles and commands long. */
const BUSY: Partial<PaneData> = {
  agents: [
    ...[1, 2, 3, 4].map(n => runAgent({ agentId: `e${n}`, state: 'error', description: `Fix the overview layout so long titles never wrap ${n}`, ...ENDED })),
    ...[1, 2, 3, 4].map(n => runAgent({ agentId: `r${n}`, description: `Audit the public export for leaks in every plugin ${n}` })),
  ],
  snap: SNAP_ONE,
  gates: [gateOf(HEREDOC, { where: 'agent-0f3c9a1b2d4e5f60' }), gateOf(LONG_CD, { at: NOW - 30_000 }), gateOf(ASSIGNS, { at: NOW - 20_000, where: 'agent-0f3c9a1b2d4e5f60' }), gateOf('bun test', { fail: 0 })],
  trees: [1, 2, 3, 4].map(n => wtree(n === 1 ? 'agent-0f3c9a1b2d4e5f60' : `agent-${'x'.repeat(60)}${n}`, { branch: `worktree-agent-${'y'.repeat(70)}` })),
  guards: [1, 2, 3, 4].map(n => ({ at: NOW - n * 60_000, guard: 'shared-tree-git', decision: 'deny' as const, op: `git checkout ${'z'.repeat(90)}`, cwd: '/r', agentId: null })),
  peers: [1, 2, 3, 4].map(n => ({ id: `p${n}`, name: `harness-${n}`, title: 'a title long enough to fill the row past its edge', state: 'permission' as const, since: NOW - 65_000, updatedAt: NOW })),
}

/** Each Text not inside another Text, with whether it is an item's title line, a Button on its right. */
function lineTexts(node: unknown, isTitle = false, out: { text: string; isTitle: boolean }[] = []) {
  if (Array.isArray(node)) {
    node.forEach(one => lineTexts(one, isTitle, out))
  } else if (node !== null && typeof node === 'object') {
    const el = node as Node

    if (el.type === 'Text') {
      out.push({ text: textOf(el), isTitle })
    } else {
      lineTexts(el.children ?? [], isTitle || el.props?.minWidth === 0, out)
    }
  }

  return out
}

describe('desktop: the overview items', () => {
  test('every overview section but the counts row sits in its own bordered frame, on every tier', () => {
    setLang('zh-CN')

    for (const columns of [50, 80, 120]) {
      const drawn = drawDesktopPane(EL, paneOf({ ...BUSY, columns }))
      const frames = nodesOf(drawn, 'Box').filter(box => box.props?.borderStyle === 'round' && box.props?.borderColor === 'promptBorder')
      const headers = ['需要你', '运行中', '最近门禁', '工作树'].filter(title => nodesOf(drawn, 'Text').some(one => textOf(one) === title))

      expect(headers.length, `${columns}: the fixture draws these sections`).toBe(4)
      for (const title of headers) {
        expect(frames.filter(frame => nodesOf(frame.children, 'Text').some(one => textOf(one) === title)).length, `${columns}: ${title} framed once`).toBe(1)
      }
      expect(frames.some(frame => nodesOf(frame.children, 'Text').some(one => textOf(one).includes('! 需要你'))), `${columns}: the counts row is not framed`).toBe(false)
    }
  })

  test("missing-page-navigation: an overview item's button opens it through onOpenItem, which moves to its page", () => {
    const opened: string[] = []
    const drawn = drawDesktopPane(EL, paneOf({ ...BUSY, onOpenItem: item => opened.push(item.kind === 'agent' ? item.run.agentId : item.run.runid) }))
    const buttons = nodesOf(drawn, 'Button').filter(one => one.props?.label === '打开' || one.props?.label === '阅读')

    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      ;(button.props?.onPress as () => void)()
    }
    expect(opened.length).toBe(buttons.length)
  })

  test("a heredoc gate's title carries its body's first line, so two heredocs read apart", () => {
    expect(commandHead("python3 - <<'EOF'\n\np = 'hooks/register.tsx'\nEOF")).toBe("python3 - <<'EOF' p = 'hooks/register.tsx'")
    expect(commandHead('cd /x && cat <<EOF\nhello\nEOF')).toBe('cat <<EOF hello')
    expect(commandHead('cd /x && bun test')).toBe('bun test')
  })

  test('no line is longer than its budget: columns - 12 beside a Button, columns - 2 otherwise', () => {
    setLang('zh-CN')

    const expanded = new Set(['needsYou', 'sessions', 'running', 'gates', 'trees', 'guards'].map(section => `more:${section}`))

    for (const columns of [50, 80, 120]) {
      for (const disclosures of [new Set<string>(), expanded]) {
        const drawn = drawDesktopPane(EL, paneOf({ ...BUSY, columns, disclosures }))
        const over = lineTexts(drawn).filter(one => widthOf(one.text) > columns - (one.isTitle ? 12 : 2))

        expect(over.map(one => `${columns}: ${one.text}`)).toEqual([])
      }

      expect(lineTexts(drawDesktopPane(EL, paneOf({ ...BUSY, columns, disclosures: expanded }))).some(one => one.text.includes("python3 - <<'EOF'")), `${columns}: the heredoc's head is drawn`).toBe(true)
    }
  })

  test('a gate is titled by its command head; 命令 shows the whole command in a Code', () => {
    setLang('zh-CN')

    const toggled: string[] = []
    const gates = [gateOf(HEREDOC, { where: 'agent-wt' }), gateOf('cd /x && bun test', { at: NOW - 30_000 })]
    const closed = drawDesktopPane(EL, paneOf({ gates, trees: null, onToggleDisclosure: key => toggled.push(key) }))
    const texts = nodesOf(closed, 'Text').map(textOf)

    expect(texts).toContain('bun test')
    expect(texts).toContain("python3 - <<'EOF' p = 'hooks/register.tsx'")
    expect(texts.filter(text => text.includes('cd /x') || text.includes('\nEOF'))).toEqual([])
    expect(nodesOf(closed, 'Code')).toEqual([])

    for (const button of nodesOf(closed, 'Button').filter(one => one.props?.label === '命令')) {
      press(button)
    }

    expect(toggled.length, 'each gate in 需要你 and 最近门禁 has its own').toBe(4)

    const open = drawDesktopPane(EL, paneOf({ gates, trees: null, disclosures: new Set(toggled) }))

    expect(nodesOf(open, 'Code').map(one => one.props?.source), '需要你 oldest first, 最近门禁 newest first').toEqual([HEREDOC, 'cd /x && bun test', 'cd /x && bun test', HEREDOC])
    expect(nodesOf(open, 'Button').filter(one => one.props?.label === '收起')).toHaveLength(4)
  })

  test('a section over 3 items shows 3 and 另有 N 项; pressed, all of them and 收起', () => {
    setLang('zh-CN')

    const toggled: string[] = []
    const agents = [1, 2, 3, 4, 5, 6].map(n => runAgent({ agentId: `e${n}`, state: 'error', description: `Task ${n}`, ...ENDED }))
    const titles = (drawn: unknown) => nodesOf(drawn, 'Text').map(textOf).filter(text => /^worker · Task \d$/.test(text))
    const closed = drawDesktopPane(EL, paneOf({ agents, onToggleDisclosure: key => toggled.push(key) }))

    expect(titles(closed)).toHaveLength(3)
    expect(buttonOf(closed, '收起')).toBeUndefined()
    press(buttonOf(closed, '另有 3 项'))
    expect(toggled).toEqual(['more:needsYou'])

    const open = drawDesktopPane(EL, paneOf({ agents, disclosures: new Set(toggled) }))

    expect(titles(open)).toHaveLength(6)
    expect(buttonOf(open, '另有 3 项')).toBeUndefined()
    expect(buttonOf(open, '收起')?.props).toMatchObject({ variant: 'secondary' })
  })

  test('a failed gate in a worktree no longer listed needs nobody; before the first collection it does', () => {
    setLang('zh-CN')

    const gates = [gateOf('bun test', { where: 'agent-gone' })]
    const needsYou = (trees: WorktreeInfo[] | null) => textOf(drawDesktopPane(EL, paneOf({ gates, trees })))

    expect(needsYou([wtree('agent-a')])).not.toContain('需要你  1')
    expect(needsYou(null)).toContain('需要你  1')
    expect(needsYou([wtree('agent-gone')])).toContain('需要你  1')
    expect(textOf(drawDesktopPane(EL, paneOf({ gates: [gateOf('bun test')], trees: [] }))), 'the main tree is always there').toContain('需要你  1')
  })

  test('ages drop their seconds past a minute', () => {
    setLang('zh-CN')

    const gates = [gateOf('bun test a', { at: NOW - 7_510_000 }), gateOf('bun test b', { at: NOW - 1_653_000 }), gateOf('bun test c', { at: NOW - 33_000 })]
    const metas = nodesOf(drawDesktopPane(EL, paneOf({ gates })), 'Text').filter(one => one.props?.color === 'subtle').map(textOf)

    expect(metas).toContain('主树 · 2 fail · 33s前')
    expect(metas).toContain('主树 · 2 fail · 27m前')
    expect(metas).toContain('主树 · 2 fail · 2h05m前')
    expect(metas.filter(text => text.includes('27m33s'))).toEqual([])
  })
})

describe('desktop: the Agents page is one card per agent', () => {
  const AGENTS = [
    runAgent({ agentId: 'a1' }),
    runAgent({ agentId: 'a2', state: 'error', denied: 2, ...ENDED }),
    runAgent({ agentId: 'a3', state: 'done', answer: 'all done', description: 'Write the docs', ...ENDED }),
    runAgent({ agentId: 'a4', state: 'aborted', startedAt: NOW - 2_400_000, endedAt: NOW - 5_000, durationMs: 2_395_000 }),
  ]

  test('one card per agent; per agent a status, the title, a bar on one shared scale and the time; 阅读 on ended rows', () => {
    setLang('zh-CN')

    const read: string[] = []
    const drawn = drawDesktopPane(EL, paneOf({ page: 'agents', agents: AGENTS, onReadAgent: id => read.push(id) }))
    const cards = roundCards(drawn)
    const svgs = nodesOf(drawn, 'Svg')
    const scales = svgs.map(svg => String(svg.props?.alt).replace(/^.*共同刻度\s*/, '共同刻度 '))

    expect(cards, 'one card per agent').toHaveLength(4)
    expect(svgs).toHaveLength(4)
    expect(scales).toEqual(['共同刻度 0—60 min', '共同刻度 0—60 min', '共同刻度 0—60 min', '共同刻度 0—60 min'])
    expect(svgs.every(svg => svg.props?.isInteractive === undefined)).toBe(true)

    const reads = nodesOf(drawn, 'Button').filter(one => one.props?.label === '阅读')

    expect(reads, 'the three ended agents').toHaveLength(3)
    expect(reads.every(one => one.props?.variant === 'secondary')).toBe(true)
    press(reads[0])
    expect(read, 'newest first').toEqual(['a4'])
    const openBtn = nodesOf(drawn, 'Button').find(one => one.props?.label === '打开')
    expect(openBtn?.props?.variant).toBe('secondary')
  })

  test('a done row metadata is subtle; a denied row keeps its ✗ 被拒 chip', () => {
    setLang('zh-CN')

    const drawn = drawDesktopPane(EL, paneOf({ page: 'agents', agents: AGENTS }))
    const titles = nodesOf(drawn, 'Text').filter(one => one.props?.wrap === 'wrap' && one.props?.bold === true)

    expect(titles.map(textOf)).toContain('Write the docs')
    const metas = nodesOf(drawn, 'Text').filter(one => one.props?.color === 'subtle').map(textOf)
    expect(metas.some(one => /opus-5-5 · \d+ tools$/.test(one))).toBe(true)
    expect(nodesOf(drawn, 'Text').find(one => textOf(one) === '✗ 被拒2')?.props).toMatchObject({ color: 'error', bold: true })
  })

  test('narrow: duration bar uses narrow width', () => {
    setLang('zh-CN')

    const svgWidth = (columns: number) =>
      nodesOf(drawDesktopPane(EL, paneOf({ page: 'agents', agents: AGENTS, columns })), 'Svg').map(svg => svg.props?.width)

    expect(svgWidth(80)).toEqual([360, 360, 360, 360])
    expect(svgWidth(40)).toEqual([224, 224, 224, 224])
  })

  test('ended and read before this visit fold into one ✓N 已完成 button; failures stay; open, the folded rows come back', () => {
    setLang('zh-CN')

    let toggles = 0
    const data = { page: 'agents' as const, agents: AGENTS, agentsSeenBefore: NOW, onToggleFold: () => (toggles += 1) }
    const closed = drawDesktopPane(EL, paneOf(data))
    const titles = (drawn: unknown) => nodesOf(drawn, 'Text').filter(one => one.props?.wrap === 'wrap' && one.props?.bold === true).map(textOf)

    expect(titles(closed)).toEqual(['Build mm plugin', 'Build mm plugin'])
    expect(buttonOf(closed, '✓1 已完成 · ⊘1 已中止')?.props).toMatchObject({ variant: 'secondary' })
    expect(buttonOf(closed, '✓1 已完成 · ⊘1 已中止')?.props?.hotkey).toBeUndefined()
    press(buttonOf(closed, '✓1 已完成 · ⊘1 已中止'))
    expect(toggles).toBe(1)
    expect(titles(drawDesktopPane(EL, paneOf({ ...data, isFoldOpen: true }))).some(one => one.startsWith('Write the docs'))).toBe(true)
    expect(nodesOf(closed, 'Svg'), 'the folded rows draw no bar').toHaveLength(2)
  })

  test('a running row: 打开, its call in flight in the meta; an ended one its tokens; the detail its usage, task, calls and text, or 读不到', () => {
    setLang('zh-CN')

    const usage = { input: 2_000, output: 9_400, cacheRead: 165_000, cacheWrite: 15_000, model: 'claude-opus-5-5' }
    const agents = [runAgent({ agentId: 'a1' }), runAgent({ agentId: 'a3', state: 'done', answer: 'all done', usage, ...ENDED })]
    const opened: string[] = []
    const flights = new Map([['a1', { name: 'Bash', requestedAt: NOW - 180_000 }]])
    const page = drawDesktopPane(EL, paneOf({ page: 'agents', agents, flights, onReadAgent: id => opened.push(id) }))
    const metas = nodesOf(page, 'Text').filter(one => one.props?.color === 'subtle').map(textOf)

    expect(metas).toContain('worker · opus-5-5 · 4 tools · Bash 3m…')
    expect(metas).toContain('worker · opus-5-5 · 4 tools · 191k tokens')
    press(buttonOf(page, '打开'))
    expect(opened).toEqual(['a1'])

    const peek = { agentId: 'a1', activityAt: NOW - 1_000, task: 'Fix the band', calls: ['Read board.ts', 'Bash bun test'], text: 'Found it.' }
    const running = textOf(drawDesktopPane(EL, paneOf({ page: 'agents', agents, detail: { page: 'agents', agentId: 'a1' }, peek })))

    expect(running).toContain('仍在运行')
    expect(running).toContain('任务')
    expect(running).toContain('Fix the band')
    expect(running).toContain('最近调用')
    expect(running).toContain('Read board.ts  Bash bun test')
    expect(running).toContain('最新')
    expect(running).toContain('Found it.')

    const failed = drawDesktopPane(EL, paneOf({ page: 'agents', agents, detail: { page: 'agents', agentId: 'a1' }, peek: { ...peek, task: '', calls: [], text: '', failed: true } }))

    expect(nodesOf(failed, 'Text').find(one => textOf(one) === '读不到它的运行记录')?.props).toMatchObject({ color: 'warning' })
    expect(textOf(drawDesktopPane(EL, paneOf({ page: 'agents', agents, detail: { page: 'agents', agentId: 'a3' }, peek })))).toContain('in 182k · 缓存读 91% · out 9.4k')
  })

  test('status row never shares a row with a narrow column: status is its own vertical row under task', () => {
    setLang('zh-CN')

    const drawn = drawDesktopPane(EL, paneOf({ page: 'agents', agents: AGENTS }))
    const cards = roundCards(drawn)

    expect(cards).toHaveLength(4)
    for (const c of cards) {
      const children = kids(c)
      expect(children[0]?.type).toBe('Text')
      expect(children[1]?.type).toBe('Box')
      expect(children[1]?.props?.flexDirection).toBe('row')
      const statusText = textOf(children[1])
      expect(/运行|已返回|已中止|出错/.test(statusText)).toBe(true)
    }
  })

  test('the copy disclosure reveals quoted text for worktrees and resume', () => {
    setLang('zh-CN')

    const wt = {
      name: 'wt',
      path: '/path/with spaces/wt',
      branch: 'feat',
      dirty: 0,
      ahead: 0,
      behind: 0,
      merged: false,
      running: false,
      error: null,
    }
    let toggledKey = ''
    const onToggle = (key: string) => {
      toggledKey = key
    }

    const closed = drawDesktopPane(
      EL,
      paneOf({
        trees: [wt],
        disclosures: new Set<string>(),
        onToggleDisclosure: onToggle,
      }),
    )
    expect(nodesOf(closed, 'Code').map(c => c.props?.source)).not.toContain("cd '/path/with spaces/wt'")
    const showBtn = buttonOf(closed, '命令')
    expect(showBtn).toBeDefined()
    press(showBtn)
    expect(toggledKey).toBe('tree:/path/with spaces/wt')

    const open = drawDesktopPane(
      EL,
      paneOf({
        trees: [wt],
        disclosures: new Set(['tree:/path/with spaces/wt']),
        onToggleDisclosure: onToggle,
      }),
    )
    expect(nodesOf(open, 'Code').map(c => c.props?.source)).toContain("cd '/path/with spaces/wt'")
    expect(buttonOf(open, '收起')).toBeDefined()
  })

  test('the GPU empty-page connect calls the same path as /gpu', () => {
    setLang('zh-CN')

    let connectedHost = ''
    const onConnect = (host: string) => {
      connectedHost = host
    }

    const drawn = drawDesktopPane(
      EL,
      paneOf({
        page: 'gpu',
        gpu: null,
        gpuHosts: ['gpu-box-1', 'gpu-box-2'],
        onConnectGpu: onConnect,
      }),
    )

    const select = nodesOf(drawn, 'Select')[0]
    expect(select?.props?.options).toEqual([
      { value: 'gpu-box-1', label: 'gpu-box-1' },
      { value: 'gpu-box-2', label: 'gpu-box-2' },
    ])
    const onSelect = select?.props?.onSelect as ((val: string) => void) | undefined
    onSelect?.('gpu-box-1')
    expect(connectedHost).toBe('gpu-box-1')

    const input = nodesOf(drawn, 'Input')[0]
    const onSubmit = input?.props?.onSubmit as ((val: string) => void) | undefined
    onSubmit?.('custom-gpu')
    expect(connectedHost).toBe('custom-gpu')
  })

  test('the shared scale caption appears once above the list', () => {
    setLang('zh-CN')

    const agentsPage = drawDesktopPane(EL, paneOf({ page: 'agents', agents: AGENTS }))
    const agentsCaptions = nodesOf(agentsPage, 'Text').filter(t => textOf(t).includes('共同刻度'))
    expect(agentsCaptions).toHaveLength(1)
    expect(textOf(agentsCaptions[0])).toContain('共同刻度')

    const mmrunPage = drawDesktopPane(EL, paneOf({ page: 'mmrun', snap: SNAP_ONE }))
    const mmrunCaptions = nodesOf(mmrunPage, 'Text').filter(t => textOf(t).includes('共同刻度'))
    expect(mmrunCaptions).toHaveLength(1)
    expect(textOf(mmrunCaptions[0])).toContain('共同刻度')
  })
})

/** A review whose findings are `[severity, claim]`, each in src/<claim>.ts at its 1-based place. */
const reviewJson = (summary: string, claims: [string, string][]) => ({
  verdict: 'needs_changes',
  summary,
  findings: claims.map(([severity, claim], i) => ({ severity, file: `src/${claim}.ts`, line: i + 1, claim, quote: `quote ${claim}`, failure_scenario: `fails ${claim}`, basis: 'read', suggestion: `fix ${claim}` })),
  not_expanded: 1,
  not_checked: ['tests/'],
})

describe('desktop: the report reader', () => {
  test('the model Select shows that model and resets the index; the severity Select changes N; Next stops at the last', { options: { language: 'en' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R1}/codex.json`] = { text: JSON.stringify(reviewJson('CODEX-SUMMARY', [['critical', 'C1'], ['minor', 'C3'], ['major', 'C2']])) }
    files[`${R1}/grok.json`] = { text: JSON.stringify(reviewJson('GROK-SUMMARY', [['major', 'G1']])) }
    seat(on, files)
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const pane = (await $.ui.mount({ plugin: PLUGIN, ...PANE, surface: 'desktop' } as never)) as Mounted<'desktop'>
    const has = async (text: string) => (await pane.find({ type: 'Text', text })) !== undefined

    await pane.press({ key: `read-run-${R1}` })
    expect(await pane.find({ type: 'Markdown', text: /CODEX-SUMMARY/ })).toBeDefined()
    expect(await has('C1')).toBe(true)
    expect(JSON.stringify(await pane.drawn())).toContain('src/C1.ts:1')
    expect(await has('Finding 1 / 2')).toBe(true)
    expect((await pane.find({ key: 'dash-severity' }))?.props).toMatchObject({ value: 'major' })

    await pane.press({ key: 'dash-next-finding' })
    expect(await has('C2')).toBe(true)
    expect(await has('Finding 2 / 2')).toBe(true)
    expect(await pane.find({ key: 'dash-next-finding' }), 'no Next on the last').toBeUndefined()

    await pane.select({ key: 'dash-model', value: 'grok' })
    expect(await pane.find({ type: 'Markdown', text: /GROK-SUMMARY/ })).toBeDefined()
    expect(await pane.find({ type: 'Markdown', text: /CODEX-SUMMARY/ })).toBeUndefined()
    expect(await has('Finding 1 / 1')).toBe(true)

    await pane.select({ key: 'dash-model', value: 'codex' })
    expect(await has('Finding 1 / 2'), 'the index starts over').toBe(true)

    await pane.select({ key: 'dash-severity', value: 'all' })
    expect(await has('Finding 1 / 3')).toBe(true)
    await pane.press({ key: 'dash-next-finding' })
    await pane.press({ key: 'dash-next-finding' })
    expect(await has('C3')).toBe(true)
    expect(await has('Finding 3 / 3')).toBe(true)
    expect(await pane.find({ key: 'dash-next-finding' })).toBeUndefined()

    await pane.select({ key: 'dash-severity', value: 'major' })
    expect(await has('Finding 1 / 2')).toBe(true)
    expect(await has('C1')).toBe(true)
    await pane.unmount()
  })

  test('no Markdown or Code leaf over 8000 characters for a 40-finding review, at any finding', () => {
    setLang('en')

    const out = '/h/.claude/mmruns/r1/grok.out'
    const json = {
      verdict: 'needs_changes',
      summary: 'summary '.repeat(1_500),
      findings: Array.from({ length: 40 }, (_, i) => ({
        severity: ['critical', 'major', 'minor', 'optional'][i % 4],
        file: `src/f${i}.ts`,
        line: i + 1,
        claim: `claim ${i}`,
        quote: `const x${i} = y\n`.repeat(700),
        failure_scenario: `breaks when ${i} `.repeat(700),
        basis: 'read',
        suggestion: `guard ${i} `.repeat(700),
      })),
      not_expanded: 3,
      not_checked: Array.from({ length: 900 }, (_, i) => `dir${i}/`),
    }
    const review = reviewOf(json, 'review', out) ?? undefined
    const reports = { r1: { loadedAt: NOW, models: [{ name: 'grok', status: 'DONE', markdown: reportOf(json, '', 'review', true, out), ...(review !== undefined && { review }) }] } }
    const leaves: string[] = []

    expect(review?.findings).toHaveLength(40)

    for (let finding = 0; finding < 40; finding += 1) {
      const drawn = drawDesktopPane(EL, paneOf({ page: 'mmrun', snap: SNAP_ONE, reports, detail: { page: 'mmrun', runid: 'r1', showAll: true, model: 'grok', finding } }))

      leaves.push(...nodesOf(drawn, 'Markdown').map(one => String(one.props?.text)), ...nodesOf(drawn, 'Code').map(one => String(one.props?.source)))
    }

    expect(leaves.filter(leaf => leaf.length > 8000).map(leaf => leaf.length)).toEqual([])
    expect(leaves.some(leaf => leaf.endsWith(`…(truncated, full text in ${out})`))).toBe(true)
  })

  test('narrow: the two Selects stack; standard: side by side', () => {
    setLang('en')

    const json = reviewJson('S', [['major', 'C1']])
    const review = reviewOf(json, 'review', '/x.out') ?? undefined
    const reports = { r1: { loadedAt: NOW, models: [{ name: 'grok', status: 'DONE', markdown: '', ...(review !== undefined && { review }) }] } }
    const selectRow = (columns: number) =>
      nodesOf(drawDesktopPane(EL, paneOf({ page: 'mmrun', snap: SNAP_ONE, reports, columns, detail: { page: 'mmrun', runid: 'r1', showAll: false } })), 'Box').find(box =>
        kids(box).filter(one => one.type === 'Select').length === 2,
      )

    expect(selectRow(40)?.props?.flexDirection).toBe('column')
    expect(selectRow(80)?.props?.flexDirection).toBe('row')
  })
})
