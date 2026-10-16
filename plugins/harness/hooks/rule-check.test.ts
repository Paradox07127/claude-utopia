import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { FRESH, HINT, afterReply, isLanguageViolation } from './rule-check'
import type { RuleState } from './rule-check'

const ENGLISH = 'I updated the configuration loader and reran the whole suite; everything passes now and nothing else changed.'
const CHINESE = '改好了：loader 现在会缓存解析结果，所有测试都通过了，其他文件没有动，也没有改配置的默认值。'
const HOME = '/home'
const NOW = new Date(2026, 9, 14, 12).getTime()
const LEDGER = `${HOME}/.claude/harness/events/-repo/2026-10-14/s1.harness.jsonl`

describe('isLanguageViolation', () => {
  test('a mostly English reply of 40 letters or more is one', () => {
    expect(isLanguageViolation(ENGLISH)).toBe(true)
  })

  test('a Chinese reply with English identifiers is not', () => {
    expect(isLanguageViolation(`${CHINESE} 见 \`register.tsx\` 里的 resolveLang 和 predict_hooks，https://example.com/a/b`)).toBe(false)
  })

  test('code, inline code, URLs, paths and identifiers do not count', () => {
    const code = '```ts\nconst answer = await somethingThatIsLongEnoughToCount(withManyLetters)\n```'
    expect(isLanguageViolation(`${code}\n改好了，见 plugins/harness/hooks/rule-check.ts 和 https://example.com/some/long/english/path`)).toBe(false)
  })

  test('fewer than 40 letters is not', () => {
    expect(isLanguageViolation('Done, all tests pass.')).toBe(false)
  })
})

describe('afterReply backoff', () => {
  const run = (replies: boolean[]) => {
    let state: RuleState = FRESH
    return replies.map(violated => {
      state = { ...afterReply(state, violated) }
      const owed = state.owed
      state = { ...state, owed: false }
      return owed
    })
  }

  test('each violation is hinted until 2 hints in a row were followed by another, then min(16, 2^(n-3)) are skipped', () => {
    expect(run(Array(12).fill(true))).toEqual([true, true, false, true, false, false, false, false, true, false, false, false])
  })

  test('a compliant reply starts over', () => {
    expect(run([true, true, false, true, true, true])).toEqual([true, true, false, true, true, false])
  })

  test('a compliant reply leaves the fresh state', () => {
    expect(afterReply({ run: 4, skip: 2, lastHinted: true, owed: true }, false)).toEqual(FRESH)
  })
})

// Stands in for the engine: settings `language`, a session s1 in repo /repo, files in memory (null: exists but unreadable).
const world = (on: On, language: string, files: Record<string, string | null> = {}) => {
  mock.store(on)
  mock.env(on, { HOME })
  const clock = mock.clock(on, { now: NOW })
  const settings = { language }
  on('settings.read', () => ({ value: { language: settings.language } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/repo/wt' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: null } }))
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => {
    const text = files[e.path]
    return typeof text === 'string' ? { value: text } : { deny: `${text === null ? 'EACCES' : 'ENOENT'} ${e.path}` }
  })
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text, ...(e.context !== undefined && { context: e.context }) }))
  return { files, clock, settings }
}

const reply = (answer: string, agentId?: string) =>
  ({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...(agentId !== undefined && { agentId }) }) as never
const prompt = (text = 'next') => ({ text, wait: false, origin: { kind: 'composer' } }) as never

async function contextAfter($: Engine, answer: string, agentId?: string): Promise<readonly string[] | undefined> {
  await $.turn.complete(reply(answer, agentId))
  return (await $.prompt.submit(prompt())).context
}

describe('reply language check', () => {
  test('after an English main reply the next prompt carries the hint once', async ($, on) => {
    world(on, '简体中文')
    expect(await contextAfter($, ENGLISH)).toEqual([HINT])
    expect((await $.prompt.submit(prompt())).context).toBeUndefined()
  })

  test('a Chinese reply adds nothing', async ($, on) => {
    world(on, '简体中文')
    expect(await contextAfter($, CHINESE)).toBeUndefined()
  })

  test('nothing when the language is not Chinese', async ($, on) => {
    world(on, 'English')
    expect(await contextAfter($, ENGLISH)).toBeUndefined()
  })

  test("a subagent's reply is not checked", async ($, on) => {
    world(on, '简体中文')
    expect(await contextAfter($, ENGLISH, 'a1')).toBeUndefined()
  })

  test('the third violation in a row after two hints gets none', async ($, on) => {
    world(on, '简体中文')
    const got = [await contextAfter($, ENGLISH), await contextAfter($, ENGLISH), await contextAfter($, ENGLISH)]
    expect(got).toEqual([[HINT], [HINT], undefined])
  })

  test("each hint appends a rule.hint line to the session's .harness.jsonl of the event ledger",async ($, on) => {
    const { files } = world(on, '简体中文', { [LEDGER]: '{"event_name":"guard.block"}\n' })
    await contextAfter($, ENGLISH)
    await contextAfter($, ENGLISH)
    const lines = (files[LEDGER] ?? '').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0] ?? '')).toEqual({ event_name: 'guard.block' })
    expect(JSON.parse(lines[1] ?? '')).toEqual({
      timestamp: new Date(NOW).toISOString(),
      event_name: 'rule.hint',
      severity_text: 'INFO',
      attributes: { 'session.id': 's1', 'rule.id': 'reply-language', 'rule.name': 'rule-check' },
    })
  })

  test('a ledger that exists but cannot be read is not rewritten', async ($, on) => {
    const { files } = world(on, '简体中文', { [LEDGER]: null })
    await contextAfter($, ENGLISH)
    expect(files).toEqual({ [LEDGER]: null })
  })

  test('a missing ledger is created with the rule.hint line', async ($, on) => {
    const { files } = world(on, '简体中文')
    await contextAfter($, ENGLISH)
    expect(JSON.parse(files[LEDGER] ?? '').event_name).toBe('rule.hint')
  })

  test('a hint owed before the language left Chinese is dropped, not recorded', async ($, on) => {
    const { files, settings } = world(on, '简体中文')
    await $.turn.complete(reply(ENGLISH))
    settings.language = 'English'
    expect((await $.prompt.submit(prompt())).context).toBeUndefined()
    settings.language = '简体中文'
    expect((await $.prompt.submit(prompt())).context).toBeUndefined()
    expect(files).toEqual({})
  })
})
