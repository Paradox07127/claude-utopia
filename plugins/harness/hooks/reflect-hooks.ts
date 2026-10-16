import type { EngineInterface, HookFailure, Register } from 'claude-code'
import { pickLang } from './i18n'
import type { Lang } from './i18n'

const COMMAND = 'reflect'
const SCRIPT = 'hooks/reflect.py'
const NOTES_DIR = '.notes/reflect'
// Today counts as the first of the days the script reads.
const DAYS = 7
const SCRIPT_TIMEOUT_MS = 120_000
const MODEL = 'sonnet'
const MAX_TOKENS = 2000
const MAX_PROPOSALS = 5

// Sent first and marked for the prompt cache, so it must not vary between calls.
const INSTRUCTIONS: Record<Lang, string> = {
  'zh-CN': `你在为一个 Claude Code 插件仓库做每日反思。下面的 JSON 是脚本统计出的近 7 天摩擦候选，每个模式至少出现 2 次：
kind 是类别（guard.block 守卫拦截；guard.false-positive 被拦后 2 次调用内换写法跑通的疑似误报；subagent.over-turns 超过 80 轮的子 agent；user.correction 用户以"别/不要/不是/我说过/no/don't/stop"开头的纠正；reply.language 违反"用简体中文回复"的回复），key 是规则 id 或 agent 类型，count 是次数，target 是猜的落点，evidence 是证据（会话 id、时间、原文片段）。

用简体中文起草最多 ${MAX_PROPOSALS} 条改进提案，按收益排序。每条严格用这个格式：

## <序号>. <一句话标题>
- 现象：……
- 证据：会话 id 前 8 位、时间、原文片段，只引用给出的证据
- 落点：\`file:line\`；不知道就写"待定"
- 建议改法：……
- 置信度：高 / 中 / 低，附一句理由

规则：
- 只根据证据下结论，不编造文件、行号或次数。
- 任何会放宽守卫、权限或安全检查的提案，标题末尾加"（需人工）"。
- 同一根因的候选合成一条。
- 不写提案以外的开场白或总结。`,
  en: `You are writing the daily reflection for a Claude Code plugin repository. The JSON below holds friction candidates a script counted over the last 7 days, each pattern seen at least twice:
kind is the category (guard.block: guard blocks; guard.false-positive: a block followed within 2 calls by a rewritten call that succeeded; subagent.over-turns: subagents past 80 turns; user.correction: user prompts opening with a correction such as "no," "don't" or "stop"; reply.language: replies that broke the reply-language rule), key the rule id or agent type, count how often, target a guessed location, evidence the session id, time and an excerpt.

Draft at most ${MAX_PROPOSALS} improvement proposals in English, most valuable first. Use exactly this format for each:

## <number>. <one-line title>
- Symptom: ...
- Evidence: first 8 characters of the session id, time, excerpt; quote only the evidence given
- Target: \`file:line\`; "unknown" when you do not know
- Suggested change: ...
- Confidence: high / medium / low, with one sentence why

Rules:
- Conclude only from the evidence; never invent files, line numbers or counts.
- End the title of any proposal that would loosen a guard, a permission or a safety check with "(needs human review)".
- Merge candidates with one root cause into one proposal.
- Write nothing besides the proposals.`,
}

const zh = {
  heading: (day: string) => `# 反思 ${day}`,
  toast: (count: number, path: string) => `反思：${count} 条提案 · ${path}`,
  wrote: (count: number, path: string) => `反思：${count} 条提案，写在 ${path}`,
  none: `反思：近 ${DAYS} 天没有出现 2 次以上的摩擦，没写提案`,
  failed: '反思失败，原因见 debug 日志',
}

const en: typeof zh = {
  heading: (day: string) => `# Reflection ${day}`,
  toast: (count: number, path: string) => `Reflection: ${count} proposals · ${path}`,
  wrote: (count: number, path: string) => `Reflection: ${count} proposals, written to ${path}`,
  none: `Reflection: no friction seen twice in the last ${DAYS} days, so no proposals`,
  failed: 'Reflection failed; see the debug log',
}

const strings: Record<Lang, typeof zh> = { 'zh-CN': zh, en }

// Lives here, not in i18n.ts: validate only follows $ into functions declared in the same file.
async function resolveLang($: EngineInterface, option: unknown): Promise<Lang> {
  const settings = await $.settings.read()
  return pickLang(option, settings.language, (await $.env.get('LC_ALL')) || (await $.env.get('LANG')))
}

function logFailure($: EngineInterface, event: string, error: HookFailure): void {
  $.ui.log(`harness: ${event} hook failed (${error.kind}): ${error.message ?? 'no message'}`, { to: 'debug' })
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** The local day `back` days before `at`'s, as YYYY-MM-DD. */
function dayOf(at: number, back = 0): string {
  const now = new Date(at)
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** The event ledger's project key: the main worktree's root with / as -, so a linked worktree's session shares it. */
async function projectKey($: EngineInterface): Promise<string> {
  const root = (await $.session.repo().catch(() => null))?.root ?? (await $.session.root())
  return root.replace(/\//g, '-')
}

/** Runs reflect.py; with candidates, drafts proposals once, writes them under the session root and toasts. `path` null: none. */
async function reflect($: EngineInterface, language: unknown): Promise<{ count: number; path: string | null }> {
  const now = await $.clock.now()
  // Taken before the slow steps, so a /cd meanwhile does not move the note to another repo.
  const root = await $.session.root()
  // `--project=` keeps argparse from reading a key that starts with - as an option.
  // root may be the plugin's directory or its .claude-plugin directory.
  const script = (await $.fs.exists(`${$.plugin.root}/${SCRIPT}`)) ? `${$.plugin.root}/${SCRIPT}` : `${$.plugin.root}/../${SCRIPT}`
  const argv = ['python3', script,`--project=${await projectKey($)}`, '--since', dayOf(now, DAYS - 1), '--json']
  const run = await $.process.run(argv, { timeoutMs: SCRIPT_TIMEOUT_MS })
  if (run.exitCode !== 0) throw new Error(`reflect.py exited ${run.exitCode}: ${run.stderr.slice(0, 300)}`)
  const { candidates } = JSON.parse(run.stdout) as { candidates?: unknown }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    $.ui.log('harness: reflect found no candidates', { to: 'debug' })
    return { count: 0, path: null }
  }
  const lang = await resolveLang($, language)
  const reply = await $.model.complete({ model: MODEL, maxTokens: MAX_TOKENS, prompt: [{ text: INSTRUCTIONS[lang], cache: true }, { text: JSON.stringify(candidates) }] })
  if (!reply.isAnswered) throw new Error(`reflect draft not answered: ${reply.reason}`)
  const count = Math.min(MAX_PROPOSALS, reply.text.match(/^## /gm)?.length ?? 0)
  const path = `${NOTES_DIR}/${dayOf(now)}.md`
  await $.fs.write(`${root}/${path}`, `${strings[lang].heading(dayOf(now))}\n\n${reply.text.trim()}\n`)
  $.ui.toast(strings[lang].toast(count, path))
  return { count, path }
}

/** reflect once per local day per project: the first session to start claims the day. */
async function reflectDaily($: EngineInterface, language: unknown): Promise<void> {
  const parent = `${(await $.env.get('HOME')) ?? ''}/.claude/harness/reflect/${await projectKey($)}`
  await $.process.run(['mkdir', '-p', parent])
  // mkdir without -p fails on an existing directory, so of sessions starting together exactly one claims the day.
  if ((await $.process.run(['mkdir', `${parent}/${dayOf(await $.clock.now())}`])).exitCode !== 0) return
  await reflect($, language)
}

export const register: Register = (on, options) => {
  // The script and the draft outlast a hook's budget, so the daily run goes on a timer.
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Count the last 7 days of friction (guard blocks, likely false positives, long subagents, corrections, reply language) and draft proposals into .notes/reflect/' })
    $.clock.after(0, () => void reflectDaily($, options.language).catch(error => $.ui.log(`harness: reflect failed: ${String(error)}`, { to: 'debug' })))
    return next(e)
  }).catch(($, e, next) => {
    logFailure($, 'session.start', next.error)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const t = strings[await resolveLang($, options.language)]
    try {
      const { count, path } = await reflect($, options.language)
      return { text: path === null ? t.none : t.wrote(count, path) }
    } catch (error) {
      $.ui.log(`harness: reflect failed: ${String(error)}`, { to: 'debug' })
      return { text: t.failed }
    }
  })
}
