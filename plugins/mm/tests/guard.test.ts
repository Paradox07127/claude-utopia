import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { register } from '../hooks/register'

const HOME = '/s/home'
const RUN = '/h/.claude/mmruns/20260101-000000-abcd'
const RAW_DENY =
  'mm: *.raw is the full event stream (tens of thousands of tokens); do not read it. Use `mmrun status <RUNID>` for status and `mmrun result <model> <RUNID>` for findings. ' +
  'For troubleshooting, the only allowed form is `tail -n N <file>.raw` with N at most 50, optionally `| cut -c1-M` with M at most 1000.'
const waitDeny = (rid: string) => `mm: the mm plugin watches ${rid} and sends its result when it ends; do not wait for it.`

/** The host beneath the guard: the environment, readable files, the session, and what the guard wrote. */
type World = {
  /** '' makes $.session.cwd() reject. */
  cwd: string
  env: Record<string, string>
  files: Record<string, string>
  /** undefined makes $.session.id() reject. */
  session: string | undefined
  isLogWritable: boolean
  log: Record<string, unknown>[]
  debug: string[]
  /** The tool input the call ran with, once it ran. */
  ran: Record<string, unknown> | undefined
}

const world = (fields: Partial<World> = {}): World => ({
  cwd: '/w',
  env: { HOME },
  files: {},
  session: 'sess-a',
  isLogWritable: true,
  log: [],
  debug: [],
  ran: undefined,
  ...fields,
})

const done = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

let calls = 0

/** Makes the call from the main thread (or from `agent`): the refusal the model reads, or undefined when it ran. */
async function call($: Engine, on: On, w: World, tool: string, input: Record<string, unknown>, agent?: string): Promise<string | undefined> {
  calls += 1
  const id = `toolu_${calls}`
  on('session.cwd', () => (w.cwd === '' ? { deny: 'no working directory' } : { value: w.cwd }))
  on('session.id', () => (w.session === undefined ? { deny: 'no session' } : { value: w.session }))
  on('clock.now', () => ({ value: 1_000 }))
  on('env.get', ($, e) => ({ value: w.env[e.name] }))
  on('fs.read', ($, e) => (w.files[e.path] === undefined ? { deny: `ENOENT ${e.path}` } : { value: w.files[e.path] }) as never)
  on('ui.log', ($, e) => {
    w.debug.push(e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const script = e.argv[0] === '/bin/sh' ? (e.argv[2] ?? '') : ''
    if (script.startsWith('printf %s ~')) return done(script === 'printf %s ~' ? (w.env.HOME ?? '~') : `~${script.slice('printf %s ~'.length)}`)
    if (!script.includes('cat >>')) return { deny: `no such command here: ${e.argv.join(' ')}` }
    if (!w.isLogWritable) return done('', 1)
    w.log.push(JSON.parse(e.init?.stdin ?? '{}') as Record<string, unknown>)
    return done()
  })
  const rows = (ids: string[]) => ({ value: [{ role: 'assistant', text: '', toolUses: ids.map(one => ({ tool_use_id: one, tool, input: {} })) }] }) as never
  on('session.messages', ($, e) => (e.agentId === undefined ? rows(agent === undefined ? [id] : []) : rows(e.agentId === agent ? [id] : [])))
  on('agent.list', () => ({ value: agent === undefined ? [] : [{ id: agent, description: 'x', type: 'worker', status: 'running' }] }) as never)
  on('tool.call', ($, e) => {
    const { tool: _tool, tool_use_id: _id, ...input } = e as unknown as Record<string, unknown>
    w.ran = input
    return { result: { stdout: 'ran' }, text: 'ran' } as never
  })
  const got = (await $.tool.call({ tool, ...input, tool_use_id: id } as never)) as { isError?: boolean; text?: string }
  return got.isError === true ? (got.text ?? '') : undefined
}

const bash = (command: string, extra: Record<string, unknown> = {}) => ({ command, description: 'd', ...extra })

function refused(name: string, commands: string[], cwd = '/w'): void {
  for (const command of commands) {
    test(`${name} [${command}]${cwd === '/w' ? '' : ` in ${cwd}`}`, async ($, on) => {
      expect(await call($, on, world({ cwd }), 'Bash', bash(command))).toBe(RAW_DENY)
    })
  }
}

/** Runs unchanged: no refusal and no rewrite. */
function untouched(name: string, commands: string[], cwd = '/w', extra: Record<string, unknown> = {}): void {
  for (const command of commands) {
    test(`${name} [${command}]${cwd === '/w' ? '' : ` in ${cwd}`}`, async ($, on) => {
      const w = world({ cwd })
      expect(await call($, on, w, 'Bash', bash(command, extra))).toBeUndefined()
      expect(w.ran).toEqual(bash(command, extra))
    })
  }
}

/** Runs in the background, otherwise as asked. */
function backgrounded(name: string, commands: string[]): void {
  for (const command of commands) {
    test(`${name} [${command}]`, async ($, on) => {
      const w = world()
      expect(await call($, on, w, 'Bash', bash(command))).toBeUndefined()
      expect([w.ran?.run_in_background, w.ran?.command, w.ran?.description]).toEqual([true, command, 'd'])
    })
  }
}

describe('mmrun wait in the foreground moves to the background', () => {
  backgrounded('moved', ['mmrun wait 20260101-000000-abcd --timeout 3600', 'cd /tmp && mmrun wait', 'mmrun status; mmrun wait X', 'true || ~/.local/bin/mmrun wait X'])

  // The background timeout covers mmrun's --timeout plus a minute, at most 2 h, never shortened
  for (const [name, command, extra, want] of [
    ['foreground --timeout 3600', 'mmrun wait X --timeout 3600', {}, 3_660_000],
    ['already background --timeout 3600', 'mmrun wait X --timeout 3600', { run_in_background: true }, 3_660_000],
    ['--timeout 9000 is capped', 'mmrun wait X --timeout 9000', { run_in_background: true, timeout: 60_000 }, 7_200_000],
    ['a longer timeout is kept', 'mmrun wait X --timeout 60', { run_in_background: true, timeout: 600_000 }, 600_000],
    ['no --timeout sets none', 'mmrun wait X', {}, undefined],
  ] as const) {
    test(`timeout: ${name}`, async ($, on) => {
      const w = world()
      expect(await call($, on, w, 'Bash', bash(command, extra))).toBeUndefined()
      expect([w.ran?.run_in_background, w.ran?.timeout]).toEqual([true, want])
    })
  }

  untouched('already background', ['mmrun wait X'], '/w', { run_in_background: true })
  untouched('mmrun wait not in command position', ['echo mmrun wait', 'mmrun status X', 'grep "mmrun wait" notes.md'])
  backgrounded('after a launcher', ['env mmrun wait R', 'timeout 600 mmrun wait R', 'nice -n 5 mmrun wait R', 'command mmrun wait R', 'exec mmrun wait R', 'FOO=1 mmrun wait R', 'env -u X timeout -s INT 600 mmrun wait R'])
  untouched('quoted or no command', ['echo "example; mmrun wait R"', "echo 'x | mmrun wait R'", 'timeout 600 echo mmrun wait R'])
  untouched('prose and a heredoc written to a file', ['git commit -m "mm guard: deny reading ~/.claude/mmruns/<rid>/<model>.raw"', "cat > notes.md <<'EOF'\nmmrun wait 20261003-120000-abcd\nEOF"])
})

describe('*.raw is refused', () => {
  test('Read of a .raw', async ($, on) => {
    expect(await call($, on, world(), 'Read', { file_path: `${RUN}/codex.raw` })).toBe(RAW_DENY)
  })

  test('Read of a .out runs', async ($, on) => {
    expect(await call($, on, world(), 'Read', { file_path: `${RUN}/codex.out` })).toBeUndefined()
  })

  refused('Bash', [`head -50 ${RUN}/codex.raw`, 'jq . "$HOME/.claude/mmruns/$RID/grok.raw"', 'cd ~/.claude/mmruns/20260101-000000-abcd && wc -l *.raw'])
  untouched('Bash of a .out', [`cat ${RUN}/codex.out`])
  // The troubleshooting step the docs give: the whole command one tail of N ≤ 50 lines, optionally one cut -c1-M with M ≤ 1000
  untouched('a bounded tail', ['tail -20 ~/.claude/mmruns/R/codex.raw', `tail -n 30 ${RUN}/codex.raw`])
  refused('not a bounded tail', [
    `tail -200 ${RUN}/codex.raw`, `tail -n 51 ${RUN}/codex.raw`, `tail -20 ${RUN}/codex.raw | cat`, `cat ${RUN}/codex.raw`,
    `tail -20 ${RUN}/codex.raw; cat ${RUN}/codex.raw`, `tail -20 ${RUN}/codex.raw && cat ${RUN}/codex.raw`, `tail -20 ${RUN}/codex.raw $(cat ${RUN}/codex.raw)`,
  ])
  untouched('a bounded tail | cut', [`tail -n 20 ${RUN}/codex.raw | cut -c1-300`, 'tail -20 ~/.claude/mmruns/R/grok.raw|cut -c1-1000'])
  refused('tail | cut in other forms', [
    `tail -n 20 ${RUN}/codex.raw | cut -c1-5000`, `tail -n 51 ${RUN}/codex.raw | cut -c1-300`, `tail -n 20 ${RUN}/codex.raw | cut -c1-300 | cat`,
    `tail -n 20 ${RUN}/codex.raw | cut -c1-300; rm x`, `tail -n 20 ${RUN}/codex.raw | cut -c2-300`, `tail -n 20 ${RUN}/codex.raw | cut -c1-`, `tail -n 20 ${RUN}/codex.raw | cut -f1`,
  ])
  untouched('a bounded tail | cut in the run directory', ['tail -n 20 codex.raw | cut -c1-300'], RUN)
  // Relative paths resolve against the cwd and any cd
  refused('relative to the cwd', ['cat codex.raw', 'cat ../20261001-000000-aaaa/grok.raw', 'tail -n 51 codex.raw', 'wc -l < codex.raw'], RUN)
  refused('relative to the cwd', ['cat 20260101-000000-abcd/codex.raw'], '/h/.claude/mmruns')
  refused('relative to a cd', ['cd ../.. && cat R/codex.raw'], `${RUN}/x`)
  untouched('relative, let through', ['tail -n 20 codex.raw', 'tail -20 codex.raw', 'cat codex.out'], RUN)
  untouched('relative, let through', ['cat codex.raw'], '/w/project')
  refused('the body of a heredoc fed to a shell, and a plain command', ["bash <<'EOF'\ntail ~/.claude/mmruns/x/codex.raw\nEOF", 'cat ~/.claude/mmruns/x/codex.raw'])
})

describe('the deny log', () => {
  test('Read of a .raw from a subagent logs one line', async ($, on) => {
    const w = world()
    expect(await call($, on, w, 'Read', { file_path: `${RUN}/codex.raw` }, 'a1')).toBe(RAW_DENY)
    expect(w.log).toEqual([{ at: 1_000, guard: 'mm-raw', decision: 'deny', op: 'read *.raw', cwd: '/w', agent_id: 'a1' }])
  })

  test('Bash of a .raw from the main thread logs agent_id null', async ($, on) => {
    const w = world()
    await call($, on, w, 'Bash', bash(`cat ${RUN}/codex.raw`))
    expect(w.log.map(line => [line.guard, line.agent_id])).toEqual([['mm-raw', null]])
  })

  for (const [name, tool, input] of [
    ['a call let through', 'Read', { file_path: `${RUN}/codex.out` }],
    ['a wait moved to the background', 'Bash', bash('mmrun wait X')],
  ] as const) {
    test(`${name} logs nothing`, async ($, on) => {
      const w = world()
      await call($, on, w, tool, input)
      expect(w.log).toEqual([])
    })
  }

  test('an unwritable log changes no refusal', async ($, on) => {
    expect(await call($, on, world({ isLogWritable: false }), 'Read', { file_path: `${RUN}/codex.raw` })).toBe(RAW_DENY)
  })
})

describe('a main-thread wait on a run the plugin watches', () => {
  const runs = `${HOME}/.claude/mmruns`
  const marks = {
    [`${runs}/W1/watched`]: 'watched\n',
    [`${runs}/E1/watched`]: '',
    [`${runs}/L1/watched`]: 'watched\n',
    [`${runs}/S1/watched`]: 'watched sess-a\n',
    [`${runs}/.latest-s_1`]: 'L1\n',
    [`${runs}/.latest-host_x`]: 'L1\n',
  }

  for (const [name, command, env, rid] of [
    ['with a RUNID', 'mmrun wait W1 --timeout 3600', {}, 'W1'],
    ['--timeout first', 'mmrun wait --timeout 600 W1', {}, 'W1'],
    ['after a launcher', 'cd /r && timeout 900 ~/.local/bin/mmrun wait W1', {}, 'W1'],
    ['a redirection, then a pipe', 'mmrun wait W1 --timeout 3600 2>&1 | tail -5', {}, 'W1'],
    ['a redirection to a file', 'mmrun wait W1 > /tmp/x; mmrun result codex W1', {}, 'W1'],
    ['no RUNID: .latest of MMRUN_SESSION', 'mmrun wait --timeout 600', { MMRUN_SESSION: 's 1' }, 'L1'],
    ['no RUNID: .latest of CLAUDE_CODE_HOST_SESSION_ID', 'mmrun wait', { CLAUDE_CODE_HOST_SESSION_ID: 'host/x' }, 'L1'],
    ['the mark names this session', 'mmrun wait S1', {}, 'S1'],
  ] as const) {
    test(`refused: ${name}`, async ($, on) => {
      const w = world({ env: { HOME, ...env }, files: marks })
      expect(await call($, on, w, 'Bash', bash(command))).toBe(waitDeny(rid))
      expect(w.log.map(line => line.guard)).toEqual(['mm-wait'])
    })
  }

  for (const [name, command, fields, agent] of [
    ['an empty mark', 'mmrun wait E1', {}, undefined],
    ['no mark', 'mmrun wait NOPE', {}, undefined],
    ['a subagent', 'mmrun wait W1', {}, 'a1'],
    ['no RUNID and no session variable', 'mmrun wait', {}, undefined],
    ['no RUNID and no .latest', 'mmrun wait', { env: { HOME, MMRUN_SESSION: 'other' } }, undefined],
    ['the mark names another session', 'mmrun wait S1', { session: 'sess-b' }, undefined],
    ['the mark names a session and this one has no id', 'mmrun wait S1', { session: undefined }, undefined],
  ] as const) {
    test(`moved to the background instead: ${name}`, async ($, on) => {
      const w = world({ files: marks, ...fields })
      expect(await call($, on, w, 'Bash', bash(command), agent)).toBeUndefined()
      expect(w.ran?.run_in_background).toBe(true)
    })
  }
})

describe('the guard hook failing', () => {
  test('lets the call through and leaves one debug line', async ($, on) => {
    const w = world({ cwd: '' })
    expect(await call($, on, w, 'Read', { file_path: `${RUN}/codex.raw` })).toBeUndefined()
    expect(w.debug.filter(line => line.startsWith('mm: classic.PreToolUse hook failed'))).toHaveLength(1)
  })
})

describe('registration', () => {
  test('tool.call only on Skill, the guard on classic.PreToolUse for Bash and Read (claude-code#92533)', () => {
    const seen: { pattern: string; matcher?: { tool?: unknown } }[] = []
    const record = ((pattern: string, matcher: unknown) => {
      seen.push({ pattern, ...(typeof matcher === 'object' && matcher !== null && { matcher: matcher as { tool?: unknown } }) })
      return { catch: () => undefined }
    }) as unknown as On
    register(record, { reviewModels: '' })
    expect(seen.filter(one => one.pattern === 'tool.call' || one.pattern === '*' || one.pattern === 'tool.*')).toEqual([{ pattern: 'tool.call', matcher: { tool: 'Skill' } }])
    expect(seen.filter(one => one.pattern === 'classic.PreToolUse')).toEqual([{ pattern: 'classic.PreToolUse', matcher: { tool: ['Bash', 'Read'] } }])
  })
})
