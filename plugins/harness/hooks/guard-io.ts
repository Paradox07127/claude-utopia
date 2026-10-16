import { basename, dirname, join } from './posixpath'

/** What the guards read of the host; guards.ts answers it from `$`, a test from its own world. */
export type GuardIo = {
  /** A variable of the host process's environment; undefined when unset. */
  env: (name: string) => Promise<string | undefined>
  /** User `name`'s home directory ('' for the current user); undefined when there is no such user. */
  userHome: (name: string) => Promise<string | undefined>
  /** Runs argv with `env` set over the host's environment; undefined when it cannot start or runs past timeoutMs. */
  run: (argv: readonly string[], init: { env?: Record<string, string>; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string } | undefined>
  /** What the path leads to, links followed, and where it lands; undefined when it leads nowhere. */
  stat: (path: string) => Promise<{ kind: 'file' | 'dir' | 'other'; realPath?: string } | undefined>
  /** The directory's entries; undefined when it cannot be listed. */
  list: (path: string) => Promise<{ name: string; kind: 'file' | 'dir' | 'other' }[] | undefined>
  /** Epoch milliseconds. */
  now: () => Promise<number>
}

/** os.path.expanduser: `~` is $HOME (the user database when unset), `~name` that user's home; an unknown user keeps the path. */
export async function expanduser(io: GuardIo, path: string): Promise<string> {
  if (!path.startsWith('~')) return path
  const cut = path.indexOf('/', 1) < 0 ? path.length : path.indexOf('/', 1)
  const name = path.slice(1, cut)
  const home = name === '' ? ((await io.env('HOME')) ?? (await io.userHome(''))) : await io.userHome(name)
  if (home === undefined) return path
  return home.replace(/\/+$/, '') + path.slice(cut) || '/'
}

/** os.path.realpath of an absolute path: resolved where it exists, its missing tail kept as written under its nearest existing directory. */
export async function realpath(io: GuardIo, path: string): Promise<string> {
  const found = await io.stat(path)
  if (found !== undefined) return found.realPath ?? path
  const parent = dirname(path)
  return parent === path ? path : join(await realpath(io, parent), basename(path))
}

export async function isdir(io: GuardIo, path: string): Promise<boolean> {
  return (await io.stat(path))?.kind === 'dir'
}

export async function exists(io: GuardIo, path: string): Promise<boolean> {
  return (await io.stat(path)) !== undefined
}
