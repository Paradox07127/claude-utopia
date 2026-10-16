// In a repo's main worktree, refuse git commands that discard uncommitted changes, and git commit --amend.
// The main tree often has several writers (Claude sessions, foreground codex/grok); these commands take their changes away.
// Linked worktrees (worker's .claude/worktrees/*, mmrun's .mm-wt/*) are allowed.
// Shell is parsed as text: this guards against agent mistakes, not adversarial bypass. When the directory cannot be
// determined, or git cannot tell whether it is the main tree, dangerous operations are treated as being on the main tree.
import type { GuardIo } from './guard-io'
import { expanduser, isdir, exists, realpath } from './guard-io'
import { basename, isabs, join, normpath } from './posixpath'
import { pySplit, shlexJoin, shlexSplit, shlexTokens } from './shlex'

/** A directory that could not be determined. */
const UNKNOWN = Symbol('unknown directory')
type Dir = string | typeof UNKNOWN

// Word characters (\w) are Unicode letters, digits and _.
const QUOTED_HEREDOC = /<<-?\s*(['"])([\p{L}\p{N}_]+)\1[^\n]*\n.*?\n\s*\2\s*(?=\n|$)/gsu
const ANY_HEREDOC = /<<-?\s*(['"]?)([\p{L}\p{N}_]+)\1[^\n]*\n.*?\n\s*\2\s*(?=\n|$)/gsu
const GLOB = /[*?[]/
const VAR = /\$\{([\p{L}\p{N}_]+)(?::?-([^}]*))?\}|\$([\p{L}\p{N}_]+)/gu
const SEPARATORS = ';&|()\n'
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time', 'exec', 'nohup'])
const ASSIGN = /^([A-Za-z_][\p{L}\p{N}_]*)=(.*)$/su
const SHELL_C = /^-[a-zA-Z]*c[a-zA-Z]*$/
const REASON =
  'Blocked on the shared main worktree: `{op}` would take away uncommitted changes from other sessions or the user. ' +
  'Undo your own edit with a reverse Edit; for a clean baseline open a temporary worktree. Linked worktrees are exempt.'
const AMEND = "Blocked on the shared main worktree: `{op}` would rewrite a commit already on the main tree's branch. Make a new commit instead. Linked worktrees are exempt."
const UNVERIFIED =
  'Blocked: `{op}` would take away uncommitted changes if this is the shared main worktree, and git could not tell ' +
  '(git missing, timed out or failed). Make sure `git rev-parse --git-common-dir` works in that directory, ' +
  'or run the command in a linked worktree.'
// Short options that take a value, and long ones that may take it as the next word, per subcommand
const VALUED: Record<string, [string, string[]]> = {
  checkout: ['bB', ['--orphan', '--conflict']],
  restore: ['s', ['--source']],
  clean: ['e', ['--exclude']],
  switch: ['cC', ['--create', '--force-create', '--orphan', '--conflict']],
}
// Git ignores an alias named like a builtin, so these are never looked up as aliases
const BUILTINS = new Set(
  ('add am apply archive bisect blame branch cat-file checkout cherry-pick clean clone commit config describe diff fetch ' +
    'for-each-ref format-patch gc grep help init log ls-files ls-remote ls-tree merge merge-base mv notes pull push range-diff ' +
    'rebase reflog remote reset restore rev-list rev-parse revert rm shortlog show show-ref stash status submodule switch ' +
    'symbolic-ref tag version worktree').split(' '),
)
const ALIAS_DEPTH = 5
// One check's git calls share GIT_BUDGET_MS, each cut at GIT_CALL_MS, so a hung git holds the tool call 7 s at most.
const GIT_BUDGET_MS = 7_000
const GIT_CALL_MS = 5_000

type Git = { exitCode: number; stdout: string; stderr: string }

/** One guard call: its I/O, the deadline its git calls share, and the dangerous ops git could not place. */
type Run = { io: GuardIo; deadline: number; unchecked: string[] }

/** The shell's variables: values the command set or unset, the host's environment beneath. */
class Env {
  private readonly io: GuardIo
  private readonly own: Map<string, string | null>

  constructor(io: GuardIo, own = new Map<string, string | null>()) {
    this.io = io
    this.own = own
  }

  copy(): Env {
    return new Env(this.io, new Map(this.own))
  }

  async get(name: string): Promise<string | undefined> {
    const value = this.own.get(name)
    return value === null ? undefined : (value ?? (await this.io.env(name)))
  }

  set(name: string, value: string): void {
    this.own.set(name, value)
  }

  unset(name: string): void {
    this.own.set(name, null)
  }
}

const uniq = <T>(items: Iterable<T>): T[] => [...new Set(items)]
const first = (pattern: RegExp, text: string) => pattern.exec(text)

/** git in target; the repository is found from target alone unless `env` sets GIT_DIR / GIT_WORK_TREE. */
async function git(run: Run, target: string, args: string[], env: Record<string, string> = {}): Promise<Git | undefined> {
  const left = run.deadline - (await run.io.now())
  if (left <= 0) return undefined
  return run.io.run(['git', '-C', target, ...args], { env: { ...env, LC_ALL: 'C' }, timeoutMs: Math.min(GIT_CALL_MS, left) })
}

/** true / false, or undefined when git could not answer (missing, timed out, failed). */
async function isMainTree(run: Run, path: string): Promise<boolean | undefined> {
  const out = await git(run, path, ['rev-parse', '--absolute-git-dir', '--git-common-dir'])
  if (out === undefined) return undefined
  if (out.exitCode !== 0) return out.stderr.includes('not a git repository') ? false : undefined
  const lines = out.stdout.split('\n')
  if (lines.length < 2 || !lines[0] || !lines[1]) return undefined
  return (await realpath(run.io, lines[0])) === (await realpath(run.io, join(path, lines[1])))
}

/** Letters of short option clusters before `--`; a letter that takes a value ends its cluster (or takes the next word). */
function shortFlags(args: string[], sub = ''): Set<string> {
  const [short, long] = VALUED[sub] ?? ['', []]
  const flags = new Set<string>()
  let skip = false
  for (const a of args) {
    if (skip) {
      skip = false
    } else if (a === '--') {
      break
    } else if (long.includes(a)) {
      skip = true
    } else if (a.startsWith('-') && !a.startsWith('--')) {
      const letters = Array.from(a).slice(1)
      for (const [k, c] of letters.entries()) {
        flags.add(c)
        if (short.includes(c)) {
          skip = k === letters.length - 1
          break
        }
      }
    }
  }
  return flags
}

async function checkoutOp(run: Run, rest: string[], target: Dir, probe: Dir): Promise<string | undefined> {
  const flags = shortFlags(rest, 'checkout')
  if (rest.includes('--force') || flags.has('f')) return 'git checkout --force'
  if (rest.includes('--') || rest.some(a => ['--ours', '--theirs', '--patch', '-p'].includes(a) || a.startsWith('--pathspec-from-file'))) {
    return 'git checkout <path>'
  }
  if (flags.has('b') || flags.has('B') || rest.includes('--orphan')) return undefined
  const positional: string[] = []
  let skip = false
  for (const a of rest) {
    if (skip) skip = false
    else if (a === '--conflict' || a === '--track') skip = true
    else if (!a.startsWith('-')) positional.push(a)
  }
  const [name] = positional
  if (positional.length >= 2 || positional.includes('.') || (name !== undefined && GLOB.test(name))) return 'git checkout <path>'
  if (name === undefined) return undefined
  if (target === UNKNOWN) {
    // Directory unknown: refs are shared by a repo's worktrees, so a ref that resolves in probe is a branch switch, else a file restore
    const ref = probe === UNKNOWN ? undefined : await git(run, probe, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`])
    return ref?.exitCode === 0 ? undefined : 'git checkout <path>'
  }
  const ref = await git(run, target, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`])
  if (ref?.exitCode !== 0) {
    // Not a commit: a path on disk or a deleted tracked file, both mean a file restore
    const tracked = await git(run, target, ['ls-files', '--error-unmatch', '--', name])
    if ((await exists(run.io, join(target, name))) || tracked?.exitCode === 0) return 'git checkout <path>'
  }
  return undefined
}

async function dangerous(run: Run, sub: string, rest: string[], target: Dir, probe: Dir): Promise<string | undefined> {
  if (rest.includes('-h') || rest.includes('--help')) return undefined
  const flags = shortFlags(rest, sub)
  if (sub === 'checkout') return checkoutOp(run, rest, target, probe)
  if (sub === 'restore') {
    const staged = rest.includes('--staged') || flags.has('S')
    const worktree = rest.includes('--worktree') || flags.has('W')
    return staged && !worktree ? undefined : 'git restore'
  }
  if (sub === 'stash' && !['list', 'show', 'create'].includes(rest[0] ?? '')) return 'git stash'
  if (sub === 'clean' && !(rest.includes('--dry-run') || flags.has('n'))) return 'git clean'
  if (sub === 'switch' && (rest.includes('--discard-changes') || rest.includes('--force') || flags.has('f'))) return 'git switch --discard-changes'
  if (sub === 'reset' && rest.includes('--hard')) return 'git reset --hard'
  if (sub === 'commit' && rest.includes('--amend')) return 'git commit --amend'
  return undefined
}

async function expand(io: GuardIo, word: string, env: Env, cwd: Dir): Promise<Dir> {
  if (word.includes('`') || word.includes('$(')) return UNKNOWN
  // $X, ${X}, ${X:-default}, ${X-default}; other ${...} forms leave a $ and count as unknown
  let replaced = ''
  let from = 0
  for (const m of word.matchAll(VAR)) {
    const value = await env.get(m[1] ?? m[3] ?? '')
    replaced += word.slice(from, m.index) + (m[2] !== undefined && !value ? m[2] : (value ?? '$?'))
    from = m.index + m[0].length
  }
  const path = await expanduser(io, replaced + word.slice(from))
  if (path.includes('$')) return UNKNOWN
  if (isabs(path)) return normpath(path)
  return cwd === UNKNOWN ? UNKNOWN : normpath(join(cwd, path))
}

/** Contents of $(...) and `...` outside single quotes (single-quoted text is literal; the shell does not run it). */
function substitutions(text: string): string[] {
  const chars = Array.from(text)
  const out: string[] = []
  let quote = ''
  let i = 0
  while (i < chars.length) {
    const c = chars[i]
    if (c === '\\' && quote !== "'") {
      i += 2
      continue
    }
    if (c === "'" && quote !== '"') {
      quote = quote === "'" ? '' : "'"
    } else if (c === '"' && quote !== "'") {
      quote = quote === '"' ? '' : '"'
    } else if (quote !== "'" && c === '$' && chars[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      while (j < chars.length && depth > 0) {
        depth += chars[j] === '(' ? 1 : chars[j] === ')' ? -1 : 0
        j += 1
      }
      out.push(chars.slice(i + 2, j - 1).join(''))
      i = j
      continue
    } else if (quote !== "'" && c === '`') {
      const found = chars.indexOf('`', i + 1)
      const j = found < 0 ? chars.length : found
      out.push(chars.slice(i + 1, j).join(''))
      i = j + 1
      continue
    }
    i += 1
  }
  return out
}

/** Strip from a word-initial # outside quotes to end of line (the newline stays: it separates commands). */
function stripComments(text: string): string {
  const chars = Array.from(text)
  let out = ''
  let quote = ''
  let i = 0
  while (i < chars.length) {
    const c = chars[i] ?? ''
    if (c === '\\' && quote !== "'") {
      out += chars.slice(i, i + 2).join('')
      i += 2
      continue
    }
    if ((c === "'" || c === '"') && (quote === '' || quote === c)) {
      quote = quote === '' ? c : ''
    } else if (c === '#' && quote === '' && (i === 0 || ' \t\n;&|('.includes(chars[i - 1] ?? ''))) {
      const j = chars.indexOf('\n', i)
      i = j < 0 ? chars.length : j
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** The command text as [(preceding separator, words)] plus the $(...) contents to check separately.
 * A quoted heredoc body is literal; an unquoted body is not run, but $(...) inside it is expanded. */
function commands(command: string): { cmds: [string, string[]][]; extra: string[] } {
  let text = stripComments(command.replace(QUOTED_HEREDOC, ''))
  const extra = substitutions(text)
  text = text.replace(ANY_HEREDOC, '').replaceAll('\\\n', ' ')
  let tokens: string[]
  try {
    tokens = shlexTokens(text, ';&|()\n', ' \t\r')
  } catch {
    tokens = pySplit(text)
  }
  const cmds: [string, string[]][] = []
  let cur: string[] = []
  let sep = ''
  for (const t of tokens) {
    if (Array.from(t).every(c => SEPARATORS.includes(c))) {
      if (cur.length > 0) cmds.push([sep, cur])
      cur = []
      sep = t
    } else {
      cur.push(t)
    }
  }
  if (cur.length > 0) cmds.push([sep, cur])
  return { cmds, extra }
}

/** The words of the command actually run, and the directory from env -C or undefined. */
function stripWrappers(words: string[], env: Env): [string[], string | undefined] {
  let chdir: string | undefined
  while (words.length > 0) {
    const w = basename(words[0] ?? '')
    if (KEYWORDS.has(w)) {
      words = words.slice(1)
    } else if (w === 'sudo' || w === 'command' || w === 'nice') {
      const takesArg = w === 'sudo' ? ['-u', '-g', '-p', '-C', '-D', '-h', '-U', '-r', '-t'] : w === 'nice' ? ['-n'] : []
      words = words.slice(1)
      while (words[0]?.startsWith('-')) words = words.slice(takesArg.includes(words[0]) ? 2 : 1)
    } else if (w === 'env') {
      words = words.slice(1)
      while (words[0] !== undefined && (words[0].startsWith('-') || ASSIGN.test(words[0]))) {
        const [opt, value] = words
        const assign = first(ASSIGN, opt)
        if (assign) {
          env.set(assign[1] ?? '', assign[2] ?? '')
        } else if ((opt === '-u' || opt === '--unset') && value !== undefined) {
          env.unset(value)
          words = words.slice(1)
        } else if ((opt === '-C' || opt === '--chdir') && value !== undefined) {
          chdir = value
          words = words.slice(1)
        } else if (opt.startsWith('--chdir=')) {
          chdir = opt.slice('--chdir='.length)
        }
        words = words.slice(1)
      }
    } else {
      return [words, chdir]
    }
  }
  return [words, chdir]
}

/** The dangerous op that `git <args>` run from base would do on the main tree, or undefined. Aliases are expanded first. */
async function gitOp(run: Run, args: string[], local: Env, base: Dir, probe: Dir, depth: number): Promise<string | undefined> {
  let rundir = base
  let worktree: Dir | undefined
  let gitdir: string | undefined
  let target: Dir = base
  const aliases = new Map<string, string>()
  let isResolved = false
  for (let round = 0; round < ALIAS_DEPTH; round += 1) {
    // git runs in the -C directory, but an explicit work tree (--work-tree / GIT_WORK_TREE) takes precedence
    while (args[0]?.startsWith('-')) {
      const [opt, value] = args
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(opt) && value !== undefined) {
        if (opt === '-C') {
          rundir = await expand(run.io, value, local, rundir)
        } else if (opt === '-c' && value.toLowerCase().startsWith('alias.') && value.includes('=')) {
          const cut = value.indexOf('=')
          aliases.set(value.slice('alias.'.length, cut).toLowerCase(), value.slice(cut + 1))
        } else if (opt === '--work-tree') {
          worktree = value
        } else if (opt === '--git-dir') {
          gitdir = value
          worktree = worktree || UNKNOWN
        }
        args = args.slice(2)
      } else {
        if (opt.startsWith('-C') && opt.length > 2) {
          rundir = await expand(run.io, opt.slice(2), local, rundir)
        } else if (opt.startsWith('--work-tree=')) {
          worktree = opt.slice(opt.indexOf('=') + 1)
        } else if (opt.startsWith('--git-dir=')) {
          gitdir = opt.slice(opt.indexOf('=') + 1)
          worktree = worktree || UNKNOWN
        }
        args = args.slice(1)
      }
    }
    let tree = worktree
    const envTree = await local.get('GIT_WORK_TREE')
    if (tree === undefined && envTree !== undefined) tree = envTree
    else if (tree === undefined && (await local.get('GIT_DIR')) !== undefined) tree = UNKNOWN
    target = tree === undefined ? rundir : tree === UNKNOWN ? UNKNOWN : await expand(run.io, tree, local, rundir)
    const [sub] = args
    if (sub === undefined) return undefined
    let alias = BUILTINS.has(sub) ? undefined : aliases.get(sub.toLowerCase())
    if (alias === undefined && !BUILTINS.has(sub)) {
      const repo: Record<string, string> = {}
      for (const name of ['GIT_DIR', 'GIT_WORK_TREE']) {
        const value = await local.get(name)
        if (value !== undefined) repo[name] = value
      }
      if (gitdir !== undefined) repo.GIT_DIR = gitdir
      if (typeof worktree === 'string') repo.GIT_WORK_TREE = worktree
      const got = await git(run, rundir === UNKNOWN ? '/' : rundir, ['config', '--get', `alias.${sub}`], repo)
      alias = got?.exitCode === 0 ? got.stdout.trim() : undefined
    }
    if (alias === undefined) {
      isResolved = true
      break
    }
    if (alias.startsWith('!')) {
      // A shell alias runs from the top of the work tree with the remaining words appended
      return depth < 3 ? check(run, `${alias.slice(1)} ${shlexJoin(args.slice(1))}`, target, depth + 1) : undefined
    }
    try {
      args = [...shlexSplit(alias), ...args.slice(1)]
    } catch {
      return undefined
    }
  }
  if (!isResolved) return undefined
  const op = await dangerous(run, args[0] ?? '', args.slice(1), target, probe)
  if (op !== undefined && target !== UNKNOWN) {
    const onMain = await isMainTree(run, target)
    if (onMain === undefined) run.unchecked.push(op)
    else if (!onMain) return undefined
  }
  return op
}

async function check(run: Run, command: string, cwd: Dir, depth = 0): Promise<string | undefined> {
  // heres: where the next command may run if it continues the && chain; maybe: where it may run once the chain breaks
  let env = new Env(run.io)
  let heres: Dir[] = [cwd]
  let maybe: Dir[] | undefined
  let prev: Dir[] = [UNKNOWN]
  const outer: Dir[][] = []
  const visited: Dir[] = [cwd]
  const { cmds, extra } = commands(command)
  for (const [i, [sep, cmdWords]] of cmds.entries()) {
    let words = cmdWords
    if (maybe !== undefined && sep !== '&&') {
      heres = maybe
      maybe = undefined
    }
    // Parentheses are a subshell: a cd inside stops applying after the closing paren
    for (const c of sep) {
      if (c === '(') outer.push(heres)
      else if (c === ')' && outer.length > 0) heres = outer.pop() ?? heres
    }
    const local = env.copy()
    for (let assign = first(ASSIGN, words[0] ?? ''); words.length > 0 && assign; assign = first(ASSIGN, words[0] ?? '')) {
      local.set(assign[1] ?? '', assign[2] ?? '')
      words = words.slice(1)
    }
    if (words.length === 0) {
      env = local
      continue
    }
    let chdir: string | undefined
    ;[words, chdir] = stripWrappers(words, local)
    const bases: Dir[] = []
    for (const here of heres) bases.push(chdir === undefined ? here : await expand(run.io, chdir, local, here))
    const dirs = uniq(bases)
    if (words.length === 0) continue
    const nextSep = cmds[i + 1]?.[0] ?? ''
    const [cmd = '', ...rest] = words
    if (cmd === 'export') {
      for (const w of rest) {
        const assign = first(ASSIGN, w)
        if (assign) env.set(assign[1] ?? '', assign[2] ?? '')
      }
      continue
    }
    if (cmd === 'unset') {
      for (const w of rest) env.unset(w)
      continue
    }
    if (cmd === 'cd') {
      const args = rest.filter(a => a !== '-L' && a !== '-P' && a !== '--')
      let dests: Dir[] = []
      if (args.length === 1 && args[0] === '-') dests = prev
      else if (args[0] !== undefined) for (const h of heres) dests.push(await expand(run.io, args[0], local, h))
      else dests = [await expanduser(run.io, '~')]
      // A cd in a pipeline runs in a subshell and does not affect later commands
      if ((sep + nextSep).includes('|') && !(sep + nextSep).includes('||')) continue
      const kept: Dir[] = []
      for (const d of dests) if (d === UNKNOWN || (await isdir(run.io, d))) kept.push(d)
      dests = uniq(kept)
      if (dests.length > 0) {
        // A cd after && or || may not run: after ||, or once a following && chain breaks, the old directory stays possible
        if (sep.includes('||')) {
          ;[heres, prev] = [uniq([...(maybe ?? []), ...heres, ...dests]), heres]
          maybe = undefined
        } else if (sep.includes('&&')) {
          ;[maybe, heres, prev] = [uniq([...(maybe !== undefined && maybe.length > 0 ? maybe : heres), ...dests]), dests, heres]
        } else {
          ;[heres, prev] = [dests, heres]
        }
        visited.push(...heres, ...(maybe ?? []))
      }
      continue
    }
    // Commands that launch others: the bash -c string is checked on its own; xargs / find -exec yield the command after them
    const name = basename(cmd)
    const cflag = words.slice(1, -1).findIndex(a => SHELL_C.test(a)) + 1
    if (['bash', 'sh', 'zsh'].includes(name) && cflag > 0) {
      for (const base of dirs) {
        const op = depth < 3 ? await check(run, words[cflag + 1] ?? '', base, depth + 1) : undefined
        if (op !== undefined) return op
      }
      continue
    }
    if (name === 'xargs') {
      words = words.slice(1)
      while (words[0]?.startsWith('-')) words = words.slice(['-I', '-n', '-P', '-L', '-s', '-d', '-E'].includes(words[0]) ? 2 : 1)
    } else if (name === 'find') {
      const start = words.findIndex(a => ['-exec', '-execdir', '-ok', '-okdir'].includes(a))
      words = start < 0 ? [] : words.slice(start + 1)
    }
    if (words.length === 0 || basename(words[0] ?? '') !== 'git') continue
    for (const base of dirs) {
      const op = await gitOp(run, words.slice(1), local, base, cwd, depth)
      if (op !== undefined) return op
    }
  }
  if (depth < 3) {
    // Which command a substitution sits in is not tracked, so check it in every directory the command visited
    for (const inner of extra) {
      for (const d of uniq(visited)) {
        const op = await check(run, inner, d, depth + 1)
        if (op !== undefined) return op
      }
    }
  }
  return undefined
}

/** The reason to refuse `command` run in cwd, the op it would do, or undefined to let it run. */
export async function sharedTreeGit(io: GuardIo, command: string, cwd: string): Promise<{ op: string; reason: string } | undefined> {
  const run: Run = { io, deadline: (await io.now()) + GIT_BUDGET_MS, unchecked: [] }
  const op = await check(run, command, cwd)
  if (op === undefined) return undefined
  const template = run.unchecked.length > 0 ? UNVERIFIED : op === 'git commit --amend' ? AMEND : REASON
  return { op, reason: template.replace('{op}', op) }
}
