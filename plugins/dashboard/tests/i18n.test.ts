import { describe, expect, test } from 'claude-code/testing'

import type { MmRun, MmSnapshot, WorktreeInfo } from '../types'
import { pickLang, setLang } from '../hooks/i18n'
import type { Lang } from '../hooks/i18n'
import { endToast, reportOf } from '../hooks/runs'
import { treeMarks } from '../hooks/workspace'

const HAN = /\p{Script=Han}/u

describe('pickLang', () => {
  test('an explicit option wins over the settings and the locale', () => {
    expect(pickLang('en', '简体中文', 'zh_CN.UTF-8')).toBe('en')
    expect(pickLang('zh-CN', 'english', 'en_US.UTF-8')).toBe('zh-CN')
  })

  test('auto follows the settings language', () => {
    expect(pickLang('auto', '简体中文', undefined)).toBe('zh-CN')
    expect(pickLang('auto', 'Chinese', undefined)).toBe('zh-CN')
    expect(pickLang('auto', 'english', 'zh_CN.UTF-8')).toBe('en')
    expect(pickLang('auto', 'japanese', 'zh_CN.UTF-8')).toBe('en')
  })

  test('no settings language: the locale', () => {
    expect(pickLang('auto', undefined, 'zh_CN.UTF-8')).toBe('zh-CN')
    expect(pickLang('auto', '', 'zh_CN.UTF-8')).toBe('zh-CN')
  })

  test('nothing set: English', () => {
    expect(pickLang(undefined, undefined, undefined)).toBe('en')
    expect(pickLang('auto', '', '')).toBe('en')
  })
})

const REVIEW = {
  verdict: 'REQUEST_CHANGES',
  summary: 'two problems',
  findings: [
    { severity: 'critical', file: 'a.ts', line: 3, claim: 'breaks', quote: 'x()', failure_scenario: 'on empty input', basis: 'read', suggestion: 'guard it' },
    { severity: 'minor', file: 'b.ts', line: 9, claim: 'naming', quote: 'y', failure_scenario: 'none', basis: 'read' },
  ],
  not_expanded: 2,
  not_checked: ['tests'],
}
const RUN = { status: 'done', summary: 'did it', checks_run: [], not_verified: ['perf'], decisions_made: [], questions: [] }

const model = (name: string, status: string) => ({ name, status, startedAt: 1 })
const run = (models: ReturnType<typeof model>[]): MmRun => ({ runid: '20261002-010000-aaaa', tag: 'design', workdir: '/x', mode: 'review', createdAt: 0, models })
const snap = (models: ReturnType<typeof model>[]): MmSnapshot => ({ polledAt: 0, runs: [run(models)] })

const PREV = snap([model('grok', 'RUNNING'), model('kimi', 'RUNNING'), model('agy', 'RUNNING'), model('codex', 'RUNNING')])
const NEXT = snap([model('grok', 'DONE'), model('kimi', 'STALE'), model('agy', 'FAIL:1'), model('codex', 'RUNNING')])

const tree = (over: Partial<WorktreeInfo>): WorktreeInfo => ({ name: 'agent-a', path: '/r/.claude/worktrees/agent-a', branch: 'b', dirty: 0, ahead: 0, behind: 0, merged: false, running: false, error: null, ...over })
const TREES = [tree({ error: 'fatal: nope' }), tree({ dirty: 3, ahead: 2, behind: 1, running: true }), tree({ merged: true })]

/** Every string runs.ts and workspace.ts hand to the UI, in one language. */
function uiStrings(lang: Lang): string[] {
  setLang(lang)

  return [
    reportOf(REVIEW, '', 'review', true, '/r/codex.out'),
    reportOf(RUN, '', 'run', false, '/r/codex.out'),
    reportOf(null, 'x'.repeat(7000), 'review', false, '/r/codex.out'),
    endToast(PREV, NEXT) ?? '',
    ...TREES.flatMap(one => treeMarks(one).map(mark => mark.text)),
  ]
}

describe('runs and workspace strings', () => {
  test('en: no Chinese anywhere', () => {
    for (const text of uiStrings('en')) {
      expect(text).not.toMatch(HAN)
    }
  })

  test('en: the not-expanded line reads `Not expanded: N`', () => {
    setLang('en')
    expect(reportOf(REVIEW, '', 'review', false, '/r/codex.out')).toContain('Not expanded: 2')
  })

  test('zh-CN: the key words are Chinese', () => {
    const text = uiStrings('zh-CN').join('\n')

    for (const part of ['失败场景', '修改', '未检查', '未展开 2 条', '截断', 'checks_run: 无', '已返回', '已失联', '失败 FAIL:1', '仍在运行', '读取失败', '改动 3', '领先 2', '落后 1', '运行中', '已合入 可删']) {
      expect(text).toContain(part)
    }
  })
})
