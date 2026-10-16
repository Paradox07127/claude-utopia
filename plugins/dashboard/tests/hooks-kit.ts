import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { AgentStatus, CommandSpec, FsEntry, On, RenderInput, SessionMeasureInput, SessionStartInput } from 'claude-code'

export const PLUGIN = 'dashboard'
export const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
export const BOTTOM = { type: 'Text', props: {}, children: ['engine band'] }
export const IDLE = ['✓ 空闲', 'engine band']
export const IDLE_AFTER_WORKER = ['✓ 空闲 · 最近 ✓ worker 已返回 21s前', 'engine band']
export const NOW = 1_790_922_800_000
export const ROOT = '/h/.claude/mmruns'
export const SESSIONS = '/h/.claude/dashboard/sessions'
export const R1 = '20261002-010000-aaaa'
export const R2 = '20260930-000000-bbbb'
export const R3 = '20261002-005000-cccc'
export const R4 = '20261002-020000-dddd'

export const bandOf = (maxRows = 20): RenderInput<'AbovePrompt'> => ({
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: { hasSurvey: false, isWorking: true, maxRows, bodyColumns: 100, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} },
})
export const BAND = bandOf()

export const hintOf = (surface: 'terminal' | 'desktop', more: Partial<RenderInput<'PromptHint'>['props']> = {}): RenderInput<'PromptHint'> => ({
  component: 'PromptHint',
  surface,
  requestId: 'hint',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts', ...more },
})

export const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: 'dashboard',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: { title: '工作台', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}

export const command = (name: string, args = '') => ({
  command: name,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 180 },
})

export const SPAWN = {
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
export const ran = (tool_name: string, tool_input: Record<string, unknown>, agent_id?: string) =>
  ({ tool_name, tool_input, tool_response: 'ok', tool_use_id: 'toolu_x', ...(agent_id !== undefined && { agent_id }) }) as never
export const denied = (tool_name: string, agent_id?: string) =>
  ({ tool_name, tool_input: {}, tool_use_id: 'toolu_x', reason: 'auto-denied', ...(agent_id !== undefined && { agent_id }) }) as never

export const usage = (output_tokens: number) => ({ input_tokens: 1, output_tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' })
export const complete = (agentId: string, reason = 'answer', durationMs = 1_000) =>
  ({ answer: 'report', durationMs, isAborted: reason === 'aborted', turnId: 't', agentId, reason, usage: usage(500) }) as never

export const BUN_OK = ['(pass) a [1ms]', '', ' 24 pass', ' 0 fail', 'Ran 24 tests across 1 file. [0.17s]'].join('\n')
export const TEGRA_RUN =['@@NVSMI', '0, Orin (nvgpu), [N/A], [N/A], [N/A], [N/A], [N/A]', '@@APPS', '@@TEGRA',
  'RAM 5120/30536MB (lfb 4x4MB) GR3D_FREQ 37% cpu@47.3C gpu@45.8C tj@47.3C'].join('\n')
export const NVIDIA_RUN = ['@@NVSMI', '0, NVIDIA GeForce RTX 4090, 52, 18636, 24564, 67, 280.45', '@@APPS', '4242, /usr/bin/python3, 10240'].join('\n')
export const NVML_RUN = ['@@NVERR', 'Failed to initialize NVML: Driver/library version mismatch', '@@NOGPU'].join('\n')
/** The engine's measurement of the session: the context window with its fill, the rate-limit windows, the cost. */
export const measure = ($: Engine, more: Partial<SessionMeasureInput> = {}) => $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'], ...more })
/** The context the main reply left: 182k of 200k. */
export const FILLED = { context: { tokens: 182_000, window: 200_000, percent: 91 } }
/** What a compaction leaves. */
export const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

export type Files = Record<string, { text: string; mtimeMs?: number }>

export const runMeta = (runid: string, tag: string, models: string) =>
  `runid=${runid}\nworkdir=/work/proj\ntag=${tag}\nmodels=${models}\nmode=review\nschema=\nwt=\nsession=x\n`

/** R1 has codex running (pid 111) and grok done; R2 is older than a day; R3 failed an hour ago. */
export function mmruns(): Files {
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

export type World = {
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
  listed: { id: string; description: string; type: string; status: AgentStatus }[]
  listCalls: number
  /** How many times the plugin asked for a redraw. */
  invalidated: number
  /** How many times a ToolResult row reached the engine's drawing beneath. */
  toolResults: number
  /** fs.list paths that are refused, with the refusal. */
  listDenied: Record<string, string>
  /** Awaited by the engine's fs.read before it answers. */
  beforeRead?: (path: string) => Promise<void>
  /** The text of ~/.claude/progress/canvas.json; absent, the file is missing. */
  canvas?: string
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
export function writtenAt(text: string): number {
  try {
    const updatedAt = (JSON.parse(text) as { updatedAt?: unknown }).updatedAt

    return typeof updatedAt === 'number' ? updatedAt : NOW
  } catch {
    return NOW
  }
}

/** The engine beneath the plugin, in memory; ~/.claude/mmruns holds `files`. With `clock`, a GPU ssh sends a pass every 3 s, else its first alone. */
export function seat(on: On, files: Files = {}, clock?: MockClock): World {
  const world: World = { opened: [], panes: new Set(), hidden: new Set(), runs: [], commands: [], specs: [], refusedNames: new Set(), tools: [], logs: [], stdout: TEGRA_RUN, files, alive: new Set(), kills: [], reads: [], toasts: [], sessions: {}, copies: [], hints: [], listed: [], listCalls: 0, listDenied: {}, invalidated: 0, toolResults: 0, statuses: [], clips: [], isMuted: false, spawns: [], spawnedAt: [], samples: 0, killed: 0, sshDown: null }
  let spawned = 0

  mock.env(on, { HOME: '/h' })
  mock.store(on)
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

    const path = String(e.argv.at(-1))

    // `head -n 1 <path>` and `tail -c <n> <path>` of a run file answer from `files`, counted as reads.
    if ((e.argv[0] === 'head' || e.argv[0] === 'tail') && path.startsWith(`${ROOT}/`)) {
      const file = world.files[path.slice(ROOT.length + 1)]
      const stdout = file === undefined ? '' : e.argv[0] === 'head' ? `${file.text.split('\n')[0]}\n` : file.text.slice(-Number(e.argv[2]))

      world.reads.push(path)

      return { value: { exitCode: file === undefined ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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

    if (e.path === '/h/.claude/progress/canvas.json') {
      return world.canvas === undefined ? { deny: `ENOENT ${e.path}` } : { value: world.canvas }
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
export const mine = (world: World) => JSON.parse(world.sessions['me.json'] ?? 'null') as Record<string, unknown> | null

export const PROMPT = { text: 'go', wait: false, origin: { kind: 'composer' } } as never
/** One key typed into the prompt box; the test engine raises prompt.edit, which its `$` type does not list. */
export const typeKey = ($: Engine) =>
  ($.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }).edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'a' })

/** Another session's presence file, its heartbeat `now`. */
export const peer = (id: string, state: string, since: number, more: Record<string, unknown> = {}) =>
  JSON.stringify({ id, name: id, state, since, updatedAt: since, ...more })

/** How many times dashboard's `key` atom has been written so far. */
export function writes(on: On, key: string): () => number {
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
export function textOf(node: unknown): string {
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
export function linesOf(node: unknown): string[] {
  const tree = node as { type?: string; children?: unknown[] }

  if (tree.type === 'Text') {
    const text = textOf(tree)

    return text.trim() === '' ? [] : [text]
  }

  return (tree.children ?? []).flatMap(child => (typeof child === 'object' && child !== null ? linesOf(child) : []))
}

/** The color of each drawn Text whose whole text is `text`. */
export function colorsOf(node: unknown, text: string): unknown[] {
  const tree = node as { type?: string; props?: { color?: unknown }; children?: unknown[] }
  const own = tree.type === 'Text' && tree.children?.length === 1 && tree.children[0] === text ? [tree.props?.color] : []

  return [...own, ...(tree.children ?? []).flatMap(child => (typeof child === 'object' && child !== null ? colorsOf(child, text) : []))]
}

/** Every Box with a Button among its own children. */
export function boxesWithButton(node: unknown): unknown[] {
  const tree = node as { type?: string; children?: unknown[] }
  const children = (tree.children ?? []).filter(child => typeof child === 'object' && child !== null) as { type?: string }[]
  const own = tree.type === 'Box' && children.some(child => child.type === 'Button') ? [tree] : []

  return [...own, ...children.flatMap(boxesWithButton)]
}

/** Whether a drawn Text holding `text` is dim. */
export function isDimText(node: unknown, text: string): boolean {
  const tree = node as { type?: string; props?: { dimColor?: unknown }; children?: unknown[] }

  if (tree.type === 'Text' && textOf(tree).includes(text)) {
    return tree.props?.dimColor === true
  }

  return (tree.children ?? []).some(child => typeof child === 'object' && child !== null && isDimText(child, text))
}

/** The text of every dim Text, a dim plain Button's label too. */
export function dimTexts(node: unknown, out: string[] = []): string[] {
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
export function inlineOf(node: unknown): string {
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
export function rowsOf(node: unknown): string[] {
  const tree = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }

  if (tree.type === 'Box' && tree.props?.flexDirection === 'column') {
    return (tree.children ?? []).filter(child => typeof child === 'object' && child !== null).flatMap(rowsOf)
  }

  return [inlineOf(tree)]
}

/** The engine's model request beneath turn.step: one text chunk, then the end. */
export function stepper(on: On): void {
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'hi' }

    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: usage(10) }
  })
}

export const stepIn = (turnId: string, index = 0, agentId?: string) => ({ turnId, index, model: 'claude-opus-5-5', messageCount: 2, ...(agentId !== undefined && { agentId }) }) as never

/** Runs a turn.step stream to its end. */
export async function drain(stream: AsyncGenerator<unknown, unknown>): Promise<void> {
  while ((await stream.next()).done !== true) {}
}

/** A main turn of `steps` steps, ended unless `isOpen`. */
export async function mainTurn($: Engine, turnId: string, steps: number, isOpen = false): Promise<void> {
  await $.turn.start({ text: 'go', turnId })

  for (let i = 0; i < steps; i += 1) {
    await drain($.turn.step(stepIn(turnId, i)))
  }

  if (!isOpen) {
    await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId, reason: 'answer' } as never)
  }
}

/** mm as dashboard sees it: `/mm-watch` writes mm's own `watches`. Loaded from its source alone: nothing of this file's in scope. */
export const MM = {
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
