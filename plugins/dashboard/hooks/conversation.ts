import type { ConversationItem } from '../types'

const TEXT_CHARS = 4000
const ITEMS_KEPT = 80

type Fields = Record<string, unknown>

const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The line as an object; null for a line cut by the tail or one that is not a JSON object. */
function fieldsOf(line: string): Fields | null {
  try {
    const parsed: unknown = JSON.parse(line)

    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

const stringOf = (value: unknown) => (typeof value === 'string' ? value : '')

/** A string as it is, or the `text` of each part of an array, one per line. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) {
    return stringOf(content)
  }

  return content
    .map(part => (isObject(part) ? stringOf(part.text) : ''))
    .filter(text => text !== '')
    .join('\n')
}

/** A codex rollout line's items: a response_item's user or assistant message, tool call, tool output or reasoning summary. */
function codexItems(payload: Fields): ConversationItem[] {
  switch (payload.type) {
    case 'message':
      return payload.role === 'user' || payload.role === 'assistant' ? [{ kind: payload.role, text: textOf(payload.content) }] : []
    case 'custom_tool_call':
      return [{ kind: 'call', tool: stringOf(payload.name), text: stringOf(payload.input) }]
    case 'function_call':
      return [{ kind: 'call', tool: stringOf(payload.name), text: stringOf(payload.arguments) }]
    case 'custom_tool_call_output':
    case 'function_call_output':
      return [{ kind: 'result', text: textOf(payload.output) }]
    case 'reasoning':
      return [{ kind: 'thinking', text: textOf(payload.summary) }]
    default:
      return []
  }
}

/** A grok chat_history line's items: an assistant's text, then one call per tool call. */
function grokItems(line: Fields): ConversationItem[] {
  switch (line.type) {
    case 'user':
      return [{ kind: 'user', text: textOf(line.content) }]
    case 'assistant': {
      const calls = Array.isArray(line.tool_calls) ? line.tool_calls.filter(isObject) : []

      return [{ kind: 'assistant', text: textOf(line.content) }, ...calls.map((call): ConversationItem => ({ kind: 'call', tool: stringOf(call.name), text: stringOf(call.arguments) }))]
    }
    case 'reasoning':
      return [{ kind: 'thinking', text: textOf(line.summary) }]
    case 'tool_result':
      return [{ kind: 'result', text: textOf(line.content) }]
    default:
      return []
  }
}

const cut = (text: string) => (text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS - 1)}…` : text)

/** The entries of a codex rollout or a grok chat_history, oldest first: the last ITEMS_KEPT, `dropped` counting those before. */
export function conversationOf(text: string): { items: ConversationItem[]; dropped: number } {
  const items: ConversationItem[] = []

  for (const line of text.split('\n')) {
    const fields = fieldsOf(line)

    if (fields === null) {
      continue
    }

    const found = fields.type === 'response_item' ? (isObject(fields.payload) ? codexItems(fields.payload) : []) : grokItems(fields)

    items.push(...found.filter(item => item.text !== '').map(item => ({ ...item, text: cut(item.text) })))
  }

  const dropped = Math.max(0, items.length - ITEMS_KEPT)

  return { items: items.slice(dropped), dropped }
}
