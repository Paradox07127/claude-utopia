import type { EngineInterface, HookFailure, Register } from 'claude-code'

import { sharedTreeGit } from './guard-git'
import type { GuardIo } from './guard-io'
import { secretFiles } from './guard-secret'
import { basename, dirname } from './posixpath'

// The variables git would otherwise read in place of the repository found from -C.
const REPO_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'] as const
// A login name sh expands after an unquoted ~; any other ~name names no user and keeps the path.
const USER_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/
const LOG_TIMEOUT_MS = 5_000
const GIT_TIMEOUT_MS = 2_000
const SESSION_ID = /^[\p{L}\p{N}_-]+$/u

// Ledger appends of this load, one at a time: $.fs has no append, so each is a read and a whole write.
let appending: Promise<unknown> = Promise.resolve()

function logFailure($: EngineInterface, event: string, error: HookFailure): void {
  $.ui.log(`harness: ${event} hook failed (${error.kind}): ${error.message ?? 'no message'}`, { to: 'debug' })
}

/** The host as the guards read it, for one call: stats and the environment read once. */
function guardIo($: EngineInterface): GuardIo {
  const stats = new Map<string, ReturnType<GuardIo['stat']>>()
  let hostEnv: Promise<Map<string, string>> | undefined
  let repoVars: Promise<string[]> | undefined

  // $.env.get takes literal names only; any other is read from one `env -0`.
  const env = async (name: string): Promise<string | undefined> => {
    if (name === 'HOME') return $.env.get('HOME')
    if (name === 'GIT_DIR') return $.env.get('GIT_DIR')
    if (name === 'GIT_WORK_TREE') return $.env.get('GIT_WORK_TREE')
    hostEnv ??= $.process.run(['env', '-0']).then(
      got => new Map(got.stdout.split('\0').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])),
      () => new Map(),
    )
    return (await hostEnv).get(name)
  }

  return {
    env,
    userHome: async name => {
      if (name !== '' && !USER_NAME.test(name)) return undefined
      const got = await $.process.run(['/bin/sh', '-c', `printf %s ~${name}`]).catch(() => undefined)
      return got?.exitCode === 0 && got.stdout.startsWith('/') ? got.stdout : undefined
    },
    run: async (argv, init) => {
      repoVars ??= Promise.all([$.env.get('GIT_DIR'), $.env.get('GIT_WORK_TREE'), $.env.get('GIT_COMMON_DIR'), $.env.get('GIT_INDEX_FILE')]).then(values =>
        REPO_VARS.filter((_, i) => values[i] !== undefined),
      )
      const unset = (await repoVars).filter(name => init.env?.[name] === undefined)
      const command = unset.length > 0 ? ['env', ...unset.flatMap(name => ['-u', name]), ...argv] : argv
      return $.process.run(command, { env: init.env, timeoutMs: init.timeoutMs }).catch(() => undefined)
    },
    stat: path => {
      let found = stats.get(path)
      if (found === undefined) {
        found = $.fs.stat(path, { resolve: true }).then(
          got => ({ kind: got.kind, realPath: got.realPath }),
          () => undefined,
        )
        stats.set(path, found)
      }
      return found
    },
    list: path =>
      $.fs.list(path).then(
        entries => entries.map(entry => ({ name: entry.name, kind: entry.kind })),
        () => undefined,
      ),
    now: () => $.clock.now(),
  }
}

/** The loop that made the call: null for the main thread or when no loop holds it, else the agent's id. */
async function agentOf($: EngineInterface, toolUseId: string): Promise<string | null> {
  const holds = (rows: { toolUses: { tool_use_id: string }[] }[]) => rows.some(row => row.toolUses.some(use => use.tool_use_id === toolUseId))
  if (holds(await $.session.messages())) return null
  for (const agent of await $.agent.list()) {
    const rows = await $.session.messages({ agentId: agent.id })
    if (Array.isArray(rows) && holds(rows)) return agent.id
  }
  return null
}

/** Appends one line to ~/.claude/harness/guard.jsonl; a log that cannot be written is skipped. */
async function logDeny($: EngineInterface, guard: string, op: string, cwd: string, agentId: string | null): Promise<void> {
  const home = await $.env.get('HOME')
  if (home === undefined) return
  const line = `${JSON.stringify({ at: await $.clock.now(), guard, decision: 'deny', op, cwd, agent_id: agentId })}\n`
  await $.process
    .run(['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', `${home}/.claude/harness/guard.jsonl`], { stdin: line, timeoutMs: LOG_TIMEOUT_MS })
    .catch(() => undefined)
}

const pad2 = (n: number) => String(n).padStart(2, '0')

function dayOf(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** The main working tree's root, so a linked worktree's session shares its project (as the dashboard's ledgers do); else cwd. */
async function projectRoot($: EngineInterface, cwd: string): Promise<string> {
  const got = await $.process.run(['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined)
  const common = got?.stdout.trim() ?? ''
  return got?.exitCode === 0 && basename(common) === '.git' ? dirname(common) : cwd
}

/** Appends one guard.block line to the secret guard's file of the event ledger,
 * ~/.claude/harness/events/<project>/<local day>/<session>.guard.jsonl; rule.name stays that of the Python guard it replaces. */
async function recordBlock($: EngineInterface, cwd: string, rule: string, tool: string, target: string): Promise<void> {
  const home = await $.env.get('HOME')
  if (home === undefined) return
  const at = await $.clock.now()
  const id = await $.session.id().catch(() => '')
  const session = SESSION_ID.test(id) ? id : 'unknown-session'
  const line = JSON.stringify({
    timestamp: new Date(at).toISOString(),
    event_name: 'guard.block',
    severity_text: 'WARN',
    attributes: {
      'session.id': session,
      'rule.id': rule,
      'rule.name': 'guard-secret-files',
      tool,
      target: Array.from(target.split(/\s+/).filter(word => word !== '').join(' ')).slice(0, 120).join(''),
      decision: 'deny',
    },
  })
  const path = `${home}/.claude/harness/events/${(await projectRoot($, cwd)).replace(/\//g, '-')}/${dayOf(at)}/${session}.guard.jsonl`
  const write = appending.then(async () => {
    // Only a missing file counts as empty: any other read failure throws rather than overwrite the day's lines.
    const before = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    await $.fs.write(path, `${before}${before === '' || before.endsWith('\n') ? '' : '\n'}${line}\n`)
  })
  appending = write.catch(() => undefined)
  await write
}

export const register: Register = (on, options) => {
  // The option may arrive as a string as well as a boolean: "false" and "0" turn the guard off.
  const isGitGuardOn = !['false', '0'].includes(String(options.sharedTreeGitGuard).toLowerCase())

  // classic.PreToolUse, never tool.call: a tool.call hook on Bash breaks isolation: worktree subagents (claude-code#92533).
  on('classic.PreToolUse', { tool: /^(?:Bash|Read|Edit|Write|Grep)$/ }, async ($, e, next) => {
    const io = guardIo($)
    const cwd = await $.session.cwd()
    // Both guards check every call, so a call both refuse logs two lines and names both reasons.
    const denials: { guard: string; op: string; reason: string }[] = []
    const git = e.tool === 'Bash' && isGitGuardOn ? await sharedTreeGit(io, e.command, cwd) : undefined
    if (git !== undefined) denials.push({ guard: 'shared-tree-git', ...git })
    const secret = await secretFiles(io, e, cwd)
    if (secret !== undefined) denials.push({ guard: 'secret-files', ...secret })
    if (denials.length === 0) return next(e)
    const agentId = await agentOf($, e.tool_use_id)
    for (const one of denials) await logDeny($, one.guard, one.op, cwd, agentId)
    if (secret !== undefined) await recordBlock($, cwd, secret.rule, e.tool, secret.target).catch(() => undefined)
    return { deny: denials.map(one => one.reason).join('\n') }
  }).catch(($, e, next) => {
    logFailure($, 'classic.PreToolUse', next.error)
    return next(e)
  })
}
