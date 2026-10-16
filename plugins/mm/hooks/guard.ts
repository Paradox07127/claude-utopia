// Denies reading mmrun's *.raw and a main-thread `mmrun wait` on a run the mm plugin watches;
// moves any other foreground `mmrun wait` to the background.
import type { EngineInterface, HookFailure, Register } from 'claude-code'

import { basename, isabs, join, normpath } from './posixpath'
import { pySplit, shlexTokens } from './shlex'

const RAW_DENY =
  'mm: *.raw is the full event stream (tens of thousands of tokens); do not read it. ' +
  'Use `mmrun status <RUNID>` for status and `mmrun result <model> <RUNID>` for findings. ' +
  'For troubleshooting, the only allowed form is `tail -n N <file>.raw` with N at most 50, optionally `| cut -c1-M` with M at most 1000.'
const WAIT_DENY = 'mm: the mm plugin watches {} and sends its result when it ends; do not wait for it.'

// RAW_PATH's end also holds before a final newline; word characters (\w, \b) are Unicode letters, digits and _.
const RAW_PATH = /\/\.claude\/mmruns\/[^/]+\/[^/]+\.raw(?=\n?$)/
// The whole command is one `tail -N|-n N <file>.raw`, optionally piped to `cut -c1-M`: the troubleshooting step the mm docs recommend.
const BOUNDED_TAIL = /^\s*tail\s+(?:-(\d+)|-n\s+(\d+))\s+[^\s;&|<>()$`'"\\*?]+\.raw\s*(?:\|\s*cut\s+-c1-(\d+)\s*)?$/
const ASSIGN = /^[A-Za-z_][\p{L}\p{N}_]*=/u
const HOME_VAR = /\$(?:HOME(?![\p{L}\p{N}_])|\{HOME\})/gu
const HEREDOC = /<<-?\s*(['"]?)([\p{L}\p{N}_]+)\1([^\n]*)\n.*?\n\s*\2\s*(?=\n|$)/gsu
const SHELL_FED = /^(?:(?:ba|z|da|k)?sh|python[\p{Nd}.]*|node|ruby|perl)$/u
const SEPARATORS = ';&|()\n'
// A login name sh expands after an unquoted ~; any other ~name names no user and keeps the path.
const USER_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/
// Background Bash is stopped at its `timeout` (default 30 min, max 2 h).
const BASH_TIMEOUT_MS = 1_800_000
const BASH_TIMEOUT_MAX_MS = 7_200_000
const LOG_TIMEOUT_MS = 5_000

/** What the guard reads of the host; register answers it from `$`, a test from its own world. */
export type MmIo = {
  env: (name: 'HOME' | 'MMRUN_SESSION' | 'CLAUDE_CODE_HOST_SESSION_ID') => Promise<string | undefined>
  /** User `name`'s home directory ('' for the current user); undefined when there is no such user. */
  userHome: (name: string) => Promise<string | undefined>
  /** The file's text; undefined when it cannot be read. */
  read: (path: string) => Promise<string | undefined>
}

/** The call as the guard sees it: the tool, its arguments, and lazily whose loop made it. */
export type MmCall = {
  tool: string
  input: Record<string, unknown>
  cwd: string | undefined
  session: string | undefined
  isMainThread: () => Promise<boolean>
}

export type MmDecision = { deny: { guard: string; op: string; message: string } } | { updatedInput: Record<string, unknown> } | undefined

/** os.path.expanduser: `~` is $HOME (the user database when unset), `~name` that user's home; an unknown user keeps the path. */
async function expanduser(io: MmIo, path: string): Promise<string> {
  if (!path.startsWith('~')) return path
  const cut = path.indexOf('/', 1) < 0 ? path.length : path.indexOf('/', 1)
  const name = path.slice(1, cut)
  const home = name === '' ? ((await io.env('HOME')) ?? (await io.userHome(''))) : await io.userHome(name)
  if (home === undefined) return path
  return home.replace(/\/+$/, '') + path.slice(cut) || '/'
}

/** The command's simple commands as word lists, split at ; & | ( ) and newlines outside quotes. */
function commands(command: string): string[][] {
  let tokens: string[]
  try {
    tokens = shlexTokens(command, SEPARATORS, ' \t\r')
  } catch {
    tokens = pySplit(command)
  }
  const out: string[][] = []
  let cur: string[] = []
  for (const t of tokens) {
    if (Array.from(t).every(c => SEPARATORS.includes(c))) {
      out.push(cur)
      cur = []
    } else {
      cur.push(t)
    }
  }
  return [...out, cur].filter(words => words.length > 0)
}

/** The command without heredoc bodies, except those on a line that runs a shell or interpreter. */
function dropHeredocs(command: string): string {
  return command.replace(HEREDOC, (whole: string, _quote: string, _delimiter: string, rest: string, at: number) => {
    const line = command.slice(at === 0 ? 0 : command.lastIndexOf('\n', at - 1) + 1, at) + rest
    const isFed = commands(line)
      .map(executable)
      .some(run => run.length > 0 && SHELL_FED.test(basename(run[0] ?? '')))
    return isFed ? whole : rest
  })
}

/** The words of the command actually run, past assignments, keywords and the env / timeout / nice / command / exec launchers. */
function executable(words: string[]): string[] {
  while (words.length > 0) {
    const w = basename(words[0] ?? '')
    if (ASSIGN.test(words[0] ?? '') || ['!', '{', 'then', 'do', 'else', 'time', 'nohup'].includes(w)) {
      words = words.slice(1)
    } else if (w === 'env') {
      words = words.slice(1)
      while (words[0] !== undefined && (words[0].startsWith('-') || ASSIGN.test(words[0]))) {
        words = words.slice(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(words[0]) ? 2 : 1)
      }
    } else if (w === 'timeout') {
      words = words.slice(1)
      while (words[0]?.startsWith('-')) words = words.slice(['-s', '--signal', '-k', '--kill-after'].includes(words[0]) ? 2 : 1)
      words = words.slice(1) // the duration
    } else if (w === 'nice' || w === 'command' || w === 'exec') {
      words = words.slice(1)
      while (words[0]?.startsWith('-')) words = words.slice(words[0] === '-n' || words[0] === '-a' ? 2 : 1)
    } else {
      return words
    }
  }
  return words
}

/** Absolute paths the word may name: ~ and $HOME expanded, relative to each possible directory; none if unresolvable. */
async function resolve(io: MmIo, word: string, dirs: string[]): Promise<string[]> {
  const home = await expanduser(io, '~')
  const path = await expanduser(io, word.replace(HOME_VAR, () => home))
  if (path.includes('$') || path.includes('`')) return []
  if (isabs(path)) return [normpath(path)]
  return dirs.map(d => normpath(join(d, path)))
}

/** True when a *.raw operand resolves, against the cwd and any cd, into an mmruns run directory. */
async function namesRaw(io: MmIo, command: string, cwd: string | undefined): Promise<boolean> {
  const dirs = cwd ? [cwd] : []
  for (const words of commands(command)) {
    if (words[0] === 'cd' && words.length > 1 && words[1] !== '-') {
      dirs.push(...(await resolve(io, words[1] ?? '', dirs)))
      continue
    }
    for (const word of words) {
      for (const part of word.split(/[=<>]/)) {
        if (part.endsWith('.raw') && (await resolve(io, part, dirs)).some(p => RAW_PATH.test(p))) return true
      }
    }
  }
  return false
}

/** mmrun's session_key(); undefined where mmrun falls back to its own parent pid, which the guard cannot know. */
async function sessionKey(io: MmIo): Promise<string | undefined> {
  const k = (await io.env('MMRUN_SESSION')) || (await io.env('CLAUDE_CODE_HOST_SESSION_ID'))
  if (!k) return undefined
  // mmrun replaces each UTF-8 byte outside [A-Za-z0-9_.-] with _.
  let key = ''
  for (const c of k) {
    const cp = c.codePointAt(0) ?? 0
    key += /[A-Za-z0-9_.-]/.test(c) ? c : '_'.repeat(cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4)
  }
  return key.slice(0, 64)
}

/** The first waited run whose `watched` mark the mm plugin wrote in this session (a bare `watched`: any session);
 * RUNID parsed as mmrun's cmd_wait does. */
async function watchedRun(io: MmIo, waits: string[][], session: string | undefined): Promise<string | undefined> {
  const root = await expanduser(io, '~/.claude/mmruns')
  for (const run of waits) {
    let words = run.slice(2)
    // A redirection ends mmrun's own words: `2>&1` reaches here as `2>`, `> f` as `>` and `f`.
    const redirect = words.findIndex(w => w.includes('<') || w.includes('>'))
    words = words.slice(0, redirect < 0 ? words.length : redirect)
    let rid = ''
    while (words.length > 0) {
      if (words[0] === '--timeout') {
        words = words.slice(2)
      } else {
        rid = words[0] ?? ''
        words = words.slice(1)
      }
    }
    if (!rid) {
      const key = await sessionKey(io)
      if (key === undefined) continue
      const latest = await io.read(`${root}/.latest-${key}`)
      if (latest === undefined) continue
      rid = latest.trim()
    }
    const text = await io.read(`${root}/${rid}/watched`)
    if (text === undefined) continue
    const mark = text.split(/\s+/).filter(word => word !== '')
    if (mark[0] === 'watched' && (mark.length === 1 || mark[1] === session)) return rid
  }
  return undefined
}

export async function mmGuard(io: MmIo, call: MmCall): Promise<MmDecision> {
  const rawDeny = { deny: { guard: 'mm-raw', op: 'read *.raw', message: RAW_DENY } }
  if (call.tool === 'Read') return RAW_PATH.test(String(call.input.file_path ?? '')) ? rawDeny : undefined
  if (call.tool !== 'Bash') return undefined
  const command = String(call.input.command ?? '')
  const text = dropHeredocs(command)
  // Best effort: a word naming the mmruns tree and a *.raw, or a *.raw operand that resolves into a run directory.
  // A word with whitespace is quoted prose unless it holds a command substitution.
  const words = commands(text).flat()
  const isNamed = words.some(w => w.includes('mmruns') && /\.raw(?![\p{L}\p{N}_])/u.test(w) && (!/\s/.test(w) || w.includes('$(') || w.includes('`')))
  if (isNamed || (await namesRaw(io, text, call.cwd))) {
    const tail = BOUNDED_TAIL.exec(command)
    if (!tail || Number(tail[1] ?? tail[2]) > 50 || Number(tail[3] ?? 0) > 1000) return rawDeny
  }
  const waits = commands(text)
    .map(executable)
    .filter(run => run.length > 1 && basename(run[0] ?? '') === 'mmrun' && run[1] === 'wait')
  if (waits.length === 0) return undefined
  const rid = await watchedRun(io, waits, call.session)
  if (rid !== undefined && (await call.isMainThread())) {
    return { deny: { guard: 'mm-wait', op: 'mmrun wait', message: WAIT_DENY.replace('{}', rid) } }
  }
  const updated: Record<string, unknown> = { ...call.input, run_in_background: true }
  // Background Bash is stopped at its `timeout`: cover mmrun's own --timeout plus a minute.
  const asked = /--timeout\s+(\d+)/.exec(command)
  if (asked) {
    const need = Math.min((Number(asked[1]) + 60) * 1000, BASH_TIMEOUT_MAX_MS)
    const timeout = call.input.timeout ?? BASH_TIMEOUT_MS
    if (typeof timeout === 'number' && timeout < need) updated.timeout = need
  }
  const isChanged = call.input.run_in_background !== true || updated.timeout !== call.input.timeout
  return isChanged ? { updatedInput: updated } : undefined
}

function logFailure($: EngineInterface, event: string, error: HookFailure): void {
  $.ui.log(`mm: ${event} hook failed (${error.kind}): ${error.message ?? 'no message'}`, { to: 'debug' })
}

/** Whether the main thread made the call: its tool_use is in the main conversation while the call is decided. */
async function isMainThread($: EngineInterface, toolUseId: string): Promise<boolean> {
  return (await $.session.messages()).some(row => row.toolUses.some(use => use.tool_use_id === toolUseId))
}

/** The subagent that made the call, or null for the main thread or when no loop holds it. */
async function agentOf($: EngineInterface, toolUseId: string): Promise<string | null> {
  if (await isMainThread($, toolUseId)) return null
  for (const agent of await $.agent.list()) {
    const rows = await $.session.messages({ agentId: agent.id })
    if (Array.isArray(rows) && rows.some(row => row.toolUses.some(use => use.tool_use_id === toolUseId))) return agent.id
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

export const register: Register = on => {
  // classic.PreToolUse, never tool.call: a tool.call hook on Bash breaks isolation: worktree subagents (claude-code#92533).
  on('classic.PreToolUse', { tool: ['Bash', 'Read'] }, async ($, e, next) => {
    const { tool, tool_use_id: toolUseId, ...input } = e
    const io: MmIo = {
      env: name => (name === 'HOME' ? $.env.get('HOME') : name === 'MMRUN_SESSION' ? $.env.get('MMRUN_SESSION') : $.env.get('CLAUDE_CODE_HOST_SESSION_ID')),
      userHome: async name => {
        if (name !== '' && !USER_NAME.test(name)) return undefined
        const got = await $.process.run(['/bin/sh', '-c', `printf %s ~${name}`]).catch(() => undefined)
        return got?.exitCode === 0 && got.stdout.startsWith('/') ? got.stdout : undefined
      },
      read: path => $.fs.read(path).catch(() => undefined),
    }
    const cwd = await $.session.cwd()
    const decision = await mmGuard(io, { tool, input, cwd, session: await $.session.id().catch(() => undefined), isMainThread: () => isMainThread($, toolUseId) })
    if (decision === undefined) return next(e)
    if ('deny' in decision) {
      await logDeny($, decision.deny.guard, decision.deny.op, cwd, await agentOf($, toolUseId))
      return { deny: decision.deny.message }
    }
    // Hooks beneath see the call as the model made it; a rewrite of theirs keeps all but the fields this one changes.
    const below = await next(e)
    const changes = Object.fromEntries(Object.entries(decision.updatedInput).filter(([key, value]) => input[key as keyof typeof input] !== value))
    return { ...below, updatedInput: { ...input, ...below.updatedInput, ...changes } }
  }).catch(($, e, next) => {
    logFailure($, 'classic.PreToolUse', next.error)
    return next(e)
  })
}
