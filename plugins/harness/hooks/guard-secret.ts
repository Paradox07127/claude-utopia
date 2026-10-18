// Refuse tool calls that would put the contents of API-key config files into the transcript (Read / Edit results,
// Grep content, shell output such as cat, jq, diff or an environment dump).
// Shell is parsed as text: this guards against agent mistakes, not adversarial bypass.
import type { GuardIo } from './guard-io'
import { exists, expanduser, realpath } from './guard-io'
import { basename, dirname, join, normpath, split } from './posixpath'
import { pySplit, shlexSplit } from './shlex'

// Relative to HOME; `*` also crosses `/`
const HOME_SECRETS = [
  '.claude.json', '.claude.json.*', '.claude/backups/*', '.claude/settings.json', '.claude/settings.json.*',
  '.claude/settings.local.json', '.codex/config.toml', '.codex/config.toml.*', '.codex/auth.json',
  '.openviking/*', '.grok/auth.json', '.claude/file-history/*', '.codex/shell_snapshots/*',
]
const SECRET_NAMES = ['ovcli.conf', 'ov.conf'] // matched anywhere: the server side is reached over ssh
// Word characters (\w) are Unicode letters, digits and _.
const MENTION = new RegExp(
  String.raw`\.claude\.json|\.claude/settings\.json|\.claude/settings\.local\.json|\.claude/backups` +
    String.raw`|\.claude/file-history|\.codex/shell_snapshots|\.codex/config\.toml|\.codex/auth\.json|\.openviking(?:/|(?![\p{L}\p{N}_.\-]))|\.grok/auth\.json` +
    String.raw`|(?<![\p{L}\p{N}_.\-])(?:ovcli|ov)\.conf(?![\p{L}\p{N}_.\-])`,
  'iu',
)
const SPLIT = /&&|\|\||\$\(|[;&|()\n`]/y
// Options whose value is the next word (rg --help, man grep); rg -r is --replace, grep -r is --recursive
const VALUE_OPTIONS = {
  rg: {
    short: 'ABCdEefgjMmrTt',
    long: [
      '--after-context', '--before-context', '--context', '--max-depth', '--encoding', '--regexp', '--file', '--glob', '--threads', '--max-columns',
      '--max-count', '--replace', '--type-not', '--type', '--pre', '--pre-glob', '--dfa-size-limit', '--engine', '--regex-size-limit', '--iglob',
      '--ignore-file', '--max-filesize', '--type-add', '--type-clear', '--color', '--colors', '--context-separator', '--field-context-separator',
      '--field-match-separator', '--hostname-bin', '--hyperlink-format', '--path-separator', '--sort', '--sortr', '--generate',
    ],
  },
  grep: {
    short: 'ABCDdefm',
    long: [
      '--after-context', '--before-context', '--context', '--devices', '--directories', '--regexp', '--file', '--max-count', '--exclude', '--exclude-dir',
      '--include', '--include-dir', '--label', '--binary-files',
    ],
  },
}
const HEREDOC = /<<-?\s*(['"]?)([\p{L}\p{N}_]+)\1([^\n]*)\n(.*?)\n\s*\2\s*(?=\n|$)/gsu
const SHELL_FED = /^(?:(?:ba|z|da|k)?sh|python[\p{Nd}.]*|node|ruby|perl|osascript)$/u
const SHELLS = /^(?:ba|z|da|k)?sh$/
const MESSAGE_FLAGS = ['-m', '--message', '-t', '--title', '-b', '--body'] // gh / git: the next word is text, not a file
const WRAPPERS = ['sudo', 'command', 'time', 'nohup']
const ASSIGN = /^[A-Za-z_][\p{L}\p{N}_]*=/u
const METADATA = ['ls', 'stat', 'test', '[', 'chmod', 'chown', 'touch', 'wc', 'du', 'file', 'echo', 'printf']
const QUIET_LONG = ['--files-with-matches', '--files-without-match', '--count', '--quiet']
const SECRET_VAR = /KEY|TOKEN|SECRET|PASSWORD/iu
const REASON =
  'Blocked: `{call}` would put the contents of {file} into the transcript. That file holds API keys, and whatever ' +
  'this call reads or prints is saved in the transcript. Ask the user to look at or change it; to check it, use ' +
  'metadata only (ls, stat, wc, grep -c / grep -l); to find where the file name is mentioned in other files, ' +
  'use grep -l or rg -l in Bash.'
const ENV_REASON =
  'Blocked: `{call}` would print environment variables into the transcript, and some of them hold API keys or ' +
  'tokens that would be saved there. Print one named variable that is not a secret instead (printenv HOME).'

type Found = { reason: string; call: string; file: string | undefined }
type Tool = { tool: string; command?: unknown; file_path?: unknown; path?: unknown; output_mode?: unknown; glob?: unknown }
/** One guard call: its I/O, the home directory as written, and `homes` (as written and resolved) lowercased. */
type Run = { io: GuardIo; home: string; homes: string[] }

/** fnmatch.translate: a shell pattern as an anchored regex source, `*` crossing `/`. */
function translate(pattern: string): string {
  const pat = Array.from(pattern)
  const n = pat.length
  let out = ''
  let i = 0
  let isStar = false
  while (i < n) {
    const c = pat[i] ?? ''
    i += 1
    if (c === '*' && isStar) continue
    isStar = c === '*'
    if (c === '*') {
      out += '.*'
    } else if (c === '?') {
      out += '.'
    } else if (c === '[') {
      let j = i
      if (pat[j] === '!') j += 1
      if (pat[j] === ']') j += 1
      while (j < n && pat[j] !== ']') j += 1
      if (j >= n) {
        out += '\\['
        continue
      }
      let stuff: string
      if (!pat.slice(i, j).includes('-')) {
        stuff = pat.slice(i, j).join('').replaceAll('\\', '\\\\')
      } else {
        // Ranges: a reversed one (z-a) is dropped, as fnmatch does.
        const chunks: string[] = []
        let k = pat[i] === '!' ? i + 2 : i + 1
        for (;;) {
          k = pat.slice(0, j).indexOf('-', k)
          if (k < 0) break
          chunks.push(pat.slice(i, k).join(''))
          i = k + 1
          k += 3
        }
        const chunk = pat.slice(i, j).join('')
        if (chunk !== '') chunks.push(chunk)
        else chunks[chunks.length - 1] += '-'
        for (let m = chunks.length - 1; m > 0; m -= 1) {
          const left = chunks[m - 1] ?? ''
          const right = chunks[m] ?? ''
          if (left.slice(-1) > right.slice(0, 1)) {
            chunks[m - 1] = left.slice(0, -1) + right.slice(1)
            chunks.splice(m, 1)
          }
        }
        stuff = chunks.map(s => s.replaceAll('\\', '\\\\').replaceAll('-', '\\-')).join('-')
      }
      i = j + 1
      if (stuff === '') {
        out += '(?!)'
      } else if (stuff === '!') {
        out += '.'
      } else {
        if (stuff.startsWith('!')) stuff = `^${stuff.slice(1)}`
        else if (stuff.startsWith('^') || stuff.startsWith('[')) stuff = `\\${stuff}`
        // A ] first in the set is literal to fnmatch; JavaScript reads [] as an empty set.
        stuff = stuff.replace(/^(\^?)\]/, '$1\\]')
        out += `[${stuff}]`
      }
    } else {
      out += c.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
    }
  }
  return `^(?:${out})$`
}

const compiled = new Map<string, RegExp>()

function fnmatch(name: string, pattern: string): boolean {
  let rx = compiled.get(pattern)
  if (rx === undefined) {
    rx = new RegExp(translate(pattern), 's')
    compiled.set(pattern, rx)
  }
  return rx.test(name)
}

const hasMagic = (path: string) => /[*?[]/.test(path)

/** glob.glob of an absolute pattern: hidden names only for a pattern part that starts with a dot. */
async function glob(io: GuardIo, pathname: string, dirsOnly = false): Promise<string[]> {
  const [dir, name] = split(pathname)
  if (!hasMagic(pathname)) {
    if (name !== '') return (await io.stat(pathname)) !== undefined ? [pathname] : []
    return (await io.stat(dir))?.kind === 'dir' ? [pathname] : []
  }
  const dirs = dir !== pathname && hasMagic(dir) ? await glob(io, dir, true) : [dir]
  const out: string[] = []
  for (const d of dirs) {
    let names: string[]
    if (!hasMagic(name)) {
      names = name === '' ? ((await io.stat(d))?.kind === 'dir' ? [name] : []) : (await io.stat(join(d, name))) !== undefined ? [name] : []
    } else {
      names = []
      for (const entry of (await io.list(d)) ?? []) {
        if (dirsOnly && entry.kind !== 'dir' && (entry.kind !== 'other' || (await io.stat(join(d, entry.name)))?.kind !== 'dir')) continue
        if (entry.name.startsWith('.') && !name.startsWith('.')) continue
        if (fnmatch(entry.name, name)) names.push(entry.name)
      }
    }
    for (const found of names) out.push(join(d, found))
  }
  return out
}

/** The absolute path and its realpath, with ~, $HOME and ${HOME} expanded and relative paths taken from cwd. */
async function paths(run: Run, path: string, cwd: string): Promise<string[]> {
  const expanded = await expanduser(run.io, path.replace(/^\$(?:HOME|\{HOME\})(?=\/|\n?$)/, () => run.home))
  const full = normpath(join(cwd, expanded))
  return [...new Set([full, await realpath(run.io, full)])]
}

// Paths are compared lowercased: the default macOS volume is case-insensitive, so ~/.Codex/auth.json is the same file.
function isSecret(run: Run, path: string): boolean {
  path = path.toLowerCase()
  if (SECRET_NAMES.includes(basename(path))) return true
  return run.homes.some(h => path.startsWith(`${h}/`) && HOME_SECRETS.some(pat => fnmatch(path.slice(h.length + 1), pat)))
}

/** True when a home-anchored secret file lies under directory `path` at any depth. */
function holdsSecret(run: Run, path: string): boolean {
  const prefix = `${path.toLowerCase().replace(/\/+$/, '')}/`
  return run.homes.some(h => HOME_SECRETS.some(pat => `${dirname(join(h, pat))}/` === prefix || join(h, pat).startsWith(prefix)))
}

function envDump(words: string[]): boolean {
  const name = basename(words[0] ?? '')
  let args = words.slice(1)
  if (name === 'env') {
    while (args[0] !== undefined && (['-0', '--null', '-u'].includes(args[0]) || ASSIGN.test(args[0]))) args = args.slice(args[0] === '-u' ? 2 : 1)
    return args.length === 0
  }
  if (name === 'declare' || name === 'typeset') {
    // An empty word counts as an option.
    const isOption = (a: string) => a === '' || a.startsWith('-') || a.startsWith('+')
    const options = args.filter(isOption)
    // zsh `typeset NAME` and `-p NAME` print the value; `-x NAME` or an assignment NAME=V prints nothing
    const names = args.filter(a => !isOption(a) && !a.includes('='))
    return (
      (options.length === args.length && !options.some(o => o.includes('f') || o.includes('F'))) ||
      ((options.length === 0 || options.some(o => o.includes('p'))) && names.some(a => SECRET_VAR.test(a)))
    )
  }
  return (
    (name === 'printenv' && (args.length === 0 || args.some(a => SECRET_VAR.test(a)))) ||
    (name === 'export' && (args.length === 0 || (args.length === 1 && args[0] === '-p'))) ||
    (name === 'set' && args.length === 0)
  )
}

function printsSecretVar(segment: string, words: string[]): boolean {
  if (!['echo', 'printf'].includes(basename(words[0] ?? ''))) return false
  // $NAME inside single quotes is not expanded; double-quoted strings are kept whole so their ' is literal
  const text = segment.replace(/"(?:\\[^\n]|[^"\\])*"|'[^']*'/g, m => (m.startsWith('"') ? m : ''))
  // \$NAME is literal, \\$NAME is not; ${NAME:+text} and ${NAME+text} print only the text
  for (const m of text.matchAll(/(?<!\\)(?:\\\\)*\$(?:([A-Za-z_][\p{L}\p{N}_]*)|\{([A-Za-z_][\p{L}\p{N}_]*)(?![\p{L}\p{N}_]|:?\+))/gu)) {
    if (SECRET_VAR.test((m[1] ?? '') + (m[2] ?? ''))) return true
  }
  return false
}

function allowed(words: string[]): boolean {
  const name = basename(words[0] ?? '')
  if (METADATA.includes(name)) return true
  if (['grep', 'egrep', 'rg'].includes(name)) {
    const quiet = name === 'rg' ? 'lcq' : 'lLcq' // rg -L is --follow and still prints matching lines
    const short = new RegExp(`^-[A-Za-z]*[${quiet}][A-Za-z]*$`)
    return words.slice(1).some(a => QUIET_LONG.includes(a) || short.test(a))
  }
  if (name !== 'git' || words[1] !== 'commit') return false
  // -F reads the message from a file, so its path is checked like any other
  return !words.some((a, i) => i > 1 && !MESSAGE_FLAGS.includes(words[i - 1] ?? '') && (a === '--file' || a.startsWith('--file=') || a.startsWith('-F')))
}

/** The words of an rg or grep call past options and their values, and whether -e or -f gave the pattern. */
function operands(name: string, words: string[]): { operands: string[]; patternGiven: boolean } {
  const table = name === 'rg' ? VALUE_OPTIONS.rg : VALUE_OPTIONS.grep
  let patternGiven = false
  let skip = false
  const out: string[] = []
  for (const a of words.slice(1)) {
    if (skip) {
      skip = false
      continue
    }
    let option: string | undefined
    if (a.startsWith('--')) {
      const long = a.split('=')[0] ?? ''
      if (table.long.includes(long)) [option, skip] = [long, !a.includes('=')]
    } else if (/^-[A-Za-z0-9]+$/.test(a)) {
      // the first value-taking letter of a cluster takes the rest of the word, or the next word when it is last
      const at = Array.from(a).findIndex((ch, i) => i > 0 && table.short.includes(ch))
      if (at > 0) [option, skip] = [`-${a[at]}`, at === a.length - 1]
    }
    if (option !== undefined) patternGiven ||= ['-e', '-f', '--regexp', '--file'].includes(option)
    else if (!a.startsWith('-')) out.push(a)
  }
  return { operands: out, patternGiven }
}

/** True when rg, or grep with -r, gets no path operand and so searches the cwd. */
function searchesCwd(name: string, words: string[]): boolean {
  const args = words.slice(1)
  if (name !== 'rg' && !args.some(a => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(a) || ['--recursive', '--dereference-recursive'].includes(a))) return false
  const given = operands(name, words)
  return given.operands.length === (given.patternGiven ? 0 : 1)
}

/** The command cut at SPLIT outside quotes; inside double quotes only at $( and `, which still run there. */
function splitCommands(command: string): string[] {
  const out: string[] = []
  const open: string[] = [] // quotes and substitutions not yet closed: ' " $( ( `
  let start = 0
  let i = 0
  while (i < command.length) {
    const top = open.at(-1)
    const ch = command[i] ?? ''
    if (top === "'") {
      if (ch === "'") open.pop()
      i += 1
      continue
    }
    if (ch === '\\') {
      i += 2
      continue
    }
    if (top === '"') {
      if (ch === '"') open.pop()
      if (ch !== '`' && !command.startsWith('$(', i)) {
        i += 1
        continue
      }
    } else if (ch === "'" || ch === '"') {
      open.push(ch)
      i += 1
      continue
    } else if (ch === '#' && (i === 0 || /[\s;&|()`]/.test(command[i - 1] ?? ''))) {
      // a quote in a comment opens nothing
      const end = command.indexOf('\n', i)
      i = end < 0 ? command.length : end
      continue
    }
    SPLIT.lastIndex = i
    const token = SPLIT.exec(command)?.[0]
    if (token === undefined) {
      i += 1
      continue
    }
    if (token === '$(' || token === '(' || (token === '`' && top !== '`')) open.push(token)
    else if ((token === ')' && (top === '$(' || top === '(')) || (token === '`' && top === '`')) open.pop()
    out.push(command.slice(start, i))
    i += token.length
    start = i
  }
  out.push(command.slice(start))
  return out
}

/** [segment, words] per simple command, past assignments and wrappers. */
function simpleCommands(command: string): [string, string[]][] {
  const out: [string, string[]][] = []
  // The plain split cuts too much inside quotes, splitCommands too little past quotes like $'…'; refusing on both only refuses more
  for (const segment of new Set([...splitCommands(command), ...command.split(new RegExp(SPLIT.source))])) {
    let words: string[]
    try {
      words = shlexSplit(segment)
    } catch {
      words = pySplit(segment)
    }
    while (words[0] !== undefined && ASSIGN.test(words[0])) words = words.slice(1)
    while (words[0] !== undefined && WRAPPERS.includes(words[0])) {
      words = words.slice(1)
      while (words[0]?.startsWith('-')) words = words.slice(1)
    }
    if (words.length > 0) out.push([segment, words])
  }
  return out
}

/** The command without heredoc bodies that are only text: kept when fed to a program `readers` matches,
 * or when an unquoted delimiter lets the body run $( ) or backticks. */
function dropHeredocs(command: string, readers = SHELL_FED): string {
  return command.replace(HEREDOC, (whole: string, quote: string, _delimiter: string, rest: string, body: string, at: number) => {
    const line = command.slice(at === 0 ? 0 : command.lastIndexOf('\n', at - 1) + 1, at) + rest
    const isFed = simpleCommands(line).some(([, words]) => readers.test(basename(words[0] ?? '')))
    const expands = quote === '' && /\$\(|`/.test(body)
    return isFed || expands ? whole : rest
  })
}

async function checkBash(run: Run, command: string, cwd: string): Promise<Found | undefined> {
  // Code fed to python, node and the like is not shell: a word such as `set` there dumps nothing
  for (const [segment, words] of simpleCommands(dropHeredocs(command, SHELLS))) {
    if (envDump(words) || printsSecretVar(segment, words)) return { reason: ENV_REASON, call: segment.trim(), file: undefined }
  }
  let cwds = [cwd]
  for (const [segment, words] of simpleCommands(dropHeredocs(command))) {
    const name = basename(words[0] ?? '')
    const isMessage = name === 'gh' || name === 'git'
    if (name === 'cd' && words.length === 2) {
      // a cd inside ( ) leaves the outer cwd as it was
      const more: string[] = []
      for (const c of cwds) more.push(...(await paths(run, words[1] ?? '', c)))
      cwds = [...new Set([...cwds, ...more])]
    }
    const flag = SHELLS.test(name) ? words.findIndex((w, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w)) : -1
    const script = flag > 0 ? words[flag + 1] : undefined
    if (script !== undefined) {
      for (const c of cwds) {
        const found = await checkBash(run, script, c)
        if (found) return found
      }
    }
    let text = segment
    if (isMessage) {
      text = words.filter((w, i) => !(i > 0 && MESSAGE_FLAGS.includes(words[i - 1] ?? '')) && !/^--(?:message|title|body)=/.test(w)).join(' ')
    }
    const mention = MENTION.exec(text)
    if (mention && !allowed(words)) return { reason: REASON, call: segment.trim(), file: mention[0] }
    // A recursive search of a directory such as ~/.codex prints lines of the secret files inside it
    if (['grep', 'egrep', 'rg'].includes(name) && !allowed(words)) {
      let hit: string | undefined
      for (const a of operands(name, words).operands) {
        const found: string[] = []
        for (const c of cwds) found.push(...(await paths(run, a, c)))
        if (found.some(p => holdsSecret(run, p))) {
          hit = a
          break
        }
      }
      if (hit) return { reason: REASON, call: segment.trim(), file: `a file under ${hit}` }
      const held = searchesCwd(name, words) ? cwds.find(c => holdsSecret(run, c)) : undefined
      if (held) return { reason: REASON, call: segment.trim(), file: `a file under ${held}` }
    }
    if (!allowed(words)) {
      for (const [i, a] of words.entries()) {
        if (i === 0 || a.startsWith('-') || (isMessage && MESSAGE_FLAGS.includes(words[i - 1] ?? ''))) continue
        const found = new Set<string>()
        for (const c of cwds) for (const p of await paths(run, a, c)) found.add(p)
        if (/[*?[]/.test(a)) {
          for (const p of [...found]) for (const g of await glob(run.io, p)) for (const q of await paths(run, g, '/')) found.add(q)
        }
        if ([...found].some(p => isSecret(run, p))) return { reason: REASON, call: segment.trim(), file: a }
      }
    }
  }
  return undefined
}

async function find(run: Run, e: Tool, cwd: string): Promise<Found | undefined> {
  if (e.tool === 'Bash') return checkBash(run, String(e.command), cwd)
  if (e.tool === 'Read' || e.tool === 'Edit' || e.tool === 'Write') {
    const path = String(e.file_path)
    if ((await paths(run, path, cwd)).some(p => isSecret(run, p))) return { reason: REASON, call: `${e.tool} ${path}`, file: path }
  }
  if (e.tool === 'Grep' && e.output_mode === 'content') {
    const path = typeof e.path === 'string' && e.path !== '' ? e.path : '.'
    for (const p of await paths(run, path, cwd)) {
      let holds = isSecret(run, p) || holdsSecret(run, p)
      for (const name of SECRET_NAMES) holds ||= await exists(run.io, join(p, name))
      if (holds) return { reason: REASON, call: `Grep (output_mode content) in ${path}`, file: `a file under ${path}` }
    }
    const pattern = e.glob
    if (typeof pattern === 'string' && pattern !== '' && SECRET_NAMES.includes(pattern.replace(/^(?:\*\*\/)+/, '').toLowerCase())) {
      return { reason: REASON, call: `Grep (output_mode content) in ${path} with glob ${pattern}`, file: pattern }
    }
  }
  return undefined
}

/** The reason to refuse the call, the call as the log names it, and the rule and target the event ledger records; undefined to let it run. */
export async function secretFiles(
  io: GuardIo,
  e: Tool,
  cwd: string,
): Promise<{ op: string; reason: string; rule: 'env-dump' | 'secret-file'; target: string } | undefined> {
  const home = await expanduser(io, '~')
  const run: Run = { io, home, homes: [...new Set([home, await realpath(io, home)].map(h => h.toLowerCase()))] }
  const found = await find(run, e, cwd)
  if (found === undefined) return undefined
  const values: Record<string, string> = { call: found.call, file: String(found.file) }
  return {
    op: found.call,
    reason: found.reason.replace(/\{(call|file)\}/g, (_, key: string) => values[key] ?? ''),
    rule: found.reason === ENV_REASON ? 'env-dump' : 'secret-file',
    target: e.tool === 'Bash' ? found.call : String(found.file),
  }
}
