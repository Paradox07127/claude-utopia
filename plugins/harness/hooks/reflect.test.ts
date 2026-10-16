import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = new Date(2026, 9, 14, 12).getTime()
const NOTE = '.notes/reflect/2026-10-14.md'
const CANDIDATE = {
  kind: 'guard.false-positive',
  key: 'env-dump',
  count: 3,
  target: 'plugins/harness/hooks/guard-secret.ts:177',
  evidence: [{ session: 's1', time: '2026-10-14T01:00:00', excerpt: "python3 -c 'print(set())'" }],
}
const DRAFT = '## 1. a\n- 现象：x\n\n## 2. b\n- 现象：y\n\n## 3. c\n- 现象：z'
const CLAIM = '/home/.claude/harness/reflect/-repo/2026-10-14'

type Seen = { runs: (readonly string[])[]; models: { model: string; maxTokens?: number; blocks?: readonly { text: string; cache?: true }[] }[]; writes: Record<string, string>; toasts: string[]; logs: string[] }

// Stands in for the engine: reflect.py answers `candidates` (null = it fails), the model answers DRAFT, mkdir makes `dirs`.
const world = (on: On, candidates: unknown[] | null, language = '简体中文', claimed: string[] = [], exists = (path: string) => !path.includes('/../')) => {
  const seen: Seen = { runs: [], models: [], writes: {}, toasts: [], logs: [] }
  const session = { root: '/repo/wt', onModel: () => {} }
  const dirs = new Set(claimed)
  mock.env(on, { HOME: '/home' })
  const clock = mock.clock(on, { now: NOW })
  on('settings.read', () => ({ value: { language } }))
  on('session.root', () => ({ value: session.root }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: null } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    if (e.argv[0] === 'mkdir') {
      const dir = e.argv[e.argv.length - 1] as string
      const made = e.argv[1] === '-p' || !dirs.has(dir)
      dirs.add(dir)
      return { value: { exitCode: made ? 0 : 1, stdout: '', stderr: made ? '' : 'File exists' } } as never
    }
    seen.runs.push(e.argv)
    return { value: candidates === null ? { exitCode: 1, stdout: '', stderr: 'boom' } : { exitCode: 0, stdout: JSON.stringify({ candidates }), stderr: '' } } as never
  })
  on('model.complete', ($, e) => {
    seen.models.push({ model: e.model, maxTokens: e.maxTokens, blocks: e.promptBlocks })
    session.onModel()
    return { value: { isAnswered: true, text: DRAFT, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as never
  })
  on('fs.exists', ($, e) => ({ value: exists(e.path) }))
  on('fs.write', ($, e) => {
    seen.writes[e.path] = e.text
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    seen.logs.push(String(e.text))
    return { value: undefined }
  })
  return { seen, clock, session }
}

const start = { surface: 'desktop', isInteractive: true, cwd: '/repo/wt' } as const
const command = { command: 'reflect', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

describe('reflect', () => {
  test('the first session of the day runs reflect.py over 7 days, drafts once with Sonnet, writes the note and toasts', async ($, on) => {
    const { seen, clock } = world(on, [CANDIDATE])
    await $.session.start(start)
    await clock.advance(0)
    expect(seen.runs).toHaveLength(1)
    expect(seen.runs[0]?.[1]).toEndWith('/hooks/reflect.py')
    expect(seen.runs[0]?.slice(2)).toEqual(['--project=-repo', '--since', '2026-10-08', '--json'])
    expect(seen.models).toHaveLength(1)
    expect(seen.models[0]?.model).toBe('sonnet')
    expect(seen.models[0]?.maxTokens).toBe(2000)
    expect(seen.models[0]?.blocks?.[0]?.cache).toBe(true)
    expect(seen.models[0]?.blocks?.[1]?.text).toContain("python3 -c 'print(set())'")
    expect(seen.writes[`/repo/wt/${NOTE}`]).toContain(DRAFT)
    expect(seen.toasts).toEqual([`反思：3 条提案 · ${NOTE}`])
  })

  test('a root that is the .claude-plugin directory finds the script one level up', async ($, on) => {
    const { seen, clock } = world(on, [], '简体中文', [], path => path.endsWith('/../hooks/reflect.py'))
    await $.session.start(start)
    await clock.advance(0)
    expect(seen.runs[0]?.[1]).toEndWith('/../hooks/reflect.py')
  })

  test('a later session the same day does not run it again', async ($, on) => {
    const { seen, clock } = world(on, [CANDIDATE], '简体中文', [CLAIM])
    await $.session.start(start)
    await clock.advance(0)
    expect(seen.runs).toEqual([])
  })

  test('two sessions starting together draft only once', async ($, on) => {
    const { seen, clock } = world(on, [CANDIDATE])
    await $.session.start(start)
    await $.session.start(start)
    await clock.advance(0)
    expect(seen.models).toHaveLength(1)
  })

  test('the note goes under the root the run started in, even after a /cd meanwhile', async ($, on) => {
    const { seen, clock, session } = world(on, [CANDIDATE])
    session.onModel = () => {
      session.root = '/other'
    }
    await $.session.start(start)
    await clock.advance(0)
    expect(Object.keys(seen.writes)).toEqual([`/repo/wt/${NOTE}`])
  })

  test('no candidates: no model call, no file, no toast', async ($, on) => {
    const { seen, clock } = world(on, [])
    await $.session.start(start)
    await clock.advance(0)
    expect(seen.runs).toHaveLength(1)
    expect(seen.models).toEqual([])
    expect(seen.writes).toEqual({})
    expect(seen.toasts).toEqual([])
  })

  test('a failing script logs to debug only', async ($, on) => {
    const { seen, clock } = world(on, null)
    await $.session.start(start)
    await clock.advance(0)
    expect(seen.toasts).toEqual([])
    expect(seen.writes).toEqual({})
    expect(seen.logs.some(line => line.includes('reflect'))).toBe(true)
  })

  test('the toast follows the language', async ($, on) => {
    const { seen, clock } = world(on, [CANDIDATE], 'English')
    await $.session.start(start)
    await clock.advance(0)
    expect(seen.toasts).toEqual([`Reflection: 3 proposals · ${NOTE}`])
  })

  test('/reflect runs even after the daily run and prints the path and the count', async ($, on) => {
    const { seen } = world(on, [CANDIDATE], '简体中文', [CLAIM])
    await $.session.start(start)
    const got = await $.command.run(command)
    expect(seen.runs).toHaveLength(1)
    expect(got.text).toContain(NOTE)
    expect(got.text).toContain('3')
  })

  test('/reflect with no candidates says so', async ($, on) => {
    world(on, [])
    await $.session.start(start)
    const got = await $.command.run(command)
    expect(got.text).toContain('没有')
  })
})
