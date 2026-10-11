import { fmtAge, fmtDuration } from '../hooks/agent-model'

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
type ClockProps = { from: number; now: number; format: 'duration' | 'age'; color: string; bold: boolean }

/** The tree with each clock-client Client drawn as the Text it shows before its first tick. */
export function withClocks<T>(node: T): T {
  if (Array.isArray(node)) {
    return node.map(withClocks) as T
  }

  if (node === null || typeof node !== 'object') {
    return node
  }

  const el = node as Node

  if (el.type === 'Client' && String(el.props?.module).endsWith('clock-client.tsx')) {
    const clock = el.props?.props as ClockProps

    return { type: 'Text', props: { color: clock.color, ...(clock.bold && { bold: true }) }, children: [(clock.format === 'age' ? fmtAge : fmtDuration)(clock.now - clock.from)] } as T
  }

  return { ...el, children: withClocks(el.children ?? []) } as T
}
