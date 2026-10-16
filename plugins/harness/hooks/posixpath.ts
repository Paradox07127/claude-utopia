// CPython's posixpath, the lexical part, ported line for line: the guards resolve paths exactly as it does.
// plugins/harness/hooks/posixpath.ts and plugins/mm/hooks/posixpath.ts are the same file: each plugin ships on its own.

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** os.path.split: the head keeps a root of slashes and loses any other trailing ones. */
export function split(path: string): [string, string] {
  const cut = path.lastIndexOf('/') + 1
  const head = path.slice(0, cut)
  return [/^\/*$/.test(head) ? head : head.replace(/\/+$/, ''), path.slice(cut)]
}

export function dirname(path: string): string {
  return split(path)[0]
}

export function isabs(path: string): boolean {
  return path.startsWith('/')
}

export function join(first: string, ...rest: string[]): string {
  let path = first
  for (const part of rest) {
    if (part.startsWith('/')) path = part
    else if (path === '' || path.endsWith('/')) path += part
    else path += `/${part}`
  }
  return path
}

export function normpath(path: string): string {
  if (path === '') return '.'
  // POSIX leaves the meaning of exactly two leading slashes to the implementation, so Python keeps them.
  const slashes = !path.startsWith('/') ? 0 : path.startsWith('//') && !path.startsWith('///') ? 2 : 1
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..' || (slashes === 0 && parts.length === 0) || parts.at(-1) === '..') parts.push(part)
    else if (parts.length > 0) parts.pop()
  }
  return '/'.repeat(slashes) + parts.join('/') || '.'
}
