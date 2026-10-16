import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

/** A repository the fake git answers for: its top, what rev-parse prints for it, and what it holds. */
export type Repo = { top: string; gitDir: string; commonDir: string; refs: string[]; tracked: string[] }

/** The host beneath the harness guards: files, links, repositories, the environment, and what the guards wrote. */
export type World = {
  /** '' makes $.session.cwd() reject. */
  cwd: string
  /** '' makes $.session.id() reject. */
  session: string
  env: Record<string, string>
  dirs: string[]
  files: string[]
  /** Symbolic link → its absolute target. */
  links: Record<string, string>
  repos: Repo[]
  /** git config aliases, shared by every repository here (a linked worktree reads its main tree's config). */
  aliases: Record<string, string>
  /** Home directories `~name` expands to. */
  users: Record<string, string>
  /** `hanging`: each git call runs 6 s, killed at its timeout. */
  git: 'ok' | 'missing' | 'failing' | 'hanging'
  now: number
  /** Off, neither the log nor $.fs.write can be written. */
  isLogWritable: boolean
  log: Record<string, unknown>[]
  /** Text of the files $.fs reads and writes (null: exists but unreadable). */
  texts: Record<string, string | null>
  debug: string[]
  /** tool_use ids of the main conversation; a call whose id is in `agents` came from that agent. */
  mainIds: string[]
  agents: Record<string, string[]>
}

const HANG_MS = 6_000

export function world(fields: Partial<World>): World {
  return {
    cwd: '/',
    session: 'sess-a',
    env: {},
    dirs: [],
    files: [],
    links: {},
    repos: [],
    aliases: {},
    users: {},
    git: 'ok',
    now: 1_000_000,
    isLogWritable: true,
    log: [],
    texts: {},
    debug: [],
    mainIds: [],
    agents: {},
    ...fields,
  }
}

/** The path with every link in it followed. */
function resolve(w: World, path: string): string {
  let out = ''
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    out = part === '..' ? out.slice(0, out.lastIndexOf('/')) : `${out}/${part}`
    const target = w.links[out]
    if (target !== undefined) out = resolve(w, target)
  }
  return out === '' ? '/' : out
}

const entries = (w: World) => [...w.dirs, ...w.files, ...Object.keys(w.links)]
const isDir = (w: World, real: string) => real === '/' || w.dirs.includes(real) || entries(w).some(p => p.startsWith(`${real}/`))
const isFile = (w: World, real: string) => w.files.includes(real)

function repoOf(w: World, dir: string): Repo | undefined {
  const real = resolve(w, dir)
  return w.repos.filter(r => real === r.top || real.startsWith(`${r.top}/`)).sort((a, b) => b.top.length - a.top.length)[0]
}

const done = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

function git(w: World, args: string[], timeoutMs: number) {
  if (w.git === 'missing') return { deny: 'spawn git ENOENT' }
  if (w.git === 'failing') return done('', 1)
  if (w.git === 'hanging') {
    w.now += Math.min(timeoutMs, HANG_MS)
    return timeoutMs < HANG_MS ? { deny: `git timed out after ${timeoutMs} ms` } : done()
  }
  const [dashC, dir = '', ...rest] = args
  if (dashC !== '-C') return { deny: `unexpected git ${args.join(' ')}` }
  const repo = repoOf(w, dir)
  if (repo === undefined) return done('', 128, 'fatal: not a git repository (or any of the parent directories): .git\n')
  const sub = rest.join(' ')
  if (sub === 'rev-parse --absolute-git-dir --git-common-dir') return done(`${repo.gitDir}\n${resolve(w, dir) === repo.top ? repo.commonDir : `${repo.top}/${repo.commonDir}`}\n`)
  if (sub === 'rev-parse --path-format=absolute --git-common-dir') return done(`${repo.commonDir.startsWith('/') ? repo.commonDir : `${repo.top}/${repo.commonDir}`}\n`)
  if (sub.startsWith('rev-parse --verify --quiet ')) return done('', repo.refs.includes((rest[3] ?? '').replace(/\^\{commit\}$/, '')) ? 0 : 1)
  if (sub.startsWith('ls-files --error-unmatch -- ')) return done('', repo.tracked.includes(rest[3] ?? '') ? 0 : 1)
  if (sub.startsWith('config --get alias.')) {
    const alias = w.aliases[(rest[2] ?? '').slice('alias.'.length).toLowerCase()]
    return alias === undefined ? done('', 1) : done(`${alias}\n`)
  }
  return { deny: `unexpected git ${args.join(' ')}` }
}

/** Answers the engine beneath the guards from `w`; a call no guard refused runs and answers `ran`. */
export function stage(on: On, w: World): void {
  on('session.cwd', () => (w.cwd === '' ? { deny: 'no working directory' } : { value: w.cwd }))
  on('session.id', () => (w.session === '' ? { deny: 'no session' } : { value: w.session }))
  on('clock.now', () => ({ value: w.now }))
  on('env.get', ($, e) => ({ value: w.env[e.name] }))
  on('ui.log', ($, e) => {
    w.debug.push(e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    const real = resolve(w, e.path)
    const kind = isDir(w, real) ? 'dir' : isFile(w, real) ? 'file' : undefined
    if (kind === undefined) return { deny: `ENOENT ${e.path}` }
    return { value: { kind, size: 0, mtimeMs: 0, isLink: w.links[e.path] !== undefined, realPath: real } }
  })
  on('fs.list', ($, e) => {
    const real = resolve(w, e.path)
    if (!isDir(w, real)) return { deny: `ENOENT ${e.path}` }
    const names = new Set(entries(w).filter(p => p.startsWith(`${real}/`)).map(p => p.slice(real.length + 1).split('/')[0] ?? ''))
    return {
      value: [...names].map(name => {
        const path = `${real}/${name}`
        const kind = w.links[path] !== undefined ? 'other' : isDir(w, path) ? 'dir' : 'file'
        return { name, kind, size: 0, mtimeMs: 0, isLink: w.links[path] !== undefined }
      }),
    }
  })
  on('fs.exists', ($, e) => ({ value: e.path in w.texts }))
  on('fs.read', ($, e) => {
    const text = w.texts[e.path]
    return typeof text === 'string' ? { value: text } : { deny: `${text === null ? 'EACCES' : 'ENOENT'} ${e.path}` }
  })
  on('fs.write', ($, e) => {
    if (!w.isLogWritable) return { deny: `ENOTDIR ${e.path}` }
    w.texts[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    let argv = [...e.argv]
    if (argv[0] === 'env' && argv[1] === '-0') return done(Object.entries(w.env).map(([k, v]) => `${k}=${v}\0`).join(''))
    if (argv[0] === 'env') {
      while (argv[1] === '-u') argv.splice(1, 2)
      argv = argv.slice(1)
    }
    if (argv[0] === 'git') return git(w, argv.slice(1), e.init?.timeoutMs ?? 30_000)
    const script = argv[0] === '/bin/sh' ? (argv[2] ?? '') : ''
    if (script.startsWith('printf %s ~')) {
      const name = script.slice('printf %s ~'.length)
      return done((name === '' ? w.env.HOME : w.users[name]) ?? `~${name}`)
    }
    if (script.includes('cat >>')) {
      if (!w.isLogWritable) return done('', 1, 'mkdir: not a directory\n')
      w.log.push(JSON.parse(e.init?.stdin ?? '{}') as Record<string, unknown>)
      return done()
    }
    return { deny: `no such command here: ${argv.join(' ')}` }
  })
  on('session.messages', ($, e) => {
    const ids = e.agentId === undefined ? w.mainIds : w.agents[e.agentId]
    if (ids === undefined) return { value: { deny: 'no such agent' } } as never
    return { value: [{ role: 'assistant', text: '', toolUses: ids.map(id => ({ tool_use_id: id, tool: 'Bash', input: {} })) }] } as never
  })
  on('agent.list', () => ({ value: Object.keys(w.agents).map(id => ({ id, description: 'x', type: 'worker', status: 'running' })) }) as never)
  on('tool.call', () => ({ result: { stdout: 'ran' }, text: 'ran' }) as never)
}

let calls = 0

/** Makes the call from the main thread (or from `agent`); the refusal the model reads, or undefined when it ran. */
export async function refusal($: Engine, w: World, tool: string, input: Record<string, unknown>, agent?: string): Promise<string | undefined> {
  calls += 1
  const id = `toolu_${calls}`
  if (agent === undefined) w.mainIds.push(id)
  else w.agents[agent] = [...(w.agents[agent] ?? []), id]
  const got = (await $.tool.call({ tool, ...input, tool_use_id: id } as never)) as { isError?: boolean; text?: string }
  return got.isError === true ? (got.text ?? '') : undefined
}
