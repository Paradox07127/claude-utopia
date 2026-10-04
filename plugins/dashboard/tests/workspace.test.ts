import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderInput, SessionStartInput } from 'claude-code'

import { setLang } from '../hooks/i18n'
import { parseAheadBehind, parseWorktrees, treeMarks, treeOf } from '../hooks/workspace'

const ZH = { options: { language: 'zh-CN' } }

const NOW = 1_790_922_800_000
const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/r' }
const BOTTOM = { type: 'Text', props: {}, children: ['engine band'] }
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

const A = '/r/.claude/worktrees/agent-a'
const B = '/r/.claude/worktrees/agent-b'
const PORCELAIN = [
  'worktree /r',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  `worktree ${A}`,
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/worktree-agent-a',
  '',
  `worktree ${B}`,
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
].join('\n')
const GUARD = '/h/.claude/harness/guard.jsonl'
const TAIL = `tail -c 65536 ${GUARD}`
const blocked = (ago: number, decision: string, op: string, cwd: string | null, agentId: string | null) =>
  JSON.stringify({ at: NOW - ago, guard: 'shared-tree-git', decision, op, cwd, agent_id: agentId })
/** Six blocks after the end of a line the 64 KB cut began inside, one line that is no JSON, and an `unchecked` line an older guard wrote. */
const GUARD_LOG = [
  'ision": "deny", "op": "cut"}',
  blocked(600_000, 'deny', 'git stash', '/r', null),
  blocked(500_000, 'deny', 'cat codex.raw', A, 'abcdef0123456789'),
  blocked(400_000, 'unchecked', 'git checkout', null, null),
  'not json',
  blocked(300_000, 'deny', 'git reset --hard', '/r', null),
  blocked(200_000, 'deny', 'git rebase main', B, 'a1'),
  blocked(65_000, 'deny', 'git checkout main', '/r', null),
  '',
].join('\n')

const command = (name: string, args = '') => ({
  command: name,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 180 },
})

const pane = (surface: Surface): RenderInput<'Pane'> => ({
  component: 'Pane',
  surface,
  requestId: 'dashboard',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: { title: '工作台', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
})

type Reply = { exitCode: number; stdout: string; stderr?: string }

/** The engine beneath the plugin: git answers from `replies` by argv, the home directory is empty. */
function seat(on: On) {
  const world = {
    replies: new Map<string, Reply>([
      ['git -C /r worktree list --porcelain', { exitCode: 0, stdout: PORCELAIN }],
      [`git -C ${A} status --porcelain`, { exitCode: 0, stdout: ' M a.ts\n M b.ts\n?? c.ts\n' }],
      [`git -C ${A} rev-list --left-right --count main...HEAD`, { exitCode: 0, stdout: '0\t2\n' }],
      [`git -C ${B} status --porcelain`, { exitCode: 0, stdout: '' }],
      [`git -C ${B} rev-list --left-right --count main...HEAD`, { exitCode: 0, stdout: '1\t0\n' }],
    ]),
    runs: [] as string[],
    panes: new Set<string>(),
    /** ~/.claude/harness/guard.jsonl's mtime; null while there is none. Its tail is `replies`' TAIL. */
    guardMtimeMs: null as number | null,
    copies: [] as string[],
    toasts: [] as string[],
  }
  const clock = mock.clock(on, { now: NOW })

  mock.env(on, { HOME: '/h' })
  on('session.root', () => ({ value: '/r' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('settings.read', () => ({ value: {} }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    world.panes.add(e.id)

    return { value: { isPlaced: true } } as never
  })
  on('ui.panes', () => ({ value: [...world.panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    const reply = world.replies.get(argv) ?? { exitCode: 1, stdout: '', stderr: `unexpected ${argv}` }

    world.runs.push(argv)

    return { value: { exitCode: reply.exitCode, stdout: reply.stdout, stderr: reply.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', ($, e) =>
    e.path === GUARD && world.guardMtimeMs !== null ? { value: { kind: 'file', size: 1, mtimeMs: world.guardMtimeMs, isLink: false } } : { deny: `ENOENT ${e.path}` },
  )
  on('ui.copy', ($, e) => {
    world.copies.push(e.text)

    return { value: { isCopied: true } }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('fs.read', ($, e) => ({ deny: `ENOENT ${e.path}` }))
  on('classic.PostToolUse', () => ({}))
  on('ui.render', () => BOTTOM as never)

  return { world, clock }
}

/** Every string a drawn tree holds, joined. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  return ((node as { children?: unknown[] }).children ?? []).map(textOf).join('')
}

const bash = ($: Engine, cmd: string) =>
  $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: cmd }, tool_response: { stdout: '', stderr: '', interrupted: false }, tool_use_id: 'toolu_w', cwd: '/r' } as never)

const listed = (runs: string[]) => runs.filter(argv => argv.endsWith('worktree list --porcelain')).length

/** The drawn tree's lines: each Text not inside another Text, its nested Texts joined. */
function linesOf(node: unknown): string[] {
  const tree = node as { type?: string; children?: unknown[] }

  if (tree.type === 'Text') {
    return [textOf(tree)]
  }

  return (tree.children ?? []).flatMap(child => (typeof child === 'object' && child !== null ? linesOf(child) : []))
}

describe('workspace parsing', () => {
  test('porcelain: the main tree first, branches without refs/heads/, detached named so', () => {
    expect(parseWorktrees(PORCELAIN)).toEqual([
      { path: '/r', head: '1111111111111111111111111111111111111111', branch: 'main' },
      { path: A, head: '2222222222222222222222222222222222222222', branch: 'worktree-agent-a' },
      { path: B, head: '3333333333333333333333333333333333333333', branch: 'detached' },
    ])
  })

  test('rev-list --left-right --count prints behind, then ahead', () => {
    expect(parseAheadBehind('3\t5\n')).toEqual({ behind: 3, ahead: 5 })
    expect(parseAheadBehind('0\t0')).toEqual({ behind: 0, ahead: 0 })
  })

  test('uncommitted changes with nothing ahead: not merged, no 已合入 可删', () => {
    const tree = treeOf('agent-a', 'worktree-agent-a', ' M a.ts\n', '0\t0\n', false)

    setLang('zh-CN')
    expect(tree.merged).toBe(false)
    expect(treeMarks(tree).map(mark => mark.text)).toEqual(['改动 1'])
  })

  test('a running worker clean and level with main shows only 运行中', () => {
    const tree = { name: 'agent-abc', branch: 'worktree-agent-abc', dirty: 0, ahead: 0, behind: 0, merged: true, running: true, error: null }

    setLang('zh-CN')
    expect(treeMarks(tree)).toEqual([{ text: '运行中', tone: 'running' }])
  })
})

describe('workspace cards', () => {
  test('the overview shows the worktrees on both surfaces, no 会话状态', ZH, async ($, on) => {
    const { clock } = seat(on)

    await $.session.start(SESSION)
    await $.command.run(command('dashboard'))
    await clock.settle()

    for (const surface of SURFACES) {
      const text = textOf(await $.ui.render(pane(surface)))

      expect(text).toContain(surface === 'terminal' ? '工作树 · 2' : '工作树  2')
      expect(text).toContain('agent-a')
      expect(text).toContain('worktree-agent-a')
      expect(text).toContain('改动 3')
      expect(text).toContain('领先 2')
      expect(text).toContain('detached')
      expect(text).toContain('落后 1')
      expect(text).toContain('已合入 可删')
      expect(text).not.toContain('会话状态')
      expect(text.indexOf('最近门禁')).toBeLessThan(text.indexOf('工作树'))
    }
  })

  test('before the first collection 工作树 reads 读取中…, no 会话状态', ZH, async ($, on) => {
    seat(on)

    for (const surface of SURFACES) {
      const text = textOf(await $.ui.render(pane(surface)))

      expect(text).toContain('读取中…')
      expect(text).not.toContain('会话状态')
    }
  })

  test('a failing git call reads 读取失败', ZH, async ($, on) => {
    const { world, clock } = seat(on)

    await $.session.start(SESSION)
    await $.command.run(command('dashboard'))
    await clock.settle()
    world.replies.set(`git -C ${A} status --porcelain`, { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\nmore' })
    await bash($, 'git commit -m x')
    await clock.settle()

    for (const surface of SURFACES) {
      const text = textOf(await $.ui.render(pane(surface)))

      expect(text).toContain('读取失败')
      // The desktop's side-by-side column cuts the metadata line short.
      expect(text).toContain(surface === 'terminal' ? 'fatal: not a git repository' : '读取失败 · fatal: not a')
      expect(text).not.toContain('more')
      expect(text).not.toContain('改动 3')
    }
  })

  test('a running worker\'s worktree reads 运行中, not 已合入 可删, until the agent ends', ZH, async ($, on) => {
    const { world, clock } = seat(on)
    const C = '/r/.claude/worktrees/agent-abc'
    const rowOf = async (surface: Surface) => {
      const lines = linesOf(await $.ui.render(pane(surface)))
      const at = lines.findIndex(line => line.includes('worktree-agent-abc'))

      if (at === -1) {
        return ''
      }

      return lines[at] ?? ''
    }

    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'abc' }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    world.replies.set('git -C /r worktree list --porcelain', {
      exitCode: 0,
      stdout: [PORCELAIN.split('\n\n')[0], '', `worktree ${C}`, 'HEAD 4444444444444444444444444444444444444444', 'branch refs/heads/worktree-agent-abc', ''].join('\n'),
    })
    world.replies.set(`git -C ${C} status --porcelain`, { exitCode: 0, stdout: '' })
    world.replies.set(`git -C ${C} rev-list --left-right --count main...HEAD`, { exitCode: 0, stdout: '0\t0\n' })
    await $.session.start(SESSION)
    await $.command.run(command('dashboard'))
    await clock.settle()
    await $.agent.spawn({ tool_use_id: 'toolu_1', prompt: 'do it', description: 'Fix cards', subagentType: 'worker', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false } as never)
    await clock.settle()

    for (const surface of SURFACES) {
      const row = await rowOf(surface)

      expect(row, surface).toContain('运行中')
      expect(row, surface).not.toContain('已合入 可删')
    }

    await $.turn.complete({ answer: 'ok', durationMs: 1_000, isAborted: false, turnId: 't', agentId: 'abc', reason: 'answer' } as never)
    await clock.settle()

    for (const surface of SURFACES) {
      const row = await rowOf(surface)

      expect(row, surface).toContain('已合入 可删')
      expect(row, surface).not.toContain('运行中')
    }
  })

  test('no linked worktree: no 工作树 section', ZH, async ($, on) => {
    const { world, clock } = seat(on)

    world.replies.set('git -C /r worktree list --porcelain', { exitCode: 0, stdout: PORCELAIN.split('\n\n')[0] ?? '' })
    await $.session.start(SESSION)
    await $.command.run(command('dashboard'))
    await clock.settle()

    for (const surface of SURFACES) {
      expect(textOf(await $.ui.render(pane(surface)))).not.toContain('工作树')
    }
  })

  test('five worktrees at most on the terminal, three on the desktop; the rest counted', ZH, async ($, on) => {
    const { world, clock } = seat(on)
    const paths = [1, 2, 3, 4, 5, 6, 7].map(n => `/r/.claude/worktrees/wt-${n}`)

    world.replies.set('git -C /r worktree list --porcelain', {
      exitCode: 0,
      stdout: [PORCELAIN.split('\n\n')[0], ...paths.map((path, i) => `worktree ${path}\nHEAD ${String(i).repeat(40)}\nbranch refs/heads/b-${i + 1}`)].join('\n\n'),
    })

    for (const path of paths) {
      world.replies.set(`git -C ${path} status --porcelain`, { exitCode: 0, stdout: '' })
      world.replies.set(`git -C ${path} rev-list --left-right --count main...HEAD`, { exitCode: 0, stdout: '0\t1\n' })
    }

    await $.session.start(SESSION)
    await $.command.run(command('dashboard'))
    await clock.settle()

    for (const surface of SURFACES) {
      const drawn = await $.ui.render(pane(surface))
      const lines = linesOf(drawn)

      expect(lines.filter(line => line.startsWith('wt-')), surface).toHaveLength(surface === 'terminal' ? 5 : 3)

      if (surface === 'terminal') {
        expect(lines, surface).toContain('… 另有 2 个')
      } else {
        expect(JSON.stringify(drawn), surface).toContain('另有 4 项')
      }
    }
  })
})

describe('workspace refresh', () => {
  test('a git merge in Bash collects; ls does not', async ($, on) => {
    const { world, clock } = seat(on)

    await bash($, 'ls')
    await clock.settle()
    expect(listed(world.runs)).toBe(0)

    await bash($, 'git merge --ff-only x')
    await clock.settle()
    expect(listed(world.runs)).toBe(1)
  })

  test('every 15 s while the overview is up, not on another page', async ($, on) => {
    const { world, clock } = seat(on)

    await $.session.start(SESSION)
    await $.command.run(command('dashboard'))
    await clock.settle()
    expect(listed(world.runs)).toBe(1)

    await clock.advance(15_000)
    expect(listed(world.runs)).toBe(2)

    await $.command.run(command('subagents'))
    await clock.advance(30_000)
    expect(listed(world.runs)).toBe(2)
  })
})

describe('recent blocks', () => {
  test('the last five denies of guard.jsonl, newest first, in inactive; an unchecked line an older guard wrote is skipped', ZH, async ($, on) => {
    const { world, clock } = seat(on)

    world.guardMtimeMs = NOW - 65_000
    world.replies.set(TAIL, { exitCode: 0, stdout: GUARD_LOG })
    await $.session.start(SESSION)
    await $.command.run(command('dashboard'))
    await clock.settle()

    const five = [
      'git checkout main · r · 主线程 · 1m05s前',
      'git rebase main · agent-b · a1 · 3m20s前',
      'git reset --hard · r · 主线程 · 5m00s前',
      'cat codex.raw · agent-a · abcdef01 · 8m20s前',
      'git stash · r · 主线程 · 10m00s前',
    ]

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'dashboard', ...pane(surface) } as never)
      let lines = linesOf(await ui.drawn())
      const head = surface === 'terminal' ? '最近拦截' : '最近拦截  5'
      const at = lines.indexOf(head)

      expect(at, surface).toBeGreaterThan(-1)

      // The desktop shows three, the rest behind 另有 2 项.
      if (surface === 'desktop') {
        expect(lines.slice(at + 1, at + 4), surface).toEqual(five.slice(0, 3))
        await ui.press({ key: 'more-guards' })
        lines = linesOf(await ui.drawn())
      }

      expect(lines.slice(lines.indexOf(head) + 1, lines.indexOf(head) + 6), surface).toEqual(five)
      expect(lines.join('\n'), `${surface}: the unchecked line`).not.toContain('6m40s前')
      expect(lines.join('\n'), surface).not.toContain('未检查')
      expect((await ui.find({ type: 'Text', text: 'git reset --hard · r · 主线程 · 5m00s前' }))?.props.color, surface).toBe('inactive')
      await ui.unmount()
    }

    const tails = () => world.runs.filter(argv => argv === TAIL).length

    expect(tails()).toBe(1)
    await clock.advance(15_000)
    expect(tails(), 'the mtime did not move: not read again').toBe(1)

    world.guardMtimeMs = NOW + 1_000
    await clock.advance(15_000)
    expect(tails()).toBe(2)
  })

  test('no guard.jsonl: no 最近拦截 section, nothing read', ZH, async ($, on) => {
    const { world, clock } = seat(on)

    await $.session.start(SESSION)
    await $.command.run(command('dashboard'))
    await clock.settle()

    for (const surface of SURFACES) {
      expect(textOf(await $.ui.render(pane(surface))), surface).not.toContain('最近拦截')
    }

    expect(world.runs.filter(argv => argv === TAIL)).toEqual([])
  })
})

describe('worktree rows', () => {
  test("复制 cd puts `cd '<path>'` on the clipboard and says 已复制", ZH, async ($, on) => {
    const { world, clock } = seat(on)

    await $.session.start(SESSION)
    await $.command.run(command('dashboard'))
    await clock.settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'dashboard', ...pane(surface) } as never)
      const button = await ui.find({ key: `copy-cd-${A}` })

      expect(button?.props.label, surface).toBe(surface === 'terminal' ? '复制 cd' : '命令')
      expect(button?.props.hotkey, surface).toBeUndefined()
      await ui.press({ key: `copy-cd-${A}` })

      if (surface === 'desktop') {
        expect((await ui.findAll({ type: 'Code' })).map(one => one.props.source), 'the desktop shows the command instead').toContain(`cd '${A}'`)
      }

      await ui.unmount()
    }

    expect(world.copies).toEqual([`cd '${A}'`])
    expect(world.toasts).toEqual(['已复制'])
  })
})
