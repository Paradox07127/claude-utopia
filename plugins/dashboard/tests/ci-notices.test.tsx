import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On, RenderInput, SessionStartInput } from 'claude-code'

import { ciEvents, ciLine, ciOutcome, nextCi, parseChecks, parsePr } from '../hooks/ci'
import type { CiCheck, CiStatus } from '../hooks/ci'
import { setLang } from '../hooks/i18n'
import { mainMoved, newestNotice, noticeOf, parseNotice, shaOf } from '../hooks/notices'
import { dayOf } from '../hooks/usage'
import { isDimText, linesOf } from './hooks-kit'

const PLUGIN = 'dashboard'
const ZH = { options: { language: 'zh-CN' } }
const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const NOW = 1_790_922_800_000
const BOTTOM = { type: 'Text', props: {}, children: ['engine band'] }
const NOTICES = '/h/.claude/dashboard/notices/-work'
const MMRUNS = '/h/.claude/mmruns'
const VIEW = 'gh pr view --json number,url,headRefName,state'
const CHECKS = 'gh pr checks --json name,state,bucket'
const HEAD = 'git -C /work rev-parse --abbrev-ref HEAD'
const MAIN = 'git -C /work rev-parse --verify --quiet main'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b1c2d3e'.padEnd(40, '0')
const SHA_C = 'c'.repeat(40)
const PR = JSON.stringify({ number: 12, url: 'https://github.com/o/r/pull/12', headRefName: 'feature', state: 'OPEN' })
const check = (name: string, bucket: string): CiCheck => ({ name, state: bucket.toUpperCase(), bucket })
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
const complete = (agentId: string) => ({ answer: 'report', durationMs: 1_000, isAborted: false, turnId: 't', agentId, reason: 'answer' }) as never

const bandAt = (surface: 'terminal' | 'desktop', maxRows = 20): RenderInput<'AbovePrompt'> => ({
  component: 'AbovePrompt',
  surface,
  requestId: 'band',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: { hasSurvey: false, isWorking: true, maxRows, bodyColumns: 100, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} },
})
const paneAt = (surface: 'terminal' | 'desktop'): RenderInput<'Pane'> => ({
  component: 'Pane',
  surface,
  requestId: 'dashboard',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: { title: '工作台', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
})
const command = (name: string, args = '') => ({ command: name, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 180 } })

// `deny`: the run rejects with it, as when the command cannot start or times out.
type Reply = { exitCode: number; stdout: string; stderr?: string; deny?: string }
type World = { replies: Record<string, Reply>; calls: string[]; files: Record<string, { text: string; mtimeMs: number }>; toasts: string[]; root: string }

/** The engine beneath: `replies` by argv joined (exit 1 for any other), `files` by absolute path, `root` the repository's. */
function seat(on: On): World {
  const world: World = { replies: {}, calls: [], files: {}, toasts: [], root: '/work' }
  const panes = new Set<string>()

  mock.env(on, { HOME: '/h' })
  mock.store(on)
  on('session.id', () => ({ value: 'me' }))
  on('session.root', () => ({ value: world.root }))
  on('session.repo', () => ({ value: { root: world.root, remote: null, internal: false, name: null } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__dashboard__${e.name}` } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    panes.add(e.id)

    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.invalidate', ($, e, next) => next(e))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const key = e.argv.join(' ')
    const reply = world.replies[key] ?? { exitCode: e.argv[0] === 'kill' ? 0 : 1, stdout: '' }

    world.calls.push(key)

    if (reply.deny !== undefined) {
      return { deny: reply.deny }
    }

    return { value: { exitCode: reply.exitCode, stdout: reply.stdout, stderr: reply.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', ($, e) => {
    world.files[e.path] = { text: e.text, mtimeMs: NOW }

    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const names = new Map<string, FsEntry>()

    for (const [path, file] of Object.entries(world.files)) {
      if (path.startsWith(`${e.path}/`)) {
        const [name, ...rest] = path.slice(e.path.length + 1).split('/') as [string, ...string[]]

        names.set(name, { name, kind: rest.length > 0 ? 'dir' : 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false })
      }
    }

    return names.size > 0 ? { value: [...names.values()] } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.exists', ($, e) => ({ value: world.files[e.path] !== undefined }))
  on('fs.stat', ($, e) => {
    const file = world.files[e.path]

    return file ? { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.read', ($, e) => {
    const file = world.files[e.path]

    world.calls.push(`read ${e.path}`)

    return file ? { value: file.text } : { deny: `ENOENT ${e.path}` }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('settings.read', () => ({ value: {} }))
  let spawned = 0
  on('agent.spawn', () => {
    spawned += 1

    return { model: 'claude-opus-5-5', agentId: `a${spawned}` }
  })
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('ui.render', () => BOTTOM as never)

  return world
}

const ledgerOf = (world: World) =>
  Object.entries(world.files)
    .filter(([path]) => path.startsWith('/h/.claude/harness/events/-work/'))
    .map(([, file]) => file.text)
    .join('')
const ciResults = (world: World) => ledgerOf(world).split('\n').filter(line => line.includes('"ci.result"'))
const bandLinesOf = async ($: Engine, maxRows = 20) => linesOf(await $.ui.render(bandAt('terminal', maxRows)))

describe('E2: the CI of the branch PR', () => {
  test('gh output parsed: the PR, the checks, the outcome', () => {
    expect(parsePr(PR)).toEqual({ number: 12, url: 'https://github.com/o/r/pull/12', branch: 'feature' })
    expect(parsePr('no pull requests found')).toBeNull()
    expect(parseChecks(JSON.stringify([{ name: 'build', state: 'FAILURE', bucket: 'fail' }, { bucket: 'pass' }]))).toEqual([check('build', 'fail')].map(one => ({ ...one, state: 'FAILURE' })))
    expect(parseChecks('')).toBeNull()
    expect(ciOutcome([check('a', 'pass'), check('b', 'pending')])).toBe('pending')
    expect(ciOutcome([check('a', 'pending'), check('b', 'fail')])).toBe('fail')
    expect(ciOutcome([check('a', 'pass'), check('b', 'skipping')])).toBe('pass')
  })

  test('the row per outcome, and a ci.result only when the outcome or the PR changed', () => {
    setLang('zh-CN')

    const pr = { number: 12, url: 'u', branch: 'feature' }
    const failing = nextCi(null, pr, [check('lint', 'pass'), check('build', 'fail')], NOW)
    const still = nextCi(failing, pr, [check('lint', 'pass'), check('build', 'fail')], NOW + 120_000)
    const text = (ci: CiStatus, now: number) => ciLine(ci, now).map(seg => seg.text).join('')

    expect(still.changedAt, 'the same outcome keeps its time').toBe(NOW)
    expect(text(still, NOW + 120_000)).toBe('CI ✗ build · PR #12 · 2m前')
    expect(text(nextCi(null, pr, [check('a', 'pass'), check('b', 'pass'), check('c', 'pass'), check('d', 'pending'), check('e', 'pending'), check('f', 'pending'), check('g', 'pending')], NOW), NOW)).toBe('CI ● 3/7 · PR #12')
    expect(text(nextCi(null, pr, [check('a', 'pass')], NOW), NOW)).toBe('CI ✓ PR #12')
    expect(ciEvents(null, failing)).toEqual([expect.objectContaining({ name: 'ci.result', severity: 'WARN', attributes: expect.objectContaining({ 'pr.number': 12, outcome: 'fail', failing: 'build' }) })])
    expect(ciEvents(failing, still)).toEqual([])
    expect(ciEvents(still, nextCi(still, pr, [check('build', 'pass')], NOW + 180_000))).toEqual([expect.objectContaining({ severity: 'INFO', attributes: expect.objectContaining({ outcome: 'pass' }) })])
  })

  test('a failing check: a P1 row with its age, one ci.result, gh asked once a minute', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.replies[HEAD] = { exitCode: 0, stdout: 'feature\n' }
    world.replies[VIEW] = { exitCode: 0, stdout: PR }
    world.replies[CHECKS] = { exitCode: 1, stdout: JSON.stringify([check('lint', 'pass'), check('build', 'fail')]) }
    await $.session.start(SESSION)
    await clock.advance(120_000)

    expect(await bandLinesOf($)).toEqual(['CI ✗ build · PR #12 · 2m前', 'engine band'])
    expect(world.calls.filter(call => call === CHECKS), 'at start, then each 60 s').toHaveLength(3)
    expect(ciResults(world), 'one ci.result for the one change').toHaveLength(1)
    expect(ciResults(world)[0]).toContain('"outcome":"fail"')

    world.replies[CHECKS] = { exitCode: 0, stdout: JSON.stringify([check('lint', 'pass'), check('build', 'pass')]) }
    await clock.advance(60_000)

    expect(await bandLinesOf($), 'a pass is a new result').toEqual(['CI ✓ PR #12', 'engine band'])
    expect(ciResults(world)).toHaveLength(2)

    await clock.advance(21_000)

    expect((await bandLinesOf($))[0], 'folded after 20 s').toMatch(/^✓ 空闲/)
  })

  test('a ci.result goes to the session own <session>.ci.jsonl; its <session>.jsonl is left as it was', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const day = `/h/.claude/harness/events/-work/${dayOf(NOW)}`
    const own = '{"timestamp":"2026-10-01T00:00:00.000Z","event_name":"gate.result","severity_text":"INFO","attributes":{"session.id":"me"}}\n'

    world.files[`${day}/me.jsonl`] = { text: own, mtimeMs: NOW - 1_000 }
    world.replies[HEAD] = { exitCode: 0, stdout: 'feature\n' }
    world.replies[VIEW] = { exitCode: 0, stdout: PR }
    world.replies[CHECKS] = { exitCode: 1, stdout: JSON.stringify([check('build', 'fail')]) }
    await $.session.start(SESSION)
    await clock.advance(1_000)

    expect(world.files[`${day}/me.jsonl`]?.text.startsWith(own), 'what the session file held is kept').toBe(true)
    expect(world.files[`${day}/me.jsonl`]?.text, 'no ci.result in the session file').not.toContain('"ci.result"')
    expect(world.files[`${day}/me.ci.jsonl`]?.text.split('\n').filter(line => line.includes('"ci.result"'))).toHaveLength(1)
  })

  test('running checks: a P3 row counting the finished ones', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.replies[HEAD] = { exitCode: 0, stdout: 'feature\n' }
    world.replies[VIEW] = { exitCode: 0, stdout: PR }
    world.replies[CHECKS] = { exitCode: 8, stdout: JSON.stringify([check('lint', 'pass'), check('build', 'pending'), check('e2e', 'pending')]) }
    await $.session.start(SESSION)
    await clock.advance(1_000)

    expect(await bandLinesOf($)).toEqual(['CI ● 1/3 · PR #12', 'engine band'])
  })

  test('no PR, or gh not logged in: no row; gh asked again no earlier than 10 minutes', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.replies[HEAD] = { exitCode: 0, stdout: 'feature\n' }
    world.replies[VIEW] = { exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }
    await $.session.start(SESSION)
    await clock.advance(9 * 60_000)

    expect(world.calls.filter(call => call === VIEW)).toHaveLength(1)
    expect((await bandLinesOf($))[0]).toMatch(/^✓ 空闲/)

    world.replies[VIEW] = { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "feature"' }
    await clock.advance(60_000)

    expect(world.calls.filter(call => call === VIEW)).toHaveLength(2)
    expect(world.calls, 'no checks without a PR').not.toContain(CHECKS)
    expect((await bandLinesOf($))[0]).toMatch(/^✓ 空闲/)
  })

  test('a merged or closed PR: no row', ZH, async ($, on) => {
    expect(parsePr(JSON.stringify({ ...JSON.parse(PR), state: 'MERGED' }))).toBeNull()
    expect(parsePr(JSON.stringify({ ...JSON.parse(PR), state: 'CLOSED' }))).toBeNull()

    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.replies[HEAD] = { exitCode: 0, stdout: 'feature\n' }
    world.replies[VIEW] = { exitCode: 0, stdout: PR }
    world.replies[CHECKS] = { exitCode: 1, stdout: JSON.stringify([check('build', 'fail')]) }
    await $.session.start(SESSION)
    await clock.advance(1_000)

    expect((await bandLinesOf($))[0]).toMatch(/^CI ✗ build/)

    world.replies[VIEW] = { exitCode: 0, stdout: JSON.stringify({ ...JSON.parse(PR), state: 'MERGED' }) }
    await clock.advance(60_000)

    expect((await bandLinesOf($))[0]).toMatch(/^✓ 空闲/)
  })

  test('gh timed out: asked again the next minute; gh not found: asked again no earlier than 10 minutes', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.replies[HEAD] = { exitCode: 0, stdout: 'feature\n' }
    world.replies[VIEW] = { exitCode: 0, stdout: '', deny: 'timed out after 10000 ms' }
    await $.session.start(SESSION)
    await clock.advance(60_000)

    expect(world.calls.filter(call => call === VIEW)).toHaveLength(2)

    world.replies[VIEW] = { exitCode: 0, stdout: '', deny: 'spawn gh ENOENT' }
    await clock.advance(60_000)
    await clock.advance(9 * 60_000)

    expect(world.calls.filter(call => call === VIEW)).toHaveLength(3)
  })

  test('a failed fetch keeps the row; gh logged out drops it', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.replies[HEAD] = { exitCode: 0, stdout: 'feature\n' }
    world.replies[VIEW] = { exitCode: 0, stdout: PR }
    world.replies[CHECKS] = { exitCode: 1, stdout: JSON.stringify([check('build', 'fail')]) }
    await $.session.start(SESSION)
    await clock.advance(1_000)

    expect((await bandLinesOf($))[0]).toMatch(/^CI ✗ build/)

    world.replies[VIEW] = { exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' }
    await clock.advance(60_000)

    expect((await bandLinesOf($))[0], 'pr view failed').toMatch(/^CI ✗ build/)

    world.replies[VIEW] = { exitCode: 0, stdout: PR }
    world.replies[CHECKS] = { exitCode: 0, stdout: '', deny: 'timed out after 10000 ms' }
    await clock.advance(60_000)

    expect((await bandLinesOf($))[0], 'pr checks timed out').toMatch(/^CI ✗ build/)

    world.replies[VIEW] = { exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }
    await clock.advance(60_000)

    expect((await bandLinesOf($))[0], 'not logged in').toMatch(/^✓ 空闲/)
  })

  test('a pass is unread until the workbench opens on any page', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.replies[HEAD] = { exitCode: 0, stdout: 'feature\n' }
    world.replies[VIEW] = { exitCode: 0, stdout: PR }
    world.replies[CHECKS] = { exitCode: 8, stdout: JSON.stringify([check('build', 'pending')]) }
    await $.session.start(SESSION)
    // A running agent beside the CI row: two rows in a budget of one draw the counts.
    await $.agent.spawn(SPAWN as never)
    await clock.advance(1_000)
    world.replies[CHECKS] = { exitCode: 0, stdout: JSON.stringify([check('build', 'pass')]) }
    await clock.advance(65_000)

    expect((await bandLinesOf($, 1))[0]).toContain('待读1')

    await $.command.run(command('dashboard'))

    expect((await bandLinesOf($, 1))[0], 'opened on 总览').not.toContain('待读')
  })
})

describe('E3: notices to the sessions of this repository', () => {
  test('a notice: trimmed, cut to 120, kept 24 h, hidden by a clear', () => {
    const one = noticeOf('me', NOW, `  ${'x'.repeat(130)}  `)!

    expect(one.text).toHaveLength(120)
    expect(noticeOf('me', NOW, '   ')).toBeNull()
    expect(parseNotice(JSON.stringify(one))).toEqual(one)
    expect(parseNotice('{"id":1}')).toBeNull()

    const old = { ...one, id: 'old', at: NOW - 25 * 3_600_000 }
    const newer = { ...one, id: 'new', at: NOW + 1 }

    expect(newestNotice([old, one, newer], 0, NOW + 2)?.id).toBe('new')
    expect(newestNotice([old], 0, NOW), 'expired').toBeNull()
    expect(newestNotice([one], NOW, NOW + 2), 'cleared').toBeNull()
  })

  test("main's sha: a notice once it moved, none for the first read or this session's own move", () => {
    setLang('zh-CN')
    expect(shaOf(`${SHA_A}\n`)).toBe(SHA_A)
    expect(shaOf('fatal: not a git repository')).toBeNull()
    expect(mainMoved(null, SHA_A, false, 'main', 'me', NOW).notice).toBeNull()
    expect(mainMoved(SHA_A, SHA_A, false, 'main', 'me', NOW).notice).toBeNull()
    expect(mainMoved(SHA_A, SHA_B, true, 'main', 'me', NOW)).toEqual({ sha: SHA_B, notice: null })
    expect(mainMoved(SHA_A, SHA_B, false, 'main', 'me', NOW).notice?.text).toBe('main 前进了 (b1c2d3e)，push 前先 rebase')
  })

  test('/notice posts a file for the repository; the band shows the newest one dim at P4; /notice clear hides them', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.files[`${NOTICES}/old.json`] = { text: JSON.stringify({ id: 'old', author: 'p1', at: NOW - 25 * 3_600_000, text: 'stale' }), mtimeMs: NOW - 25 * 3_600_000 }
    await $.session.start(SESSION)
    await $.command.run(command('notice', '  hello   world '))

    expect(JSON.parse(world.files[`${NOTICES}/${NOW}-me.json`]!.text)).toEqual({ id: `${NOW}-me`, author: 'me', at: NOW, text: 'hello world' })

    const drawn = await $.ui.render(bandAt('terminal'))

    expect(linesOf(drawn).slice(1)).toEqual(['公告 · hello world', 'engine band'])
    expect(isDimText(drawn, '公告 · hello world')).toBe(true)
    expect((await bandLinesOf($, 1))[0], 'no room under a budget of one row').toMatch(/^✓ 空闲/)
    expect(await bandLinesOf($, 1)).not.toContain('公告 · hello world')

    world.files[`${NOTICES}/p1.json`] = { text: JSON.stringify({ id: 'p1', author: 'p1', at: NOW + 5_000, text: 'deploy freeze' }), mtimeMs: NOW + 5_000 }
    await clock.advance(15_000)

    expect(await bandLinesOf($), 'the newest, one row').toContain('公告 · deploy freeze')
    expect((await bandLinesOf($)).join('\n')).not.toContain('hello world')
    expect(world.calls, 'the expired file removed').toContain(`rm -f ${NOTICES}/old.json`)
    expect((await bandLinesOf($)).join('\n')).not.toContain('stale')

    await $.command.run(command('notice', 'clear'))

    expect((await bandLinesOf($)).join('\n')).not.toContain('公告')
  })

  test("main moved by another session: one notice per sha; this session's own git commit moves it silently", ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.replies[MAIN] = { exitCode: 0, stdout: `${SHA_A}\n` }
    await $.session.start(SESSION)
    await clock.advance(1_000)

    expect((await bandLinesOf($)).join('\n'), 'the first read is the baseline').not.toContain('公告')

    world.replies[MAIN] = { exitCode: 0, stdout: `${SHA_B}\n` }
    await clock.advance(60_000)

    expect(await bandLinesOf($)).toContain('公告 · main 前进了 (b1c2d3e)，push 前先 rebase')

    world.replies[MAIN] = { exitCode: 0, stdout: `${SHA_C}\n` }
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'git -C /work merge --ff-only agent-x' }, tool_response: 'ok', tool_use_id: 'toolu_g', cwd: '/work' } as never)
    await clock.advance(60_000)

    expect((await bandLinesOf($)).join('\n')).not.toContain('ccccccc')
  })

  test("main moved by another session, then this session's git commit on a branch: the notice stays", ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const commit = 'git commit -m wip'

    world.replies[MAIN] = { exitCode: 0, stdout: `${SHA_A}\n` }
    await $.session.start(SESSION)
    await clock.advance(1_000)
    world.replies[MAIN] = { exitCode: 0, stdout: `${SHA_B}\n` }
    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_g', command: commit } as never)
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: commit }, tool_response: 'ok', tool_use_id: 'toolu_g', cwd: '/work' } as never)
    await clock.advance(60_000)

    expect(await bandLinesOf($)).toContain('公告 · main 前进了 (b1c2d3e)，push 前先 rebase')
  })

  test("main moved only by this session's git commands, a failed one among them: no notice", ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const commit = 'git commit -m wip'
    const merge = 'git -C /work merge --ff-only agent-y'

    world.replies[MAIN] = { exitCode: 0, stdout: `${SHA_A}\n` }
    await $.session.start(SESSION)
    await clock.advance(1_000)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_g', command: commit } as never)
    world.replies[MAIN] = { exitCode: 0, stdout: `${SHA_B}\n` }
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: commit }, tool_response: 'ok', tool_use_id: 'toolu_g', cwd: '/work' } as never)
    await clock.advance(60_000)

    expect((await bandLinesOf($)).join('\n')).not.toContain('公告')

    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_m', command: merge } as never)
    world.replies[MAIN] = { exitCode: 0, stdout: `${SHA_C}\n` }
    await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: merge }, error: 'Exit code 1', tool_use_id: 'toolu_m', cwd: '/work' } as never)
    await clock.advance(60_000)

    expect((await bandLinesOf($)).join('\n')).not.toContain('公告')
  })

  test("another repository's main after a change of root: read as a new baseline, no notice", ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    world.replies[MAIN] = { exitCode: 0, stdout: `${SHA_A}\n` }
    await $.session.start(SESSION)
    await clock.advance(1_000)
    world.root = '/other'
    world.replies['git -C /other rev-parse --verify --quiet main'] = { exitCode: 0, stdout: `${SHA_B}\n` }
    await clock.advance(60_000)

    expect((await bandLinesOf($)).join('\n')).not.toContain('公告')
  })

  test('a notice file read half written is read again on the next poll', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const whole = JSON.stringify({ id: 'p2', author: 'p2', at: NOW, text: 'deploy freeze' })

    world.files[`${NOTICES}/p2.json`] = { text: whole.slice(0, 20), mtimeMs: NOW }
    await $.session.start(SESSION)
    await clock.advance(1_000)

    expect((await bandLinesOf($)).join('\n')).not.toContain('公告')

    world.files[`${NOTICES}/p2.json`] = { text: whole, mtimeMs: NOW + 1_000 }
    await clock.advance(15_000)

    expect(await bandLinesOf($)).toContain('公告 · deploy freeze')
  })
})

describe('follow-ups', () => {
  test("the band's ✕ marks only that result read: an agent that ended earlier stays unread", ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_2', description: 'Second' } as never)
    await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_3', description: 'Third' } as never)
    await clock.advance(1_000)
    await $.turn.complete(complete('a1'))
    await clock.advance(1_000)
    await $.turn.complete(complete('a2'))

    const band = await $.ui.mount({ plugin: PLUGIN, ...bandAt('desktop') } as never)

    await band.press({ key: 'dismiss-a2' })
    await band.unmount()

    expect((await bandLinesOf($, 1))[0]).toContain('待读1')
  })

  test("the band's ✕ marks that one result read: the same agent sent on and failing shows again", ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    seat(on)
    on('session.send', () => ({ isDelivered: true }))
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN as never)
    await clock.advance(1_000)
    await $.turn.complete(complete('a1'))

    const band = await $.ui.mount({ plugin: PLUGIN, ...bandAt('desktop') } as never)

    await band.press({ key: 'dismiss-a1' })
    await band.unmount()
    await $.session.send({ to: 'a1', text: 'one more thing', origin: { kind: 'model' } })
    await clock.advance(1_000)
    await $.turn.complete({ ...(complete('a1') as object), reason: 'error' } as never)

    expect((await bandLinesOf($, 1))[0]).toMatch(/✗ worker {2}Build mm plugin .*出错/)
  })

  test('the 外审 list draws the legend of a finished run without opening it; a running run is not read', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const done = '20261002-010000-aaaa'
    const running = '20261002-020000-dddd'
    const review = { verdict: 'needs_changes', summary: 's', findings: [{ severity: 'critical', file: 'a.ts', line: 3, claim: 'c', quote: 'q', failure_scenario: 'f' }] }
    const meta = (runid: string, models: string) => `runid=${runid}\nworkdir=/work\ntag=t\nmodels=${models}\nmode=review\nschema=\nwt=\nsession=x\n`

    world.files[`${MMRUNS}/${done}/run.meta`] = { text: meta(done, 'grok'), mtimeMs: NOW - 300_000 }
    world.files[`${MMRUNS}/${done}/grok.status`] = { text: 'DONE\n', mtimeMs: NOW - 120_000 }
    world.files[`${MMRUNS}/${done}/grok.meta`] = { text: 'secs=30\nexit=0\n', mtimeMs: NOW - 120_000 }
    world.files[`${MMRUNS}/${done}/grok.json`] = { text: JSON.stringify(review), mtimeMs: NOW - 120_000 }
    world.files[`${MMRUNS}/${running}/run.meta`] = { text: meta(running, 'codex'), mtimeMs: NOW - 60_000 }
    world.files[`${MMRUNS}/${running}/codex.status`] = { text: 'RUNNING\n', mtimeMs: NOW - 60_000 }
    world.files[`${MMRUNS}/${running}/codex.pid`] = { text: '111\n', mtimeMs: NOW - 60_000 }
    await $.session.start({ ...SESSION, surface: 'desktop' })
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const pane = await $.ui.mount({ plugin: PLUGIN, ...paneAt('desktop') } as never)

    await clock.advance(1_000)
    expect(JSON.stringify(await pane.drawn())).toContain('Critical')
    expect(world.calls).toContain(`read ${MMRUNS}/${done}/grok.json`)
    expect(world.calls, 'a running run is not read').not.toContain(`read ${MMRUNS}/${running}/codex.json`)
    await pane.unmount()
  })

  test('the 外审 list reads again a report read while its run ran, once the run ends', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const runid = '20261002-030000-eeee'
    const review = (severity: string, n: number) => ({
      verdict: 'needs_changes',
      summary: 's',
      findings: Array.from({ length: n }, (_, i) => ({ severity, file: 'a.ts', line: i + 1, claim: `c${i}`, quote: 'q', failure_scenario: 'f' })),
    })

    world.files[`${MMRUNS}/${runid}/run.meta`] = { text: `runid=${runid}\nworkdir=/work\ntag=t\nmodels=grok,codex\nmode=review\nschema=\nwt=\nsession=x\n`, mtimeMs: NOW - 300_000 }
    world.files[`${MMRUNS}/${runid}/grok.status`] = { text: 'DONE\n', mtimeMs: NOW - 120_000 }
    world.files[`${MMRUNS}/${runid}/grok.meta`] = { text: 'secs=30\nexit=0\n', mtimeMs: NOW - 120_000 }
    world.files[`${MMRUNS}/${runid}/grok.json`] = { text: JSON.stringify(review('critical', 1)), mtimeMs: NOW - 120_000 }
    world.files[`${MMRUNS}/${runid}/codex.status`] = { text: 'RUNNING\n', mtimeMs: NOW - 60_000 }
    world.files[`${MMRUNS}/${runid}/codex.pid`] = { text: '111\n', mtimeMs: NOW - 60_000 }
    await $.session.start({ ...SESSION, surface: 'desktop' })
    await clock.advance(3_000)
    await $.command.run(command('mmrun'))

    const pane = await $.ui.mount({ plugin: PLUGIN, ...paneAt('desktop') } as never)
    // The legend's Major count: the bold Text after its label.
    const majors = async () => JSON.stringify(await pane.drawn()).match(/" Major "\][^[]*\["(\d+)"\]/)?.[1]

    await pane.press({ key: `read-run-${runid}` })
    await pane.press({ key: 'dash-back' })
    await clock.advance(1_000)
    expect(await majors(), 'the legend as read while the run ran').toBe('0')

    world.files[`${MMRUNS}/${runid}/codex.status`] = { text: 'DONE\n', mtimeMs: NOW + 5_000 }
    world.files[`${MMRUNS}/${runid}/codex.meta`] = { text: 'secs=60\nexit=0\n', mtimeMs: NOW + 5_000 }
    world.files[`${MMRUNS}/${runid}/codex.json`] = { text: JSON.stringify(review('major', 2)), mtimeMs: NOW + 5_000 }
    await clock.advance(15_000)

    expect(await majors()).toBe('2')
    await pane.unmount()
  })
})
