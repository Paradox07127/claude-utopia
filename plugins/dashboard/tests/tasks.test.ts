import { describe, expect, test } from 'claude-code/testing'

import type { AgentRun, AgentRunState, MmModel, MmRun } from '../types'
import { applyEvents, runSession, taskOfAgent, taskOfModel } from '../hooks/tasks'

const MODEL: MmModel = { name: 'codex', status: 'RUNNING', startedAt: 1_000 }

const started = (session: string) => JSON.stringify({ type: 'task_started', ts: 1_000, task_id: 'r/codex', provider: 'codex', mode: 'review', description: 'design', claude_session: session })
const progress = (tools: number, last: string, summary: string) =>
  JSON.stringify({ type: 'task_progress', ts: 2_000, task_id: 'r/codex', usage: { tool_uses: tools }, last_tool_name: last, summary })
const notified = (summary: string, usage: Record<string, number>) => JSON.stringify({ type: 'task_notification', ts: 3_000, task_id: 'r/codex', status: 'completed', summary, usage })

const RUN: AgentRun = {
  agentId: 'a1',
  description: 'Build mm plugin',
  subagentType: 'worker',
  model: 'claude-opus-5-5',
  background: true,
  startedAt: 5_000,
  tools: 7,
  lastTool: 'Read x.ts',
  state: 'running',
  lastActivityAt: 6_000,
}

const mmRun = (...models: MmModel[]): MmRun => ({ runid: '20261002-010000-aaaa', tag: 'design', workdir: '/work', mode: 'review', createdAt: 0, models })

describe('applyEvents', () => {
  test('task_started gives the session; an empty claude_session gives none', () => {
    expect(applyEvents(MODEL, started('s1')).claudeSession).toBe('s1')
    expect(applyEvents(MODEL, started('')).claudeSession).toBeUndefined()
    expect('claudeSession' in applyEvents(MODEL, started(''))).toBe(false)
  })

  test('the last task_progress wins', () => {
    const model = applyEvents(MODEL, [started('s1'), progress(1, 'Read a', 'one'), progress(3, 'exec_command', 'three')].join('\n'))

    expect(model).toEqual({ ...MODEL, claudeSession: 's1', tools: 3, lastTool: 'exec_command', summary: 'three' })
  })

  test('task_notification gives the summary and the output tokens, unless the model has tokens already', () => {
    const text = [progress(2, 'Bash', 'working'), notified('all done', { total_tokens: 900, output_tokens: 120 })].join('\n')

    expect(applyEvents(MODEL, text)).toEqual({ ...MODEL, tools: 2, lastTool: 'Bash', summary: 'all done', outputTokens: 120 })
    expect(applyEvents({ ...MODEL, outputTokens: 50 }, text).outputTokens).toBe(50)
    expect(applyEvents(MODEL, notified('no usage', {})).outputTokens).toBeUndefined()
  })

  test('transcript_path comes from task_progress and task_notification, the latest winning', () => {
    const at = (type: string, path: string) => JSON.stringify({ type, ts: 2_000, task_id: 'r/codex', transcript_path: path })

    expect(applyEvents(MODEL, at('task_progress', '/h/.codex/sessions/a.jsonl')).transcriptPath).toBe('/h/.codex/sessions/a.jsonl')
    expect(applyEvents(MODEL, [at('task_progress', '/a'), at('task_notification', '/b')].join('\n')).transcriptPath).toBe('/b')
    expect('transcriptPath' in applyEvents(MODEL, progress(1, 'Bash', 's'))).toBe(false)
  })

  test('task_progress gives the output tokens, the latest winning, only when the model came in without them', () => {
    const tokens = (output: number) => JSON.stringify({ type: 'task_progress', ts: 2_000, task_id: 'r/codex', usage: { tool_uses: 1, output_tokens: output, total_tokens: output * 10 } })
    const text = [tokens(40), tokens(90)].join('\n')

    expect(applyEvents(MODEL, text).outputTokens).toBe(90)
    expect(applyEvents({ ...MODEL, outputTokens: 50 }, text).outputTokens).toBe(50)
    expect(applyEvents(MODEL, [tokens(90), notified('done', { output_tokens: 120 })].join('\n')).outputTokens, 'the notification’s after it').toBe(120)
  })

  test('a cut first line and a line that is not JSON are skipped', () => {
    const whole = progress(4, 'Grep', 'four')
    const text = [progress(9, 'Cut', 'cut').slice(20), 'not json', '[1,2]', '', whole, ''].join('\n')

    expect(applyEvents(MODEL, text)).toEqual({ ...MODEL, tools: 4, lastTool: 'Grep', summary: 'four' })
    expect(applyEvents(MODEL, '')).toEqual(MODEL)
  })
})

describe('taskOfAgent', () => {
  test('the shared fields come from the run; its state maps to a task status', () => {
    expect(taskOfAgent({ ...RUN, outputTokens: 42 })).toEqual({
      id: 'a1',
      origin: 'subagent',
      provider: 'claude',
      kind: 'worker',
      title: 'Build mm plugin',
      model: 'claude-opus-5-5',
      status: 'running',
      startedAt: 5_000,
      tools: 7,
      lastTool: 'Read x.ts',
      outputTokens: 42,
    })

    const statuses: [AgentRunState, string][] = [
      ['running', 'running'],
      ['idle', 'running'],
      ['done', 'done'],
      ['error', 'failed'],
      ['refusal', 'failed'],
      ['aborted', 'stopped'],
    ]

    for (const [state, status] of statuses) {
      expect(taskOfAgent({ ...RUN, state, endedAt: 9_000 }).status, state).toBe(status)
    }

    expect(taskOfAgent({ ...RUN, state: 'done', endedAt: 9_000 }).endedAt).toBe(9_000)
  })
})

describe('taskOfModel', () => {
  test('the shared fields come from the run and the model; its status maps to a task status', () => {
    const model: MmModel = { ...MODEL, tools: 3, lastTool: 'Bash', summary: 's', outputTokens: 10, claudeSession: 'me' }

    expect(taskOfModel(mmRun(model), model, 'me')).toEqual({
      id: '20261002-010000-aaaa/codex',
      origin: 'mm',
      provider: 'codex',
      kind: 'review',
      title: 'design',
      model: 'codex',
      status: 'running',
      startedAt: 1_000,
      tools: 3,
      lastTool: 'Bash',
      summary: 's',
      outputTokens: 10,
      isThisSession: true,
    })

    const statuses: [string, string][] = [
      ['RUNNING', 'running'],
      ['DONE', 'done'],
      ['FAIL:1', 'failed'],
      ['CANCELLED', 'stopped'],
      ['SKIP:no-key', 'stopped'],
      ['STALE', 'stale'],
    ]

    for (const [raw, status] of statuses) {
      expect(taskOfModel(mmRun(), { ...MODEL, status: raw }, null).status, raw).toBe(status)
    }
  })

  test('isThisSession: absent without the model’s or this session’s id, else whether they match', () => {
    expect(taskOfModel(mmRun(), { ...MODEL, claudeSession: 'me' }, 'me').isThisSession).toBe(true)
    expect(taskOfModel(mmRun(), { ...MODEL, claudeSession: 'other' }, 'me').isThisSession).toBe(false)
    expect('isThisSession' in taskOfModel(mmRun(), MODEL, 'me')).toBe(false)
    expect('isThisSession' in taskOfModel(mmRun(), { ...MODEL, claudeSession: 'me' }, null)).toBe(false)
  })
})

describe('runSession', () => {
  const mine = { ...MODEL, claudeSession: 'me' }
  const other = { ...MODEL, name: 'grok', claudeSession: 'other' }
  const unknown = { ...MODEL, name: 'agy' }

  test('true if any model says this session, false if one says another and none this, else undefined', () => {
    expect(runSession(mmRun(other, mine), 'me')).toBe(true)
    expect(runSession(mmRun(other, unknown), 'me')).toBe(false)
    expect(runSession(mmRun(unknown), 'me')).toBeUndefined()
    expect(runSession(mmRun(), 'me')).toBeUndefined()
    expect(runSession(mmRun(other, mine), null)).toBeUndefined()
  })
})
