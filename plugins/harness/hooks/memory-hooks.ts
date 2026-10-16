import type { EngineInterface, HookFailure, Register } from 'claude-code'
import { pickLang } from './i18n'
import type { Lang } from './i18n'
import { checkMemoryDir, decodeProjectDir, encodePath, formatReport, mainTreeOf, pathsToCheck, strings } from './memory-check'
import type { MemoryDir, Problem } from './memory-check'

const COMMAND = 'memory-check'
const INDEX = 'MEMORY.md'

// Lives here, not in i18n.ts: validate only follows $ into functions declared in the same file.
async function resolveLang($: EngineInterface, option: unknown): Promise<Lang> {
  const settings = await $.settings.read()
  return pickLang(option, settings.language, (await $.env.get('LC_ALL')) || (await $.env.get('LANG')))
}

function logFailure($: EngineInterface, event: string, error: HookFailure): void {
  $.ui.log(`harness: ${event} hook failed (${error.kind}): ${error.message ?? 'no message'}`, { to: 'debug' })
}

async function readMemoryDir($: EngineInterface, dir: string): Promise<MemoryDir> {
  const entries = (await $.fs.list(dir)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
  const files = await Promise.all(entries.filter(entry => entry.name !== INDEX).map(async entry => ({ name: entry.name, text: await $.fs.read(`${dir}/${entry.name}`) })))
  const index = entries.some(entry => entry.name === INDEX) ? await $.fs.read(`${dir}/${INDEX}`) : null
  return { index, files }
}

async function checkDir($: EngineInterface, dir: string, root: string | null, home: string): Promise<Problem[]> {
  const memory = await readMemoryDir($, dir)
  const paths = pathsToCheck(memory, root, home)
  const found = await Promise.all(paths.map(path => $.fs.exists(path)))
  return checkMemoryDir(memory, new Set(paths.filter((_, i) => found[i])), root, home)
}

/** Reads memory only: the session project's dir, or with `all` every project's. */
async function memoryCheck($: EngineInterface, args: string, language: unknown): Promise<string> {
  const lang = await resolveLang($, language)
  const home = (await $.env.get('HOME')) ?? ''
  const projects = `${home}/.claude/projects`
  if (args.trim() === 'all') {
    const problems: Problem[] = []
    let count = 0
    const listDirs = async (dir: string) => (await $.fs.list(dir).catch(() => [])).filter(entry => entry.kind !== 'file').map(entry => entry.name)
    for (const project of await listDirs(projects)) {
      const dir = `${projects}/${project}/memory`
      if (!(await $.fs.exists(dir))) continue
      count += 1
      const root = await decodeProjectDir(project, listDirs)
      problems.push(...(await checkDir($, dir, root, home)).map(p => ({ ...p, file: `${project}/${p.file}` })))
    }
    return formatReport(problems, count, lang)
  }
  const root = await $.session.root()
  // A linked worktree shares the main tree's memory.
  const main = mainTreeOf(await $.fs.read(`${root}/.git`).catch(() => ''))
  for (const candidate of main === null ? [root] : [root, main]) {
    const dir = `${projects}/${encodePath(candidate)}/memory`
    if (await $.fs.exists(dir)) return formatReport(await checkDir($, dir, candidate, home), 1, lang)
  }
  return strings[lang].noDir(root)
}

export const register: Register = (on, options) => {
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'List problems in Claude Code memory: broken index links, unlisted files, bad frontmatter, paths gone; `all` for every project' })
    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'session.start', next.error)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await memoryCheck($, e.args, options.language) }))
}
