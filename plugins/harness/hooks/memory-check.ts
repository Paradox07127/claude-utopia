import type { Lang } from './i18n'

export type MemoryFile = { name: string; text: string }
/** One memory dir: MEMORY.md's text (null when absent) and its other .md files. */
export type MemoryDir = { index: string | null; files: MemoryFile[] }

export type Problem =
  | { kind: 'dangling'; file: string; target: string }
  | { kind: 'unlisted'; file: string }
  | { kind: 'duplicate'; file: string; name: string; other: string }
  | { kind: 'frontmatter'; file: string; missing: string[] }
  | { kind: 'path'; file: string; path: string }

const INDEX = 'MEMORY.md'
const REPORT_LINES = 40
const GROUPS: Problem['kind'][][] = [['dangling'], ['unlisted'], ['duplicate', 'frontmatter'], ['path']]
// Split on whitespace and on the punctuation that wraps a path in prose or markdown; a glob or brace list falls apart.
const WORD = /[^\s`'"()<>[\]{},;|*]+/g

/** How Claude Code names a project's folder under ~/.claude/projects: every other character than a letter or digit becomes `-`. */
export function encodePath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

/** The folder a project dir name stands for: walks down from `/` taking the entries whose encoded name fits; null when none does. */
export async function decodeProjectDir(encoded: string, list: (dir: string) => Promise<readonly string[]>): Promise<string | null> {
  const walk = async (dir: string, rest: string): Promise<string | null> => {
    for (const name of await list(dir)) {
      const code = encodePath(name)
      const path = `${dir === '/' ? '' : dir}/${name}`
      if (rest === code) return path
      if (rest.startsWith(`${code}-`)) {
        const found = await walk(path, rest.slice(code.length + 1))
        if (found !== null) return found
      }
    }
    return null
  }
  return encoded.startsWith('-') ? walk('/', encoded.slice(1)) : null
}

/** The main worktree named by a linked worktree's `.git` file, or null. */
export function mainTreeOf(gitFile: string): string | null {
  return /^gitdir:\s*(.+)\/\.git\/worktrees\/[^/\n]+\s*$/m.exec(gitFile)?.[1] ?? null
}

function splitFrontmatter(text: string): { fields: Map<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  const fields = new Map<string, string>()
  if (match === null) return { fields, body: text }
  for (const [, key, value] of (match[1] ?? '').matchAll(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/gm)) {
    fields.set(key as string, (value ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim())
  }
  return { fields, body: text.slice(match[0].length) }
}

function indexTargets(index: string): string[] {
  return [...index.matchAll(/\]\(([^)\s]+)\)/g)].map(m => m[1] as string).filter(target => !target.includes('://'))
}

/** The paths a body names, as written without a `:line` suffix: absolute with two or more parts, `~/…`, or relative with a slash and an extension. */
function mentionedPaths(body: string): string[] {
  const found = new Set<string>()
  // A code span holding an absolute or ~ path is one word, so a folder name may hold spaces.
  const quoted = [...body.matchAll(/`((?:\/|~\/)[^`\n]*)`/g)].map(m => m[1] as string)
  const rest = body.replace(/`(?:\/|~\/)[^`\n]*`/g, ' ')
  for (const word of [...quoted, ...(rest.match(WORD) ?? [])]) {
    // A URL, or a placeholder path such as `$HOME/x` or `<plugin>/<version>`.
    if (word.includes('://') || /[$<>]/.test(word)) continue
    const path = word.replace(/[.,:;!?]+$/, '').replace(/(?::\d+(?:-\d+)?)+$/, '').replace(/#.*$/, '')
    const isRelative = !/^[/~]/.test(path) && path.includes('/') && /\/[^/]*\w\.[A-Za-z0-9]+$/.test(`/${path}`)
    if (path.startsWith('~/') || /^\/[^/]+\/./.test(path) || isRelative) found.add(path)
  }
  return [...found]
}

function resolvePath(path: string, root: string | null, home: string): string | null {
  if (path.startsWith('~/')) return home + path.slice(1)
  if (path.startsWith('/')) return path
  return root === null ? null : `${root}/${path.replace(/^\.\//, '')}`
}

/** Every absolute path the memory bodies name; repo-relative ones only when `root` is known. */
export function pathsToCheck(dir: MemoryDir, root: string | null, home: string): string[] {
  const paths = dir.files.flatMap(file => mentionedPaths(splitFrontmatter(file.text).body).map(path => resolvePath(path, root, home)))
  return [...new Set(paths.filter((path): path is string => path !== null))]
}

/** The problems of one memory dir; `existing` holds those of `pathsToCheck` that exist. */
export function checkMemoryDir(dir: MemoryDir, existing: ReadonlySet<string>, root: string | null, home: string): Problem[] {
  const files = [...dir.files].sort((a, b) => a.name.localeCompare(b.name))
  const names = new Set(files.map(file => file.name))
  const targets = indexTargets(dir.index ?? '')
  const problems: Problem[] = targets.filter(target => !names.has(target)).map(target => ({ kind: 'dangling', file: INDEX, target }))
  problems.push(...files.filter(file => !targets.includes(file.name)).map(file => ({ kind: 'unlisted' as const, file: file.name })))
  const firstByName = new Map<string, string>()
  for (const file of files) {
    const { fields, body } = splitFrontmatter(file.text)
    const missing = ['name', 'description'].filter(key => (fields.get(key) ?? '') === '')
    if (missing.length > 0) problems.push({ kind: 'frontmatter', file: file.name, missing })
    const name = fields.get('name') ?? ''
    const other = firstByName.get(name)
    if (name !== '' && other !== undefined) problems.push({ kind: 'duplicate', file: file.name, name, other })
    else if (name !== '') firstByName.set(name, file.name)
    for (const path of mentionedPaths(body)) {
      const resolved = resolvePath(path, root, home)
      if (resolved !== null && !existing.has(resolved)) problems.push({ kind: 'path', file: file.name, path })
    }
  }
  return problems
}

const zh = {
  headings: {
    dangling: '索引指向不存在的文件',
    unlisted: 'MEMORY.md 没有列出的记忆文件',
    duplicate: 'frontmatter 重名或缺项',
    path: '提到的路径已不存在',
  } as Record<string, string>,
  problem: (p: Problem): string => {
    switch (p.kind) {
      case 'dangling': return `指向的 ${p.target} 不存在`
      case 'unlisted': return '没有列在 MEMORY.md 里'
      case 'duplicate': return `name「${p.name}」与 ${p.other} 重复`
      case 'frontmatter': return `frontmatter 缺少 ${p.missing.join('、')}`
      case 'path': return `${p.path} 不存在`
    }
  },
  more: (n: number) => `… 另有 ${n} 条`,
  total: (n: number, dirs: number) => `${dirs} 个记忆目录里共 ${n} 个问题`,
  clean: (dirs: number) => `${dirs} 个记忆目录没有发现问题`,
  noDir: (root: string) => `${root} 没有记忆目录`,
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const en: typeof zh = {
  headings: {
    dangling: 'Index links to missing files',
    unlisted: 'Memory files MEMORY.md does not list',
    duplicate: 'Duplicate or missing frontmatter',
    path: 'Paths that no longer exist',
  },
  problem: p => {
    switch (p.kind) {
      case 'dangling': return `links ${p.target}, which does not exist`
      case 'unlisted': return 'not listed in MEMORY.md'
      case 'duplicate': return `same name "${p.name}" as ${p.other}`
      case 'frontmatter': return `frontmatter lacks ${p.missing.join(', ')}`
      case 'path': return `${p.path} does not exist`
    }
  },
  more: n => `… ${n} more`,
  total: (n, dirs) => `${plural(n, 'problem', 'problems')} in ${plural(dirs, 'memory directory', 'memory directories')}`,
  clean: dirs => `No problems in ${plural(dirs, 'memory directory', 'memory directories')}`,
  noDir: root => `No memory directory for ${root}`,
}

export const strings: Record<Lang, typeof zh> = { 'zh-CN': zh, en }

/** The report grouped by check, cut at 40 lines, then the total; one line when nothing is wrong. */
export function formatReport(problems: readonly Problem[], dirCount: number, lang: Lang): string {
  const t = strings[lang]
  if (problems.length === 0) return t.clean(dirCount)
  const lines: { text: string; isProblem: boolean }[] = []
  for (const kinds of GROUPS) {
    const group = problems.filter(p => kinds.includes(p.kind))
    if (group.length === 0) continue
    lines.push({ text: t.headings[kinds[0] as string] as string, isProblem: false })
    lines.push(...group.map(p => ({ text: `${p.file}: ${t.problem(p)}`, isProblem: true })))
  }
  const kept = lines.slice(0, REPORT_LINES)
  const dropped = lines.slice(REPORT_LINES).filter(line => line.isProblem).length
  return [...kept.map(line => line.text), ...(dropped > 0 ? [t.more(dropped)] : []), t.total(problems.length, dirCount)].join('\n')
}
