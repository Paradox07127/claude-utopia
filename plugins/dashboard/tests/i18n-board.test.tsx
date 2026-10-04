import { describe, expect, test } from 'claude-code/testing'

import type { AgentRun, DashSeen, GateRun, GpuWatch, MmSnapshot, SessionPresence, WorktreeInfo } from '../types'
import { bandLines, boardOf, endedText, idleLine, overviewOf, peerToasts, pendingLine, runningLine, sessionLine } from '../hooks/board'
import { drawDesktopBand, drawDesktopPane } from '../hooks/desktop'
import type { PaneData } from '../hooks/desktop'
import { setLang, t } from '../hooks/i18n'
import type { Lang } from '../hooks/i18n'

const HAN = /\p{Script=Han}/u
const NOW = 1_790_922_800_000
const RUNID = '20261002-010000-aaaa'
// Host types, so a drawn tree is plain data to walk.
const EL = { Box: 'Box', Text: 'Text', Button: 'Button', Svg: 'Svg', Markdown: 'Markdown', Code: 'Code', Input: 'Input', Select: 'Select' } as never
const noop = () => {}

const agent = (over: Partial<AgentRun>): AgentRun => ({
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

const ENDED = { endedAt: NOW - 5_000, durationMs: 295_000 }
const AGENTS = [
  agent({ agentId: 'a1' }),
  agent({ agentId: 'a2', lastActivityAt: NOW - 180_000 }),
  agent({ agentId: 'a3', state: 'error', denied: 2, ...ENDED }),
  agent({ agentId: 'a4', state: 'done', outputTokens: 12_000, answer: 'all done', ...ENDED }),
  agent({ agentId: 'a5', state: 'aborted', ...ENDED }),
  agent({ agentId: 'a6', state: 'refusal', ...ENDED }),
]

const SNAP: MmSnapshot = {
  polledAt: NOW,
  runs: [
    {
      runid: RUNID,
      tag: 'design',
      workdir: '/work',
      mode: 'review',
      createdAt: NOW - 400_000,
      models: [
        { name: 'codex', status: 'RUNNING', startedAt: NOW - 200_000 },
        { name: 'grok', status: 'DONE', startedAt: NOW - 400_000, endedAt: NOW - 10_000, secs: 300, outputTokens: 25_835 },
        { name: 'agy', status: 'FAIL:1', startedAt: NOW - 400_000, endedAt: NOW - 10_000 },
        { name: 'kimi', status: 'STALE', startedAt: 0, endedAt: NOW - 10_000 },
      ],
    },
  ],
}

const SEEN: DashSeen = { agents: 0, runs: 0 }

const GATES: GateRun[] = [
  { at: NOW - 60_000, command: 'bun test', where: 'main', pass: 3, fail: 2, failures: [] },
  { at: NOW - 30_000, command: 'bun test x', where: 'agent-b', pass: 5, fail: 0, failures: [] },
]

const tree = (name: string, over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({ name, path: `/r/.claude/worktrees/${name}`, branch: 'b', dirty: 0, ahead: 0, behind: 0, merged: false, running: false, error: null, ...over })
const TREES = [
  tree('agent-a', { dirty: 3, ahead: 2, behind: 1 }),
  tree('agent-b', { merged: true }),
  tree('agent-c', { running: true }),
  tree('agent-d', { error: 'fatal: nope' }),
  tree('agent-e'),
  tree('agent-f'),
  tree('agent-g'),
]

const peer = (id: string, state: SessionPresence['state'], over: Partial<SessionPresence> = {}): SessionPresence => ({ id, name: id, title: 'fix the band', state, since: NOW - 185_000, updatedAt: NOW, ...over })
const PEERS = [peer('mm', 'permission', { detail: 'Bash' }), peer('ui', 'replied', { since: NOW - 60_000, turnStartedAt: NOW - 780_000, detail: 'all green' }), peer('web', 'working'), peer('api', 'failed')]

const nvidia = (error: string | null): GpuWatch => ({
  host: 'lab-box',
  okAt: NOW - 5_000,
  error,
  sample: {
    kind: 'nvidia',
    gpus: [
      { index: 0, name: 'NVIDIA GeForce RTX 4090', util: 52, memUsed: 18_636, memTotal: 24_564, temp: 67, power: 280 },
      { index: 1, name: 'NVIDIA A100', util: null, memUsed: null, memTotal: null, temp: null, power: null },
    ],
    procs: [{ pid: 4242, name: '/usr/bin/python3', memMiB: 10_240 }],
  },
})

const GPUS: (GpuWatch | null)[] = [
  null,
  { host: 'lab-box', sample: null, okAt: null, error: 'ssh: connect failed' },
  { host: 'lab-box', sample: null, okAt: null, error: null },
  { host: 'lab-box', sample: { kind: 'none' }, okAt: NOW - 5_000, error: null },
  { host: 'jetson', sample: { kind: 'tegra', util: 30, ramUsed: 2048, ramTotal: 8192, temp: 45.5 }, okAt: NOW - 5_000, error: null },
  nvidia(null),
  nvidia('timeout'),
]

const PAGES = [
  { page: 'overview', label: 'Overview' },
  { page: 'agents', label: 'Agents' },
  { page: 'mmrun', label: 'Reviews' },
  { page: 'gpu', label: 'GPU' },
] as const

const pane = (over: Partial<PaneData>): PaneData => ({
  page: 'overview',
  pages: PAGES,
  now: NOW,
  columns: 80,
  agents: AGENTS,
  snap: SNAP,
  seen: SEEN,
  gpu: null,
  gates: GATES,
  trees: TREES,
  guards: [],
  peers: PEERS,
  paneRuns: 5,
  detail: null,
  reports: { [RUNID]: { loadedAt: NOW, models: [{ name: 'grok', status: 'DONE', markdown: '**approve**' }] } },
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

/** Every string in a drawn tree or a value, Svg sources aside. */
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

/** Everything desktop.tsx draws and every line board.ts hands to the band, the overview and toasts, in one language. */
function drawn(lang: Lang): string[] {
  setLang(lang)

  const cold = { idleMs: 4_320_000, tokens: 182_000 }
  const board = boardOf(AGENTS, SNAP, SEEN, NOW, GATES, PEERS, cold)
  const view = overviewOf(AGENTS, SNAP, SEEN, NOW, PEERS)
  const items = [...view.pending, ...view.running, ...view.recent]
  const idle = { agents: [agent({ agentId: 'a4', state: 'done', answer: 'all done', ...ENDED })], snap: null, seen: { agents: NOW, runs: NOW }, peers: [], gates: [] }

  return stringsOf([
    drawDesktopBand(EL, [idleLine(undefined, undefined, NOW)], noop),
    drawDesktopBand(EL, [idleLine(view.recent[0], GATES[1], NOW)], noop),
    ...[1, 2, 3, 5].map(rows => drawDesktopBand(EL, bandLines(board, rows, 100), noop)),
    drawDesktopBand(EL, bandLines(board, 2, 10), noop),
    drawDesktopBand(EL, bandLines(boardOf([AGENTS[2]!], null, SEEN, NOW, GATES, [], cold), 5, 100), noop),
    drawDesktopPane(EL, pane({})),
    drawDesktopPane(EL, pane({ ...idle, trees: null })),
    drawDesktopPane(EL, pane({ ...idle, trees: [] })),
    drawDesktopPane(EL, pane({ page: 'agents' })),
    drawDesktopPane(EL, pane({ page: 'agents', agents: [] })),
    drawDesktopPane(EL, pane({ page: 'mmrun' })),
    drawDesktopPane(EL, pane({ page: 'mmrun', snap: null })),
    drawDesktopPane(EL, pane({ page: 'mmrun', snap: { polledAt: NOW, runs: [] } })),
    ...GPUS.map(gpu => drawDesktopPane(EL, pane({ page: 'gpu', gpu, columns: 40 }))),
    drawDesktopPane(EL, pane({ page: 'agents', detail: { page: 'agents', agentId: 'a1' } })),
    drawDesktopPane(EL, pane({ page: 'agents', detail: { page: 'agents', agentId: 'a4' } })),
    drawDesktopPane(EL, pane({ page: 'mmrun', detail: { page: 'mmrun', runid: RUNID, showAll: false } })),
    drawDesktopPane(EL, pane({ page: 'mmrun', detail: { page: 'mmrun', runid: RUNID, showAll: true } })),
    ...items.map(item => [pendingLine(item, NOW, NOW), runningLine(item, NOW, NOW, 80), endedText(item, NOW)]),
    ...view.sessions.map(one => sessionLine(one, NOW, 80)),
    // Each session seen before in another state: every one of them toasts.
    peerToasts([], PEERS.map(one => ({ ...one, since: 0 })), PEERS).toasts.map(one => one.text),
    t().copyResume,
    t().copied,
    t().close,
    // The severity Select draws only for a review JSON; the fixture report is markdown.
    t().onlyMajor,
    t().allSeverities,
  ])
}

describe('desktop and board strings', () => {
  test('en: no Chinese anywhere', () => {
    expect(drawn('en').filter(text => HAN.test(text))).toEqual([])
  })

  test('zh-CN: the key words are Chinese', () => {
    const text = drawn('zh-CN').join('\n')

    for (const part of [
      '空闲',
      ' · 最近 ',
      ' · 门禁 ',
      ' 5 pass 30s前',
      '工作台',
      '关闭',
      '\n需要你\n',
      '\n其他会话\n',
      '\n运行中\n',
      '已完成',
      '✓ 已返回 1',
      '⊘ 已中止 1',
      '✓ 外审完成 1',
      '看 Agents',
      '看外审',
      '没有需要你处理或运行中的任务',
      '最近门禁',
      '✓ 通过',
      '✗ 失败',
      '1m前',
      '主树 · ',
      '\n工作树\n',
      '另有 4 项',
      '命令',
      '读取中…',
      '本会话还没有子 agent。',
      '已耗时',
      '共同刻度',
      '耗时比较 · 共同刻度',
      '耗时未知',
      '阅读',
      '最近 24 小时没有 mmrun 运行',
      '返回',
      '仍在运行,还没有返回正文',
      '已返回 · 未验收 · 正文前 4000 字',
      '模型报告,待主模型核实',
      '只看 Critical/Major',
      '全部严重度',
      '没有主机。运行 /gpu <host>。',
      '正在连接 lab-box…',
      '此主机上没有 GPU。',
      '~ 还没有成功的采样',
      '前更新',
      '~ 数据过期 · 上次成功',
      '利用率 52%',
      '显存 18.2 / 24.0 GiB',
      '显存 N/A',
      '显存前 5 进程',
      '● 运行',
      '✓ 已返回 · 未验收',
      '✗ 出错',
      '◐ 静默 3m00s',
      '✗ 被拒2',
      '已中止',
      '拒答',
      '! 待处理',
      '待读',
      '等你',
      '\n会话\n',
      '门禁 bun test · 2 fail',
      '~ 缓存已冷',
      ' · 闲置 1h12m · 下一条重写约 182k tokens',
      '\n缓存\n',
      '\n门禁\n',
      '待授权',
      '等你回复',
      '进行中',
      'mm · fix the band 等你授权：Bash',
      'ui · fix the band 已答复（这轮 12m00s）：all green',
      '✗ api · fix the band 出错',
      '复制 resume',
      '已复制',
      ' 前',
    ]) {
      expect(text).toContain(part)
    }
  })
})
