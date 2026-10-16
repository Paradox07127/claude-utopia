import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { checkMemoryDir, decodeProjectDir, formatReport, pathsToCheck } from './memory-check'
import type { MemoryDir, MemoryFile } from './memory-check'

const ROOT = '/proj'
const HOME = '/home'

const front = (name: string, description = 'what it says') => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n---\n\n`
const memory = (name: string, body = 'Plain text.', head = front(name.replace(/\.md$/, ''))): MemoryFile => ({ name, text: head + body })
const index = (...names: string[]) => names.map(name => `- [${name}](${name}) — hook`).join('\n') + '\n'

/** The report on one memory dir whose files exist except those mentioned in `missing`. */
const report = (dir: MemoryDir, missing: string[] = []) => {
  const existing = new Set(pathsToCheck(dir, ROOT, HOME).filter(path => !missing.includes(path)))
  return formatReport(checkMemoryDir(dir, existing, ROOT, HOME), 1, 'en')
}

describe('memory check', () => {
  test('an index line pointing to a missing file is reported', () => {
    const got = report({ index: index('a.md', 'gone.md'), files: [memory('a.md')] })
    expect(got).toContain('MEMORY.md: links gone.md, which does not exist')
    expect(got).toContain('1 problem in 1 memory directory')
  })

  test('a memory file the index does not list is reported', () => {
    const got = report({ index: index('a.md'), files: [memory('a.md'), memory('stray.md')] })
    expect(got).toContain('stray.md: not listed in MEMORY.md')
    expect(got).not.toContain('a.md: not listed')
  })

  test('two files with one frontmatter name, and a file without name or description, are reported', () => {
    const files = [memory('a.md'), memory('b.md', 'x', front('a')), memory('c.md', 'x', '---\nmetadata:\n  type: user\n---\n')]
    const got = report({ index: index('a.md', 'b.md', 'c.md'), files })
    expect(got).toContain('b.md: same name "a" as a.md')
    expect(got).toContain('c.md: frontmatter lacks name, description')
    expect(got).toContain('2 problems')
  })

  test('a path the body names that no longer exists is reported; URLs and identifiers are skipped', () => {
    const body = [
      'See `docs/gone.md:12` and docs/here.md, ~/.claude/old.json and /etc/missing/file.conf.',
      'Upstream https://example.com/a/b.md, the identifier foo.bar, the command /compact and hooks/{a,b}.ts.',
    ].join('\n')
    const dir = { index: index('a.md'), files: [memory('a.md', body)] }
    expect(pathsToCheck(dir, ROOT, HOME)).toEqual([`${ROOT}/docs/gone.md`, `${ROOT}/docs/here.md`, `${HOME}/.claude/old.json`, '/etc/missing/file.conf'])
    const got = report(dir, [`${ROOT}/docs/gone.md`, `${HOME}/.claude/old.json`, '/etc/missing/file.conf'])
    expect(got).toContain('a.md: docs/gone.md does not exist')
    expect(got).toContain('a.md: ~/.claude/old.json does not exist')
    expect(got).toContain('a.md: /etc/missing/file.conf does not exist')
    expect(got).not.toContain('here.md')
    expect(got).toContain('3 problems')
  })

  test('a quoted absolute path keeps its spaces', () => {
    const dir = { index: index('a.md'), files: [memory('a.md', 'The copy: `/Volumes/me/VS Code/Big App/.claude/agents/worker.md` (added), not `~/.cache/<plugin>/<version>/`.')] }
    expect(pathsToCheck(dir, ROOT, HOME)).toEqual(['/Volumes/me/VS Code/Big App/.claude/agents/worker.md'])
  })

  test('repo-relative paths are skipped when the project root is unknown', () => {
    const dir = { index: index('a.md'), files: [memory('a.md', 'docs/gone.md and /etc/x/y.conf')] }
    expect(pathsToCheck(dir, null, HOME)).toEqual(['/etc/x/y.conf'])
  })

  test('a clean memory dir gives one line', () => {
    expect(report({ index: index('a.md', 'b.md'), files: [memory('a.md', 'docs/here.md'), memory('b.md')] })).toBe('No problems in 1 memory directory')
  })

  test('the report stops at 40 lines and counts the rest', () => {
    const files = Array.from({ length: 50 }, (_, i) => memory(`m${String(i).padStart(2, '0')}.md`))
    const lines = report({ index: '', files }).split('\n')
    expect(lines).toHaveLength(42)
    expect(lines[0]).toBe('Memory files MEMORY.md does not list')
    expect(lines[39]).toBe('m38.md: not listed in MEMORY.md')
    expect(lines[40]).toBe('… 11 more')
    expect(lines[41]).toBe('50 problems in 1 memory directory')
  })

  test('a project dir name decodes to the folder that exists, even with a dash in a folder name', async () => {
    const tree: Record<string, string[]> = { '/': ['Volumes'], '/Volumes': ['me'], '/Volumes/me': ['my', 'my-app', '.claude'], '/Volumes/me/my': ['other'], '/Volumes/me/.claude': ['wt'] }
    const list = async (dir: string) => tree[dir] ?? []
    expect(await decodeProjectDir('-Volumes-me-my-app', list)).toBe('/Volumes/me/my-app')
    expect(await decodeProjectDir('-Volumes-me--claude-wt', list)).toBe('/Volumes/me/.claude/wt')
    expect(await decodeProjectDir('-Users-me-gone', list)).toBeNull()
  })
})

const PROJECTS = `${HOME}/.claude/projects`
const MEMORY = `${PROJECTS}/-proj/memory`

// Stands in for the engine: a file system of `files` (path → text) whose directories are their parents.
const world = (on: On, files: Record<string, string>) => {
  const dirs = new Set(Object.keys(files).flatMap(path => path.split('/').slice(1, -1).map((_, i, parts) => `/${parts.slice(0, i + 1).join('/')}`)))
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', ($, e) => ({ value: e.path in files || dirs.has(e.path) }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] as string } : { deny: `ENOENT ${e.path}` }))
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const names = new Set([...Object.keys(files), ...dirs].filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0] as string))
    return { value: [...names].map(name => ({ name, kind: dirs.has(prefix + name) ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false }) as const) }
  })
}

const command = (args = '') => ({ command: 'memory-check', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })

describe('/memory-check', () => {
  test("reports the session project's memory dir", async ($, on) => {
    world(on, { [`${MEMORY}/MEMORY.md`]: index('a.md'), [`${MEMORY}/a.md`]: memory('a.md', 'see docs/gone.md').text, [`${MEMORY}/b.md`]: memory('b.md').text })
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: ROOT })
    const got = await $.command.run(command())
    expect(got.text).toContain('b.md: not listed in MEMORY.md')
    expect(got.text).toContain('a.md: docs/gone.md does not exist')
    expect(got.text).toContain('2 problems in 1 memory directory')
  })

  test('all checks every project and names each one', async ($, on) => {
    world(on, {
      [`${MEMORY}/MEMORY.md`]: index('a.md'),
      [`${MEMORY}/a.md`]: memory('a.md').text,
      [`${PROJECTS}/-other/memory/MEMORY.md`]: index('gone.md'),
    })
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: ROOT })
    const got = await $.command.run(command('all'))
    expect(got.text).toContain('-other/MEMORY.md: links gone.md, which does not exist')
    expect(got.text).toContain('1 problem in 2 memory directories')
  })

  test('a project without a memory dir says so', async ($, on) => {
    world(on, {})
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: ROOT })
    const got = await $.command.run(command())
    expect(got.text).toBe(`No memory directory for ${ROOT}`)
  })
})
