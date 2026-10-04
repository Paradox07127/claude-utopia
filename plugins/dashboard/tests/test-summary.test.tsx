import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import buildOk from './fixtures/xcode/build-ok'
import compileError from './fixtures/xcode/compile-error'
import falseGreen from './fixtures/xcode/false-green'
import persistedPreview from './fixtures/xcode/persisted-preview'
import signingNoProfiles from './fixtures/xcode/signing-no-profiles'

const SURFACES = ['terminal', 'desktop'] as const

const BUN_FAIL = ['(pass) a [1ms]', '(fail) b > breaks [2ms]', '', ' 22 pass', ' 2 fail'].join('\n')
const BUN_OK = ['(pass) a [1ms]', '', ' 24 pass', ' 0 fail'].join('\n')

// Stands in for the engine's own drawing beneath the plugin.
const engineDraws = (on: On) => {
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>raw output</Text>
  })
}

const bashRow = (id: string, stdout: string) => ({
  tool_use_id: id,
  tool: 'Bash',
  output: { stdout, stderr: '', interrupted: false },
  isErrored: false,
})

const SUMMARY = { type: 'Text', text: / tests · / } as const
const RAW = { type: 'Text', text: 'raw output' } as const
const BUILD = { type: 'Text', text: / xcodebuild/ } as const

const textsOf = async (ui: { findAll: (q: { type?: string }) => Promise<{ text?: string; props: Record<string, unknown> }[]> }) => await ui.findAll({ type: 'Text' })

const mountResult = ($: Engine, surface: (typeof SURFACES)[number], id: string, stdout: string) =>
  $.ui.mount({ plugin: 'dashboard', surface, component: 'ToolResult', requestId: id, props: bashRow(id, stdout) })

type Row = Awaited<ReturnType<typeof mountResult>>

/** The terminal's head line and its color; on the desktop, the Texts of the verdict row joined by ` · `, and the verdict's color. */
async function headOf(ui: Row, surface: (typeof SURFACES)[number]) {
  if (surface === 'terminal') {
    const summary = await ui.find(SUMMARY)
    return { text: summary?.text, color: summary?.props.color }
  }
  const texts = await textsOf(ui)
  return { text: texts.length === 0 ? undefined : texts.map(t => t.text).join(' · '), color: texts[0]?.props.color }
}

/** The failure lines under the head: the terminal's indented Texts, the desktop's Code lines indented the same. */
async function failuresOf(ui: Row, surface: (typeof SURFACES)[number], pattern: RegExp) {
  if (surface === 'terminal') return (await ui.findAll({ type: 'Text', text: pattern })).map(t => t.text)
  const source = (await ui.find({ type: 'Code' }))?.props.source
  return typeof source === 'string' ? source.split('\n').map(line => `  ${line}`) : []
}

describe('ToolResult test summary', () => {
  test('draws the failing summary and failure lines, raw output hidden', async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_fail_${surface}`, BUN_FAIL)
      const summary = await headOf(ui, surface)
      expect(summary.text).toBe(surface === 'terminal' ? '✗ tests · 22 pass · 2 fail' : '✗ tests failed · 22 pass · 2 fail')
      expect(summary.color).toBe('error')
      expect(await failuresOf(ui, surface, /\(fail\)/)).toEqual(['  (fail) b > breaks [2ms]'])
      expect(await ui.find(RAW)).toBeUndefined()
      await ui.unmount()
    }
  })

  test('draws a passing summary in green without failure lines', async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_ok_${surface}`, BUN_OK)
      const summary = await headOf(ui, surface)
      expect(summary.text).toBe(surface === 'terminal' ? '✓ tests · 24 pass · 0 fail' : '✓ tests passed · 24 pass · 0 fail')
      expect(summary.color).toBe('success')
      // The desktop's head is three Texts on one row: verdict, pass, fail.
      expect(await ui.findAll({ type: 'Text' })).toHaveLength(surface === 'terminal' ? 1 : 3)
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('leaves unknown output to the engine', async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_ls_${surface}`, 'README.md\nsrc')
      expect(await ui.find(SUMMARY)).toBeUndefined()
      expect(await ui.find(RAW)).toBeDefined()
      await ui.unmount()
    }
  })

  test('an errored run (non-zero exit, output as text) is summarized too', async ($, on) => {
    engineDraws(on)
    const output = ['Exit code 1', '(pass) a [1ms]', '(fail) b > breaks [2ms]', '(fail) c > breaks [1ms]', '', ' 1 pass', ' 2 fail'].join('\n')
    for (const surface of SURFACES) {
      const id = `toolu_err_${surface}`
      const ui = await $.ui.mount({ plugin: 'dashboard', surface, component: 'ToolResult', requestId: id, props: { tool_use_id: id, tool: 'Bash', output, isErrored: true } })
      const summary = await headOf(ui, surface)
      expect(summary.text).toBe(surface === 'terminal' ? '✗ tests · 1 pass · 2 fail' : '✗ tests failed · 1 pass · 2 fail')
      expect(await failuresOf(ui, surface, /\(fail\)/)).toEqual(['  (fail) b > breaks [2ms]', '  (fail) c > breaks [1ms]'])
      await ui.unmount()
    }
  })

  test('a guard denial keeps its own head, no test summary', { options: { language: 'zh-CN' } }, async ($, on) => {
    engineDraws(on)
    const output =
      'Blocked on the shared main worktree: `git stash` would take away uncommitted changes from other sessions or the user. Undo your own edit with a reverse Edit; for a clean baseline open a temporary worktree. Linked worktrees are exempt.'
    for (const surface of SURFACES) {
      const id = `toolu_guard_${surface}`
      const ui = await $.ui.mount({ plugin: 'dashboard', surface, component: 'ToolResult', requestId: id, props: { tool_use_id: id, tool: 'Bash', output, isErrored: true } })
      expect(await ui.find({ text: surface === 'terminal' ? '已阻止:共享主树 git 操作' : '已拦截：在共享主工作树上执行 git stash' })).toBeDefined()
      expect(await ui.find(SUMMARY)).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^[✓✗] 测试/ })).toBeUndefined()
      // The desktop folds the raw result behind its button.
      if (surface === 'desktop') await ui.press({ key: 'raw' })
      expect(await ui.find(RAW)).toBeDefined()
      await ui.unmount()
    }
  })

  test('xcodebuild TEST FAILED over passing counts is not green; its marker rides the head', async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_fg_${surface}`, falseGreen)
      const summary = await headOf(ui, surface)
      expect(summary.text, 'failed, not 0 fail').toBe(surface === 'terminal' ? '✗ tests · 312 pass · failed · TEST FAILED' : '✗ tests failed · 312 pass · — fail · TEST FAILED')
      expect(summary.color).toBe('error')
      expect(await ui.find(RAW)).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a pass count no line gave reads —, not 0', async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_st_${surface}`, 'Test "x" failed after 0.010 seconds with 1 issue.')
      const summary = await headOf(ui, surface)
      expect(summary.text).toBe(surface === 'terminal' ? '✗ tests · — pass · 1 fail' : '✗ tests failed · — pass · 1 fail')
      expect(summary.color).toBe('error')
      await ui.unmount()
    }
  })

  test('a failed run with no failure lines lists the build errors', async ($, on) => {
    engineDraws(on)
    const stdout = ['Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.000) seconds', '/work/App/A.swift:3:5: error: boom', 'Test run with 4 tests in 1 suite passed after 0.1 seconds.', '** TEST FAILED **'].join('\n')
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_fe_${surface}`, stdout)
      expect((await headOf(ui, surface)).text).toBe(surface === 'terminal' ? '✗ tests · 4 pass · failed · TEST FAILED' : '✗ tests failed · 4 pass · — fail · TEST FAILED')
      expect(await failuresOf(ui, surface, /A\.swift/)).toContain('  A.swift:3:5  boom')
      await ui.unmount()
    }
  })

  test('a build with more errors than the summary keeps counts the rest from the real total', { options: { language: 'en' } }, async ($, on) => {
    engineDraws(on)
    const many = [...Array.from({ length: 60 }, (_, i) => `/p/A.swift:${i + 1}:1: error: boom ${i + 1}`), '** BUILD FAILED **'].join('\n')
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_many_${surface}`, many)
      const texts = (await textsOf(ui)).map(t => t.text)
      expect(texts).toContain('  … 55 more')
      await ui.unmount()
    }
  })

  test('a failed build: head with errors, five error lines, the rest counted; raw output behind its button', { options: { language: 'en' } }, async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_bf_${surface}`, compileError)
      const head = (await textsOf(ui)).find(t => t.text?.startsWith('✗ xcodebuild'))
      expect(head?.text).toBe('✗ xcodebuild · TEST BUILD FAILED · 16 errors')
      expect(head?.props.color).toBe('error')
      const texts = (await textsOf(ui)).map(t => t.text)
      expect(texts).toContain("  TokenizerTests.swift:42:31  cannot infer contextual base in reference to member 'trailingWhitespace'")
      expect(texts.filter(text => text?.startsWith('  TokenizerTests.swift:'))).toHaveLength(5)
      expect((await textsOf(ui)).find(t => t.text === '  … 11 more')?.props.dimColor).toBe(true)
      expect(await ui.find(RAW)).toBeUndefined()
      expect((await ui.find({ key: 'full' }))?.props.hotkey).toBeUndefined()
      await ui.press({ key: 'full' })
      expect(await ui.find(RAW)).toBeDefined()
      await ui.unmount()
    }
  })

  test('the rest counted in Chinese; an error with no location is the message alone', { options: { language: 'zh-CN' } }, async ($, on) => {
    engineDraws(on)
    const ui = await mountResult($, 'terminal', 'toolu_bz', compileError)
    expect(await ui.find({ type: 'Text', text: '  … 另有 11 条' })).toBeDefined()
    await ui.unmount()
    const signing = await mountResult($, 'terminal', 'toolu_bs', signingNoProfiles)
    expect((await signing.find(BUILD))?.text).toBe('✗ xcodebuild · TEST FAILED · 1 error')
    expect(await signing.find({ type: 'Text', text: /^ {2}No profiles for 'com\.example\.demoapp' were found/ })).toBeDefined()
    await signing.unmount()
  })

  test('a succeeded build: one green line, warnings dim', async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_bo_${surface}`, buildOk)
      const texts = await textsOf(ui)
      expect(texts.find(t => t.text === '✓ xcodebuild · BUILD SUCCEEDED')?.props.color).toBe('success')
      expect(texts.find(t => t.text === ' · 2 warnings')?.props.dimColor).toBe(true)
      expect(await ui.find(RAW)).toBeUndefined()
      await ui.unmount()
    }
  })

  test('the failed-commands list alone: ✗ in the error color, never ✓', { options: { language: 'zh-CN' } }, async ($, on) => {
    engineDraws(on)
    const stdout = ['The following build commands failed:', "\tSwiftCompile normal arm64 /work/App/A.swift (in target 'App' from project 'App')", '(1 failure)'].join('\n')
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_bu_${surface}`, stdout)
      const head = await ui.find(BUILD)
      expect(head?.text).toBe('✗ xcodebuild · 1 failed command')
      expect(head?.props.color).toBe('error')
      expect(JSON.stringify(await ui.drawn())).not.toContain('✓')
      await ui.unmount()
    }
  })

  test('a persisted preview says it is only a preview', { options: { language: 'en' } }, async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_bp_${surface}`, persistedPreview)
      expect((await ui.find(BUILD))?.text).toBe('✗ xcodebuild · TEST BUILD FAILED')
      expect((await textsOf(ui)).find(t => t.text === 'preview only')?.props.dimColor).toBe(true)
      await ui.unmount()
    }
  })

  test('parsed-success-overrides-failure: passing counts beside a nonzero exit or a build error are failed, counts kept', async ($, on) => {
    engineDraws(on)
    const rows = [
      ['exit', `Exit code 1\n${BUN_OK}`, true],
      ['build', { stdout: `${BUN_OK}\n/work/App/A.swift:3:5: error: boom`, stderr: '', interrupted: false }, false],
    ] as const
    for (const surface of SURFACES) {
      for (const [name, output, isErrored] of rows) {
        const id = `toolu_pso_${name}_${surface}`
        const ui = await $.ui.mount({ plugin: 'dashboard', surface, component: 'ToolResult', requestId: id, props: { tool_use_id: id, tool: 'Bash', output, isErrored } })
        const texts = await textsOf(ui)
        if (surface === 'terminal') {
          const summary = await ui.find(SUMMARY)
          expect(summary?.text, name).toBe('✗ tests · 24 pass · 0 fail')
          expect(summary?.props.color, name).toBe('error')
        } else {
          expect(texts.find(t => t.text === '✗ tests failed')?.props.color, name).toBe('error')
          expect(texts.map(t => t.text)).toEqual(expect.arrayContaining(['24 pass', '0 fail']))
        }
        expect(JSON.stringify(await ui.drawn()), `${surface} ${name}`).not.toContain('✓')
        await ui.unmount()
      }
    }
  })

  test('packages label: go package counts say packages on the card, not tests', async ($, on) => {
    engineDraws(on)
    const stdout = ['ok  \texample.com/a\t0.01s', 'ok  \texample.com/b\t(cached)'].join('\n')
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_go_${surface}`, stdout)
      const texts = (await textsOf(ui)).map(t => t.text)
      if (surface === 'terminal') {
        expect(texts).toContain('✓ packages · 2 pass · 0 fail')
      } else {
        expect(texts).toEqual(expect.arrayContaining(['✓ packages passed', '2 pass', '0 fail']))
      }
      expect(JSON.stringify(await ui.drawn()), surface).not.toContain('tests')
      await ui.unmount()
    }
  })

  test('the full-output button toggles the full output under the summary', async ($, on) => {
    engineDraws(on)
    for (const surface of SURFACES) {
      const ui = await mountResult($, surface, `toolu_toggle_${surface}`, BUN_FAIL)
      expect((await ui.find({ key: 'full' }))?.props.hotkey).toBeUndefined()
      await ui.press({ key: 'full' })
      expect(await ui.find(RAW)).toBeDefined()
      expect((await headOf(ui, surface)).color).toBe('error')
      await ui.press({ key: 'full' })
      expect(await ui.find(RAW)).toBeUndefined()
      await ui.unmount()
    }
  })
})
