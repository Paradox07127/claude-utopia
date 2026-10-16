import { describe, expect, mock, test } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'

import type { AgentRun, MmRun, MmSnapshot } from '../types'
import { agentEvents, capped, cutCommand, eventLine, eventsPath, gateEvent, groupEvents, parseLedger, runEvents, serially, staleDays } from '../hooks/events'
import { dayOf } from '../hooks/usage'
import { BUN_OK, NOW, PANE, PLUGIN, SESSION, SPAWN, complete, seat } from './hooks-kit'

const EVENTS = '/h/.claude/harness/events'
const LATER = NOW + 86_400_000

const agent = (agentId: string, more: Partial<AgentRun> = {}): AgentRun => ({
  agentId,
  description: 'Build',
  subagentType: 'worker',
  model: 'claude-opus-5-5',
  background: true,
  startedAt: 0,
  tools: 0,
  lastTool: '',
  state: 'running',
  lastActivityAt: 0,
  ...more,
})

const run = (runid: string, statuses: string[], workdir = '/r'): MmRun => ({
  runid,
  tag: 'design',
  workdir,
  mode: 'review',
  createdAt: 0,
  models: statuses.map((status, i) => ({ name: `m${i}`, status, startedAt: 0 })),
})

const snap = (...runs: MmRun[]): MmSnapshot => ({ polledAt: 0, runs })

describe('event ledger helpers', () => {
  test('a session file lives under its project and local day', async () => {
    expect(eventsPath('/h', '-r', '2026-10-14', 's1')).toBe('/h/.claude/harness/events/-r/2026-10-14/s1.jsonl')
  })

  test('a line carries the OTel fields, session.id leading the attributes', async () => {
    const line = JSON.parse(eventLine(NOW, 's1', { name: 'gate.result', severity: 'WARN', attributes: { outcome: 'fail' } })) as Record<string, unknown>

    expect(line).toEqual({ timestamp: new Date(NOW).toISOString(), event_name: 'gate.result', severity_text: 'WARN', attributes: { 'session.id': 's1', outcome: 'fail' } })
    expect(String(line.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  test('a command is cut to 120 characters, its whitespace folded', async () => {
    expect(cutCommand('  bun   test\n  a ')).toBe('bun test a')
    expect(cutCommand('x'.repeat(200))).toHaveLength(120)
  })

  test('the cap drops the oldest lines until the rest fit, newlines counted', async () => {
    expect(capped(['aaaa', 'bbbb', 'cccc'], 10)).toEqual(['bbbb', 'cccc'])
    expect(capped(['aaaa', 'bbbb'], 10)).toEqual(['aaaa', 'bbbb'])
    expect(capped(['é'], 2), 'bytes, not characters').toEqual([])
  })

  test('serially: a later work starts only once the earlier settled, a failure included', async () => {
    const order: string[] = []
    const chain = serially()
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const first = chain(async () => {
      order.push('first starts')
      await held
      order.push('first ends')
      throw new Error('first fails')
    })
    const second = chain(async () => {
      order.push('second')

      return 2
    })

    await Promise.resolve()
    expect(order).toEqual(['first starts'])
    release()
    await expect(first).rejects.toThrow('first fails')
    expect(await second).toBe(2)
    expect(order).toEqual(['first starts', 'first ends', 'second'])
  })

  test('only date directories older than 30 days are stale', async () => {
    const at = new Date(2026, 9, 14, 9).getTime()

    expect(staleDays(['2026-10-14', '2026-09-14', '2026-09-13', '2025-01-01', 'notes'], at)).toEqual(['2026-09-13', '2025-01-01'])
  })

  test('a gate: a pass, a failure by its counts, a failure by its exit alone', async () => {
    expect(gateEvent('bun test', { pass: 24, fail: 0, failed: false, failures: [] }, false)).toEqual({
      name: 'gate.result',
      severity: 'INFO',
      attributes: { command: 'bun test', pass: 24, fail: 0, outcome: 'pass' },
    })
    expect(gateEvent('bun test', { pass: 22, fail: 2, failed: true, failures: [] }, true).attributes).toEqual({ command: 'bun test', pass: 22, fail: 2, outcome: 'fail' })
    expect(gateEvent('bun test', { pass: 24, fail: 0, failed: false, failures: [] }, true).attributes).toEqual({ command: 'bun test', pass: 24, fail: null, outcome: 'fail' })
  })

  test('agents: an end from running or idle, a denied call; nothing for a resume or an unchanged end', async () => {
    const before = [agent('a1'), agent('a2', { state: 'idle' }), agent('a3', { state: 'done' }), agent('a4')]
    const after = [
      agent('a1', { state: 'done', durationMs: 5_000 }),
      agent('a2', { state: 'aborted', durationMs: 7_000 }),
      agent('a3', { state: 'running' }),
      agent('a4', { denied: 1, lastTool: 'Bash git stash' }),
    ]

    expect(agentEvents(before, after)).toEqual([
      { name: 'agent.end', severity: 'INFO', attributes: { 'agent.id': 'a1', 'agent.type': 'worker', state: 'done', duration_ms: 5_000 } },
      { name: 'agent.end', severity: 'WARN', attributes: { 'agent.id': 'a2', 'agent.type': 'worker', state: 'aborted', duration_ms: 7_000 } },
      { name: 'agent.denied', severity: 'WARN', attributes: { 'agent.id': 'a4', 'agent.type': 'worker', tool: 'Bash git stash' } },
    ])
    expect(agentEvents(after, after)).toEqual([])
    expect(agentEvents([agent('a1')], [agent('a1', { state: 'error' })])[0]?.severity).toBe('ERROR')
  })

  test('runs: a new one starts, one that stops running ends; another project and the first poll say nothing', async () => {
    const isOurs = (one: MmRun) => one.workdir === '/r'

    expect(runEvents(null, snap(run('r1', ['RUNNING'])), isOurs)).toEqual([])
    expect(runEvents(snap(), snap(run('r1', ['RUNNING', 'RUNNING']), run('x1', ['RUNNING'], '/other')), isOurs)).toEqual([
      { name: 'mmrun.start', severity: 'INFO', attributes: { 'run.id': 'r1', label: 'design', models: 'm0,m1', mode: 'review' } },
    ])
    expect(runEvents(snap(run('r1', ['RUNNING', 'RUNNING'])), snap(run('r1', ['DONE', 'RUNNING'])), isOurs)).toEqual([])
    expect(runEvents(snap(run('r1', ['DONE', 'RUNNING'])), snap(run('r1', ['DONE', 'FAIL:1'])), isOurs)).toEqual([
      { name: 'mmrun.end', severity: 'WARN', attributes: { 'run.id': 'r1', label: 'design', models: 'm0,m1', status: 'm0:DONE,m1:FAIL:1' } },
    ])
    expect(runEvents(snap(run('r1', ['STALE'])), snap(run('r1', ['DONE'])), isOurs), 'a stale model that turns done ended already').toEqual([])
  })
})

/** The session's event files in memory, by path; registered before seat, so they answer above it. */
function ledger(on: On): Record<string, string> {
  const files: Record<string, string> = {}
  const inLedger = { path: /^\/h\/\.claude\/harness\/events\// }

  on('fs.read', inLedger, ($, e) => (files[e.path] === undefined ? { deny: `ENOENT ${e.path}` } : { value: files[e.path]! }))
  on('fs.exists', inLedger, ($, e) => ({ value: files[e.path] !== undefined }))
  on('fs.write', inLedger, ($, e) => {
    files[e.path] = e.text

    return { value: undefined }
  })
  on('fs.list', inLedger, ($, e) => {
    const names = new Set(Object.keys(files).filter(path => path.startsWith(`${e.path}/`)).map(path => path.slice(e.path.length + 1).split('/')[0]!))

    return { value: [...names].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: NOW, isLink: false }) as FsEntry) }
  })

  return files
}

const parsed = (text: string | undefined) => (text ?? '').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as { event_name: string; severity_text: string; attributes: Record<string, unknown> })

describe('event ledger hooks', () => {
  test('a passing test run and a subagent that returns each add a line to the session file', async ($, on) => {
    mock.clock(on, { now: NOW })

    const files = ledger(on)

    seat(on)
    await $.session.start(SESSION)
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'bun   test\n a' }, tool_response: { stdout: BUN_OK, stderr: '' }, tool_use_id: 't1', cwd: '/work/harness' } as never)
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a b', stderr: '' }, tool_use_id: 't2', cwd: '/work/harness' } as never)
    await $.agent.spawn(SPAWN as never)
    await $.turn.complete(complete('a1', 'answer', 4_000))

    const lines = parsed(files[`${EVENTS}/-work-harness/${dayOf(NOW)}/me.jsonl`])

    expect(Object.keys(files)).toEqual([`${EVENTS}/-work-harness/${dayOf(NOW)}/me.jsonl`])
    expect(lines.map(line => line.event_name)).toEqual(['session.start', 'gate.result', 'agent.end'])
    expect(lines[1]).toEqual({ timestamp: new Date(NOW).toISOString(), event_name: 'gate.result', severity_text: 'INFO', attributes: { 'session.id': 'me', command: 'bun test a', pass: 24, fail: 0, outcome: 'pass' } })
    expect(lines[2]?.attributes).toEqual({ 'session.id': 'me', 'agent.id': 'a1', 'agent.type': 'worker', state: 'done', duration_ms: 4_000 })
  })

  test('a failing test run is a WARN line; the file read back after a reload keeps what it held', async ($, on) => {
    // A day later: a file of its own.
    mock.clock(on, { now: LATER })

    const files = ledger(on)
    const path = `${EVENTS}/-work-harness/${dayOf(LATER)}/me.jsonl`

    files[path] = `${JSON.stringify({ timestamp: 'x', event_name: 'earlier', severity_text: 'INFO', attributes: {} })}\n`
    seat(on)
    await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_use_id: 't', error: `Exit code 1\n${BUN_OK}`, cwd: '/work/harness' } as never)

    const lines = parsed(files[path])

    expect(lines.map(line => [line.event_name, line.severity_text])).toEqual([
      ['earlier', 'INFO'],
      ['gate.result', 'WARN'],
    ])
    expect(lines[1]?.attributes.outcome).toBe('fail')
  })

  test('a file that exists but cannot be read is not written over: the line is dropped', async ($, on) => {
    mock.clock(on, { now: NOW })

    const path = `${EVENTS}/-work-harness/${dayOf(NOW)}/me.jsonl`
    const writes: string[] = []

    on('fs.read', { path }, () => ({ deny: `EACCES ${path}` }))
    on('fs.write', { path }, ($, e) => {
      writes.push(e.text)

      return { value: undefined }
    })

    const files = ledger(on)

    files[path] = `${JSON.stringify({ timestamp: 'x', event_name: 'earlier', severity_text: 'INFO', attributes: {} })}\n`
    seat(on)
    await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_use_id: 't', error: `Exit code 1\n${BUN_OK}`, cwd: '/work/harness' } as never)

    expect(writes).toEqual([])
  })

  test('a file that does not exist yet is written as new', async ($, on) => {
    mock.clock(on, { now: NOW })

    const files = ledger(on)
    const path = `${EVENTS}/-work-harness/${dayOf(NOW)}/me.jsonl`

    seat(on)
    await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_use_id: 't', error: `Exit code 1\n${BUN_OK}`, cwd: '/work/harness' } as never)

    expect(parsed(files[path]).map(line => line.event_name)).toEqual(['gate.result'])
  })
})

/** A ledger line at `at`; `session` absent leaves `session.id` out, as a writer that names its file only. */
const lineAt = (at: number, name: string, attributes: Record<string, unknown>, session?: string, severity = 'INFO') =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), event_name: name, severity_text: severity, attributes: session === undefined ? attributes : { 'session.id': session, ...attributes } })

describe('event ledger, read back', () => {
  test('a line that is not an event is skipped; one without session.id belongs to its file’s session', () => {
    const text = [
      lineAt(NOW, 'guard.block', { 'rule.id': 'secret', target: '.env', nested: { no: 1 } }),
      'not json',
      '42',
      JSON.stringify({ event_name: 'gate.result', attributes: {} }),
      JSON.stringify({ timestamp: 'later', event_name: 'gate.result' }),
      lineAt(NOW + 1, '', {}),
      lineAt(NOW + 2, 'gate.result', { pass: 3 }, 'other'),
      '',
    ].join('\n')

    expect(parseLedger(text, 'me')).toEqual([
      { at: NOW, name: 'guard.block', severity: 'INFO', session: 'me', attributes: { 'rule.id': 'secret', target: '.env' } },
      { at: NOW + 2, name: 'gate.result', severity: 'INFO', session: 'other', attributes: { 'session.id': 'other', pass: 3 } },
    ])
  })

  test('one session’s lines from two files merge in time order; the other sessions come latest start first', () => {
    const records = [
      ...parseLedger([lineAt(NOW - 50, 'session.start', {}, 'me'), lineAt(NOW - 10, 'gate.result', {}, 'me')].join('\n'), 'me'),
      ...parseLedger(lineAt(NOW - 30, 'guard.block', {}), 'me'),
      ...parseLedger(lineAt(NOW - 90, 'session.start', {}, 'old'), 'old'),
      ...parseLedger(lineAt(NOW - 20, 'session.start', {}, 'new'), 'new'),
    ]
    const read = groupEvents(records, 'me')

    expect(read.own.map(one => one.name)).toEqual(['session.start', 'guard.block', 'gate.result'])
    expect(read.others.map(one => one.session)).toEqual(['new', 'old'])
    expect(groupEvents([], 'me')).toEqual({ session: 'me', own: [], others: [] })
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the timeline page’s events view reads every *.jsonl of the day, a file again only once it changed, on ${surface}`, { options: { language: 'zh-CN' } }, async ($, on) => {
      mock.clock(on, { now: NOW })

      const dir = `${EVENTS}/-work-harness/${dayOf(NOW)}`
      const files: Record<string, string> = {
        'me.jsonl': `${[lineAt(NOW - 50_000, 'session.start', {}, 'me'), lineAt(NOW - 30_000, 'gate.result', { command: 'bun test', pass: 24, fail: 0, outcome: 'pass' }, 'me')].join('\n')}\n`,
        'me.guard.jsonl': `${lineAt(NOW - 40_000, 'guard.block', { 'rule.id': 'secret', target: '.env' })}\nnot json\n`,
        'peer.jsonl': `${lineAt(NOW - 90_000, 'gate.result', { pass: 1, fail: 0, outcome: 'pass' }, 'peer')}\n`,
        'notes.txt': 'not a ledger',
      }
      const reads: string[] = []

      on('fs.list', { path: dir }, () => ({ value: Object.entries(files).map(([name, text]) => ({ name, kind: 'file', size: text.length, mtimeMs: NOW, isLink: false }) as FsEntry) }))
      on('fs.read', { path: /^\/h\/\.claude\/harness\/events\// }, ($, e) => {
        reads.push(e.path)

        const text = files[e.path.slice(dir.length + 1)]

        return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
      })
      seat(on)
      await $.session.start(SESSION)
      reads.length = 0

      const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface } as never)

      await pane.press({ key: 'page-timeline' })
      expect(reads, 'the steps view reads no ledger').toEqual([])
      await pane.press({ key: 'timeline-events' })

      const text = JSON.stringify(await pane.drawn())

      expect(text.indexOf('守卫拦截'), 'the guard file’s block sorts between the session file’s lines').toBeLessThan(text.indexOf('门禁通过'))
      expect(text).toContain('secret · .env')
      expect(text).toContain('24 pass · 0 fail · bun test')
      expect(text).toContain('▸ 会话 peer · ')
      expect(text).not.toContain('not json')
      expect(text).not.toContain('not a ledger')
      expect([...reads].sort()).toEqual([`${dir}/me.guard.jsonl`, `${dir}/me.jsonl`, `${dir}/peer.jsonl`])

      reads.length = 0
      await pane.press({ key: surface === 'terminal' ? 'timeline-events' : 'timeline-steps' })
      await pane.press({ key: 'timeline-events' })
      expect(JSON.stringify(await pane.drawn())).toContain('守卫拦截')
      expect(reads, 'unchanged files are not read again').toEqual([])
      await pane.unmount()
    })
  }
})
