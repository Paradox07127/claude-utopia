import { describe, expect, test } from 'claude-code/testing'

import { conversationOf } from '../hooks/conversation'

const item = (payload: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-10-15T00:00:00Z', type: 'response_item', payload })
const message = (role: string, text: string) => item({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] })

describe('conversationOf: a codex rollout', () => {
  test('user and assistant messages, a tool call with its output, a reasoning summary; developer messages and other line types skipped', () => {
    const text = [
      JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { id: 's' } }),
      message('developer', 'you are codex'),
      message('user', 'review the diff'),
      item({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Looking at the **diff**' }], encrypted_content: 'SECRET' }),
      item({ type: 'reasoning', summary: [], encrypted_content: 'SECRET' }),
      item({ type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch' }),
      item({ type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'Success' }] }),
      item({ type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' }),
      item({ type: 'function_call_output', output: 'a.ts' }),
      JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'agent_message', message: 'shown twice' } }),
      message('assistant', 'Two problems'),
      '',
    ].join('\n')

    expect(conversationOf(text)).toEqual({
      items: [
        { kind: 'user', text: 'review the diff' },
        { kind: 'thinking', text: 'Looking at the **diff**' },
        { kind: 'call', tool: 'apply_patch', text: '*** Begin Patch' },
        { kind: 'result', text: 'Success' },
        { kind: 'call', tool: 'shell', text: '{"cmd":"ls"}' },
        { kind: 'result', text: 'a.ts' },
        { kind: 'assistant', text: 'Two problems' },
      ],
      dropped: 0,
    })
    expect(JSON.stringify(conversationOf(text))).not.toContain('SECRET')
  })

  test('a first line cut by the tail and lines that are no JSON object are skipped', () => {
    const text = [message('user', 'cut off').slice(30), 'not json', '[1,2]', message('assistant', 'whole')].join('\n')

    expect(conversationOf(text)).toEqual({ items: [{ kind: 'assistant', text: 'whole' }], dropped: 0 })
    expect(conversationOf('')).toEqual({ items: [], dropped: 0 })
  })
})

describe('conversationOf: a grok chat history', () => {
  test('system skipped; user array content; an assistant text then one call per tool call; a tool result; reasoning', () => {
    const text = [
      JSON.stringify({ type: 'system', content: 'you are grok' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'review it' }] }),
      JSON.stringify({ type: 'reasoning', summary: [{ text: 'Need the file' }] }),
      JSON.stringify({
        type: 'assistant',
        content: 'Reading two files',
        tool_calls: [
          { name: 'read_file', arguments: '{"path":"a.ts"}' },
          { name: 'grep', arguments: '{"pattern":"x"}' },
        ],
      }),
      JSON.stringify({ type: 'tool_result', content: 'const a = 1' }),
      JSON.stringify({ type: 'assistant', content: '', tool_calls: [{ name: 'read_file', arguments: '{"path":"b.ts"}' }] }),
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'Done' }] }),
    ].join('\n')

    expect(conversationOf(text)).toEqual({
      items: [
        { kind: 'user', text: 'review it' },
        { kind: 'thinking', text: 'Need the file' },
        { kind: 'assistant', text: 'Reading two files' },
        { kind: 'call', tool: 'read_file', text: '{"path":"a.ts"}' },
        { kind: 'call', tool: 'grep', text: '{"pattern":"x"}' },
        { kind: 'result', text: 'const a = 1' },
        { kind: 'call', tool: 'read_file', text: '{"path":"b.ts"}' },
        { kind: 'assistant', text: 'Done' },
      ],
      dropped: 0,
    })
  })
})

describe('conversationOf: limits', () => {
  test('keeps the last 80 items and counts the earlier ones it left out', () => {
    const text = Array.from({ length: 95 }, (_, i) => JSON.stringify({ type: 'user', content: `turn ${i}` })).join('\n')
    const { items, dropped } = conversationOf(text)

    expect(items).toHaveLength(80)
    expect(dropped).toBe(15)
    expect(items[0]).toEqual({ kind: 'user', text: 'turn 15' })
    expect(items.at(-1)).toEqual({ kind: 'user', text: 'turn 94' })
  })

  test('a text over 4000 characters is cut to 4000 with a trailing …; one of 4000 stays whole', () => {
    const long = conversationOf(JSON.stringify({ type: 'tool_result', content: 'x'.repeat(9_000) })).items[0]!
    const exact = conversationOf(JSON.stringify({ type: 'tool_result', content: 'y'.repeat(4_000) })).items[0]!

    expect(long.text).toHaveLength(4_000)
    expect(long.text.endsWith('x…')).toBe(true)
    expect(exact.text).toBe('y'.repeat(4_000))
  })
})
