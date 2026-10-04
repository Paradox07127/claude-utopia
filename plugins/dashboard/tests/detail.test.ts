import { describe, expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'
import type { FsEntry, On, RenderInput, SessionStartInput } from 'claude-code'

import { setLang } from '../hooks/i18n'
import { reportOf } from '../hooks/runs'

const PLUGIN = 'dashboard'
const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const BOTTOM = { type: 'Text', props: {}, children: ['engine band'] }
const NOW = 1_790_922_800_000
const ROOT = '/h/.claude/mmruns'
const R1 = '20261002-010000-aaaa'
const R3 = '20261002-005000-cccc'

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

const usage = (output_tokens: number) => ({ input_tokens: 1, output_tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' })
const ANSWER = '改完了:runs.ts 加了 reportOf'
const complete = (agentId: string) =>
  ({ answer: ANSWER, durationMs: 1_000, isAborted: false, turnId: 't', agentId, reason: 'answer', usage: usage(500) }) as never

const REVIEW = {
  verdict: 'needs_changes',
  summary: '两处问题',
  findings: [
    { severity: 'critical', file: 'a.ts', line: 3, claim: 'CLAIM-CRIT', quote: 'x = 1', failure_scenario: '崩溃', basis: 'read' },
    { severity: 'major', file: 'b.ts', line: 7, claim: 'CLAIM-MAJOR', quote: 'y = 2', failure_scenario: '错值' },
    { severity: 'minor', file: 'c.ts', line: 9, claim: 'CLAIM-MINOR', quote: 'z = 3', failure_scenario: '难读' },
  ],
  not_expanded: 2,
  not_checked: ['tests/'],
}

type Files = Record<string, { text: string; mtimeMs?: number }>

const runMeta = (runid: string, tag: string, models: string) =>
  `runid=${runid}\nworkdir=/work/proj\ntag=${tag}\nmodels=${models}\nmode=review\nschema=\nwt=\nsession=x\n`

/** R1: grok done with a review JSON; R3: agy failed with only a .out. */
function mmruns(): Files {
  return {
    [`${R1}/run.meta`]: { text: runMeta(R1, 'design', 'grok'), mtimeMs: NOW - 300_000 },
    [`${R1}/grok.status`]: { text: 'DONE\n', mtimeMs: NOW - 120_000 },
    [`${R1}/grok.started`]: { text: `${(NOW - 422_000) / 1000}\n` },
    [`${R1}/grok.json`]: { text: JSON.stringify(REVIEW) },
    [`${R1}/grok.out`]: { text: 'grok raw text' },
    [`${R3}/run.meta`]: { text: runMeta(R3, '', 'agy'), mtimeMs: NOW - 4_000_000 },
    [`${R3}/agy.status`]: { text: 'FAIL:1\n', mtimeMs: NOW - 3_600_000 },
    [`${R3}/agy.out`]: { text: 'agy partial' },
  }
}

/** The engine beneath the plugin, in memory; ~/.claude/mmruns holds `files`. */
function seat(on: On, files: Files = {}): void {
  let spawned = 0
  const panes = new Set<string>()

  mock.env(on, { HOME: '/h' })
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
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
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
  on('classic.PostToolUse', () => ({}))
  on('classic.PermissionDenied', () => ({}))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', () => BOTTOM as never)
}

describe('reportOf', () => {
  test('a review shows critical and major by default, every severity with showAll', () => {
    setLang('zh-CN')
    const top = reportOf(REVIEW, '', 'review', false, '/x/grok.out')

    expect(top).toContain('**needs_changes** · 两处问题')
    expect(top).toContain('CRITICAL')
    expect(top).toContain('MAJOR')
    expect(top).toContain('- **a.ts:3** — CLAIM-CRIT [read]')
    expect(top).toContain('CLAIM-MAJOR')
    expect(top).toContain('> x = 1')
    expect(top).toContain('失败场景:崩溃')
    expect(top).not.toContain('CLAIM-MINOR')
    expect(top).toContain('未检查:')
    expect(top).toContain('tests/')
    expect(top).toContain('未展开 2 条')

    expect(reportOf(REVIEW, '', 'review', true, '/x/grok.out')).toContain('CLAIM-MINOR')
    expect(reportOf({ ...REVIEW, not_checked: [] }, '', 'review', false, '/x/grok.out')).not.toContain('未检查')
  })

  test('a run report lists checks_run as objects or strings', () => {
    const json = {
      status: 'done',
      summary: '全部完成',
      checks_run: [{ cmd: 'bun test', exit_code: 0, result_line: '41 pass' }, 'tsc --noEmit'],
      not_verified: ['desktop'],
      decisions_made: ['放在 runs.ts'],
      questions: ['要不要缓存?'],
    }
    const md = reportOf(json, '', 'run', false, '/x/m.out')

    expect(md).toContain('done')
    expect(md).toContain('全部完成')
    expect(md).toContain('bun test → exit 0 · 41 pass')
    expect(md).toContain('tsc --noEmit')
    expect(md).toContain('desktop')
    expect(md).toContain('放在 runs.ts')
    expect(md).toContain('要不要缓存?')
  })

  test('without JSON the .out text, cut at 6000 characters with the path', () => {
    setLang('zh-CN')
    expect(reportOf(null, 'plain answer', 'review', false, '/x/m.out')).toBe('plain answer')

    const long = reportOf(null, 'a'.repeat(7000), 'review', false, '/x/m.out')

    expect(long).toContain('a'.repeat(6000))
    expect(long).not.toContain('a'.repeat(6001))
    expect(long).toContain('…(截断,全文见 /x/m.out)')
  })
})

describe('reading a report in the workbench', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`外审: 阅读, 全部严重度, 返回 on ${surface}`, { options: { language: 'zh-CN' } }, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })

      seat(on, mmruns())
      await $.session.start(SESSION)
      await clock.advance(3_000)
      await $.command.run(command('mmrun'))

      const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

      expect(await ui.find({ key: `read-run-${R3}` })).toBeDefined()
      await ui.press({ key: `read-run-${R1}` })
      expect(await ui.find({ text: '模型报告,待主模型核实' })).toBeDefined()
      expect(await ui.find({ text: `design · ${R1}` })).toBeDefined()
      if (surface === 'terminal') {
        expect(await ui.find({ type: 'Markdown', text: /CLAIM-MAJOR/ })).toBeDefined()
        expect(await ui.find({ type: 'Markdown', text: /CLAIM-MINOR/ })).toBeUndefined()

        expect((await ui.find({ key: 'dash-severity' }))?.props).toMatchObject({ label: '全部严重度' })
        await ui.press({ key: 'dash-severity' })
        expect(await ui.find({ type: 'Markdown', text: /CLAIM-MINOR/ })).toBeDefined()
        expect((await ui.find({ key: 'dash-severity' }))?.props).toMatchObject({ label: '只看 Critical/Major' })
      } else {
        // One finding at a time: critical and major make two, every severity three, the minor one last.
        expect(await ui.find({ type: 'Text', text: 'CLAIM-CRIT' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: '\u7b2c 1 / 2 \u6761' })).toBeDefined()
        await ui.press({ key: 'dash-next-finding' })
        expect(await ui.find({ type: 'Text', text: 'CLAIM-MAJOR' })).toBeDefined()
        expect(await ui.find({ key: 'dash-next-finding' }), 'no minor finding').toBeUndefined()

        expect((await ui.find({ key: 'dash-severity' }))?.props).toMatchObject({ value: 'major' })
        await (ui as Mounted<'desktop'>).select({ key: 'dash-severity', value: 'all' })
        expect(await ui.find({ type: 'Text', text: '\u7b2c 1 / 3 \u6761' })).toBeDefined()
        await ui.press({ key: 'dash-next-finding' })
        await ui.press({ key: 'dash-next-finding' })
        expect(await ui.find({ type: 'Text', text: 'CLAIM-MINOR' })).toBeDefined()
        expect((await ui.find({ key: 'dash-severity' }))?.props).toMatchObject({ value: 'all' })
      }

      expect((await ui.find({ key: 'dash-back' }))?.props).toMatchObject({ label: '返回' })
      expect((await ui.find({ key: 'dash-back' }))?.props.hotkey).toBeUndefined()
      await ui.press({ key: 'dash-back' })
      expect(await ui.find({ text: '模型报告,待主模型核实' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: R3.slice(-4) })).toBeDefined()
      await ui.unmount()
    })

    test(`Agents: 阅读 shows the answer; a page change closes it on ${surface}`, { options: { language: 'zh-CN' } }, async ($, on) => {
      mock.clock(on, { now: NOW })
      seat(on, mmruns())
      await $.session.start(SESSION)
      await $.agent.spawn(SPAWN as never)
      await $.agent.spawn({ ...SPAWN, description: 'Still going' } as never)
      await $.turn.complete(complete('a1'))
      await $.command.run(command('subagents'))

      const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

      // The terminal's row is its button whatever the state; the desktop's reads 打开 while the agent runs.
      const running = await ui.find({ key: 'read-agent-a2' })

      expect(running, 'a running agent opens too').toBeDefined()
      expect(surface === 'terminal' || running?.props.label === '打开').toBe(true)
      await ui.press({ key: 'read-agent-a1' })
      expect(await ui.find({ text: '已返回 · 未验收' })).toBeDefined()
      expect(await ui.find({ text: 'worker · Build mm plugin' })).toBeDefined()
      expect(await ui.find({ type: 'Markdown', text: ANSWER })).toBeDefined()

      await ui.press({ key: 'page-overview' })
      await ui.press({ key: 'page-agents' })
      expect(await ui.find({ type: 'Markdown', text: ANSWER })).toBeUndefined()
      expect(await ui.find({ key: 'read-agent-a1' }), 'read on the last visit: folded').toBeUndefined()
      await ui.press({ key: 'agents-fold' })
      expect(await ui.find({ key: 'read-agent-a1' })).toBeDefined()
      await ui.unmount()
    })
  }
})
