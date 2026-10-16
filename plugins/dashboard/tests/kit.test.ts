import { describe, expect, test } from 'claude-code/testing'

import { FILL } from '../hooks/desktop-svg'
import { attention, bar, dots, gauge, iconOf, kpis, kv, pxWidth, sparkline, stacked } from '../hooks/desktop/kit'
import type { AnyEl } from '../hooks/desktop/kit'

// Host types, so a drawn tree is plain data: the terminal's table has no Svg, the desktop's does.
const TERMINAL = { Box: 'Box', Text: 'Text' } as unknown as AnyEl
const DESKTOP = { Box: 'Box', Text: 'Text', Svg: 'Svg' } as unknown as AnyEl

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

function nodesOf(node: unknown, type: string, out: Node[] = []): Node[] {
  if (Array.isArray(node)) {
    node.forEach(one => nodesOf(one, type, out))
  } else if (node !== null && typeof node === 'object') {
    const el = node as Node

    if (el.type === type) {
      out.push(el)
    }

    nodesOf(el.children ?? [], type, out)
  }

  return out
}

const textOf = (node: unknown): string =>
  typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node !== null && typeof node === 'object' ? textOf((node as Node).children ?? []) : ''

describe('the kit draws Svg only where the surface has it', () => {
  test('without Svg: K1 a line of cells, K2 the percent, K3 the levels, K4 the legend, K5 a glyph, the dots ●, each in a theme key', () => {
    const drawn = [
      bar(TERMINAL, 0.5, 'running', 95, 'half'),
      gauge(TERMINAL, 0.52, 'done', 'util'),
      sparkline(TERMINAL, [0, 4, 8], 'running', 'week', 60),
      stacked(TERMINAL, [{ label: 'in', value: 1, text: '1k', tone: 'running' }, { label: 'out', value: 3, text: '3k', tone: 'done' }], 'tokens', 200),
      iconOf(TERMINAL, 'warning', 'stale', 'needs you'),
      dots(TERMINAL, ['running', 'done'], 5, 'agents', null),
    ]

    expect(nodesOf(drawn, 'Svg')).toEqual([])
    expect(textOf(drawn[0])).toBe('━━━━━─────')
    expect(textOf(drawn[1])).toBe('52%')
    expect(nodesOf(drawn[2], 'Text')[0]?.props).toMatchObject({ color: 'permission' })
    expect(textOf(drawn[2])).toBe('▁▅█')
    expect(nodesOf(drawn[3], 'Text').filter(one => textOf(one) === '■').map(one => one.props?.color)).toEqual(['permission', 'success'])
    expect(nodesOf(drawn[4], 'Text')[0]?.props).toMatchObject({ color: 'warning' })
    expect(nodesOf(drawn[5], 'Text').filter(one => textOf(one) === '●').map(one => one.props?.color)).toEqual(['permission', 'success'])
  })

  test('with Svg: each is one Svg of its stated size, its alt said, never interactive', () => {
    const svgs = nodesOf(
      [
        bar(DESKTOP, 0.5, 'running', 300, 'half', true),
        bar(DESKTOP, 0.5, 'done', 300, 'half'),
        gauge(DESKTOP, 0.52, 'done', 'util'),
        sparkline(DESKTOP, [0, 4, 8], 'running', 'week', 60),
        stacked(DESKTOP, [{ label: 'in', value: 1, text: '1k', tone: 'running' }], 'tokens', 200),
        iconOf(DESKTOP, 'check', 'done', 'ok'),
      ],
      'Svg',
    )

    expect(svgs.map(svg => [svg.props?.width, svg.props?.height, svg.props?.alt])).toEqual([
      [300, 8, 'half'],
      [300, 4, 'half'],
      [24, 24, 'util'],
      [60, 16, 'week'],
      [200, 8, 'tokens'],
      [16, 16, 'ok'],
    ])
    expect(svgs.every(svg => svg.props?.isInteractive === undefined)).toBe(true)
    expect(String(svgs[5]?.props?.source)).toContain(`stroke="${FILL.done}"`)
  })
})

describe('the kit elements', () => {
  test('K6: a fixed-width subtle label, the value bold', () => {
    const row = kv(TERMINAL, '任务', 'Fix X') as Node
    const [label, value] = nodesOf(row, 'Text')

    expect(nodesOf(row, 'Box')[1]?.props).toMatchObject({ width: 7, flexShrink: 0 })
    expect(label?.props).toMatchObject({ color: 'subtle' })
    expect(value?.props).toMatchObject({ bold: true })
    expect(textOf(value)).toBe('Fix X')
  })

  test('K7: framed in warning or error', () => {
    expect((attention(TERMINAL, 'warning', null) as Node).props).toMatchObject({ borderColor: 'warning', borderStyle: 'round' })
    expect((attention(TERMINAL, 'error', null) as Node).props).toMatchObject({ borderColor: 'error' })
  })

  test('K8: columns × 9.5 px, kept within the bounds', () => {
    expect(pxWidth(40, 120, 720)).toBe(380)
    expect(pxWidth(5, 120, 720)).toBe(120)
    expect(pxWidth(200, 120, 720)).toBe(720)
  })

  test('a KPI tile: the label subtle, the value bold in its key; a zero tile inactive and not bold', () => {
    const tiles = nodesOf(kpis(TERMINAL, [{ label: 'a', value: '2', color: 'warning', isZero: false }, { label: 'b', value: '0', color: 'warning', isZero: true }]), 'Text')

    expect(tiles.map(one => [textOf(one), one.props?.color, one.props?.bold])).toEqual([
      ['a', 'subtle', undefined],
      ['2', 'warning', true],
      ['b', 'inactive', undefined],
      ['0', 'inactive', false],
    ])
  })
})
