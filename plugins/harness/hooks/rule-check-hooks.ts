import type { EngineInterface, HookFailure, Register } from 'claude-code'
import { pickLang } from './i18n'
import type { Lang } from './i18n'
import { FRESH, HINT, afterReply, isLanguageViolation } from './rule-check'
import type { RuleState } from './rule-check'

const STATE_KEY = 'ruleCheck'

// Ledger appends of this load, one at a time: $.fs has no append, so each is a read and a whole write.
let appending: Promise<unknown> = Promise.resolve()

// Lives here, not in i18n.ts: validate only follows $ into functions declared in the same file.
async function resolveLang($: EngineInterface, option: unknown): Promise<Lang> {
  const settings = await $.settings.read()
  return pickLang(option, settings.language, (await $.env.get('LC_ALL')) || (await $.env.get('LANG')))
}

function logFailure($: EngineInterface, event: string, error: HookFailure): void {
  $.ui.log(`harness: ${event} hook failed (${error.kind}): ${error.message ?? 'no message'}`, { to: 'debug' })
}

async function stateOf($: EngineInterface, session: string): Promise<RuleState> {
  const stored = await $.store.get(`${STATE_KEY}:${session}`)
  return typeof stored === 'object' && stored !== null ? { ...FRESH, ...(stored as Partial<RuleState>) } : FRESH
}

// A session back in the fresh state leaves no key behind.
async function saveState($: EngineInterface, session: string, state: RuleState): Promise<void> {
  const isFresh = (Object.keys(FRESH) as (keyof RuleState)[]).every(key => state[key] === FRESH[key])
  if (isFresh) await $.store.delete(`${STATE_KEY}:${session}`)
  else await $.store.set(`${STATE_KEY}:${session}`, state)
}

const pad2 = (n: number) => String(n).padStart(2, '0')

function dayOf(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** Appends a rule.hint line to this session's .harness.jsonl of the event ledger, the format guards.ts's recordBlock() writes. */
async function recordHint($: EngineInterface, session: string): Promise<void> {
  const at = await $.clock.now()
  // The main worktree's root, so a linked worktree's session shares its project.
  const root = (await $.session.repo().catch(() => null))?.root ?? (await $.session.root())
  const path = `${(await $.env.get('HOME')) ?? ''}/.claude/harness/events/${root.replace(/\//g, '-')}/${dayOf(at)}/${session}.harness.jsonl`
  const line = JSON.stringify({
    timestamp: new Date(at).toISOString(),
    event_name: 'rule.hint',
    severity_text: 'INFO',
    attributes: { 'session.id': session, 'rule.id': 'reply-language', 'rule.name': 'rule-check' },
  })
  const write = appending.then(async () => {
    // Only a missing file counts as empty: any other read failure throws rather than overwrite the day's lines.
    const before = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    await $.fs.write(path, `${before}${before === '' || before.endsWith('\n') ? '' : '\n'}${line}\n`)
  })
  appending = write.catch(() => undefined)
  await write
}

export const register: Register = (on, options) => {
  // A matcher on every hook: in the source tree register.tsx holds the matcher-less one on each of these events, and the engine refuses a second.
  on('turn.complete', { reason: 'answer' }, async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && (await resolveLang($, options.language)) === 'zh-CN') {
      const session = await $.session.id()
      await saveState($, session, afterReply(await stateOf($, session), isLanguageViolation(e.answer)))
    }
    return done
  }).catch(($, e, next) => {
    logFailure($, 'turn.complete', next.error)
    return next(e)
  })

  // The hint rides after the new prompt, where only Claude reads it.
  on('prompt.submit', { wait: [true, false] }, async ($, e, next) => {
    // A failure here would skip the plugin's whole prompt.submit chain, prediction logging included, so it only drops the hint.
    const session = await $.session.id().catch(() => null)
    const state = session === null ? FRESH : await stateOf($, session).catch(() => FRESH)
    if (session === null || !state.owed) return next(e)
    await saveState($, session, { ...state, owed: false })
    // The language may have left zh-CN since the reply that owed the hint.
    if ((await resolveLang($, options.language).catch(() => null)) !== 'zh-CN') return next(e)
    await recordHint($, session).catch(error => $.ui.log(`harness: rule.hint not recorded: ${String(error)}`, { to: 'debug' }))
    return next({ ...e, context: [...(e.context ?? []), HINT] })
  }).catch(($, e, next) => {
    logFailure($, 'prompt.submit', next.error)
    return next(e)
  })
}
