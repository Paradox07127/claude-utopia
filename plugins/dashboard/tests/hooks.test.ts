import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { CommandSpec, FsEntry, On, RenderInput, SessionMeasureInput, SessionStartInput } from 'claude-code'

import { fit, widthOf } from '../hooks/agent-model'

const PLUGIN = 'dashboard'
const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const BOTTOM = { type: 'Text', props: {}, children: ['engine band'] }
const IDLE = ['空闲', 'engine band']
const IDLE_AFTER_WORKER = ['空闲 · 最近 ✓ worker 已返回 21s前', 'engine band']
const NOW = 1_790_922_800_000
const ROOT = '/h/.claude/mmruns'
const SESSIONS = '/h/.claude/dashboard/sessions'
const R1 = '20261002-010000-aaaa'
const R2 = '20260930-000000-bbbb'
const R3 = '20261002-005000-cccc'
const R4 = '20261002-020000-dddd'

const bandOf = (maxRows = 20): RenderInput<'AbovePrompt'> => ({
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: { hasSurvey: false, isWorking: true, maxRows, bodyColumns: 100, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} },
})
const BAND = bandOf()

const hintOf = (surface: 'terminal' | 'desktop', more: Partial<RenderInput<'PromptHint'>['props']> = {}): RenderInput<'PromptHint'> => ({
  component: 'PromptHint',
  surface,
  requestId: 'hint',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts', ...more },
})

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

/** A tool call that ran, as the engine reports it after the fact. */
const ran = (tool_name: string, tool_input: Record<string, unknown>, agent_id?: string) =>
  ({ tool_name, tool_input, tool_response: 'ok', tool_use_id: 'toolu_x', ...(agent_id !== undefined && { agent_id }) }) as never
const denied = (tool_name: string, agent_id?: string) =>
  ({ tool_name, tool_input: {}, tool_use_id: 'toolu_x', reason: 'auto-denied', ...(agent_id !== undefined && { agent_id }) }) as never

const usage = (output_tokens: number) => ({ input_tokens: 1, output_tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' })
const complete = (agentId: string, reason = 'answer', durationMs = 1_000) =>
  ({ answer: 'report', durationMs, isAborted: reason === 'aborted', turnId: 't', agentId, reason, usage: usage(500) }) as never

const BUN_OK = ['(pass) a [1ms]', '', ' 24 pass', ' 0 fail', 'Ran 24 tests across 1 file. [0.17s]'].join('\n')
const TEGRA_RUN =['@@NVSMI', '0, Orin (nvgpu), [N/A], [N/A], [N/A], [N/A], [N/A]', '@@APPS', '@@TEGRA',
  'RAM 5120/30536MB (lfb 4x4MB) GR3D_FREQ 37% cpu@47.3C gpu@45.8C tj@47.3C'].join('\n')
const NVIDIA_RUN = ['@@NVSMI', '0, NVIDIA GeForce RTX 4090, 52, 18636, 24564, 67, 280.45', '@@APPS', '4242, /usr/bin/python3, 10240'].join('\n')
const NVML_RUN = ['@@NVERR', 'Failed to initialize NVML: Driver/library version mismatch', '@@NOGPU'].join('\n')
/** The engine's measurement of the session: the context window with its fill, the rate-limit windows, the cost. */
const measure = ($: Engine, more: Partial<SessionMeasureInput> = {}) => $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'], ...more })
/** The context the main reply left: 182k of 200k. */
const FILLED = { context: { tokens: 182_000, window: 200_000, percent: 91 } }
/** What a compaction leaves. */
const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

type Files = Record<string, { text: string; mtimeMs?: number }>

const runMeta = (runid: string, tag: string, models: string) =>
  `runid=${runid}\nworkdir=/work/proj\ntag=${tag}\nmodels=${models}\nmode=review\nschema=\nwt=\nsession=x\n`

/** R1 has codex running (pid 111) and grok done; R2 is older than a day; R3 failed an hour ago. */
function mmruns(): Files {
  return {
    [`${R1}/run.meta`]: { text: runMeta(R1, 'design', 'codex,grok'), mtimeMs: NOW - 300_000 },
    [`${R1}/codex.status`]: { text: 'RUNNING\n' },
    [`${R1}/codex.started`]: { text: `${(NOW - 252_000) / 1000}\n` },
    [`${R1}/codex.pid`]: { text: '111\n' },
    [`${R1}/codex.raw`]: { text: 'never read' },
    [`${R1}/grok.status`]: { text: 'DONE\n', mtimeMs: NOW - 120_000 },
    [`${R1}/grok.started`]: { text: `${(NOW - 422_000) / 1000}\n` },
    [`${R1}/grok.meta`]: { text: 'session_id=s\nsecs=302\nexit=0\nattempts=1\nusage={"input_tokens":1,"output_tokens":25835}\n' },
    [`${R2}/run.meta`]: { text: runMeta(R2, '', 'codex'), mtimeMs: NOW - 2 * 86_400_000 },
    [`${R2}/codex.status`]: { text: 'RUNNING\n' },
    [`${R3}/run.meta`]: { text: runMeta(R3, '', 'agy'), mtimeMs: NOW - 4_000_000 },
    [`${R3}/agy.status`]: { text: 'FAIL:1\n', mtimeMs: NOW - 3_600_000 },
    [`${R3}/agy.started`]: { text: `${(NOW - 3_700_000) / 1000}\n` },
    [`${R3}/agy.meta`]: { text: 'secs=100\nexit=1\n' },
  }
}

type World = {
  opened: { id: string; title?: string }[]
  panes: Set<string>
  /** Open panes behind another tab: listed with isShown false. */
  hidden: Set<string>
  runs: string[][]
  commands: string[]
  /** Each `$.command.register` spec as given. */
  specs: CommandSpec[]
  /** Command names `$.command.register` refuses. */
  refusedNames: Set<string>
  /** Names of the tools the plugin registered. */
  tools: string[]
  /** Every `$.ui.log` line. */
  logs: { text: string; to: string }[]
  stdout: string
  files: Files
  alive: Set<string>
  kills: string[]
  reads: string[]
  toasts: string[]
  /** ~/.claude/dashboard/sessions by file name. */
  sessions: Record<string, string>
  /** What `$.ui.copy` was asked to put on the clipboard. */
  copies: string[]
  /** The PromptHint props that reach the engine beneath. */
  hints: RenderInput<'PromptHint'>['props'][]
  /** What the settings hooks beneath answer a PermissionRequest with; none asks the person. */
  decision?: { behavior: 'allow' } | { behavior: 'deny'; message: string }
  /** What `$.agent.list()` answers, and how often it was asked. */
  listed: { id: string; description: string; type: string; status: string }[]
  listCalls: number
  /** How many times the plugin asked for a redraw. */
  invalidated: number
  /** How many times a ToolResult row reached the engine's drawing beneath. */
  toolResults: number
  /** fs.list paths that are refused, with the refusal. */
  listDenied: Record<string, string>
  /** Awaited by the engine's fs.read before it answers. */
  beforeRead?: (path: string) => Promise<void>
  /** Awaited by the engine's agent.spawn before it answers the n-th spawn. */
  beforeSpawn?: (n: number) => Promise<void>
  /** Every `$.ui.status` text, undefined for a clear. */
  statuses: (string | undefined)[]
  /** The base64 of every clip `$.audio.play` was asked to play. */
  clips: string[]
  /** `$.audio.play` rejects: no device to play on. */
  isMuted: boolean
  /** Each GPU ssh connection's argv, and the clock's time it started at (0 without a clock). */
  spawns: string[][]
  spawnedAt: number[]
  /** Passes the GPU ssh connections sent. */
  samples: number
  /** GPU ssh connections the plugin ended. */
  killed: number
  /** Set: the GPU ssh says this on stderr at its next pass and exits 255. */
  sshDown: string | null
}

/** A session file's mtime: its own updatedAt, as the session that wrote it last did then; else NOW. */
function writtenAt(text: string): number {
  try {
    const updatedAt = (JSON.parse(text) as { updatedAt?: unknown }).updatedAt

    return typeof updatedAt === 'number' ? updatedAt : NOW
  } catch {
    return NOW
  }
}

/** The engine beneath the plugin, in memory; ~/.claude/mmruns holds `files`. With `clock`, a GPU ssh sends a pass every 3 s, else its first alone. */
function seat(on: On, files: Files = {}, clock?: MockClock): World {
  const world: World = { opened: [], panes: new Set(), hidden: new Set(), runs: [], commands: [], specs: [], refusedNames: new Set(), tools: [], logs: [], stdout: TEGRA_RUN, files, alive: new Set(), kills: [], reads: [], toasts: [], sessions: {}, copies: [], hints: [], listed: [], listCalls: 0, listDenied: {}, invalidated: 0, toolResults: 0, statuses: [], clips: [], isMuted: false, spawns: [], spawnedAt: [], samples: 0, killed: 0, sshDown: null }
  let spawned = 0

  mock.env(on, { HOME: '/h' })
  on('session.id', () => ({ value: 'me' }))
  on('session.root', () => ({ value: '/work/harness' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('fs.write', ($, e) => {
    world.sessions[e.path.slice(SESSIONS.length + 1)] = e.text

    return { value: undefined }
  })
  on('command.register', ($, e) => {
    if (world.refusedNames.has(e.name)) {
      return { deny: `${e.name} is taken` }
    }

    world.commands.push(e.name)
    world.specs.push(e)

    return { value: { command: e.name } }
  })
  on('ui.log', ($, e) => {
    world.logs.push({ text: e.text, to: e.to })

    return { value: undefined }
  })
  on('tool.register', ($, e) => {
    world.tools.push(e.name)

    return { value: { tool: `mcp__dashboard__${e.name}` } }
  })
  on('ui.open', ($, e) => {
    world.opened.push({ id: e.id, title: e.title })
    world.panes.add(e.id)

    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    world.panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...world.panes].map(id => ({ id, title: id, isShown: !world.hidden.has(id), isFocused: false, isPlaced: true })),
  }))
  // Passed on, so a mounted drawing follows the redraw as on screen.
  on('ui.invalidate', ($, e, next) => {
    world.invalidated += 1

    return next(e)
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    world.statuses.push(e.text)

    return { value: undefined }
  })
  on('audio.play', ($, e) => {
    world.clips.push(e.clip.base64 ?? '')

    return world.isMuted ? { deny: 'no audio device' } : { value: undefined }
  })
  on('ui.copy', ($, e) => {
    world.copies.push(e.text)

    return { value: { isCopied: true } }
  })
  on('process.run', ($, e) => {
    if (e.argv[0] === 'kill') {
      world.kills.push(String(e.argv[2]))

      return { value: { exitCode: world.alive.has(String(e.argv[2])) ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    world.runs.push([...e.argv])

    return { value: { exitCode: 0, stdout: world.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* ($, e, next) {
    const isEnded = new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))

    world.spawns.push([...e.argv])
    world.spawnedAt.push(clock?.now() ?? 0)

    let isDropped = false

    // Ended by the reader: an abort while it waits, or a return() at a yield, which runs only this finally.
    try {
      while (!next.signal.aborted) {
        if (world.sshDown !== null) {
          yield { stream: 'stderr' as const, text: `${world.sshDown}\n` }
          isDropped = true

          return { value: { code: 255, signal: null } } as never
        }

        world.samples += 1
        yield { stream: 'stdout' as const, text: `${world.stdout}\n@@END\n` }
        await Promise.race([clock?.sleep(3_000) ?? isEnded, isEnded])
      }
    } finally {
      if (!isDropped) {
        world.killed += 1
      }
    }

    return { value: { code: null, signal: 'SIGTERM' } } as never
  })
  on('fs.list', ($, e) => {
    const refusal = world.listDenied[e.path]

    if (refusal !== undefined) {
      return { deny: refusal }
    }

    if (e.path === SESSIONS) {
      return { value: Object.entries(world.sessions).map(([name, text]) => ({ name, kind: 'file', size: text.length, mtimeMs: writtenAt(text), isLink: false }) as FsEntry) }
    }

    const rel = e.path === ROOT ? '' : e.path.slice(ROOT.length + 1)
    const names = new Map<string, FsEntry>()

    for (const [path, file] of Object.entries(world.files)) {
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
    const file = world.files[e.path.slice(ROOT.length + 1)]

    return file ? { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs ?? NOW - 1000, isLink: false } } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.read', async ($, e) => {
    world.reads.push(e.path)
    await world.beforeRead?.(e.path)

    if (e.path.startsWith(`${SESSIONS}/`)) {
      const text = world.sessions[e.path.slice(SESSIONS.length + 1)]

      return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
    }

    const file = world.files[e.path.slice(ROOT.length + 1)]

    return file ? { value: file.text } : { deny: `ENOENT ${e.path}` }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('settings.read', () => ({ value: {} }))
  on('agent.spawn', async () => {
    spawned += 1

    const n = spawned

    await world.beforeSpawn?.(n)

    return { model: 'claude-opus-5-5', agentId: `a${n}` }
  })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.PermissionDenied', () => ({}))
  on('agent.list', () => {
    world.listCalls += 1

    return { value: world.listed }
  })
  on('classic.PermissionRequest', () => (world.decision === undefined ? {} : { decision: world.decision }))
  on('classic.Stop', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.edit', ($, e) => ({ text: e.text, cursor: e.cursor }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.compact', () => ({ messages: SUMMARY }))
  on('ui.render', ($, e) => {
    if (e.component === 'PromptHint') {
      world.hints.push(e.props)
    }

    if (e.component === 'ToolResult') {
      world.toolResults += 1
    }

    return BOTTOM as never
  })

  return world
}

/** This session's own presence file, parsed. */
const mine = (world: World) => JSON.parse(world.sessions['me.json'] ?? 'null') as Record<string, unknown> | null

const PROMPT = { text: 'go', wait: false, origin: { kind: 'composer' } } as never
/** One key typed into the prompt box; the test engine raises prompt.edit, which its `$` type does not list. */
const typeKey = ($: Engine) =>
  ($.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }).edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'a' })

/** Another session's presence file, its heartbeat `now`. */
const peer = (id: string, state: string, since: number, more: Record<string, unknown> = {}) =>
  JSON.stringify({ id, name: id, state, since, updatedAt: since, ...more })

/** How many times dashboard's `key` atom has been written so far. */
function writes(on: On, key: string): () => number {
  let count = 0

  on('state.set', ($, e, next) => {
    if (e.plugin === 'dashboard' && e.key === key) {
      count += 1
    }

    return next(e)
  })

  return () => count
}

/** Every string a drawn tree holds, joined. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  const children = (node as { children?: unknown[] }).children ?? []

  return children.map(textOf).join('')
}

/** The drawn tree's lines: each Text directly under a Box, its nested Texts joined. */
function linesOf(node: unknown): string[] {
  const tree = node as { type?: string; children?: unknown[] }

  if (tree.type === 'Text') {
    const text = textOf(tree)

    return text.trim() === '' ? [] : [text]
  }

  return (tree.children ?? []).flatMap(child => (typeof child === 'object' && child !== null ? linesOf(child) : []))
}

/** The color of each drawn Text whose whole text is `text`. */
function colorsOf(node: unknown, text: string): unknown[] {
  const tree = node as { type?: string; props?: { color?: unknown }; children?: unknown[] }
  const own = tree.type === 'Text' && tree.children?.length === 1 && tree.children[0] === text ? [tree.props?.color] : []

  return [...own, ...(tree.children ?? []).flatMap(child => (typeof child === 'object' && child !== null ? colorsOf(child, text) : []))]
}

/** Every Box with a Button among its own children. */
function boxesWithButton(node: unknown): unknown[] {
  const tree = node as { type?: string; children?: unknown[] }
  const children = (tree.children ?? []).filter(child => typeof child === 'object' && child !== null) as { type?: string }[]
  const own = tree.type === 'Box' && children.some(child => child.type === 'Button') ? [tree] : []

  return [...own, ...children.flatMap(boxesWithButton)]
}

/** Whether a drawn Text holding `text` is dim. */
function isDimText(node: unknown, text: string): boolean {
  const tree = node as { type?: string; props?: { dimColor?: unknown }; children?: unknown[] }

  if (tree.type === 'Text' && textOf(tree).includes(text)) {
    return tree.props?.dimColor === true
  }

  return (tree.children ?? []).some(child => typeof child === 'object' && child !== null && isDimText(child, text))
}

/** The text of every dim Text, a dim plain Button's label too. */
function dimTexts(node: unknown, out: string[] = []): string[] {
  const tree = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }

  if (tree.props?.dimColor === true) {
    out.push(tree.type === 'Button' ? String(tree.props.label) : textOf(tree))
  }

  for (const child of tree.children ?? []) {
    if (typeof child === 'object' && child !== null) {
      dimTexts(child, out)
    }
  }

  return out
}

/** A row's text as the terminal draws it: a plain Button as `1: label` (its label alone without a hotkey), any other as `[ label ]`. */
function inlineOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (node === null || typeof node !== 'object') {
    return ''
  }

  const tree = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const props = tree.props ?? {}

  if (tree.type === 'Button') {
    return props.plain === true ? `${props.hotkey === undefined ? '' : `${String(props.hotkey)}: `}${String(props.label)}` : `[ ${String(props.label)} ]`
  }

  return (tree.children ?? []).map(inlineOf).join(tree.type === 'Box' ? ' '.repeat(Number(props.columnGap ?? 0)) : '')
}

/** The drawn tree's rows: a column Box's children one under another, a row Box side by side. */
function rowsOf(node: unknown): string[] {
  const tree = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }

  if (tree.type === 'Box' && tree.props?.flexDirection === 'column') {
    return (tree.children ?? []).filter(child => typeof child === 'object' && child !== null).flatMap(rowsOf)
  }

  return [inlineOf(tree)]
}

describe('subagent status', () => {
  test('agent.spawn, tools that ran and turn.complete drive the band', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })

    seat(on)
    await $.session.start(SESSION)

    expect(linesOf(await $.ui.render(BAND)), 'no agents: the idle line').toEqual(IDLE)

    await $.agent.spawn(SPAWN as never)
    await clock.advance(5_000)
    await $.classic.PostToolUse(ran('Edit', { file_path: '/w/hooks/register.tsx', old_string: 'a', new_string: 'b' }, 'a1'))
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/README.md' }, 'a1'))
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/main-loop.md' }))

    const running = textOf(await $.ui.render(BAND))

    expect(running).toContain('●')
    expect(running).toContain('worker  Build mm plugin      5s  2 tools  Read README.md')
    expect(running, 'composes with the band beneath').toContain('engine band')

    await clock.advance(60_000)
    await $.turn.complete({ answer: 'ok', durationMs: 65_000, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer', usage: usage(12_000) } as never)

    const done = textOf(await $.ui.render(BAND))

    expect(done).toContain('✓')
    expect(done).toContain('worker  Build mm plugin   1m05s  12k out  已返回')

    await clock.advance(21_000)
    expect(linesOf(await $.ui.render(BAND)), 'finished more than 20 s ago: back to idle').toEqual(IDLE_AFTER_WORKER)
  })

  test('a message delivered to an ended agent runs it again at once, its time going on from the turns before', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })

    seat(on)
    on('session.send', ($, e) => (e.to === 'a1' ? { isDelivered: true } : { isDelivered: false, reason: `nobody named ${e.to}` }))
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await clock.advance(65_000)
    await $.turn.complete(complete('a1', 'answer', 65_000))
    await clock.advance(600_000)

    await $.session.send({ to: 'nobody', text: 'one more thing', origin: { kind: 'model' } })
    expect(textOf(await $.ui.render(BAND)), 'not delivered: still ended').not.toContain('●')

    await $.session.send({ to: 'a1', text: 'one more thing', origin: { kind: 'model' } })
    await clock.advance(10_000)
    expect(textOf(await $.ui.render(BAND)), 'running before any tool of it ends, the idle gap left out').toContain('● worker  Build mm plugin   1m15s  0 tools')

    await clock.advance(5_000)
    await $.turn.complete(complete('a1', 'answer', 15_000))
    expect(textOf(await $.ui.render(BAND)), 'done: both turns, not the latest alone').toContain('✓ worker  Build mm plugin   1m20s')
  })

  test('an interrupted agent shows ⊘, and a survey takes the band', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)

    expect(await $.ui.render({ ...BAND, props: { ...BAND.props, hasSurvey: true } })).toEqual(BOTTOM)

    await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: true, turnId: 't', agentId: 'a1', reason: 'aborted' } as never)
    expect(textOf(await $.ui.render(BAND))).toContain('⊘')
  })

  test('a permission denied to a subagent marks it 被拒1 on the band', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })

    seat(on)

    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.classic.PermissionDenied(denied('Write', 'a1'))
    await $.classic.PermissionDenied(denied('Write'))
    await $.classic.PermissionDenied(denied('Write', 'someone-else'))
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/x' }, 'a1'))

    const band = textOf(await $.ui.render(BAND))

    expect(band, 'the denied call counts as a tool call too').toContain('2 tools  Read x  ✗ 被拒1')

    await $.turn.complete(complete('a1'))
    expect(textOf(await $.ui.render(BAND)), 'still on the band once returned, until the Agents page is opened').toContain('被拒1')

    await $.command.run(command('subagents'))
    expect(textOf(await $.ui.render(PANE))).toContain('✗1')
    await clock.advance(21_000)
    expect(linesOf(await $.ui.render(BAND)), 'seen and past its 20 s: off the band').toEqual(IDLE_AFTER_WORKER)
  })

  test('two agents whose redraw-timer checks overlap start one timer, not one each', async ($, on) => {
    let timers = 0
    let release: (() => void) | undefined
    let onHeld = () => {}
    const isHeld = new Promise<void>(resolve => {
      onHeld = resolve
    })

    // Above mock.clock's hook, so it sees every period asked.
    on('clock.every', { ms: 1000 }, ($, e, next) => {
      timers += 1

      return next(e)
    })
    mock.clock(on, { now: 1_000 })

    const world = seat(on)

    // The first agent's liveness read is held until the second agent's own read: both checks are in flight at once.
    on('state.get', async ($, e, next) => {
      const r = await next(e)
      const list = (r as { value?: { value?: { value?: unknown } } }).value?.value?.value
      const count = (e as { key: string }).key === 'agents' && Array.isArray(list) ? list.length : 0

      if (count === 1 && release === undefined) {
        await new Promise<void>(resolve => {
          release = resolve
          onHeld()
        })
      }

      if (count === 2) {
        release?.()
      }

      return r
    })
    world.beforeSpawn = async n => (n === 2 ? isHeld : undefined)
    await $.session.start(SESSION)
    await Promise.all([$.agent.spawn(SPAWN as never), $.agent.spawn(SPAWN as never)])

    expect(timers).toBe(1)
  })

  test('an agent spawned while the redraw timer decides to stop still gets a timer', async ($, on) => {
    let isHolding = false
    let release = () => {}
    let onHeld = () => {}
    const isHeld = new Promise<void>(resolve => {
      onHeld = resolve
    })

    const clock = mock.clock(on, { now: 1_000 })
    const ticks = writes(on, 'tick')

    seat(on)

    // The timer's liveness check is held once it has read the agents (gates come after them), until a second agent is spawned.
    on('state.get', async ($, e, next) => {
      if (isHolding && (e as { key: string }).key === 'gates') {
        isHolding = false
        await new Promise<void>(resolve => {
          release = resolve
          onHeld()
        })
      }

      return next(e)
    })
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.turn.complete(complete('a1'))
    await clock.advance(19_000)
    isHolding = true

    // a1 ended 20 s ago at this tick: the timer finds nothing live.
    const ticking = clock.advance(1_000)

    await isHeld
    await $.agent.spawn(SPAWN as never)
    release()
    await ticking
    await clock.settle()

    const before = ticks()

    await clock.advance(2_000)

    expect(ticks() - before, 'a2 runs: the band is redrawn every second').toBeGreaterThanOrEqual(2)
  })

  test('the redraw timer redraws the workbench each second, never a Bash result row of the transcript', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command('dashboard'))

    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 'toolu_b',
      props: { tool_use_id: 'toolu_b', tool: 'Bash', output: { stdout: 'hello', stderr: '', interrupted: false }, isErrored: false },
    } as never)
    const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await row.drawn()

    const before = world.toolResults

    world.invalidated = 0
    await clock.advance(5_000)
    expect(world.invalidated, 'no redraw of every instance the plugin drew').toBe(0)
    expect(rowsOf(await pane.drawn()).join('\n'), 'the elapsed time moves').toMatch(/worker .* 5s$/m)
    await row.drawn()
    expect(world.toolResults - before, 'five ticks: the row is not drawn again').toBe(0)
    await row.unmount()
    await pane.unmount()
  })

  test('failed and denied calls are activity: an agent whose calls keep failing is not quiet', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })

    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await clock.advance(100_000)
    await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'make' }, tool_use_id: 'toolu_f', error: 'Exit code 2', agent_id: 'a1' } as never)
    await clock.advance(100_000)
    await $.classic.PermissionDenied(denied('Write', 'a1'))
    await clock.advance(100_000)

    const band = textOf(await $.ui.render(BAND))

    expect(band).toContain('2 tools  Write  ✗ 被拒1')
    expect(band).not.toContain('静默')
  })

  test('an agent that returned and is sent on runs again, its time going on from its turns before; its earlier answer stays readable', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })

    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await clock.advance(5_000)
    await $.turn.complete(complete('a1'))
    expect(textOf(await $.ui.render(BAND))).toContain('已返回')

    await clock.advance(30_000)
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/x' }, 'a1'))

    const band = textOf(await $.ui.render(BAND))

    expect(band, 'its 1 s turn, the idle gap left out').toContain('● worker  Build mm plugin      1s  1 tools  Read x')
    expect(band).not.toContain('已返回')

    await $.command.run(command('subagents'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect(await ui.find({ key: 'read-agent-a1' })).toBeDefined()
    await ui.unmount()
  })

  test('a quiet agent the engine lists as killed is closed ⊘ 已中止; one it does not list stays running; the list is asked every 15 s at most', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn({ ...SPAWN, description: 'Other job' } as never)
    world.listed = [{ id: 'a1', description: 'Build mm plugin', type: 'worker', status: 'killed' }]
    await clock.advance(119_000)
    expect(world.listCalls, 'nobody quiet yet').toBe(0)

    await clock.advance(16_000)
    expect(world.listCalls).toBe(2)

    const band = textOf(await $.ui.render(BAND))

    expect(band).toContain('⊘ worker  Build mm plugin')
    expect(band).toContain('已中止')
    expect(band).toMatch(/● worker {2}Other job .*静默/)
  })

  test('agent.spawn keeps the loop it happened in as parentAgentId', async ($, on) => {
    let stored: { agentId: string; parentAgentId?: string }[] = []

    on('state.set', ($, e, next) => {
      if (e.plugin === 'dashboard' && e.key === 'agents') {
        stored = (e as unknown as { value: { value: typeof stored } }).value.value
      }

      return next(e)
    })
    mock.clock(on, { now: 1_000 })
    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn({ ...SPAWN, parentAgentId: 'a1' } as never)

    expect(stored.map(one => [one.agentId, one.parentAgentId])).toEqual([['a1', undefined], ['a2', 'a1']])
  })

  test('over budget the band groups like items, and with one row it is a line of counts', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: 1_000 })
    seat(on)
    await $.session.start(SESSION)

    for (let i = 0; i < 4; i += 1) {
      await $.agent.spawn(SPAWN as never)
    }

    await $.turn.complete(complete('a1', 'error'))
    await $.turn.complete(complete('a2'))

    expect(linesOf(await $.ui.render(bandOf(5))), 'four items: more than three, so grouped even with five rows').toEqual(['✗ worker  Build mm plugin      1s  出错', 'agents ●2 ✓1', 'engine band'])
    expect(linesOf(await $.ui.render(bandOf(2)))).toEqual(['✗ worker  Build mm plugin      1s  出错', 'agents ●2 ✓1', 'engine band'])
    expect(linesOf(await $.ui.render(bandOf(1)))).toEqual(['! 待处理1 · ●运行2 · 待读1', 'engine band'])
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn(SPAWN as never)
    expect(linesOf(await $.ui.render(bandOf(99))), 'six items: never more than 5 rows of ours').toEqual(['✗ worker  Build mm plugin      1s  出错', 'agents ●4 ✓1', 'engine band'])
  })
})

describe('workbench', () => {
  test('commands register without built-in names and each lands on its page', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    expect(world.commands).toEqual(['dashboard', 'subagents', 'mmrun', 'gpu', 'timeline'])

    await $.agent.spawn(SPAWN as never)
    await $.command.run(command('dashboard'))
    const first = textOf(await $.ui.render(PANE))

    expect(first, 'first time: 总览').toContain('运行中 · 2')
    expect(first, 'no empty sections').not.toContain('待处理')

    await $.command.run(command('subagents'))
    expect(rowsOf(await $.ui.render(PANE))[2]).toMatch(/^● 运行 +1: worker  Build mm plug… +opus-5-5 +0s +— +0$/)

    await $.command.run(command('mmrun'))
    expect(rowsOf(await $.ui.render(PANE))).toContain('design · review  aaaa  proj [ 阅读 ]')

    await $.command.run(command('gpu', 'gpu-box'))
    await clock.settle()
    expect(textOf(await $.ui.render(PANE))).toContain('GR3D ')

    await $.command.run(command('dashboard'))
    await clock.settle()
    expect(textOf(await $.ui.render(PANE)), '/dashboard reopens the last page').toContain('GR3D ')
    expect(new Set(world.opened.map(one => JSON.stringify(one)))).toEqual(new Set([JSON.stringify({ id: 'dashboard', title: '工作台' })]))
  })

  test('deferred-monitoring-command: each command only opens a page, so each registers immediate and runs mid-turn', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    expect(world.specs.map(one => [one.name, one.immediate])).toEqual([
      ['dashboard', true],
      ['subagents', true],
      ['mmrun', true],
      ['gpu', true],
      ['timeline', true],
    ])
  })

  test('the overview behind another tab reads no worktrees; opened or on screen again it does', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const lists = () => world.runs.filter(argv => argv[0] === 'git' && argv.includes('worktree')).length

    await $.session.start(SESSION)
    await $.command.run(command('dashboard'))
    expect(lists(), 'opening the overview reads them at once').toBe(1)

    world.hidden.add('dashboard')
    await clock.advance(15_000)
    expect(lists(), 'hidden: not read').toBe(1)

    world.hidden.delete('dashboard')
    await clock.advance(15_000)
    expect(lists()).toBe(2)
  })

  test('session.start runs whole: no hook fails, no tool registers', async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    expect(world.tools).toEqual([])
    expect(world.logs.filter(one => one.text.includes('failed'))).toEqual([])
  })

  test('a refused command name skips only that command: the others register and the session writes its presence', async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    world.refusedNames.add('subagents')
    await $.session.start(SESSION)
    expect(world.commands).toEqual(['dashboard', 'mmrun', 'gpu', 'timeline'])
    expect(mine(world)?.state).toBe('idle')
  })

  test('the page buttons switch pages; 外审 shows the runs', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('dashboard'))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

      expect((await ui.find({ key: 'page-mmrun' }))?.props).toMatchObject({ label: '外审' })
      expect((await ui.find({ key: 'page-mmrun' }))?.props.hotkey, 'no letter hotkey').toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'aaaa' })).toBeUndefined()

      await ui.press({ key: 'page-mmrun' })
      expect(await ui.find({ type: 'Text', text: 'aaaa' })).toBeDefined()
      if (surface === 'terminal') {
        expect((await ui.find({ type: 'Text', text: /grok/ }))?.text).toMatch(/DONE +5m02s +25\.8k tok/)
      } else {
        expect((await ui.findAll({ type: 'Box', text: /grok/ })).at(-1)?.text, 'the model row: name, status, time, tokens').toMatch(/grok ?✓ 完成 ?5m02s ?25\.8k tok/)
      }

      expect((await ui.find({ key: 'page-mmrun' }))?.props).toMatchObject({ variant: 'primary' })

      await ui.press({ key: 'page-overview' })
      expect(await ui.find({ type: 'Text', text: 'aaaa' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('the band button opens the overview', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: 1_000 })

    const world = seat(on)

    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)

    const ui = await $.ui.mount({ plugin: PLUGIN, ...BAND } as never)

    expect((await ui.find({ key: 'dash-open' }))?.props).toMatchObject({ label: '工作台' })
    expect((await ui.find({ key: 'dash-open' }))?.props.hotkey, 'no hotkey on the band').toBeUndefined()
    await ui.press({ key: 'dash-open' })
    expect(world.opened).toEqual([{ id: 'dashboard', title: '工作台' }])
    expect(textOf(await $.ui.render(PANE))).toContain('运行中 · 1')
  })

})

/** The engine's model request beneath turn.step: one text chunk, then the end. */
function stepper(on: On): void {
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'hi' }

    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: usage(10) }
  })
}

const stepIn = (turnId: string, index = 0, agentId?: string) => ({ turnId, index, model: 'claude-opus-5-5', messageCount: 2, ...(agentId !== undefined && { agentId }) }) as never

/** Runs a turn.step stream to its end. */
async function drain(stream: AsyncGenerator<unknown, unknown>): Promise<void> {
  while ((await stream.next()).done !== true) {}
}

/** A main turn of `steps` steps, ended unless `isOpen`. */
async function mainTurn($: Engine, turnId: string, steps: number, isOpen = false): Promise<void> {
  await $.turn.start({ text: 'go', turnId })

  for (let i = 0; i < steps; i += 1) {
    await drain($.turn.step(stepIn(turnId, i)))
  }

  if (!isOpen) {
    await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId, reason: 'answer' } as never)
  }
}

describe('timeline page', () => {
  test('/timeline opens it on the main loop latest turn; 上一轮 / 下一轮 / 最新 move between main turns, a button with nowhere to go not drawn', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    stepper(on)
    await $.session.start(SESSION)
    await mainTurn($, 'm1', 2)
    await mainTurn($, 'm2', 1)
    await drain($.turn.step(stepIn('s1', 0, 'a9')))

    expect(world.commands).toContain('timeline')
    expect((await $.command.run(command('timeline'))).text).toBeUndefined()

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)
    const shown = async () => {
      const keys: string[] = []

      for (const key of ['timeline-prev', 'timeline-next', 'timeline-latest']) {
        if ((await ui.find({ key })) !== undefined) {
          keys.push(key)
        }
      }

      return keys
    }

    expect((await ui.find({ key: 'page-timeline' }))?.props).toMatchObject({ label: '时间线', variant: 'primary' })
    expect((await ui.find({ key: 'page-timeline' }))?.props.hotkey).toBeUndefined()
    expect((await ui.find({ key: 'timeline-prev' }))?.props.hotkey).toBeUndefined()
    expect((await ui.find({ key: 'timeline-prev' }))?.props).toMatchObject({ label: '上一轮' })
    expect(textOf(await ui.drawn())).toContain('时间线 · 1步')
    expect(await shown(), 'the latest: only back').toEqual(['timeline-prev'])

    await ui.press({ key: 'timeline-prev' })
    expect(textOf(await ui.drawn())).toContain('时间线 · 2步')
    expect(await shown(), 'the first: forward and to the latest').toEqual(['timeline-next', 'timeline-latest'])

    await ui.press({ key: 'timeline-latest' })
    expect(textOf(await ui.drawn())).toContain('时间线 · 1步')
    await mainTurn($, 'm3', 3, true)
    expect(textOf(await ui.drawn()), 'following the latest: a new turn shows').toContain('时间线 · 3步')

    await ui.press({ key: 'timeline-prev' })
    await ui.press({ key: 'timeline-next' })
    expect(textOf(await ui.drawn())).toContain('时间线 · 3步')
    expect(await shown()).toEqual(['timeline-prev'])
    await ui.unmount()
  })

  test('hidden-follow-mode-control: stepping forward to the newest turn follows again, so a new turn shows', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    stepper(on)
    await $.session.start(SESSION)
    await mainTurn($, 'm1', 2)
    await mainTurn($, 'm2', 3)
    await $.command.run(command('timeline'))

    let next = 4

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

      await ui.press({ key: 'timeline-prev' })
      expect(textOf(await ui.drawn()), surface).toContain(`${next - 2}步`)
      await ui.press({ key: 'timeline-next' })
      expect(await ui.find({ key: 'timeline-latest' }), `${surface}: the newest turn needs no 最新`).toBeUndefined()
      await mainTurn($, `m${next}`, next, true)
      expect(textOf(await ui.drawn()), `${surface}: the new turn shows`).toContain(`${next}步`)
      await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: `m${next}`, reason: 'answer' } as never)
      next += 1
      await ui.unmount()
    }
  })

  test('热点 switches to the hotspots of every main turn and 单轮 back; the view is kept, the button has no hotkey', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    stepper(on)
    await $.session.start(SESSION)
    await mainTurn($, 'm1', 2)
    await mainTurn($, 'm2', 1)
    await drain($.turn.step(stepIn('s1', 0, 'a9')))
    await $.command.run(command('timeline'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect((await ui.find({ key: 'timeline-view' }))?.props).toMatchObject({ label: '热点' })
    expect((await ui.find({ key: 'timeline-view' }))?.props.hotkey).toBeUndefined()

    await ui.press({ key: 'timeline-view' })

    const text = textOf(await ui.drawn())

    expect(text).toContain('热点 · 主线程 2轮')
    expect(text).toContain('最慢的回合')
    expect(text).not.toContain('时间线 · ')
    expect((await ui.find({ key: 'timeline-view' }))?.props).toMatchObject({ label: '单轮' })
    expect(await ui.find({ key: 'timeline-prev' }), 'stepping between turns is the single-turn view’s').toBeUndefined()
    await ui.unmount()

    const again = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect(textOf(await again.drawn()), 'the view is kept').toContain('热点 · 主线程 2轮')
    await again.press({ key: 'timeline-view' })
    expect(textOf(await again.drawn())).toContain('时间线 · 1步')
    await again.unmount()
  })

  test('a page whose data cannot be read draws ✗ and why under the page buttons; the other pages still work', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    let isBroken = false

    const { logs } = seat(on)
    on('state.get', ($, e, next) => (isBroken && (e as { key: string }).key === 'timeline' ? ({ deny: 'timeline unreadable' } as never) : next(e)))
    await $.session.start(SESSION)
    await $.command.run(command('timeline'))

    for (const surface of ['terminal', 'desktop'] as const) {
      isBroken = true

      const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)
      const failure = await ui.find({ type: 'Text', text: /^✗ / })

      expect((await ui.find({ key: 'page-timeline' }))?.props, surface).toMatchObject({ variant: 'primary' })
      // The desktop host draws its own close control.
      expect(await ui.find({ key: 'dash-close' }), surface)[surface === 'terminal' ? 'toBeDefined' : 'toBeUndefined']()
      expect(failure?.text, surface).toContain('timeline unreadable')
      expect(failure?.props.color, surface).toBe('error')

      // The desktop reads every page's data up front, so there the failure stays on every page until the read works.
      if (surface === 'terminal') {
        await ui.press({ key: 'page-agents' })
        expect(textOf(await ui.drawn()), 'another page draws').not.toContain('timeline unreadable')
      }

      isBroken = false
      await ui.press({ key: 'page-timeline' })
      expect(await ui.find({ type: 'Text', text: /^✗ / }), `${surface}: drawn again once the read works`).toBeUndefined()
      await ui.unmount()
    }

    expect(logs.some(one => one.to === 'debug' && one.text.includes('timeline unreadable'))).toBe(true)
  })

  test('no turn yet: the empty line and no buttons', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    await $.session.start(SESSION)
    await $.command.run(command('timeline'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect(textOf(await ui.drawn())).toContain('从本次加载起记录；还没有模型请求')
    expect(await ui.find({ key: 'timeline-prev' })).toBeUndefined()
    expect(await ui.find({ key: 'timeline-latest' })).toBeUndefined()
    await ui.unmount()
  })

  test('the redraw timer runs while the page shows a turn not ended, and stops once it ends', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const ticks = writes(on, 'tick')

    seat(on)
    stepper(on)
    await $.session.start(SESSION)
    await $.command.run(command('timeline'))
    await mainTurn($, 'm1', 1, true)

    const running = ticks()

    await clock.advance(3_000)
    expect(ticks() - running, 'a running turn: redrawn every second').toBeGreaterThanOrEqual(3)

    await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 'm1', reason: 'answer' } as never)
    await clock.advance(2_000)

    const ended = ticks()

    await clock.advance(3_000)
    expect(ticks() - ended, 'ended: no more ticks').toBe(0)
  })
})

describe('overview layout', () => {
  test('需要你, 运行中 right-aligned, 已完成 folded into one line with buttons; empty sections not drawn', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R1}/grok.status`] = { text: 'DONE\n', mtimeMs: NOW + 1_000 }

    const world = seat(on, files)

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.agent.spawn(SPAWN as never)
    await $.turn.complete(complete('a1', 'error'))
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn(SPAWN as never)
    await $.turn.complete(complete('a3'))
    await $.command.run(command('dashboard'))

    const lines = rowsOf(await $.ui.render(PANE)).slice(1)

    expect(lines.slice(0, 8)).toEqual([
      expect.stringMatching(/^! 需要你1 · ● 运行2 · 待读2 · 更新 \d+s前$/),
      '需要你 · 1',
      '✗ 1: worker  Build mm plugin  1s  500 out  出错',
      '运行中 · 2',
      expect.stringMatching(/^● 2: 运行 worker · Build mm plugin +0 tools  0s$/),
      expect.stringMatching(/^● 运行 design \/ codex +4m15s$/),
      '已完成',
      '✓ 已返回 1 · ✓ 外审完成 1 [ 看 Agents ] [ 看外审 ]',
    ])
    expect(widthOf(lines[4] ?? ''), 'the time column ends at the pane edge').toBe(70)
    expect(widthOf(lines[5] ?? '')).toBe(70)

    const text = lines.join('\n')

    for (const gone of ['待处理', '最近门禁', '工作树']) {
      expect(text, gone).not.toContain(gone)
    }

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect((await ui.find({ key: 'overview-mmrun' }))?.props).toMatchObject({ label: '看外审' })
    await ui.press({ key: 'overview-agents' })
    expect((await ui.find({ key: 'page-agents' }))?.props, '看 Agents goes to the Agents page').toMatchObject({ variant: 'primary' })
    await ui.press({ key: 'page-overview' })
    expect(await ui.find({ type: 'Text', text: '已返回' }), 'visiting Agents read the returned one').toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '✓ 外审完成 1' })).toBeDefined()
    await ui.unmount()
  })

  test('a running agent quiet for two minutes reads 静默 on the band and the overview, and is not 需要你', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })

    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await clock.advance(60_000)
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/x.md' }, 'a1'))
    await clock.advance(119_000)
    expect(textOf(await $.ui.render(BAND))).not.toContain('静默')

    await clock.advance(1_000)
    expect(textOf(await $.ui.render(BAND))).toContain('Read x.md  静默 2m00s')

    await $.command.run(command('dashboard'))

    const lines = rowsOf(await $.ui.render(PANE))

    expect(lines[2]).toBe('运行中 · 1')
    expect(lines[3]).toMatch(/^◐ 静默 2m00s 1: worker · Build mm plugin +1 tools  3m00s$/)
  })

  test('idle: one gray line, then the last three that ended, agents and models by end time', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW - 60_000 }

    seat(on, files)
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.agent.spawn(SPAWN as never)
    await clock.advance(5_000)
    await $.turn.complete(complete('a1'))
    await $.command.run(command('subagents'))

    for (const cmd of ['bun test a', 'bun test b', 'bun test c', 'bun test d']) {
      await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: cmd }, tool_response: { stdout: BUN_OK, stderr: '', interrupted: false }, tool_use_id: 'toolu_g', cwd: '/work' } as never)
    }

    await clock.advance(10_000)

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await ui.press({ key: 'page-overview' })

    const lines = linesOf(await $.ui.render(PANE))

    expect(lines.slice(0, 4)).toEqual([
      '没有需要你处理或运行中的任务',
      '✓ worker · Build mm plugin · 10s 前',
      expect.stringMatching(/^✓ design \/ codex · 1m1\ds 前$/),
      expect.stringMatching(/^✓ design \/ grok · 2m1\ds 前$/),
    ])
    expect(lines[4]).toBe('最近门禁')
    expect(lines.filter(line => line.includes('bun test'))).toHaveLength(3)
    expect(lines.join('\n')).not.toContain('bun test a')
    expect((await ui.find({ type: 'Text', text: '没有需要你处理或运行中的任务' }))?.props).toMatchObject({ dimColor: true })
    expect((await ui.find({ type: 'Text', text: 'design / grok' }))?.props).toMatchObject({ dimColor: true })
    await ui.unmount()
  })
})

describe('mmrun runs', () => {
  test('reads the 24 h window from ~/.claude/mmruns, never a .raw, and draws a band line per active run', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    expect(rowsOf(await $.ui.render(PANE)).slice(1).map(line => line.replace(/ +/g, ' ').trim())).toEqual([
      'design · review aaaa proj [ Read ]',
      '● codex RUNNING 4m15s — tok',
      '✓ grok DONE 5m02s 25.8k tok',
      '- · review cccc proj [ Read ]',
      '✗ agy FAIL:1 1m40s — tok',
    ])
    expect(world.reads.some(path => path.endsWith('.raw'))).toBe(false)
    expect(linesOf(await $.ui.render(BAND))[0], 'R3 failed before the session: read already').toBe('design · codex ● 4m15s · grok ✓ 5m02s')
    expect(world.toasts).toEqual([])
  })

  test('model names and pids from run files never leave the run directory or reach kill unchecked', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R1}/run.meta`] = { text: runMeta(R1, 'design', 'codex,../../../../etc/x,grok'), mtimeMs: NOW - 300_000 }
    files[`${R1}/codex.pid`] = { text: '-1\n' }

    const world = seat(on, files)

    await $.session.start(SESSION)
    await clock.advance(3_000)

    expect(world.reads.filter(path => path.includes('..'))).toEqual([])
    expect(world.kills).toEqual([])
  })

  test('a model leaving RUNNING toasts once; several in one poll make one toast; the first load none', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R1}/grok.status`] = { text: 'RUNNING\n' }
    files[`${R1}/grok.pid`] = { text: '222\n' }
    delete files[`${R1}/grok.meta`]

    const world = seat(on, files)

    world.alive.add('111')
    world.alive.add('222')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    expect(world.toasts).toEqual([])
    expect(linesOf(await $.ui.render(BAND))[0]).toMatch(/^design · codex ● \S+ · grok ● \S+$/)

    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 4_000 }
    await clock.advance(3_000)
    expect(world.toasts).toEqual(['design：codex 已返回，grok 仍在运行'])

    world.alive.delete('222')
    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 4_000 }
    await clock.advance(3_000)
    expect(world.toasts).toEqual(['design：codex 已返回，grok 仍在运行', 'design：grok 已失联 STALE'])
    expect(textOf(await $.ui.render(BAND))).toContain('grok ✗ STALE')

    await clock.advance(30_000)
    expect(world.toasts).toHaveLength(2)
  })

  test('two models ending in the same poll share one toast', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R1}/grok.status`] = { text: 'RUNNING\n' }
    files[`${R1}/grok.pid`] = { text: '222\n' }

    const world = seat(on, files)

    world.alive.add('111')
    world.alive.add('222')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 4_000 }
    files[`${R1}/grok.status`] = { text: 'FAIL:2\n', mtimeMs: NOW + 4_500 }
    await clock.advance(3_000)
    expect(world.toasts).toEqual(['design：codex 已返回、grok 失败 FAIL:2'])
  })

  test('a model rewritten STALE long after its last output ends then, so it is not new on the band', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R3}/agy.status`] = { text: 'STALE\n', mtimeMs: NOW + 1_000 }
    files[`${R3}/agy.raw`] = { text: 'never read', mtimeMs: NOW - 3_650_000 }

    const world = seat(on, files)

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)

    expect(textOf(await $.ui.render(BAND))).not.toContain('agy')
  })

  test('a model still marked RUNNING whose worker died long ago ends at its last output, so it is not new on the band', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R3}/agy.status`] = { text: 'RUNNING\n', mtimeMs: NOW - 3_600_000 }
    files[`${R3}/agy.pid`] = { text: '333\n' }
    files[`${R3}/agy.raw`] = { text: 'never read', mtimeMs: NOW - 3_650_000 }

    const world = seat(on, files)

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)

    expect(textOf(await $.ui.render(BAND))).not.toContain('agy')
  })

  test('a listing that fails keeps the runs it had and says so above them; a poll that reads again clears it', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    for (const [path, refusal] of [[ROOT, "EACCES: permission denied, scandir '/h/.claude/mmruns'\nsecond line"], [`${ROOT}/${R1}`, 'EIO: i/o error']] as const) {
      world.listDenied[path] = refusal
      await clock.advance(3_000)

      for (const surface of ['terminal', 'desktop'] as const) {
        const tree = await $.ui.render({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 120 } })
        const lines = linesOf(tree)
        const warning = lines.find(line => line.startsWith('~ 读不到 ~/.claude/mmruns：'))

        expect(warning, `${surface}: ${path}`).toContain(refusal.split('\n')[0])
        expect(warning).not.toContain('second line')
        expect(colorsOf(tree, warning ?? '')).toEqual(['warning'])
        expect(lines.indexOf(warning ?? ''), 'above the runs').toBeLessThan(lines.findIndex(line => line.includes('aaaa')))
        expect(textOf(tree), 'the runs read before stay').toContain('codex')
        expect(textOf(tree)).toContain('cccc')
      }

      delete world.listDenied[path]
      await clock.advance(3_000)
      expect(textOf(await $.ui.render(PANE))).not.toContain('读不到')
    }
  })

  test('no ~/.claude/mmruns at all is no runs, not a read failure', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    for (const surface of ['terminal', 'desktop'] as const) {
      const text = textOf(await $.ui.render({ ...PANE, surface }))

      expect(text).toContain('最近 24 小时没有 mmrun 运行')
      expect(text).not.toContain('读不到')
    }
  })

  test('外审 hands every run to the pane to scroll, each run one block with its 阅读 button', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const tree = await $.ui.render({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 3 } } })
    const blocks = boxesWithButton(tree).map(box => ['aaaa', 'cccc'].filter(tail => textOf(box).includes(tail))).filter(found => found.length > 0)

    expect(textOf(tree).replace(/ +/g, ' ')).toContain('agy FAIL:1')
    expect(blocks).toEqual([['aaaa'], ['cccc']])
  })

  test('a model ending while 外审 is on screen does not toast; on another page it does', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R1}/grok.status`] = { text: 'RUNNING\n' }
    files[`${R1}/grok.pid`] = { text: '222\n' }
    delete files[`${R1}/grok.meta`]

    const world = seat(on, files)

    world.alive.add('111')
    world.alive.add('222')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))
    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 4_000 }
    await clock.advance(3_000)
    expect(world.toasts).toEqual([])

    await $.command.run(command('subagents'))
    world.alive.delete('222')
    await clock.advance(3_000)
    expect(world.toasts).toEqual(['design：grok 已失联 STALE'])
  })

  test('a poll with nothing running and nothing changed leaves the runs unwritten; a running model is written every poll', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const world = seat(on, files)
    const written = writes(on, 'runs')

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)

    const first = written()

    await clock.advance(3_000)
    expect(written(), 'codex running').toBe(first + 1)

    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 7_000 }
    await clock.advance(3_000)

    const ended = written()

    expect(ended).toBe(first + 2)
    await clock.advance(40_000)
    expect(written(), 'idle polls found the same runs').toBe(ended)
  })

  test('provisional-state-cached: a run read before its models settled is read again until every model is final', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    // R4 lists no model yet; R1's grok started past the pid grace with no status or pid file: STALE.
    const files: Files = {
      [`${R4}/run.meta`]: { text: runMeta(R4, 'early', ''), mtimeMs: NOW - 60_000 },
      [`${R1}/run.meta`]: { text: runMeta(R1, 'design', 'grok'), mtimeMs: NOW - 300_000 },
      [`${R1}/grok.started`]: { text: `${(NOW - 120_000) / 1000}\n` },
    }

    seat(on, files)
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const rows = async () => rowsOf(await $.ui.render(PANE)).map(line => line.replace(/ +/g, ' ').trim())

    const before = await rows()

    expect(before.some(row => row.includes('grok STALE')), before.join('\n')).toBe(true)
    expect(before.some(row => row.includes('codex')), before.join('\n')).toBe(false)

    files[`${R4}/run.meta`] = { text: runMeta(R4, 'early', 'codex'), mtimeMs: NOW - 60_000 }
    files[`${R4}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 5_000 }
    files[`${R1}/grok.status`] = { text: 'DONE\n', mtimeMs: NOW + 5_000 }
    await clock.advance(16_000)

    const after = await rows()

    expect(after.some(row => row.startsWith('✓ codex DONE')), after.join('\n')).toBe(true)
    expect(after.some(row => row.startsWith('✓ grok DONE')), after.join('\n')).toBe(true)
  })

  test('stale-open-report: the open report of a running review reloads once a model ends, and only then', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const world = seat(on, files)
    const codexJson = () => world.reads.filter(path => path === `${ROOT}/${R1}/codex.json`).length

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await ui.press({ key: `read-run-${R1}` })
    expect(await ui.find({ type: 'Markdown', text: /CLAIM-NEW/ })).toBeUndefined()

    files[`${R1}/codex.json`] = { text: JSON.stringify({ verdict: 'needs_changes', summary: 's', findings: [{ severity: 'major', file: 'a.ts', line: 1, claim: 'CLAIM-NEW', quote: 'q', failure_scenario: 'f' }] }) }
    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 4_000 }
    await clock.advance(3_000)
    expect(await ui.find({ type: 'Markdown', text: /CLAIM-NEW/ })).toBeDefined()

    const loaded = codexJson()

    await clock.advance(40_000)
    expect(codexJson(), 'nothing changed: no reload').toBe(loaded)
    await ui.unmount()
  })

  test('a reload begun before the severity toggle lands after it without undoing it: body and button agree', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const world = seat(on, files)
    let release = () => {}
    let isHeld = false

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await ui.press({ key: `read-run-${R1}` })
    files[`${R1}/codex.json`] = { text: JSON.stringify({ verdict: 'needs_changes', summary: 's', findings: [{ severity: 'minor', file: 'a.ts', line: 1, claim: 'CLAIM-MINOR', quote: 'q', failure_scenario: 'f' }] }) }
    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 4_000 }
    world.beforeRead = path => {
      if (isHeld || path !== `${ROOT}/${R1}/codex.json`) {
        return Promise.resolve()
      }

      isHeld = true

      return new Promise(resolve => {
        release = resolve
      })
    }
    await clock.advance(3_000)
    expect(isHeld, 'the tick reload waits on codex.json').toBe(true)

    await ui.press({ key: 'dash-severity' })
    release()
    await clock.settle()
    expect(await ui.find({ type: 'Markdown', text: /CLAIM-MINOR/ })).toBeDefined()
    expect((await ui.find({ key: 'dash-severity' }))?.props.label).toBe('只看 Critical/Major')
    await ui.unmount()
  })
})

describe('gpu page', () => {
  test('/gpu opens the GPU page on one ssh that sends a sample every 3 s, ended on another page or once the pane closes', { options: { language: 'zh-CN' }, timeoutMs: 15_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on, {}, clock)

    await $.session.start(SESSION)
    await $.command.run(command('gpu', 'gpu-box'))
    await clock.settle()

    expect(world.opened).toEqual([{ id: 'dashboard', title: '工作台' }])
    expect(world.spawns).toHaveLength(1)
    expect(world.spawns[0]?.at(-2)).toBe('gpu-box')

    const tegra = textOf(await $.ui.render(PANE))

    expect(tegra).toContain('GPU · gpu-box')
    expect(tegra).toContain('GR3D ')
    expect(tegra).toContain('37%')
    expect(tegra).toContain('RAM 5.0/29.8 GiB')
    expect(tegra).toContain('46°C')

    await clock.advance(6_000)
    expect(world.samples).toBe(3)
    expect(world.spawns, 'one connection').toHaveLength(1)

    await $.command.run(command('subagents'))
    await clock.settle()
    expect(world.killed, 'another page ends the ssh').toBe(1)

    await clock.advance(9_000)
    expect(world.samples, 'nothing read on another page').toBe(3)

    await $.command.run(command('gpu'))
    await clock.settle()
    expect(world.spawns).toHaveLength(2)
    expect(world.samples).toBe(4)

    // The test engine cannot raise the person's close; the pane leaving the engine's list is the same signal to the stream.
    world.panes.delete('dashboard')
    await clock.advance(9_000)
    expect(world.killed, 'the next pass finds the pane gone and ends the ssh').toBe(2)
    expect(world.samples).toBe(5)
    expect(world.spawns).toHaveLength(2)
  })

  test('pane-existence-as-visibility: the GPU page behind another tab ends its ssh at the next pass; drawn on screen again, it connects again', { options: { language: 'zh-CN' }, timeoutMs: 15_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on, {}, clock)

    await $.session.start(SESSION)
    await $.command.run(command('gpu', 'gpu-box'))
    await clock.settle()
    expect(world.samples).toBe(1)

    world.hidden.add('dashboard')
    await clock.advance(9_000)
    expect(world.killed, 'the next pass finds the pane hidden and ends the ssh').toBe(1)
    expect(world.samples).toBe(2)
    expect(world.spawns).toHaveLength(1)

    world.hidden.delete('dashboard')
    await $.ui.render(PANE)
    await clock.settle()
    expect(world.spawns, 'shown again: a new ssh').toHaveLength(2)
    expect(world.samples).toBe(3)

    await $.ui.render(PANE)
    await clock.settle()
    expect(world.spawns, 'a drawing while it runs adds none').toHaveLength(2)
  })

  test('nvidia rows with a bar, the top processes, and an NVML error', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on, {}, clock)

    world.stdout = NVIDIA_RUN
    await $.session.start(SESSION)
    await $.command.run(command('gpu', 'lab-box'))
    await clock.settle()

    const rows = textOf(await $.ui.render(PANE))

    expect(rows).toContain('0  RTX 4090  ▇')
    expect(rows).toContain('52%  18.2/24.0 GiB  67°C  280W')
    expect(rows).toContain('4242')
    expect(rows).toContain('python3')

    world.stdout = NVML_RUN
    await clock.advance(3_000)

    const tree = await $.ui.render(PANE)

    expect(linesOf(tree).slice(0, 3)).toEqual(['GPU · lab-box', '~ stale · last success 3s ago', '✗ Failed to initialize NVML: Driver/library version mismatch'])
    expect(colorsOf(tree, '~ stale · last success 3s ago')).toEqual(['warning'])
    expect(textOf(tree), 'the last good sample stays').toContain('52%  18.2/24.0 GiB  67°C  280W')
    expect(isDimText(tree, '52%  18.2/24.0 GiB'), 'and is dim').toBe(true)
    expect(isDimText(tree, 'python3')).toBe(true)
  })

  test('zh-CN: /gpu replies and the GPU page lines are Chinese', { options: { language: 'zh-CN' }, timeoutMs: 15_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on, {}, clock)

    await $.session.start(SESSION)
    expect((await $.command.run(command('gpu'))).text).toBe('用法：/gpu <host>')
    expect((await $.command.run(command('gpu', '-oProxyCommand=x'))).text).toBe('不是主机名：-oProxyCommand=x')

    world.stdout = NVML_RUN
    expect((await $.command.run(command('gpu', 'lab-box'))).text).toBeUndefined()
    await clock.settle()
    expect(textOf(await $.ui.render(PANE))).toContain('还没有成功的采样')

    world.stdout = '@@NOGPU'
    await clock.advance(3_000)
    expect(textOf(await $.ui.render(PANE))).toContain('此主机上没有 GPU。')

    world.stdout = NVIDIA_RUN
    await clock.advance(3_000)
    expect(textOf(await $.ui.render(PANE))).toContain('显存占用最多的进程')

    world.stdout = NVML_RUN
    await clock.advance(3_000)
    expect(textOf(await $.ui.render(PANE))).toContain('~ 数据过期 · 上次成功 3s 前')
    expect(textOf(await $.ui.render(PANE)), 'the last good sample stays').toContain('显存占用最多的进程')
  })

  test('/gpu with a host that looks like an option is refused', async ($, on) => {
    mock.clock(on)

    const world = seat(on)

    await $.session.start(SESSION)
    expect((await $.command.run(command('gpu', '-oProxyCommand=x'))).text).toContain('Not a host name')
    expect(world.opened).toEqual([])
  })

  test('a Bash ssh call to a listed host opens the GPU page once; other commands do not', { options: { gpuHosts: 'gpu-box, lab-box', language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.ui.render(BAND)

    for (const cmd of ['echo ssh gpu-box', 'ssh other nvidia-smi', 'ls']) {
      await $.classic.PostToolUse(ran('Bash', { command: cmd }))
    }

    await $.classic.PostToolUse(ran('Read', { command: 'ssh gpu-box' }))
    expect(await $.tool.call({ tool: 'Bash', command: 'ssh gpu-box ls' } as never), 'no tool.call hook stands in the way of Bash').toMatchObject({ text: 'ok' })
    await clock.settle()
    expect(world.opened).toEqual([])

    await $.classic.PostToolUse(ran('Bash', { command: 'ssh gpu-box nvidia-smi' }))
    await clock.settle()
    await $.classic.PostToolUse(ran('Bash', { command: 'ssh -p 22 gpu-box ls' }))
    await clock.settle()
    expect(world.opened).toEqual([{ id: 'dashboard', title: '工作台' }])

    await $.classic.PostToolUse(ran('Bash', { command: 'ssh -o BatchMode=yes lab-box ls' }))
    await clock.settle()
    expect(world.spawns.at(-1)?.at(-2), 'on the GPU page the new host replaces the old').toBe('lab-box')
    expect(world.killed, 'and its ssh ends').toBe(1)
    expect(world.opened).toHaveLength(1)
  })

  test('an ssh call opens nothing unasked where a pane would take over the screen, or before any drawing said', { options: { gpuHosts: 'gpu-box', language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.classic.PostToolUse(ran('Bash', { command: 'ssh gpu-box ls' }))
    await clock.settle()
    expect(world.opened, 'nothing drawn yet').toEqual([])

    await $.ui.render({ ...BAND, viewport: { columns: 120, rows: 40, isFullscreen: false } })
    await $.classic.PostToolUse(ran('Bash', { command: 'ssh gpu-box ls' }))
    await clock.settle()
    expect(world.opened, 'the main screen').toEqual([])

    await $.command.run(command('gpu', 'gpu-box'))
    await clock.settle()
    expect(world.opened, 'asked: opens').toHaveLength(1)
  })

  test('an ssh call leaves another page alone, and once the person closes the pane it never opens unasked', { options: { gpuHosts: 'gpu-box', language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.command.run(command('subagents'))
    await $.classic.PostToolUse(ran('Bash', { command: 'ssh gpu-box ls' }))
    await clock.settle()
    expect(textOf(await $.ui.render(PANE)), 'still on Agents').not.toContain('GPU · gpu-box')
    expect(world.spawns).toHaveLength(0)

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect((await ui.find({ key: 'dash-close' }))?.props).toMatchObject({ label: '关闭' })
    expect((await ui.find({ key: 'dash-close' }))?.props.hotkey).toBeUndefined()
    await ui.press({ key: 'dash-close' })
    await ui.unmount()
    expect(world.panes.size).toBe(0)

    await $.classic.PostToolUse(ran('Bash', { command: 'ssh gpu-box ls' }))
    await clock.settle()
    expect(world.opened).toHaveLength(1)
    expect(world.panes.size).toBe(0)

    await $.command.run(command('gpu', 'gpu-box'))
    await clock.settle()
    expect(world.opened, 'asked: opens').toHaveLength(2)
  })
  test('a dropped ssh keeps the last sample dim under its error, and connects again 3 s, 6 s, 12 s … at most 60 s later', { options: { language: 'zh-CN' }, timeoutMs: 15_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on, {}, clock)

    world.stdout = NVIDIA_RUN
    await $.session.start(SESSION)
    await $.command.run(command('gpu', 'lab-box'))
    await clock.settle()
    world.sshDown = 'Connection to lab-box closed by remote host.'
    await clock.advance(3_000)

    const tree = await $.ui.render(PANE)

    expect(linesOf(tree).slice(0, 3)).toEqual(['GPU · lab-box', '~ 数据过期 · 上次成功 3s 前', '✗ Connection to lab-box closed by remote host.'])
    expect(isDimText(tree, '52%  18.2/24.0 GiB'), 'the last sample stays, dim').toBe(true)

    await clock.advance(214_000)
    expect(world.spawnedAt).toEqual([1_000, 7_000, 13_000, 25_000, 49_000, 97_000, 157_000, 217_000])
    expect(world.killed).toBe(0)

    world.sshDown = null
    await clock.advance(60_000)
    expect(world.spawnedAt.at(-1)).toBe(277_000)
    expect(textOf(await $.ui.render(PANE)), 'a sample again: no longer stale').not.toContain('数据过期')

    world.sshDown = 'Connection to lab-box closed by remote host.'
    await clock.advance(3_000)
    await clock.advance(3_000)
    expect(world.spawnedAt.at(-1), 'a sample since: the wait starts again at 3 s').toBe(283_000)
  })

  test('the session ending ends the GPU ssh; a /clear leaves it', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.command.run(command('gpu', 'lab-box'))
    await clock.settle()
    await $.session.end({ reason: 'clear', sessionId: 'me' } as never)
    await clock.settle()
    expect(world.killed).toBe(0)

    await $.session.end({ reason: 'other', sessionId: 'me' } as never)
    await clock.settle()
    expect(world.killed).toBe(1)
  })
})

describe('other sessions', () => {
  test('prompt.submit writes working, the main turn.complete replied, a heartbeat every 30 s; a subagent turn.complete leaves the file alone', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    expect(mine(world)).toMatchObject({ id: 'me', name: 'harness', state: 'idle', since: NOW, updatedAt: NOW })

    await clock.advance(1_000)
    await $.prompt.submit(PROMPT)
    expect(mine(world)).toMatchObject({ state: 'working', since: NOW + 1_000, turnStartedAt: NOW + 1_000 })

    await $.agent.spawn(SPAWN as never)

    const before = world.sessions['me.json']

    await $.turn.complete(complete('a1'))
    expect(world.sessions['me.json'], 'a subagent turn').toBe(before)

    await clock.advance(2_000)
    await $.turn.complete({ answer: 'done', durationMs: 2_000, isAborted: false, turnId: 't', reason: 'answer', usage: usage(10) } as never)
    expect(mine(world)).toMatchObject({ state: 'replied', since: NOW + 3_000, turnStartedAt: NOW + 1_000 })

    await clock.advance(30_000)
    expect(mine(world)).toMatchObject({ state: 'replied', since: NOW + 3_000, updatedAt: NOW + 30_000 })

    await $.session.end({ reason: 'other', sessionId: 'me', resume: {} } as never)
    expect(mine(world)).toMatchObject({ state: 'ended' })
  })

  test('a main-thread PermissionRequest writes permission and the tool; the next main-thread tool result writes working', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await clock.advance(1_000)
    await $.classic.PermissionRequest({ tool_name: 'Write', tool_input: {}, agent_id: 'a9' } as never)
    expect(mine(world), 'a subagent asking').toMatchObject({ state: 'permission', detail: 'a9: Write' })

    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm x' } } as never)
    expect(mine(world)).toMatchObject({ state: 'permission', detail: 'Bash', since: NOW + 1_000, turnStartedAt: NOW })

    await $.classic.PostToolUse(ran('Read', { file_path: '/w/x' }, 'a9'))
    expect(mine(world)).toMatchObject({ state: 'permission' })

    await clock.advance(1_000)
    await $.classic.PostToolUse(ran('Bash', { command: 'rm x' }))
    expect(mine(world)).toMatchObject({ state: 'working', since: NOW + 2_000, turnStartedAt: NOW })
    expect(mine(world)?.detail).toBeUndefined()
  })

  test('a subagent asking marks the session permission with its type and the tool; its own tool result answers it, another agent\'s does not', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await $.agent.spawn({ ...SPAWN, background: false } as never)
    await clock.advance(1_000)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {}, agent_id: 'a1' } as never)
    expect(mine(world)).toMatchObject({ state: 'permission', detail: 'worker: Bash', since: NOW + 1_000, turnStartedAt: NOW })

    await $.classic.PostToolUse(ran('Read', { file_path: '/w/x' }, 'b2'))
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/x' }))
    expect(mine(world), 'another agent and the main thread').toMatchObject({ state: 'permission' })

    await clock.advance(1_000)
    await $.classic.PostToolUse(ran('Bash', { command: 'ls' }, 'a1'))
    expect(mine(world)).toMatchObject({ state: 'working', since: NOW + 2_000, turnStartedAt: NOW })

    await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: {}, agent_id: 'f00dcafe1234' } as never)
    expect(mine(world), 'not in the agents list: its id cut to 8').toMatchObject({ state: 'permission', detail: 'f00dcafe: Edit' })

    await $.classic.PermissionDenied(denied('Edit', 'f00dcafe1234'))
    expect(mine(world)).toMatchObject({ state: 'working' })
  })

  test('a PermissionRequest the settings hooks beneath already decided asks nobody: the session stays working', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await clock.advance(1_000)
    world.decision = { behavior: 'allow' }
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    expect(mine(world)).toMatchObject({ state: 'working', since: NOW })

    world.decision = { behavior: 'deny', message: 'no' }
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {}, agent_id: 'a9' } as never)
    expect(mine(world)).toMatchObject({ state: 'working', since: NOW })

    world.decision = undefined
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    expect(mine(world)).toMatchObject({ state: 'permission', detail: 'Bash', since: NOW + 1_000 })
  })

  test('a reload mid-turn keeps the presence the session had: session.start again leaves state and since alone', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await clock.advance(1_000)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    await clock.advance(1_000)
    await $.session.start(SESSION)
    expect(mine(world), 'asking').toMatchObject({ state: 'permission', detail: 'Bash', since: NOW + 1_000, turnStartedAt: NOW })

    await $.classic.PostToolUse(ran('Bash', { command: 'ls' }))
    await clock.advance(1_000)
    await $.session.start(SESSION)
    expect(mine(world), 'working').toMatchObject({ state: 'working', since: NOW + 2_000, turnStartedAt: NOW })
  })

  test('a main Stop with background work in flight leaves the session working, before or after turn.complete; with none it is replied', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const TASK = { id: 'w1', type: 'subagent', status: 'running', description: 'worker', agent_type: 'worker' }
    const stop = (background_tasks: unknown[]) => $.classic.Stop({ stop_hook_active: false, background_tasks } as never)
    const reply = () => $.turn.complete({ answer: 'done', durationMs: 2_000, isAborted: false, turnId: 't', reason: 'answer', usage: usage(10) } as never)
    const turn = async (n: number) => {
      await $.prompt.submit(PROMPT)
      await $.turn.start({ text: 'go', turnId: `t${n}` } as never)
      await clock.advance(1_000)
    }

    await $.session.start(SESSION)
    await turn(1)
    await stop([TASK])
    await reply()
    expect(mine(world), 'Stop first').toMatchObject({ state: 'working' })

    await turn(2)
    await reply()
    await stop([TASK])
    expect(mine(world), 'turn.complete first').toMatchObject({ state: 'working' })

    await turn(3)
    await stop([])
    await reply()
    expect(mine(world), 'Stop first, nothing in flight').toMatchObject({ state: 'replied' })

    await turn(4)
    await reply()
    await stop([])
    expect(mine(world), 'turn.complete first, nothing in flight').toMatchObject({ state: 'replied' })

    await $.classic.Stop({ stop_hook_active: false, background_tasks: [TASK], agent_id: 'a1' } as never)
    expect(mine(world), 'a subagent\'s Stop').toMatchObject({ state: 'replied' })
  })

  test('another session waiting on a permission draws its ! in warning, on the band, in its summary and on the overview', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'permission', NOW - 1_000, { name: 'mm', detail: 'Bash', updatedAt: NOW })
    world.sessions['p2.json'] = peer('p2', 'permission', NOW - 1_000, { name: 'ui', detail: 'Edit', updatedAt: NOW })
    world.sessions['p3.json'] = peer('p3', 'permission', NOW - 1_000, { name: 'web', detail: 'Write', updatedAt: NOW })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    expect(colorsOf(await $.ui.render(BAND), '!')).toEqual(['warning', 'warning', 'warning'])
    expect(linesOf(await $.ui.render(bandOf(2))).slice(0, 2)).toEqual(['! mm 待授权 Bash · 6s', '会话 !2'])
    expect(colorsOf(await $.ui.render(bandOf(2)), '!'), 'a line, then the group of the other two').toEqual(['warning', 'warning'])

    await $.command.run(command('dashboard'))
    expect(colorsOf(await $.ui.render(PANE), '!')).toEqual(['warning', 'warning', 'warning'])
  })

  test('another session waiting on a permission is a 需要你 row and 等你1; working ones count as running; 90 s without a heartbeat or ended is gone', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'permission', NOW - 180_000, { name: 'mm', detail: 'Bash', turnStartedAt: NOW - 200_000, updatedAt: NOW })
    world.sessions['p2.json'] = peer('p2', 'permission', NOW - 60_000, { name: 'old', detail: 'Edit', updatedAt: NOW - 86_000 })
    world.sessions['p3.json'] = peer('p3', 'ended', NOW - 1_000, { updatedAt: NOW })
    world.sessions['p4.json'] = peer('p4', 'working', NOW - 65_000, { name: 'ui', title: 'fix band', turnStartedAt: NOW - 65_000, updatedAt: NOW })
    await $.session.start(SESSION)
    await clock.advance(5_000)

    expect(linesOf(await $.ui.render(BAND))).toEqual(['! mm 待授权 Bash · 3m05s', 'engine band'])

    await $.command.run(command('dashboard'))

    const lines = linesOf(await $.ui.render(PANE))

    expect(lines.slice(0, 3)).toEqual(['其他会话 · 2', expect.stringMatching(/^! 待授权 mm +3m05s$/), expect.stringMatching(/^● 进行中 ui · fix band +1m10s$/)])
    expect(widthOf(lines[1] ?? ''), 'the copy button after it ends at the pane edge').toBe(70 - widthOf('[ 复制 resume ]') - 1)
    expect(lines.join('\n')).not.toContain('old')

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface: 'desktop' } as never)

    expect(await ui.find({ type: 'Text', text: '其他会话  2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ui · fix band' })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: '! 待授权' })).map(one => one.props.color), 'waiting on a permission is no failure: yellow').toContain('warning')
    await ui.unmount()
  })

  test('a session entering permission, or replying after a long turn, toasts once; a short turn does not', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'working', NOW - 1_000, { name: 'mm', turnStartedAt: NOW - 1_000 })
    world.sessions['p2.json'] = peer('p2', 'working', NOW - 1_000, { turnStartedAt: NOW - 1_000 })
    world.sessions['p3.json'] = peer('p3', 'working', NOW - 1_000, { name: 'ui', turnStartedAt: NOW + 15_000 - 720_000 })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    expect(world.toasts).toEqual([])

    world.sessions['p1.json'] = peer('p1', 'permission', NOW + 5_000, { name: 'mm', detail: 'Bash', turnStartedAt: NOW - 1_000 })
    world.sessions['p2.json'] = peer('p2', 'replied', NOW + 5_000, { turnStartedAt: NOW - 1_000 })
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['mm 等你授权：Bash'])

    await clock.advance(5_000)
    expect(world.toasts, 'the same change polled again').toHaveLength(1)

    world.sessions['p3.json'] = peer('p3', 'replied', NOW + 15_000, { name: 'ui', turnStartedAt: NOW + 15_000 - 720_000 })
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['mm 等你授权：Bash', 'ui 已答复（这轮 12m00s）'])
  })

  test('a session replied 30 min ago or more no longer waits on you', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'replied', NOW - 29 * 60_000, { name: 'mm', updatedAt: NOW })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    await $.command.run(command('dashboard'))
    expect(textOf(await $.ui.render(PANE))).toContain('其他会话 · 1')

    world.sessions['p1.json'] = peer('p1', 'replied', NOW + 5_000 - 31 * 60_000, { name: 'mm', updatedAt: NOW + 5_000 })
    await clock.advance(5_000)
    expect(textOf(await $.ui.render(PANE))).not.toContain('其他会话')

    world.sessions['p1.json'] = peer('p1', 'replied', NOW + 10_000 - 29 * 60_000, { name: 'mm', updatedAt: NOW + 10_000 })
    await clock.advance(5_000)
    expect(textOf(await $.ui.render(PANE))).toContain('其他会话 · 1')
  })

  test('a second PermissionRequest with another tool rewrites the detail and toasts again; the same tool writes once', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    // Another session sees this one's file as `other.json`.
    const share = () => {
      world.sessions['other.json'] = world.sessions['me.json'] ?? ''
    }

    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    share()
    await clock.advance(5_000)

    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    share()
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['harness · go 等你授权：Bash'])

    const before = world.sessions['me.json']

    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    expect(world.sessions['me.json'], 'the same tool').toBe(before)

    await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: {} } as never)
    expect(mine(world)).toMatchObject({ state: 'permission', detail: 'Edit', since: NOW + 10_000 })
    share()
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['harness · go 等你授权：Bash', 'harness · go 等你授权：Edit'])
  })

  test('polls that find the same sessions write the peers once', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const written = writes(on, 'peers')

    world.sessions['p1.json'] = peer('p1', 'working', NOW - 1_000, { name: 'mm', turnStartedAt: NOW - 1_000 })
    await $.session.start(SESSION)
    await clock.advance(5_000)

    const first = written()

    expect(first).toBeGreaterThan(0)
    await clock.advance(15_000)
    expect(written()).toBe(first)

    world.sessions['p1.json'] = peer('p1', 'permission', NOW + 20_000, { name: 'mm', detail: 'Bash', turnStartedAt: NOW - 1_000 })
    await clock.advance(5_000)
    expect(written(), 'a change is written').toBe(first + 1)
  })

  test('this session\'s own file and idle sessions are not shown', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'idle', NOW - 1_000)
    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    await clock.advance(5_000)
    expect(mine(world)).toMatchObject({ state: 'permission' })
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)

    await $.command.run(command('dashboard'))
    expect(textOf(await $.ui.render(PANE))).not.toContain('其他会话')
  })

  test('a main turn ended by Esc is idle; by an error or a refusal failed, which a later Stop leaves alone until the next prompt; a cron is background work', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const end = (reason: string) => $.turn.complete({ answer: '', durationMs: 1_000, isAborted: reason === 'aborted', turnId: 't', reason, usage: usage(10) } as never)
    const stop = (more: Record<string, unknown> = {}) => $.classic.Stop({ stop_hook_active: false, background_tasks: [], ...more } as never)

    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await clock.advance(1_000)
    await end('aborted')
    expect(mine(world), 'Esc').toMatchObject({ state: 'idle' })
    await stop()
    expect(mine(world), 'a Stop after Esc').toMatchObject({ state: 'idle' })

    for (const reason of ['error', 'refusal']) {
      await $.prompt.submit(PROMPT)
      expect(mine(world)).toMatchObject({ state: 'working' })
      await clock.advance(1_000)
      await end(reason)
      expect(mine(world), reason).toMatchObject({ state: 'failed' })
      await stop()
      expect(mine(world), `a Stop after ${reason}`).toMatchObject({ state: 'failed' })
    }

    await $.prompt.submit(PROMPT)
    await stop({ session_crons: [{ id: 'c1', cron: '*/5 * * * *', prompt: 'check' }] })
    await end('answer')
    expect(mine(world), 'a cron wakes it later').toMatchObject({ state: 'working' })
  })

  test('another session whose turn failed is a red ✗ on the band and the overview, waits on you until its next prompt, and toasts once', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const names = ['mm', 'ui', 'web']

    names.forEach((name, i) => {
      world.sessions[`p${i}.json`] = peer(`p${i}`, 'working', NOW - 1_000, { name, title: 'fix band', turnStartedAt: NOW - 1_000 })
    })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    names.forEach((name, i) => {
      world.sessions[`p${i}.json`] = peer(`p${i}`, 'failed', NOW + 5_000 + i, { name, title: 'fix band', turnStartedAt: NOW - 1_000 })
    })
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['✗ mm · fix band 出错', '✗ ui · fix band 出错', '✗ web · fix band 出错'])
    expect(linesOf(await $.ui.render(BAND)).slice(0, 3)).toEqual(['✗ mm 出错 · 5s', '✗ ui 出错 · 4s', '✗ web 出错 · 4s'])
    expect(colorsOf(await $.ui.render(BAND), '✗')).toEqual(['error', 'error', 'error'])
    expect(linesOf(await $.ui.render(bandOf(2))).slice(0, 2)).toEqual(['✗ mm 出错 · 5s', '会话 ✗2'])
    expect(colorsOf(await $.ui.render(bandOf(2)), '✗'), 'a line, then the group of the other two').toEqual(['error', 'error'])
    expect(linesOf(await $.ui.render(bandOf(1)))[0]).toBe('等你3')

    await $.command.run(command('dashboard'))
    expect(linesOf(await $.ui.render(PANE)).slice(0, 2)).toEqual(['其他会话 · 3', expect.stringMatching(/^✗ 出错 mm · fix band +5s$/)])
    expect(colorsOf(await $.ui.render(PANE), '✗')).toEqual(['error', 'error', 'error'])

    await clock.advance(30 * 60_000)
    names.forEach((name, i) => {
      world.sessions[`p${i}.json`] = peer(`p${i}`, 'failed', NOW + 5_000 + i, { name, title: 'fix band', turnStartedAt: NOW - 1_000, updatedAt: NOW + 30 * 60_000 })
    })
    await clock.advance(5_000)
    expect(linesOf(await $.ui.render(bandOf(1)))[0], 'still waiting after 30 min').toBe('等你3')
    expect(world.toasts).toHaveLength(3)

    names.forEach((name, i) => {
      world.sessions[`p${i}.json`] = peer(`p${i}`, 'working', NOW + 30 * 60_000 + 5_000, { name, turnStartedAt: NOW + 30 * 60_000 + 5_000 })
    })
    await clock.advance(5_000)
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)
  })

  test('a session that went silent and came back toasts nothing again: neither the state it toasted nor a new one', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const asking = (since: number, detail: string, updatedAt = since) => peer('p1', 'permission', since, { name: 'mm', detail, turnStartedAt: NOW - 1_000, updatedAt })

    world.sessions['p1.json'] = peer('p1', 'working', NOW - 1_000, { name: 'mm', turnStartedAt: NOW - 1_000 })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    world.sessions['p1.json'] = asking(NOW + 5_000, 'Bash')
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['mm 等你授权：Bash'])

    await clock.advance(95_000)
    await $.command.run(command('dashboard'))
    expect(textOf(await $.ui.render(PANE)), 'silent past 90 s').not.toContain('其他会话')

    world.sessions['p1.json'] = asking(NOW + 5_000, 'Bash', NOW + 105_000)
    await clock.advance(5_000)
    expect(textOf(await $.ui.render(PANE))).toContain('其他会话 · 1')
    expect(world.toasts, 'back in the state it toasted').toHaveLength(1)

    delete world.sessions['p1.json']
    await clock.advance(5_000)
    world.sessions['p1.json'] = asking(NOW + 115_000, 'Edit')
    await clock.advance(5_000)
    expect(world.toasts, 'back in a new state').toHaveLength(1)

    world.sessions['p1.json'] = asking(NOW + 125_000, 'Write')
    await clock.advance(5_000)
    expect(world.toasts, 'a change while seen').toEqual(['mm 等你授权：Bash', 'mm 等你授权：Write'])
  })

  test('a session file silent past 90 s by its mtime is not read; one whose mtime did not move is read once', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const reads = (name: string) => world.reads.filter(path => path === `${SESSIONS}/${name}`).length

    world.sessions['p1.json'] = peer('p1', 'working', NOW - 100_000, { name: 'old' })
    world.sessions['p2.json'] = peer('p2', 'working', NOW - 1_000, { name: 'mm', updatedAt: NOW })
    await $.session.start(SESSION)
    await clock.advance(15_000)
    expect(reads('p1.json')).toBe(0)
    expect(reads('p2.json')).toBe(1)

    world.sessions['p2.json'] = peer('p2', 'permission', NOW + 15_000, { name: 'mm', detail: 'Bash' })
    await clock.advance(5_000)
    expect(reads('p2.json'), 'a new mtime').toBe(2)
  })

  test('a session file with a field missing or of the wrong kind is left out, never drawn as NaN', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = JSON.stringify({ id: 'p1', name: 'nosince', state: 'working', updatedAt: NOW })
    world.sessions['p2.json'] = JSON.stringify({ id: 'p2', name: 'badstate', state: 'asleep', since: NOW - 1_000, updatedAt: NOW })
    world.sessions['p3.json'] = JSON.stringify({ id: 3, name: 'badid', state: 'working', since: NOW - 1_000, updatedAt: NOW })
    world.sessions['p4.json'] = JSON.stringify({ id: 'p4', name: 'badtime', state: 'permission', since: 'soon', updatedAt: NOW })
    world.sessions['p5.json'] = peer('p5', 'working', NOW - 1_000, { name: 'ok', updatedAt: NOW })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    await $.command.run(command('dashboard'))

    const text = textOf(await $.ui.render(PANE)) + textOf(await $.ui.render(BAND))

    expect(text).toContain('其他会话 · 1')
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('nosince')
  })

  test('a toast names the session with its title; the first prompt titles a session that has none; a reply carries the first line of the last message', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const share = () => {
      world.sessions['other.json'] = world.sessions['me.json'] ?? ''
    }
    const ASK = '把 band 的会话行改成按状态排序，并且在每一行后面加上复制按钮，然后跑一遍测试'
    const SAID = '已把会话行按状态排序，复制按钮也加上了，全部测试通过，没有遗留问题需要你再处理，可以合并了。'

    await $.session.start(SESSION)
    await $.prompt.submit({ text: `${ASK}\n第二行`, wait: false, origin: { kind: 'composer' } } as never)
    expect(mine(world)?.title).toBe(fit(ASK, 40))
    expect(widthOf(String(mine(world)?.title))).toBeLessThanOrEqual(40)
    share()

    for (let i = 0; i < 4; i += 1) {
      await clock.advance(30_000)
      share()
    }

    await $.prompt.submit(PROMPT)
    expect(mine(world)?.title, 'a later prompt keeps it').toBe(fit(ASK, 40))
    await clock.advance(5_000)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], last_assistant_message: `${SAID}\n细节如下` } as never)
    await $.turn.complete({ answer: SAID, durationMs: 2_000, isAborted: false, turnId: 't', reason: 'answer', usage: usage(10) } as never)
    expect(mine(world)).toMatchObject({ state: 'replied', detail: fit(SAID, 60) })
    share()
    await clock.advance(5_000)
    expect(world.toasts).toEqual([`harness · ${fit(ASK, 40)} 已答复（这轮 2m05s）：${fit(SAID, 60)}`])
  })

  test('an other-sessions row copies `claude --resume \'<id>\'` and toasts 已复制, with no letter hotkey, on the terminal and the desktop', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'working', NOW - 1_000, { name: 'mm', updatedAt: NOW })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    await $.command.run(command('dashboard'))

    for (const surface of ['terminal', 'desktop']) {
      const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)
      const button = await ui.find({ key: 'copy-resume-p1' })

      expect(button?.props, surface).toMatchObject({ label: surface === 'terminal' ? '复制 resume' : '命令' })
      expect(button?.props.hotkey, surface).toBeUndefined()
      await ui.press({ key: 'copy-resume-p1' })
      await clock.settle()

      if (surface === 'desktop') {
        expect((await ui.findAll({ type: 'Code' })).map(one => one.props.source), 'the desktop shows the command instead').toContain("claude --resume 'p1'")
      }

      await ui.unmount()
    }

    expect(world.copies).toEqual(["claude --resume 'p1'"])
    expect(world.toasts).toEqual(['已复制'])
  })

  test('typing writes lastInputAt at most every 15 s; the heartbeat carries the latest; a prompt writes it with its state', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await clock.advance(1_000)
    await typeKey($)
    expect(mine(world)).toMatchObject({ lastInputAt: NOW + 1_000 })

    const first = world.sessions['me.json']

    await clock.advance(5_000)
    await typeKey($)
    expect(world.sessions['me.json'], 'within 15 s of the last write').toBe(first)

    await clock.advance(10_000)
    await typeKey($)
    expect(mine(world)).toMatchObject({ lastInputAt: NOW + 16_000 })

    await clock.advance(4_000)
    await typeKey($)
    expect(mine(world)?.lastInputAt).toBe(NOW + 16_000)

    await clock.advance(10_000)
    expect(mine(world), 'the heartbeat').toMatchObject({ lastInputAt: NOW + 20_000, updatedAt: NOW + 30_000 })

    await clock.advance(1_000)
    await $.prompt.submit(PROMPT)
    expect(mine(world)).toMatchObject({ state: 'working', lastInputAt: NOW + 31_000 })
  })

  test('automated-input-as-attention: a prompt the person did not send starts work but is no input; the person\'s own is', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await clock.advance(1_000)
    await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } } as never)
    expect(mine(world)).toMatchObject({ state: 'working' })
    expect(mine(world)?.lastInputAt, 'a task notification').toBeUndefined()

    await clock.advance(20_000)
    await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'peer' } } as never)
    await $.prompt.submit({ text: 'tick', wait: false, origin: { kind: 'scheduled-trigger' } } as never)
    await clock.advance(30_000)
    expect(mine(world)?.lastInputAt, 'a peer and a schedule, through a heartbeat').toBeUndefined()

    await $.prompt.submit(PROMPT)
    expect(mine(world)).toMatchObject({ lastInputAt: NOW + 51_000 })
  })

  test('only the session typed in last within 2 min toasts the other sessions; with no input for 2 min every session does', { options: { language: 'zh-CN', askSound: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    // Heartbeats far ahead keep both files read as live while the clock runs on.
    const mm = (state: string, since: number, detail: string) => peer('p1', state, since, { name: 'mm', detail, turnStartedAt: NOW - 1_000, updatedAt: since + 300_000 })

    world.sessions['p1.json'] = mm('working', NOW - 1_000, '')
    world.sessions['p2.json'] = peer('p2', 'idle', NOW - 1_000, { name: 'ui', lastInputAt: NOW + 1_000, updatedAt: NOW + 300_000 })
    await $.session.start(SESSION)
    await typeKey($)
    await clock.advance(5_000)
    world.sessions['p1.json'] = mm('permission', NOW + 5_000, 'Bash')
    await clock.advance(5_000)
    expect(world.toasts, 'ui was typed in after this one').toEqual([])
    expect(world.clips).toEqual([])

    await typeKey($)
    world.sessions['p1.json'] = mm('failed', NOW + 10_000, '')
    await clock.advance(5_000)
    expect(world.toasts, 'this one typed in last').toEqual(['✗ mm 出错'])

    await clock.advance(125_000)
    world.sessions['p1.json'] = mm('permission', NOW + 140_000, 'Edit')
    await clock.advance(5_000)
    expect(world.toasts, 'no input for 2 min').toEqual(['✗ mm 出错', 'mm 等你授权：Edit'])
  })

  test('askSound: a toast of a session asking or failed chimes once, a reply none, a clip that cannot play nothing', { options: { language: 'zh-CN', askSound: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const mm = (state: string, since: number, more: Record<string, unknown> = {}) => peer('p1', state, since, { name: 'mm', turnStartedAt: NOW - 600_000, ...more })

    world.sessions['p1.json'] = mm('working', NOW - 1_000)
    await $.session.start(SESSION)
    await clock.advance(5_000)
    world.sessions['p1.json'] = mm('permission', NOW + 5_000, { detail: 'Bash' })
    await clock.advance(5_000)
    expect(world.clips).toHaveLength(1)
    expect(world.clips[0], 'a WAV made in code').toMatch(/^UklGR/)

    await clock.advance(5_000)
    expect(world.clips, 'the same toast polled again').toHaveLength(1)

    world.sessions['p1.json'] = mm('replied', NOW + 15_000)
    await clock.advance(5_000)
    expect(world.toasts).toHaveLength(2)
    expect(world.clips, 'a reply').toHaveLength(1)

    world.isMuted = true
    world.sessions['p1.json'] = mm('failed', NOW + 20_000)
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['mm 等你授权：Bash', 'mm 已答复（这轮 10m15s）', '✗ mm 出错'])
    expect(world.clips).toHaveLength(2)
  })

  test('askSound is off unless set', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'working', NOW - 1_000, { name: 'mm' })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    world.sessions['p1.json'] = peer('p1', 'permission', NOW + 5_000, { name: 'mm', detail: 'Bash' })
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['mm 等你授权：Bash'])
    expect(world.clips).toEqual([])
  })

  test('toastPeerAsks off: a session asking or failed neither toasts nor chimes; a reply still toasts', { options: { language: 'zh-CN', askSound: true, toastPeerAsks: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const mm = (state: string, since: number, more: Record<string, unknown> = {}) => peer('p1', state, since, { name: 'mm', turnStartedAt: NOW - 600_000, ...more })

    world.sessions['p1.json'] = mm('working', NOW - 1_000)
    await $.session.start(SESSION)
    await clock.advance(5_000)
    world.sessions['p1.json'] = mm('permission', NOW + 5_000, { detail: 'Bash' })
    await clock.advance(5_000)
    world.sessions['p1.json'] = mm('failed', NOW + 10_000)
    await clock.advance(5_000)
    world.sessions['p1.json'] = mm('replied', NOW + 15_000)
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['mm 已答复（这轮 10m15s）'])
    expect(world.clips).toEqual([])
  })

  test('toastPeerReplies and toastRuns off: a long reply and a model ending toast nothing; a session asking still does', { options: { language: 'zh-CN', toastPeerReplies: false, toastRuns: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const world = seat(on, files)

    world.alive.add('111')
    world.sessions['p1.json'] = peer('p1', 'working', NOW - 1_000, { name: 'mm', turnStartedAt: NOW - 600_000 })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    files[`${R1}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 5_000 }
    world.sessions['p1.json'] = peer('p1', 'replied', NOW + 5_000, { name: 'mm', turnStartedAt: NOW - 600_000 })
    await clock.advance(5_000)
    expect(world.toasts).toEqual([])
    expect(textOf(await $.ui.render(BAND)), 'the run ended all the same').toContain('codex ✓')

    world.sessions['p1.json'] = peer('p1', 'permission', NOW + 10_000, { name: 'mm', detail: 'Bash' })
    await clock.advance(5_000)
    expect(world.toasts).toEqual(['mm 等你授权：Bash'])
  })

  test('an AskUserQuestion asking through PermissionRequest is permission with detail 提问, written once; its answer is working again', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const ASK = { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }

    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await clock.advance(1_000)
    await $.classic.PermissionRequest(ASK as never)
    expect(mine(world)).toMatchObject({ state: 'permission', detail: '提问', since: NOW + 1_000 })

    const before = world.sessions['me.json']

    await $.classic.PermissionRequest(ASK as never)
    expect(world.sessions['me.json'], 'the same question').toBe(before)

    await clock.advance(1_000)
    await $.classic.PostToolUse(ran('AskUserQuestion', { questions: [] }))
    expect(mine(world)).toMatchObject({ state: 'working', since: NOW + 2_000 })

    await $.agent.spawn({ ...SPAWN, background: false } as never)
    await $.classic.PermissionRequest({ ...ASK, agent_id: 'a1' } as never)
    expect(mine(world)).toMatchObject({ state: 'permission', detail: 'worker: 提问' })
  })

  test('with the workbench closed the status line counts running subagents and what waits on you; open, or both 0, it is cleared; set only on a change', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.sessions['p1.json'] = peer('p1', 'failed', NOW - 1_000, { name: 'mm', updatedAt: NOW + 300_000 })
    await $.session.start(SESSION)
    await clock.advance(5_000)
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn(SPAWN as never)
    await clock.advance(1_000)
    expect(world.statuses).toEqual(['! 1 等你', '● 2 运行 · ! 1 等你'])

    await $.prompt.submit(PROMPT)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    await clock.advance(5_000)
    expect(world.statuses.slice(2), 'this session asking').toEqual(['● 2 运行 · ! 2 等你'])

    await $.command.run(command('dashboard'))
    expect(world.statuses.at(-1), 'the workbench open').toBeUndefined()

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await ui.press({ key: 'dash-close' })
    await clock.settle()
    await ui.unmount()
    expect(world.statuses.at(-1)).toBe('● 2 运行 · ! 2 等你')

    await $.turn.complete(complete('a1'))
    await $.turn.complete(complete('a2'))
    await $.classic.PostToolUse(ran('Bash', { command: 'ls' }))
    await clock.advance(5_000)
    expect(world.statuses.at(-1)).toBe('! 1 等你')

    world.sessions['p1.json'] = peer('p1', 'working', NOW + 15_000, { name: 'mm', updatedAt: NOW + 300_001 })
    await clock.advance(5_000)
    expect(world.statuses.at(-1), 'both 0').toBeUndefined()

    const count = world.statuses.length

    await clock.advance(30_000)
    expect(world.statuses, 'nothing changed').toHaveLength(count)
  })
})

describe('cold cache', () => {
  const REPLIED = { answer: 'done', durationMs: 2_000, isAborted: false, turnId: 't', reason: 'answer', usage: usage(10) } as never
  const MINUTE = 60_000
  const switched = (cache_ttl: '5m' | '1h') =>
    ({ from_model: 'a', to_model: 'b', requested_model: null, source: 'command', context_tokens: 1, prompt_cache_warm: true, cache_ttl, estimated_cache_write_usd: 1, pricing: 'catalog' }) as never

  test('idle past the TTL after a main reply: one line with the tokens to rewrite; the next prompt clears it', { timeoutMs: 60_000, options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await $.turn.complete(REPLIED)
    await measure($, FILLED)
    await clock.advance(59 * MINUTE)
    expect(linesOf(await $.ui.render(BAND)), 'inside the TTL').toEqual(IDLE)

    await clock.advance(MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 1h00m · 下一条重写约 182k tokens', 'engine band'])

    await clock.advance(12 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 1h12m · 下一条重写约 182k tokens', 'engine band'])

    await $.prompt.submit(PROMPT)
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)
  })

  test('a subagent turn.complete does not restart the count', { timeoutMs: 60_000, options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    await $.session.start(SESSION)
    await $.turn.complete(REPLIED)
    await measure($, FILLED)
    await clock.advance(30 * MINUTE)
    await $.turn.complete(complete('a1'))
    await clock.advance(30 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 1h00m · 下一条重写约 182k tokens', 'engine band'])
  })

  test('a PostModelSwitch with a 5m TTL turns the cache cold after 6 minutes; no tokens known, no second half', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    await $.session.start(SESSION)
    await $.classic.PostModelSwitch(switched('5m'))
    await $.turn.complete(REPLIED)
    await clock.advance(4 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)

    await clock.advance(2 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 6m00s', 'engine band'])
  })

  test('assumed-cache-duration: the transcript\'s last main reply that wrote the cache sets the TTL; a subagent\'s line after it does not', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const reply = (written: Record<string, number>, isSidechain: boolean) => JSON.stringify({ type: 'assistant', isSidechain, message: { usage: { cache_creation: written } } })

    world.stdout = ['":"cut by tail"}', reply({ ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 }, false), reply({ ephemeral_1h_input_tokens: 500 }, true), ''].join('\n')
    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], last_assistant_message: 'done', transcript_path: '/t/me.jsonl' } as never)
    await $.turn.complete(REPLIED)
    expect(world.runs).toContainEqual(['tail', '-c', '262144', '/t/me.jsonl'])

    await clock.advance(4 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)

    await clock.advance(2 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 6m00s', 'engine band'])
  })

  test('a transcript that tells no TTL keeps the one before: a turn.complete before the Stop is counted with it', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    await $.session.start(SESSION)
    await $.classic.PostModelSwitch(switched('5m'))
    await $.prompt.submit(PROMPT)
    await $.turn.complete(REPLIED)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], last_assistant_message: 'done', transcript_path: '/t/me.jsonl' } as never)
    await clock.advance(6 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 6m00s', 'engine band'])
  })

  test('reply-based-cache-expiry: the TTL counts from the last main request, so a long tool phase after it eats into it; a subagent request does not', { timeoutMs: 60_000, options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    stepper(on)
    await $.session.start(SESSION)
    await $.prompt.submit(PROMPT)
    await mainTurn($, 'm1', 1, true)
    await clock.advance(30 * MINUTE)
    await drain($.turn.step(stepIn('s1', 0, 'a9')))
    await clock.advance(20 * MINUTE)
    await $.turn.complete({ ...(REPLIED as object), turnId: 'm1' } as never)
    await clock.advance(9 * MINUTE)
    expect(linesOf(await $.ui.render(BAND)), '59 minutes after the request').toEqual(IDLE)

    await clock.advance(MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 1h00m', 'engine band'])
  })

  test('a resume two hours after the last response is cold at once', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    await $.session.start(SESSION)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 7200, context_tokens: 182_000, prompt_cache_likely_expired: true } as never)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 2h00m · 下一条重写约 182k tokens', 'engine band'])
  })

  test('a resume 10 minutes after a reply that wrote a 5m cache is cold at once: the transcript tells the TTL', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    world.stdout = [JSON.stringify({ type: 'assistant', isSidechain: false, message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 900 } } } }), ''].join('\n')
    await $.session.start(SESSION)
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/t/me.jsonl', seconds_since_last_response: 600, prompt_cache_likely_expired: true } as never)
    expect(world.runs).toContainEqual(['tail', '-c', '262144', '/t/me.jsonl'])
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 10m00s', 'engine band'])
  })

  test('a resume the engine judges expired is cold though the transcript tells no TTL; the next main reply is warm', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    await $.session.start(SESSION)
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/t/me.jsonl', seconds_since_last_response: 600, prompt_cache_likely_expired: true } as never)
    expect(linesOf(await $.ui.render(BAND))).toEqual(['~ 缓存已冷 · 闲置 10m00s', 'engine band'])

    await $.prompt.submit(PROMPT)
    await $.turn.complete(REPLIED)
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)
  })

  test('a resume\'s context_tokens is the cold line\'s alone: the prompt hint waits for the engine\'s measurement', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 7200, context_tokens: 182_000, prompt_cache_likely_expired: true } as never)
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 —')
  })

  test('a /clear ends the cold line and the context figures', { timeoutMs: 60_000, options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await $.turn.complete(REPLIED)
    await measure($, FILLED)
    await $.session.end({ reason: 'clear', sessionId: 'me' } as never)
    await clock.advance(61 * MINUTE)
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)

    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 —')
  })
})

describe('context under the prompt', () => {
  const HOUR = 3_600_000
  const at = (ms: number) => new Date(NOW + ms).toISOString()
  const FIVE_HOUR = { kind: 'five_hour', percentUsed: 42, resetsAt: at(2 * HOUR + 10 * 60_000) }
  const SEVEN_DAY = { kind: 'seven_day', percentUsed: 12, resetsAt: at(3 * 24 * HOUR) }
  const HALF = { context: { tokens: 85_000, window: 200_000, percent: 41 } }

  test('terminal: the engine\'s tokens, window and percent end the tail, after any tail already there, working or drafting', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await measure($, HALF)

    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1), 'the percent as the engine gave it, not 85/200').toMatchObject({ hint: '? for shortcuts', tail: '上下文 85k/200k · 41%' })

    await $.ui.render(hintOf('terminal', { tail: 'pill', isWorking: true, isDraft: true }))
    expect(world.hints.at(-1)?.tail).toBe('pill · 上下文 85k/200k · 41%')
  })

  test('desktop: the hint itself carries it', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await measure($, HALF)

    await $.ui.render(hintOf('desktop'))
    expect(world.hints.at(-1)?.hint).toBe('? for shortcuts · 上下文 85k/200k · 41%')
  })

  test('no measurement yet: a dash; one with no fill yet, or a compaction since: a dash for the tokens', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 —')

    await measure($)
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 —/200k')

    await measure($, HALF)
    await $.session.compact({ trigger: 'manual', messages: SUMMARY })
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 —/200k')
  })

  test('the tightest rate-limit window follows, with when it resets; with none, the cost; with neither, nothing', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await measure($, { ...HALF, rateLimits: [SEVEN_DAY, FIVE_HOUR], cost: { usd: 3.4123 }, changed: ['context', 'rateLimits', 'cost'] })
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 85k/200k · 41% · 5h 42% · 2h10m后重置')

    await measure($, { ...HALF, cost: { usd: 3.4123 }, changed: ['rateLimits'] })
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 85k/200k · 41% · $3.41')

    await measure($, { ...HALF, changed: ['cost'] })
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 85k/200k · 41%')
  })

  test('in English', { options: { language: 'en' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await measure($, { ...HALF, rateLimits: [{ ...SEVEN_DAY, percentUsed: 50 }], changed: ['context', 'rateLimits'] })
    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('Context 85k/200k · 41% · 7d 50% · resets in 3d0h')
  })

  test('a window at 80% or more shows only under the prompt, not on the band', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await measure($, { rateLimits: [{ ...FIVE_HOUR, percentUsed: 81 }] })
    expect(linesOf(await $.ui.render(BAND))).toEqual(IDLE)

    await $.ui.render(hintOf('terminal'))
    expect(world.hints.at(-1)?.tail).toBe('上下文 —/200k · 5h 81% · 2h10m后重置')
  })
})

describe('the trees validate on every surface', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`band and every page on ${surface}`, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      const world = seat(on, mmruns())

      world.alive.add('111')
      world.stdout = NVIDIA_RUN
      await $.session.start(SESSION)
      await clock.advance(3_000)
      await $.agent.spawn(SPAWN as never)
      await $.command.run(command('gpu', 'lab-box'))
      await clock.settle()

      const band = await $.ui.mount({ plugin: PLUGIN, ...BAND, surface } as never)

      expect((await band.findAll({ type: 'Text' })).length).toBeGreaterThan(0)
      await band.unmount()

      const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

      for (const key of ['page-overview', 'page-agents', 'page-mmrun', 'page-gpu']) {
        await pane.press({ key })
        expect((await pane.findAll({ type: 'Text' })).length).toBeGreaterThan(1)
      }

      await pane.unmount()
    })
  }
})

describe('workbench tables', () => {
  /** a1 errored, a2 running, a3 returned; R1 codex running and grok done unread; R3 failed before. */
  async function busyOverview($: Engine, on: On) {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()

    files[`${R1}/grok.status`] = { text: 'DONE\n', mtimeMs: NOW + 1_000 }

    const world = seat(on, files)

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.agent.spawn(SPAWN as never)
    await $.turn.complete(complete('a1', 'error'))
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn(SPAWN as never)
    await $.turn.complete(complete('a3'))
    await $.command.run(command('dashboard'))
  }

  test('总览: a count bar first; 需要你 and 运行中 rows are plain Buttons that open the item, an agent numbered by its spawn digit, a model not', { options: { language: 'zh-CN' } }, async ($, on) => {
    await busyOverview($, on)

    const tree = await $.ui.render(PANE)
    const rows = rowsOf(tree).filter(row => row.trim() !== '')

    expect(rows[1]).toMatch(/^! 需要你1 · ● 运行2 · 待读2 · 更新 \d+s前$/)
    expect(colorsOf(tree, '!')).toEqual(['warning'])
    expect(rows.slice(2, 6)).toEqual([
      '需要你 · 1',
      '✗ 1: worker  Build mm plugin  1s  500 out  出错',
      '运行中 · 2',
      expect.stringMatching(/^● 2: 运行 worker · Build mm plugin +0 tools  0s$/),
    ])
    expect(rows[6]).toMatch(/^● 运行 design \/ codex +4m15s$/)
    expect(widthOf(rows[5] ?? ''), 'the hotkey counted in, the time still ends at the pane edge').toBe(70)

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect((await ui.find({ key: 'open-agent-a1' }))?.props).toMatchObject({ plain: true, label: 'worker  Build mm plugin  1s  500 out  出错' })
    expect((await ui.find({ key: 'open-agent-a1' }))?.props.hotkey, 'a failure still needing you keeps its digit').toBe('1')
    expect((await ui.find({ key: 'open-agent-a2' }))?.props).toMatchObject({ plain: true, hotkey: '2' })
    expect((await ui.find({ key: `open-model-${R1}-codex` }))?.props).toMatchObject({ plain: true })
    expect((await ui.find({ key: `open-model-${R1}-codex` }))?.props.hotkey).toBeUndefined()
    await ui.press({ key: 'open-agent-a1' })
    expect((await ui.find({ key: 'page-agents' }))?.props).toMatchObject({ variant: 'primary' })
    expect(await ui.find({ type: 'Markdown', text: 'report' })).toBeDefined()

    await ui.press({ key: 'page-overview' })
    await ui.press({ key: `open-model-${R1}-codex` })
    expect((await ui.find({ key: 'page-mmrun' }))?.props).toMatchObject({ variant: 'primary' })
    expect(await ui.find({ key: 'dash-back' })).toBeDefined()
    await ui.unmount()
  })

  test('总览 placed inline: the count bar and 需要你 alone', { options: { language: 'zh-CN' } }, async ($, on) => {
    await busyOverview($, on)

    const rows = rowsOf(await $.ui.render({ ...PANE, props: { ...PANE.props, placement: 'inline' } })).filter(row => row.trim() !== '')

    expect(rows.slice(1)).toEqual([expect.stringMatching(/^! 需要你1 · /), '需要你 · 1', '✗ 1: worker  Build mm plugin  1s  500 out  出错'])
  })

  test('Agents: a dim header, then a row per agent in columns by display width, the whole row a plain Button', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: 1_000 })
    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.classic.PermissionDenied(denied('Write', 'a1'))
    await $.turn.complete(complete('a1'))
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn(SPAWN as never)
    await $.turn.complete(complete('a3', 'error'))
    await $.command.run(command('subagents'))

    const tree = await $.ui.render(PANE)
    const [, head = '', ...rows] = rowsOf(tree)
    const at = (row: string, part: string) => widthOf(row.slice(0, row.indexOf(part)))

    expect(head).toMatch(/^状态 +类型 +任务 +模型 +耗时 +tokens +tools +被拒$/)
    expect(isDimText(tree, '状态')).toBe(true)
    expect(rows, 'running first; unread a1 kept 1, so a2 took 2 and a3 3').toEqual([
      expect.stringMatching(/^● 运行 +2: worker  Build mm pl…  opus-5-5 +0s +— +0$/),
      expect.stringMatching(/^✗ 出错 +3: worker  Build mm pl…  opus-5-5 +1s +501 +0$/),
      expect.stringMatching(/^✓ 已返回 +1: worker  Build mm pl…  opus-5-5 +1s +501 +1  ✗1$/),
    ])

    for (const row of rows) {
      expect(at(row, 'worker'), row).toBe(at(head, '类型'))
      expect(at(row, 'opus-5-5'), row).toBe(at(head, '模型'))
      expect(at(row, 's ') + 1, row).toBe(at(head, '耗时') + widthOf('耗时'))

      const tokens = row.includes('501') ? '501' : '—'

      expect(at(row, tokens) + widthOf(tokens), row).toBe(at(head, 'tokens') + widthOf('tokens'))
    }

    expect(textOf(tree)).not.toContain('claude-')
    expect(colorsOf(tree, '✗1')).toEqual(['error'])

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect((await ui.find({ key: 'read-agent-a1' }))?.props, 'a returned row is dim').toMatchObject({ plain: true, dimColor: true })
    expect((await ui.find({ key: 'read-agent-a1' }))?.props.hotkey, 'unread: it kept its digit').toBe('1')
    expect((await ui.find({ key: 'read-agent-a2' }))?.props.dimColor).toBeUndefined()
    expect(await ui.find({ key: 'read-agent' })).toBeUndefined()
    await ui.press({ key: 'read-agent-a2' })
    expect(await ui.find({ text: '仍在运行,还没有返回正文' })).toBeDefined()
    await ui.unmount()

    const narrow = async (columns: number) => rowsOf(await $.ui.render({ ...PANE, props: { ...PANE.props, bodyColumns: columns } })).slice(1)

    await $.command.run(command('subagents'))

    const [head60 = '', ...rows60] = await narrow(60)

    expect(head60, '60 columns: 模型 goes first').toMatch(/^状态 +类型 +任务 +耗时 +tools +被拒$/)
    expect(rows60.every(row => widthOf(row) <= 60 && !row.includes('opus'))).toBe(true)

    const [head40 = '', ...rows40] = await narrow(40)

    expect(head40, '40 columns: then tools, then 被拒; 状态 and 耗时 stay').toMatch(/^状态 +类型 +任务 +耗时$/)
    expect(rows40[2]).toMatch(/^✓ 已返回 +1: worker  .+ +1s$/)
  })

  test('Agents: a digit stays with its agent: a later spawn leaves the rows drawn before as they were numbered', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command('subagents'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)
    const digits = async () => {
      const out: Record<string, unknown> = {}

      for (const id of ['a1', 'a2', 'a3']) {
        out[id] = (await ui.find({ key: `read-agent-${id}` }))?.props.hotkey
      }

      return out
    }

    expect(await digits()).toEqual({ a1: '1', a2: '2', a3: undefined })
    await $.agent.spawn(SPAWN as never)
    expect(await digits(), 'a3 takes the next free digit').toEqual({ a1: '1', a2: '2', a3: '3' })
    await ui.unmount()
  })

  test('Agents: past nine rows no hotkey, the row still lined up', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: 1_000 })
    seat(on)
    await $.session.start(SESSION)

    for (let i = 0; i < 11; i += 1) {
      await $.agent.spawn(SPAWN as never)
    }

    await $.command.run(command('subagents'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    expect((await ui.find({ key: 'read-agent-a9' }))?.props).toMatchObject({ hotkey: '9' })
    expect((await ui.find({ key: 'read-agent-a10' }))?.props.hotkey, 'the tenth running at once: no digit left').toBeUndefined()
    await ui.unmount()

    const rows = rowsOf(await $.ui.render(PANE)).slice(2)

    expect(rows[10]?.indexOf('worker')).toBe(rows[8]?.indexOf('worker'))
  })

  test('Agents: a running agent opened reads its transcript once per move; a failed read says 读不到 and waits for the next move', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let answer: 'rows' | 'deny' | 'refuse' = 'rows'
    const asked: unknown[] = []

    seat(on)
    on('session.messages', ($, e) => {
      asked.push(e.agentId)

      if (answer === 'refuse') {
        return { deny: 'refused' }
      }

      return {
        value:
          answer === 'deny'
            ? { deny: 'gone' }
            : [
                { role: 'user', text: 'Fix the band\nin detail', toolUses: [] },
                { role: 'assistant', text: 'Looking.', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: '/w/board.ts' } }] },
                { role: 'assistant', text: 'Found it.\nmore', toolUses: [{ tool_use_id: 'u2', tool: 'Bash', input: { command: 'bun test' } }] },
              ],
      } as never
    })
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command('subagents'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await ui.press({ key: 'read-agent-a1' })

    const rows = rowsOf(await $.ui.render(PANE))

    expect(rows).toEqual(expect.arrayContaining(['仍在运行,还没有返回正文', '任务  Fix the band', '最近调用', '  Read board.ts', '  Bash bun test', '最新  Found it.']))
    expect(asked).toEqual(['a1'])
    await $.ui.render(PANE)
    expect(asked, 'a redraw reads nothing').toHaveLength(1)

    await clock.advance(1_000)
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/x.md' }, 'a1'))
    expect(asked, 'the agent moved: read again').toHaveLength(2)

    answer = 'deny'
    await clock.advance(1_000)
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/y.md' }, 'a1'))
    expect(rowsOf(await $.ui.render(PANE))).toContain('读不到它的运行记录')
    expect(colorsOf(await $.ui.render(PANE), '读不到它的运行记录')).toEqual(['warning'])
    await ui.press({ key: 'dash-back' })
    await ui.press({ key: 'read-agent-a1' })
    expect(asked, 'no retry before the agent moves').toHaveLength(3)

    answer = 'refuse'
    await clock.advance(1_000)
    await $.classic.PostToolUse(ran('Read', { file_path: '/w/z.md' }, 'a1'))
    expect(asked).toHaveLength(4)
    expect(rowsOf(await $.ui.render(PANE))).toContain('读不到它的运行记录')
    await ui.unmount()
  })

  test('Agents: a slow read of an agent left for another does not overwrite the other\'s peek', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    let release = () => {}
    let asked = () => {}
    const isAsked = new Promise<void>(resolve => {
      asked = resolve
    })
    const held = new Promise<void>(resolve => {
      release = resolve
    })

    seat(on)
    on('session.messages', async ($, e) => {
      if (e.agentId === 'a1') {
        asked()
        await held
      }

      return { value: [{ role: 'user', text: `Task of ${e.agentId}`, toolUses: [] }] } as never
    })
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn(SPAWN as never)
    await $.command.run(command('subagents'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)
    const first = ui.press({ key: 'read-agent-a1' })

    await isAsked
    await ui.press({ key: 'dash-back' })
    await ui.press({ key: 'read-agent-a2' })
    expect(rowsOf(await $.ui.render(PANE))).toContain('任务  Task of a2')

    release()
    await first
    await clock.settle()
    expect(rowsOf(await $.ui.render(PANE))).toContain('任务  Task of a2')
    await ui.unmount()
  })

  test('Agents: read on a past visit, the ended fold into one ✓N 已完成 row that opens and closes; failures and the running stay listed', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    await $.session.start(SESSION)

    for (let i = 0; i < 4; i += 1) {
      await $.agent.spawn(SPAWN as never)
    }

    await $.turn.complete(complete('a1'))
    await $.turn.complete(complete('a2', 'error'))
    await $.turn.complete(complete('a3', 'aborted'))
    await $.command.run(command('subagents'))
    expect(rowsOf(await $.ui.render(PANE)).slice(2), 'all unread on this visit').toHaveLength(4)

    await clock.advance(1_000)
    await $.command.run(command('subagents'))

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)
    const rows = async () => rowsOf(await $.ui.render(PANE)).slice(2)

    expect(await rows()).toEqual([expect.stringMatching(/^● 运行 +4: /), expect.stringMatching(/^✗ 出错 +2: /), '✓1 已完成 · ⊘1 已中止'])
    expect((await ui.find({ key: 'agents-fold' }))?.props).toMatchObject({ plain: true })
    expect((await ui.find({ key: 'agents-fold' }))?.props.hotkey).toBeUndefined()
    await ui.press({ key: 'agents-fold' })
    expect(await rows()).toEqual([
      expect.stringMatching(/^● 运行 +4: /),
      expect.stringMatching(/^✗ 出错 +2: /),
      '✓1 已完成 · ⊘1 已中止',
      expect.stringMatching(/^⊘ 已中止 +3: /),
      expect.stringMatching(/^✓ 已返回 +1: /),
    ])
    await ui.press({ key: 'agents-fold' })
    expect(await rows()).toHaveLength(3)
    await ui.unmount()
  })

  test('a subagent call still running: `Bash 3m…` on the band and the Agents page, no 静默; once it ends, 静默 again', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    on('turn.step', async function* ($, e) {
      yield { kind: 'tool', index: 0, id: 'toolu_b', name: 'Bash' }

      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Bash', input: {} }], stopReason: 'tool_use', usage: usage(1) }
    })
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)

    const stream = $.turn.step({ turnId: 'c1', index: 0, agentId: 'a1', model: 'claude-opus-5-5', messageCount: 2 } as never)

    while ((await stream.next()).done !== true) {}

    // The call's request time carries the stream's few real milliseconds: a second over keeps it at 3m.
    await clock.advance(181_000)

    const band = textOf(await $.ui.render(BAND))

    expect(band).toContain('0 tools  Bash 3m…')
    expect(band).not.toContain('静默')
    await $.command.run(command('subagents'))
    expect(rowsOf(await $.ui.render(PANE))[2]).toMatch(/  Bash 3m…$/)

    await $.classic.PostToolUse({ ...(ran('Bash', { command: 'sleep 180' }, 'a1') as object), tool_use_id: 'toolu_b' } as never)
    await clock.advance(121_000)
    expect(textOf(await $.ui.render(BAND))).toContain('静默')
  })

  test('外审: a head per run with its 阅读 button, then a row per model in columns; a returned model dim', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())

    world.alive.add('111')
    await $.session.start(SESSION)
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const tree = await $.ui.render(PANE)

    expect(rowsOf(tree).slice(1)).toEqual([
      'design · review  aaaa  proj [ 阅读 ]',
      '  ● codex  RUNNING  4m15s      — tok',
      '  ✓ grok   DONE     5m02s  25.8k tok',
      '- · review  cccc  proj [ 阅读 ]',
      '  ✗ agy    FAIL:1   1m40s      — tok',
    ])
    expect(colorsOf(tree, '●')).toEqual(['permission'])
    expect(colorsOf(tree, '✗')).toEqual(['error'])
    expect(dimTexts(tree).some(text => text.includes('grok'))).toBe(true)
    expect(dimTexts(tree).some(text => text.includes('codex'))).toBe(false)
    expect(dimTexts(tree)).toContain('  aaaa  proj')
    expect(boxesWithButton(tree).map(box => rowsOf(box)[0])).toContain('design · review  aaaa  proj [ 阅读 ]')
  })

  test('GPU: a dim header, a row per card lined up; a missing value is -, not 0; no bar under 64 columns', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const world = seat(on)

    world.stdout = ['@@NVSMI', '0, NVIDIA GeForce RTX 4090, 52, 18636, 24564, 67, 280.45', '1, NVIDIA A100, [N/A], [N/A], [N/A], [N/A], [N/A]', '@@APPS'].join('\n')
    await $.session.start(SESSION)
    await $.command.run(command('gpu', 'lab-box'))
    await clock.settle()

    const tree = await $.ui.render(PANE)
    const [, , head = '', one = '', two = ''] = rowsOf(tree)

    expect(head).toMatch(/^# +model +util +VRAM +temp +power$/)
    expect(isDimText(tree, 'VRAM')).toBe(true)
    expect(one).toMatch(/^0  RTX 4090  ▇+░+  52%  18\.2\/24\.0 GiB  67°C  280W$/)
    expect(two).toMatch(/^1  A100 +-  - +- +-$/)
    expect(head.indexOf('util')).toBe(one.indexOf('▇'))
    expect(head.indexOf('VRAM')).toBe(one.indexOf('18.2'))
    expect(head.indexOf('power')).toBe(one.indexOf('280W'))
    expect(widthOf(one)).toBeLessThanOrEqual(70)

    const [, , head60 = '', one60 = ''] = rowsOf(await $.ui.render({ ...PANE, props: { ...PANE.props, bodyColumns: 60 } }))

    expect(one60).toBe('0  RTX 4090   52%  18.2/24.0 GiB  67°C  280W')
    expect(head60.indexOf('VRAM')).toBe(one60.indexOf('18.2'))
  })

  test('idle, the band is redrawn every heartbeat so its 12m前 moves; with work on the band the heartbeat redraws nothing', { options: { language: 'zh-CN' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const ticks = writes(on, 'tick')

    seat(on)
    await $.session.start(SESSION)
    await clock.advance(1_000)

    const idle = ticks()

    await clock.advance(30_000)
    expect(ticks() - idle).toBeGreaterThanOrEqual(1)

    await $.agent.spawn(SPAWN as never)
    await $.turn.complete(complete('a1', 'error'))
    await clock.advance(30_000)

    const held = ticks()

    await clock.advance(30_000)
    expect(ticks() - held, 'a failed agent holds the band: no idle line to move').toBe(0)
  })
})

/** mm as dashboard sees it: `/mm-watch` writes mm's own `watches`. Loaded from its source alone: nothing of this file's in scope. */
const MM = {
  name: 'mm',
  register: (on: On) => {
    on('session.start', async ($, e, next) => {
      await $.command.register({ name: 'mm-watch', description: 'Watch a run' })

      return next(e)
    })
    on('command.run', { command: 'mm-watch' }, async $ => {
      await $.state.set({ plugin: 'mm', key: 'watches' } as never, [{ rid: '20261002-020000-dddd', kind: 'review', startedAt: 0 }] as never)

      return { text: 'watching' }
    })
  },
}

describe('commands that open the workbench', () => {
  // A command's text is stored as a transcript row the model reads: opening a page tells the model nothing.
  test('print nothing; only a /gpu it cannot run says why', { options: { language: 'zh-CN' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)
    await $.session.start(SESSION)

    for (const [name, args] of [['dashboard', ''], ['subagents', ''], ['mmrun', ''], ['timeline', ''], ['gpu', 'lab-box']] as const) {
      const r = await $.command.run(command(name, args))

      expect(r.text, name).toBeUndefined()
      expect(r.context, name).toBeUndefined()
    }

    expect((await $.command.run(command('gpu', '-x'))).text).toBe('不是主机名：-x')
  })
})

describe('state an older build left', () => {
  /** Each kept value in a shape this build does not read. */
  const OLD: Record<string, unknown> = {
    agents: { list: [] },
    runs: [],
    gates: {},
    trees: [{ name: 'agent-a' }],
    peers: {},
    presence: 'idle',
    toasted: {},
    timeline: { turns: [] },
    cache: null,
    usage: [],
    seen: [],
    detail: 'agents',
    reports: [],
    gpu: 'lab-box',
    peek: [],
    guards: [],
  }

  test('without the shape tag reads as the initial value, one debug line per key; nothing throws and the next write is whole', { options: { language: 'zh-CN', gpuHosts: 'lab-box' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())
    const debug = () => world.logs.filter(one => one.to === 'debug').map(one => one.text)

    // Kept from before this load until the plugin writes the key.
    const kept = new Map(Object.entries(OLD))

    on('state.get', ($, e, next) => {
      const key = (e as { key: string }).key

      return e.plugin === PLUGIN && kept.has(key) ? ({ value: { value: kept.get(key), version: 1 } } as never) : next(e)
    })
    on('state.set', ($, e, next) => {
      kept.delete(e.key)

      return next(e)
    })
    await $.session.start(SESSION)
    expect(textOf(await $.ui.render(BAND))).toContain('空闲')
    await $.command.run(command('subagents'))
    expect(textOf(await $.ui.render(PANE))).toContain('本会话还没有子 agent。')

    await $.agent.spawn(SPAWN as never)
    await clock.settle()
    expect(rowsOf(await $.ui.render(PANE)).filter(row => row.includes('Build mm plug'))).toHaveLength(1)

    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    for (const page of ['overview', 'mmrun', 'timeline', 'gpu'] as const) {
      await ui.press({ key: `page-${page}` })
      expect(await ui.find({ type: 'Text', text: /^✗ / }), page).toBeUndefined()
    }

    await ui.unmount()
    await clock.advance(5_000)

    for (const key of ['agents', 'runs', 'gates', 'peers', 'presence', 'timeline']) {
      expect(debug().filter(line => line.includes(`kept ${key} `)), key).toHaveLength(1)
    }

    // toasted is read by the peers poll alone, from its timer: that the poll ran clean is its check.
    expect(debug().filter(line => line.includes('poll failed'))).toEqual([])
  })
})

describe('loops', () => {
  test('a -p or SDK session starts no loop and writes no presence file', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())
    const written: Record<string, number> = {}

    on('state.set', ($, e, next) => {
      if (e.plugin === 'dashboard') {
        written[e.key] = (written[e.key] ?? 0) + 1
      }

      return next(e)
    })
    world.alive.add('111')
    world.sessions['p1.json'] = peer('p1', 'working', NOW)
    await $.session.start({ ...SESSION, surface: null, isInteractive: false })
    await $.prompt.submit(PROMPT)
    await clock.advance(60_000)
    await $.turn.complete({ answer: 'done', durationMs: 2_000, isAborted: false, turnId: 't', reason: 'answer', usage: usage(10) } as never)
    await $.session.end({ reason: 'other', sessionId: 'me' } as never)

    expect(written.runs, 'no runs read').toBeUndefined()
    expect(written.peers, 'no other sessions read').toBeUndefined()
    expect(written.trees, 'no worktrees read').toBeUndefined()
    expect(world.runs, 'no git').toEqual([])
    expect(world.sessions['me.json'], 'no presence file, heartbeat or not').toBeUndefined()
  })

  test('a reload that raised no session.start (an option changed): the first band drawing starts the loops, once', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())
    const written = writes(on, 'runs')

    world.alive.add('111')
    await $.ui.render(BAND)
    await $.ui.render(BAND)
    await clock.advance(3_000)
    expect(written(), 'a running model is written every poll: once, one loop').toBe(1)

    await clock.advance(3_000)
    expect(written()).toBe(2)
  })

  test('session.start, then the band drawn: still one loop', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on, mmruns())
    const written = writes(on, 'runs')

    world.alive.add('111')
    await $.session.start(SESSION)
    await $.ui.render(BAND)
    await clock.advance(3_000)
    expect(written()).toBe(1)
  })

  test('mm writing its watches reads the runs at once; with nothing running the 15 s poll is the fallback', { plugins: [MM] }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const world = seat(on, files)

    await $.session.start(SESSION)
    await clock.advance(3_000)
    files[`${R4}/run.meta`] = { text: runMeta(R4, 'fresh', 'codex'), mtimeMs: NOW + 4_000 }
    files[`${R4}/codex.status`] = { text: 'RUNNING\n' }
    files[`${R4}/codex.started`] = { text: `${(NOW + 4_000) / 1000}\n` }
    files[`${R4}/codex.pid`] = { text: '444\n' }
    world.alive.add('444')
    await clock.advance(3_000)
    expect(textOf(await $.ui.render(BAND)), 'nothing was running: the next poll is 15 s on').not.toContain('fresh')

    await $.command.run(command('mm-watch'))
    await clock.settle()
    expect(textOf(await $.ui.render(BAND))).toContain('fresh · codex ●')
  })

  test('mm writing its watches while a poll reads the runs reads them again once it ends, past the idle wait', { plugins: [MM] }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const files = mmruns()
    const world = seat(on, files)
    let release = () => {}
    let isHeld = false

    await $.session.start(SESSION)
    await clock.advance(3_000)
    world.beforeRead = path => {
      if (isHeld || !path.startsWith(`${ROOT}/`)) {
        return Promise.resolve()
      }

      isHeld = true

      return new Promise(resolve => {
        release = resolve
      })
    }
    await clock.advance(15_000)
    expect(isHeld, 'the 15 s poll waits on a run file').toBe(true)

    files[`${R4}/run.meta`] = { text: runMeta(R4, 'fresh', 'codex'), mtimeMs: NOW + 18_000 }
    files[`${R4}/codex.status`] = { text: 'RUNNING\n' }
    files[`${R4}/codex.started`] = { text: `${(NOW + 18_000) / 1000}\n` }
    files[`${R4}/codex.pid`] = { text: '444\n' }
    world.alive.add('444')
    await $.command.run(command('mm-watch'))
    release()
    await clock.settle()
    expect(textOf(await $.ui.render(BAND))).toContain('fresh · codex ●')
  })
})
