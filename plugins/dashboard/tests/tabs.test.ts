import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On, RenderInput, SessionStartInput } from 'claude-code'

import type { BoardEvent } from '../types'

const PLUGIN = 'dashboard'
const NOW = 1_790_922_800_000
const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/r' }
const BOTTOM = { type: 'Text', props: {}, children: ['engine'] }
const SURFACES = ['terminal', 'desktop'] as const
const RUN = '/h/.claude/mmruns/20261002-010000-aaaa/run.meta'
const BOARD = '/h/.claude/progress/-r'
const GIT_EVENTS = '/r/.claude/worktrees/agent-x/.notes/board/events'
const ALWAYS = ['page-overview', 'page-agents', 'page-timeline', 'page-usage']
const ON_DEMAND = ['page-mmrun', 'page-gpu', 'page-progress']
const ZH = { options: { language: 'zh-CN' } }

const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: 'dashboard',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: { title: '工作台', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}

const command = (name: string, args = '') => ({ command: name, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 180 } })

/** The engine beneath the plugin, in memory: files by absolute path, a folder listed while a file lies under it. */
function seat(on: On): Record<string, string> {
  const files: Record<string, string> = {}
  const panes = new Set<string>()

  mock.env(on, { HOME: '/h' })
  on('session.id', () => ({ value: 'sa' }))
  on('session.root', () => ({ value: '/r/.claude/worktrees/agent-x' }))
  on('session.repo', () => ({ value: { root: '/r', remote: null, internal: false, name: null } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__dashboard__${e.name}` } }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text

    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = files[e.path]

    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.list', ($, e) => {
    const entries = new Map<string, FsEntry>()

    for (const [path, text] of Object.entries(files).filter(([path]) => path.startsWith(`${e.path}/`))) {
      const [name, ...rest] = path.slice(e.path.length + 1).split('/') as [string, ...string[]]

      entries.set(name, { name, kind: rest.length > 0 ? 'dir' : 'file', size: text.length, mtimeMs: NOW, isLink: false })
    }

    return entries.size > 0 ? { value: [...entries.values()] } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', ($, e) => ({ deny: `ENOENT ${e.path}` }))
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
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  // The GPU ssh: nothing sent until it is ended.
  on('process.spawn', async function* ($, e, next) {
    await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))

    return { value: { code: null, signal: 'SIGTERM' } } as never
  })
  on('classic.PostToolUse', () => ({}))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('settings.read', () => ({ value: {} }))
  on('ui.render', () => BOTTOM as never)

  return files
}

/** Which of the on-demand tabs the workbench draws. */
async function onDemandTabs(pane: { find: (query: { key: string }) => Promise<unknown> }): Promise<string[]> {
  const shown: string[] = []

  for (const key of ON_DEMAND) {
    if ((await pane.find({ key })) !== undefined) {
      shown.push(key)
    }
  }

  return shown
}

const mount = ($: Engine, surface: (typeof SURFACES)[number]) => $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

/** Every string a drawn tree holds, one per Text directly under a Box. */
function linesOf(node: unknown): string[] {
  const tree = node as { type?: string; children?: unknown[] }
  const textOf = (one: unknown): string =>
    typeof one === 'string' || typeof one === 'number' ? String(one) : ((one as { children?: unknown[] } | null)?.children ?? []).map(textOf).join('')

  if (tree.type === 'Text') {
    return [textOf(tree)]
  }

  return (tree.children ?? []).flatMap(child => (typeof child === 'object' && child !== null ? linesOf(child) : []))
}

describe('workbench tabs shown on demand', () => {
  for (const surface of SURFACES) {
    test(`no ~/.claude/mmruns, no GPU host or watch, no board: the other four tabs alone on ${surface}`, async ($, on) => {
      mock.clock(on, { now: NOW })
      seat(on)
      await $.session.start(SESSION)

      const pane = await mount($, surface)

      await pane.press({ key: 'page-overview' })

      for (const key of ALWAYS) {
        expect(await pane.find({ key }), key).toBeDefined()
      }

      expect(await onDemandTabs(pane)).toEqual([])
      await pane.unmount()
    })

    test(`~/.claude/mmruns present: the Reviews tab on ${surface}; a folder made later shows at the next opening`, async ($, on) => {
      mock.clock(on, { now: NOW })

      const files = seat(on)

      files[RUN] = 'runid=x\n'
      await $.session.start(SESSION)

      const pane = await mount($, surface)

      await pane.press({ key: 'page-overview' })
      expect(await onDemandTabs(pane)).toEqual(['page-mmrun'])

      files[`${BOARD}/config.json`] = JSON.stringify({ storage: 'local' })
      await pane.press({ key: 'page-agents' })
      expect(await onDemandTabs(pane)).toEqual(['page-mmrun', 'page-progress'])
      await pane.unmount()
    })

    test(`/mmrun opens the Reviews page with no ~/.claude/mmruns: its tab shows while it is open on ${surface}`, async ($, on) => {
      mock.clock(on, { now: NOW })
      seat(on)
      await $.session.start(SESSION)
      await $.command.run(command('mmrun'))

      const pane = await mount($, surface)

      expect(await pane.find({ key: 'page-mmrun' })).toMatchObject({ props: { variant: 'primary' } })
      await pane.press({ key: 'page-overview' })
      expect(await onDemandTabs(pane)).toEqual([])
      await pane.unmount()
    })

    test(`the gpuHosts option set: the GPU tab on ${surface}`, { options: { gpuHosts: 'lab-box' } }, async ($, on) => {
      mock.clock(on, { now: NOW })
      seat(on)
      await $.session.start(SESSION)

      const pane = await mount($, surface)

      await pane.press({ key: 'page-overview' })
      expect(await onDemandTabs(pane)).toEqual(['page-gpu'])
      await pane.unmount()
    })

    test(`a /gpu watch this session: the GPU tab on ${surface}, after leaving its page too`, async ($, on) => {
      mock.clock(on, { now: NOW })
      seat(on)
      await $.session.start(SESSION)
      await $.command.run(command('gpu', 'lab-box'))

      const pane = await mount($, surface)

      await pane.press({ key: 'page-overview' })
      expect(await onDemandTabs(pane)).toEqual(['page-gpu'])
      await pane.unmount()
    })

    test(`the board's events in the project with no config here: the Progress tab on ${surface}`, async ($, on) => {
      mock.clock(on, { now: NOW })

      const files = seat(on)

      files[`${GIT_EVENTS}/sb.json`] = '[]'
      await $.session.start(SESSION)

      const pane = await mount($, surface)

      await pane.press({ key: 'page-overview' })
      expect(await onDemandTabs(pane)).toEqual(['page-progress'])
      await pane.unmount()
    })
  }
})

const node = (id: string, title: string, status: string): BoardEvent => ({
  type: 'add',
  node: id,
  at: NOW,
  session: 'sa',
  commit: null,
  fields: { title, summary: 's', status: status as never, kind: 'feature', builds_on: [], depends_on: [] },
})

describe('the progress page', () => {
  test('read on opening it and again after a progress tool call; with no storage chosen here, it says so', ZH, async ($, on) => {
    mock.clock(on, { now: NOW })

    const files = seat(on)

    files[`${GIT_EVENTS}/sb.json`] = '[]'
    await $.session.start(SESSION)

    const pane = await mount($, 'terminal')

    await pane.press({ key: 'page-overview' })
    await pane.press({ key: 'page-progress' })
    expect(linesOf(await pane.drawn()).join('\n')).toContain('尚未选择')

    // What the progress tool leaves behind, by the progress plugin's name once released.
    files[`${BOARD}/config.json`] = JSON.stringify({ storage: 'git' })
    files[`${GIT_EVENTS}/sa.json`] = JSON.stringify([node('n1', 'Progress tool', 'done'), node('n2', 'Progress page', 'doing')])
    await $.classic.PostToolUse({ tool_name: 'mcp__progress__progress', tool_input: {}, tool_response: 'Recorded', tool_use_id: 'toolu_p', cwd: '/r' } as never)

    expect(linesOf(await pane.drawn()).join('\n')).toMatch(/进行中[\s\S]*Progress page[\s\S]*已完成[\s\S]*Progress tool/)
    await pane.unmount()
  })
})
