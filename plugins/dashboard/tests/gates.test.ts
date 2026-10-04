import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderInput } from 'claude-code'

const NOW = 1_790_922_800_000
const BOTTOM = { type: 'Text', props: {}, children: ['engine band'] }
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

const BUN_OK = ['(pass) a [1ms]', '', ' 24 pass', ' 0 fail', 'Ran 24 tests across 1 file. [0.17s]'].join('\n')
const BUN_FAIL = ['(pass) a [1ms]', '(fail) b > breaks [2ms]', '', ' 22 pass', ' 2 fail', 'Ran 24 tests across 1 file. [0.17s]'].join('\n')
const HARNESS = 'claude plugin test plugins/harness'
const XCODE_FALSE_GREEN = ['Test run with 824 tests in 50 suites passed after 1.000 seconds.', '** TEST FAILED **'].join('\n')
const PYTEST_ERRORS = ['ERROR tests/test_b.py::test_two - fixture not found', '========= 3 passed, 2 errors in 0.31s ========='].join('\n')
const ST_FAILED_ONLY = 'Test "x" failed after 0.010 seconds with 1 issue.'
const WT = '/r/.claude/worktrees/agent-wt'
const DASH = 'claude   plugin test\n plugins/dashboard'

const band = (surface: Surface): RenderInput<'AbovePrompt'> => ({
  component: 'AbovePrompt',
  surface,
  requestId: 'band',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 19 }, view: {} },
})

const pane = (surface: Surface): RenderInput<'Pane'> => ({
  component: 'Pane',
  surface,
  requestId: 'dashboard',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: { title: '工作台', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
})

/** The engine beneath the plugin: a fixed clock. */
function seat(on: On) {
  const clock = mock.clock(on, { now: NOW })

  mock.env(on, { HOME: '/h' })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.root', () => ({ value: '/work' }))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('ui.render', () => BOTTOM as never)

  return { clock }
}

/** A Bash call that exited 0, as PostToolUse reports it. */
const ran = ($: Engine, command: string, stdout: string, cwd = '/work', agentId?: string) =>
  $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout, stderr: '', interrupted: false },
    tool_use_id: 'toolu_g',
    cwd,
    ...(agentId !== undefined && { agent_id: agentId }),
  } as never)

/** A Bash call that exited nonzero, as PostToolUseFailure reports it. */
const failed = ($: Engine, command: string, output: string, cwd = '/work') =>
  $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_g', error: `Exit code 1\n${output}`, cwd } as never)

/** A file tool's call that ran, as PostToolUse reports it. */
const edited = ($: Engine, tool: string, path: string) =>
  $.classic.PostToolUse({ tool_name: tool, tool_input: tool === 'NotebookEdit' ? { notebook_path: path } : { file_path: path }, tool_response: 'ok', tool_use_id: 'toolu_e', cwd: '/work' } as never)

/** `git worktree list` gives the session root and `paths` as its linked worktrees; every other git call fails. */
function listTrees(on: On, paths: string[]) {
  const porcelain = ['worktree /work', `HEAD ${'1'.repeat(40)}`, 'branch refs/heads/main', '', ...paths.flatMap(path => [`worktree ${path}`, `HEAD ${'2'.repeat(40)}`, 'branch refs/heads/b', ''])].join('\n')

  on('process.run', ($, e) => {
    const isList = e.argv.join(' ') === 'git -C /work worktree list --porcelain'

    return { value: { exitCode: isList ? 0 : 1, stdout: isList ? porcelain : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

/** The color of each drawn Text whose whole text is `text`. */
function colorsOf(node: unknown, text: string): unknown[] {
  const tree = node as { type?: string; props?: { color?: unknown }; children?: unknown[] }
  const own = tree.type === 'Text' && tree.children?.length === 1 && tree.children[0] === text ? [tree.props?.color] : []

  return [...own, ...(tree.children ?? []).flatMap(child => (typeof child === 'object' && child !== null ? colorsOf(child, text) : []))]
}

/** Every string a drawn tree holds, joined. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  // The desktop draws a gate's command as a Code, whose text is its source.
  if ((node as { type?: string }).type === 'Code') {
    return String((node as { props?: { source?: unknown } }).props?.source ?? '')
  }

  return ((node as { children?: unknown[] }).children ?? []).map(textOf).join('')
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

describe('gates', () => {
  test('nothing recorded yet: no 最近门禁 section', { options: { language: 'zh-CN' } }, async ($, on) => {
    seat(on)

    for (const surface of SURFACES) {
      const text = textOf(await $.ui.render(pane(surface)))

      expect(text).not.toContain('最近门禁')
      expect(text).not.toContain('还没有门禁记录')
    }
  })

  test('最近门禁 shows the newest three', { options: { language: 'zh-CN' } }, async ($, on) => {
    seat(on)

    for (const cmd of ['bun test a', 'bun test b', 'bun test c', 'bun test d']) {
      await ran($, cmd, BUN_OK)
    }

    for (const surface of SURFACES) {
      const drawn = await $.ui.render(pane(surface))
      const text = textOf(drawn)

      expect(text).toContain('最近门禁')
      expect(text).toContain('bun test b')
      expect(text).toContain('bun test d')
      expect(text, surface).not.toContain('bun test a')

      if (surface === 'desktop') {
        expect(JSON.stringify(drawn), 'the desktop folds the rest behind a Button').toContain('另有 1 项')
      }
    }
  })

  test('a passing and a failing run show under 最近门禁, newest first', { options: { language: 'zh-CN' } }, async ($, on) => {
    seat(on)
    await ran($, DASH, BUN_OK)
    await failed($, HARNESS, BUN_FAIL)

    for (const surface of SURFACES) {
      const text = textOf(await $.ui.render(pane(surface)))

      expect(text).toContain('最近门禁')
      expect(text).not.toContain('还没有门禁记录')

      if (surface === 'terminal') {
        expect(text).toContain('22 pass · 2 fail')
        expect(text).toContain('24 pass · 0 fail')
        expect(text).toContain('claude plugin test plugins/dashboard')
        expect(text).toContain('main · ')
        expect(text.indexOf(HARNESS)).toBeLessThan(text.indexOf('claude plugin test plugins/dashboard'))
      } else {
        // The desktop titles a gate by its command's first line, the outcome on the line under it.
        expect(text).toContain('主树 · 2 fail')
        expect(text).toContain('claude plugin test主树 · 通过 24')
        expect(text.lastIndexOf('主树 · 2 fail')).toBeLessThan(text.indexOf('主树 · 通过 24'))
      }
    }

    const desktop = textOf(await $.ui.render(pane('desktop')))

    expect(desktop).toContain('✗ 失败')
    expect(desktop).toContain('✓ 通过')
  })

  test('a failed gate is on the band until the same command passes', { options: { language: 'zh-CN' } }, async ($, on) => {
    seat(on)

    await failed($, HARNESS, BUN_FAIL)

    for (const surface of SURFACES) {
      expect(textOf(await $.ui.render(band(surface)))).toContain(`✗ 门禁 ${HARNESS} · 2 fail`)
    }

    await ran($, DASH, BUN_OK)
    expect(textOf(await $.ui.render(band('terminal'))), 'another command passing leaves it pending').toContain(`✗ 门禁 ${HARNESS} · 2 fail`)

    await ran($, HARNESS, BUN_OK)

    for (const surface of SURFACES) {
      expect(linesOf(await $.ui.render(band(surface)))).toEqual(['空闲 · 门禁 ✓ 24 pass 0s前', 'engine band'])
    }
  })

  test('packages label: a go run that counted packages says packages on the band and the overview', { options: { language: 'en' } }, async ($, on) => {
    seat(on)
    await ran($, 'go test ./...', ['ok  \texample.com/a\t0.01s', 'FAIL\texample.com/b\t0.02s'].join('\n'))

    for (const surface of SURFACES) {
      expect(textOf(await $.ui.render(band(surface))), surface).toContain('✗ gate go test ./... · packages · 1 fail')
      expect(textOf(await $.ui.render(pane(surface))), surface).toContain(surface === 'terminal' ? 'packages · 1 pass · 1 fail' : 'main · packages · 1 fail')
    }
  })

  test('a failed gate leaves the band after 30 minutes', { options: { language: 'zh-CN' } }, async ($, on) => {
    const { clock } = seat(on)

    await failed($, HARNESS, BUN_FAIL)
    await clock.advance(30 * 60_000 + 1)
    expect(linesOf(await $.ui.render(band('terminal'))), 'off the band, still the last gate on the idle line').toEqual(['空闲 · 门禁 ✗ 2 fail 30m前', 'engine band'])
  })

  test('where: the worktree a cd or the cwd points into, else main', async ($, on) => {
    seat(on)
    await ran($, 'cd /x/.claude/worktrees/agent-abc && bun test', BUN_OK)
    await ran($, 'bun test hooks', BUN_OK, '/r/.claude/worktrees/agent-def', 'a1')

    for (const surface of SURFACES) {
      const text = textOf(await $.ui.render(pane(surface)))

      expect(text).toContain('agent-abc · ')
      expect(text).toContain('agent-def · ')
      expect(text).not.toContain('main · ')
    }
  })

  test('where: a worktree the dashboard lists, wherever it lies, through a quoted or ~ cd; a .claude/worktrees dir made since the last collection is still its tree', { options: { language: 'zh-CN' } }, async ($, on) => {
    seat(on)
    listTrees(on, ['/elsewhere/feat x', '/h/wt/home-tree'])
    // A git worktree command has the dashboard collect the worktrees.
    await ran($, 'git worktree list', '')
    await failed($, "cd '/elsewhere/feat x/hooks' && bun test q", BUN_FAIL)
    await failed($, 'cd "/elsewhere/feat x" && bun test d', BUN_FAIL)
    await failed($, 'cd ~/wt/home-tree && bun test', BUN_FAIL)
    await failed($, 'bun test c', BUN_FAIL, '/elsewhere/feat x/sub')
    await failed($, 'bun test gone', BUN_FAIL, '/work/.claude/worktrees/agent-gone')

    for (const surface of SURFACES) {
      const text = textOf(await $.ui.render(pane(surface)))

      if (surface === 'terminal') {
        expect(text, surface).toContain("门禁 cd '/elsewhere/feat x/hooks' && bun test q · feat x · 2 fail")
        expect(text, surface).toContain('门禁 cd "/elsewhere/feat x" && bun test d · feat x · 2 fail')
        expect(text, surface).toContain('门禁 cd ~/wt/home-tree && bun test · home-tree · 2 fail')
        expect(text, surface).toContain('门禁 bun test c · feat x · 2 fail')
        expect(text, surface).toContain('需要你 · 4')
        expect(text, `${surface}: not listed, so it needs nobody; still under 最近门禁`).toContain('bun test gone  agent-gone · ')
      } else {
        // Titled by the command without its cd; 需要你 shows three of the four.
        expect(text, surface).toContain('bun test qfeat x · 2 fail')
        expect(text, surface).toContain('bun test dfeat x · 2 fail')
        expect(text, surface).toContain('bun testhome-tree · 2 fail')
        expect(text, surface).toContain('bun test cfeat x · 2 fail')
        expect(text, surface).toContain('需要你  4')
        expect(text, `${surface}: not listed, so it needs nobody; still under 最近门禁`).toContain('bun test goneagent-gone · 2 fail')
      }

      expect(text, surface).not.toContain('门禁 bun test gone · agent-gone')
    }
  })

  test('an edit in a worktree the dashboard lists makes that tree\'s gates 过期, not main\'s', { options: { language: 'zh-CN' } }, async ($, on) => {
    const { clock } = seat(on)

    listTrees(on, ['/elsewhere/feat'])
    await ran($, 'git worktree list', '')
    await failed($, HARNESS, BUN_FAIL)
    await failed($, 'bun test', BUN_FAIL, '/elsewhere/feat')
    await clock.advance(60_000)
    await edited($, 'Edit', '/elsewhere/feat/hooks/board.ts')

    for (const surface of SURFACES) {
      const text = textOf(await $.ui.render(band(surface)))

      expect(text, surface).toContain(`✗ 门禁 ${HARNESS} · 2 fail`)
      expect(text, surface).not.toContain('门禁 bun test · 2 fail')
    }
  })

  test('a failed gate in a worktree the dashboard no longer lists needs nobody: off the band and 需要你', { options: { language: 'zh-CN' } }, async ($, on) => {
    seat(on)
    listTrees(on, ['/elsewhere/feat'])
    await ran($, 'git worktree list', '')
    await failed($, HARNESS, BUN_FAIL, WT)
    await failed($, 'bun test', BUN_FAIL, '/elsewhere/feat')

    for (const surface of SURFACES) {
      const drawn = textOf(await $.ui.render(band(surface)))

      expect(drawn, surface).toContain('✗ 门禁 bun test · 2 fail · feat')
      expect(drawn, surface).not.toContain(HARNESS)
      expect(textOf(await $.ui.render(pane(surface))), surface).toContain(surface === 'terminal' ? '需要你 · 1' : '需要你  1')
    }
  })

  test('two commands alike in their first 120 characters, or apart only in spaces inside quotes, are two gates', { options: { language: 'zh-CN' } }, async ($, on) => {
    seat(on)

    const long = `bun test ${'x'.repeat(120)}`

    await failed($, `${long} a`, BUN_FAIL)
    await ran($, `${long} b`, BUN_OK)
    await failed($, "bun test -t 'a  b'", BUN_FAIL)
    await ran($, "bun test -t 'a b'", BUN_OK)

    for (const surface of SURFACES) {
      expect(textOf(await $.ui.render(pane(surface))), `${surface}: neither pass covers the other command's failure`).toContain(surface === 'terminal' ? '需要你 · 2' : '需要你  2')
    }
  })

  test('a failed gate alone on the band leaves it at its 30 minutes with nothing else redrawing', { options: { language: 'zh-CN' } }, async ($, on) => {
    const { clock } = seat(on)
    const bands = []

    for (const surface of SURFACES) {
      bands.push(await $.ui.mount({ plugin: 'dashboard', ...band(surface) } as never))
    }

    await clock.advance(10_000)
    await failed($, HARNESS, BUN_FAIL)
    await clock.advance(30 * 60_000)

    for (const ui of bands) {
      expect(linesOf(await ui.drawn()), ui.surface).toEqual(['空闲 · 门禁 ✗ 2 fail 30m前', 'engine band'])
      await ui.unmount()
    }
  })

  test('a run the summary calls failed is ✗ with 失败, not 0 fail, and covers the ✓ the same command had',{ options: { language: 'zh-CN' } }, async ($, on) => {
    seat(on)
    await ran($, DASH, BUN_OK)
    await ran($, DASH, XCODE_FALSE_GREEN)

    for (const surface of SURFACES) {
      expect(textOf(await $.ui.render(band(surface))), surface).toContain('✗ 门禁 claude plugin test plugins/dashboard · 失败')
    }

    expect(linesOf(await $.ui.render(pane('terminal'))).filter(line => /^[✓✗] \d+ pass/.test(line)).map(line => line.slice(0, 20))).toEqual(['✗ 824 pass · 失败  cla', '✓ 24 pass · 0 fail  '])

    const desktop = textOf(await $.ui.render(pane('desktop')))

    expect(desktop.indexOf('✗ 失败')).toBeLessThan(desktop.indexOf('✓ 通过'))
    expect(desktop.split('✗ 失败').length - 1).toBe(1)
  })

  test('总览 需要你 words a gate as the band does: 失败 when nothing counted failing, not 0 fail', { options: { language: 'zh-CN' } }, async ($, on) => {
    seat(on)
    await ran($, DASH, XCODE_FALSE_GREEN)

    for (const surface of SURFACES) {
      const text = textOf(await $.ui.render(pane(surface)))

      expect(text, surface).toContain(surface === 'terminal' ? '门禁 claude plugin test plugins/dashboard · main · 失败' : 'claude plugin test主树 · 失败')
      expect(text, surface).not.toContain(surface === 'terminal' ? 'main · 0 fail' : '主树 · 0 fail')
    }
  })

  test('a run that ended in PostToolUseFailure is ✗ whatever its counts say', { options: { language: 'zh-CN' } }, async ($, on) => {
    seat(on)
    await ran($, 'bun test x', BUN_OK)
    await failed($, 'bun test x', BUN_OK)
    await failed($, 'pytest -q', PYTEST_ERRORS)

    for (const surface of SURFACES) {
      const drawn = textOf(await $.ui.render(band(surface)))

      expect(drawn, surface).toContain('✗ 门禁 bun test x · 失败')
      expect(drawn, surface).toContain('✗ 门禁 pytest -q · 2 fail')
    }

    expect(linesOf(await $.ui.render(pane('terminal'))).filter(line => /^[✓✗] \d+ pass/.test(line)).map(line => line.slice(0, 20))).toEqual(['✗ 3 pass · 2 fail  p', '✗ 24 pass · 失败  bun ', '✓ 24 pass · 0 fail  '])
  })

  test('the same command in a worktree and the main tree are two gates; a relative cd stays in the cwd worktree', { options: { language: 'zh-CN' } }, async ($, on) => {
    seat(on)
    await failed($, HARNESS, BUN_FAIL, WT)
    await ran($, HARNESS, BUN_OK, '/r')
    await ran($, 'cd sub && bun test', BUN_OK, WT)

    for (const surface of SURFACES) {
      expect(textOf(await $.ui.render(band(surface))), `${surface}: main passing leaves the worktree's failure`).toContain(`✗ 门禁 ${HARNESS} · 2 fail`)

      const text = textOf(await $.ui.render(pane(surface)))

      if (surface === 'terminal') {
        expect(text).toMatch(new RegExp(`${HARNESS}\\s*main · `))
        expect(text).toMatch(new RegExp(`${HARNESS}\\s*agent-wt · `))
        expect(text, surface).toMatch(/cd sub && bun test\s*agent-wt · /)
      } else {
        expect(text).toMatch(/claude plugin test plugi\S*主树 · 通过 24/)
        expect(text).toContain(`${HARNESS}agent-wt · 2 fail`)
        expect(text, 'titled without its cd').toContain('bun testagent-wt · 通过 24')
      }
    }

    await ran($, HARNESS, BUN_OK, `${WT}/hooks`)

    for (const surface of SURFACES) {
      expect(linesOf(await $.ui.render(band(surface)))).toEqual(['空闲 · 门禁 ✓ 24 pass 0s前', 'engine band'])
    }
  })

  test('a count no line gave is —, not 0', { options: { language: 'zh-CN' } }, async ($, on) => {
    seat(on)
    await failed($, 'swift test', ST_FAILED_ONLY)

    for (const surface of SURFACES) {
      const text = textOf(await $.ui.render(pane(surface)))

      expect(text, surface).toContain(surface === 'terminal' ? '— pass · 1 fail' : '主树 · 1 fail')
      expect(text, surface).not.toContain('0 pass')
    }
  })

  test('总览 需要你 lists a failing gate with where it ran, until it passes or 30 minutes go by', { options: { language: 'zh-CN' } }, async ($, on) => {
    const { clock } = seat(on)

    await failed($, HARNESS, BUN_FAIL, WT)

    for (const surface of SURFACES) {
      const text = textOf(await $.ui.render(pane(surface)))

      expect(text, surface).toContain(surface === 'terminal' ? '需要你 · 1' : '需要你  1')
      expect(text, surface).toContain(surface === 'terminal' ? `门禁 ${HARNESS} · agent-wt · 2 fail` : `门禁  ${HARNESS}agent-wt · 2 fail`)
      expect(text, surface).not.toContain('没有需要你处理或运行中的任务')
    }

    expect(linesOf(await $.ui.render(pane('terminal')))).toContain(`✗ 门禁 ${HARNESS} · agent-wt · 2 fail`)

    await clock.advance(30 * 60_000 + 1)

    for (const surface of SURFACES) {
      expect(textOf(await $.ui.render(pane(surface))), surface).not.toContain(surface === 'terminal' ? '需要你 · ' : '需要你  ')
    }
  })

  test('an edit in its tree after a gate ran makes it 过期: inactive, off the band\'s failures and 需要你', { options: { language: 'zh-CN' } }, async ($, on) => {
    const { clock } = seat(on)

    await ran($, 'bun test x', BUN_OK, WT)
    await failed($, HARNESS, BUN_FAIL)
    await clock.advance(60_000)
    await edited($, 'Edit', '/work/hooks/board.ts')

    for (const surface of SURFACES) {
      const drawn = await $.ui.render(band(surface))

      expect(linesOf(drawn), surface).toEqual(['空闲 · 门禁 ✗ 2 fail · 过期 1m前', 'engine band'])
      expect(colorsOf(drawn, '✗'), surface).toEqual(['inactive'])

      const text = textOf(await $.ui.render(pane(surface)))

      expect(text, surface).not.toContain(surface === 'terminal' ? '需要你 · ' : '需要你  ')
      expect(text, surface).toContain(surface === 'terminal' ? '24 pass · 0 fail  bun test x' : '✓ 通过  bun test xagent-wt · 通过 24')
      expect(text, `${surface}: the worktree's gate is not 过期`).not.toMatch(/0 fail · 过期/)
    }

    const terminal = await $.ui.render(pane('terminal'))

    expect(linesOf(terminal).filter(line => /^[✓✗] \d+ pass/.test(line)).map(line => line.slice(0, 26))).toEqual(['✗ 22 pass · 2 fail · 过期  c', '✓ 24 pass · 0 fail  bun te'])
    expect(colorsOf(terminal, '✗')).toEqual(['inactive'])
    expect(colorsOf(terminal, ' · 过期')).toEqual(['inactive'])
    expect(colorsOf(await $.ui.render(pane('desktop')), ' ✗ 失败 ')).toEqual(['inactive'])
    expect(textOf(await $.ui.render(pane('desktop')))).toContain('主树 · 2 fail · 过期 · 1m前')
  })

  test('what does not make a gate 过期: an edit in another tree or outside the session root, or one no later than the gate', { options: { language: 'zh-CN' } }, async ($, on) => {
    const { clock } = seat(on)

    await failed($, HARNESS, BUN_FAIL)
    await clock.advance(60_000)
    await edited($, 'Write', `${WT}/hooks/board.ts`)
    await edited($, 'Edit', '/tmp/notes.md')
    await failed($, 'bun test', BUN_FAIL, WT)
    await edited($, 'MultiEdit', `${WT}/hooks/board.ts`)

    for (const surface of SURFACES) {
      const text = textOf(await $.ui.render(band(surface)))

      expect(text, surface).toContain(`✗ 门禁 ${HARNESS} · 2 fail`)
      expect(text, surface).toContain('✗ 门禁 bun test · 2 fail · agent-wt')
    }

    await clock.advance(1_000)
    await edited($, 'NotebookEdit', `${WT}/notes.ipynb`)

    for (const surface of SURFACES) {
      const text = textOf(await $.ui.render(band(surface)))

      expect(text, surface).toContain(`✗ 门禁 ${HARNESS} · 2 fail`)
      expect(text, surface).not.toContain('bun test · 2 fail · agent-wt')
    }
  })

  test('output that is not a test run, or a tool other than Bash, is not recorded', { options: { language: 'zh-CN' } }, async ($, on) => {
    seat(on)
    await ran($, 'ls', 'README.md\nsrc')
    await failed($, 'ls nope', 'ls: nope: No such file')
    await $.classic.PostToolUse({ tool_name: 'Read', tool_input: { file_path: '/x' }, tool_response: BUN_FAIL, tool_use_id: 'toolu_r', cwd: '/work' } as never)

    for (const surface of SURFACES) {
      expect(textOf(await $.ui.render(pane(surface)))).not.toContain('最近门禁')
    }
  })
})
