import { describe, expect, test } from 'claude-code/testing'

import { elapsedBar, FILL, horizontalGauge, MEMORY, scaleOf, TRACK } from '../hooks/desktop-svg'
import type { Tone } from '../hooks/desktop-svg'

/** The numeric attribute `name` of the first element tagged `data-part="part"`. */
function attrOf(svg: string, part: string, name: string): number {
  const tag = svg.match(new RegExp(`<[a-z]+ data-part="${part}"[^>]*>`))?.[0] ?? ''

  return Number(tag.match(new RegExp(` ${name}="([^"]+)"`))?.[1])
}

describe('the common scale', () => {
  test('rounds up to the first step that holds the longest time', () => {
    expect(scaleOf(3 * 60)).toEqual({ secs: 5 * 60, label: '0—5 min' })
    expect(scaleOf(7 * 60)).toEqual({ secs: 10 * 60, label: '0—10 min' })
    expect(scaleOf(240 * 60).label).toBe('0—240 min')
  })

  test('past 240 minutes, whole hours', () => {
    expect(scaleOf(250 * 60)).toEqual({ secs: 5 * 3600, label: '0—5 h' })
  })
})

describe('the elapsed bar', () => {
  test('is a whole svg document', () => {
    const svg = elapsedBar(60, 300, 'running', true)

    expect(svg).toStartWith('<svg')
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  test('half the scale fills half the track', () => {
    const svg = elapsedBar(150, 300, 'done', false)
    const track = attrOf(svg, 'track', 'width')

    expect(track).toBeGreaterThan(0)
    expect(Math.abs(attrOf(svg, 'fill', 'width') - track / 2)).toBeLessThanOrEqual(1)
  })

  test('a running bar ends in an arrow, an ended one in a square', () => {
    expect(elapsedBar(60, 300, 'running', true)).toContain('<path data-part="end"')
    expect(elapsedBar(60, 300, 'done', false)).toContain('<rect data-part="end"')
  })

  test('an unknown time is a dashed empty track, not a zero', () => {
    const svg = elapsedBar(null, 300, 'running', true)

    expect(svg).toContain('stroke-dasharray')
    expect(svg).not.toContain('data-part="fill"')
  })
})

describe('the horizontal gauge', () => {
  test('a null value is a dashed empty rounded bar', () => {
    const svg = horizontalGauge(null, FILL.done)

    expect(svg).toStartWith('<svg')
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toMatch(/data-part="track"[^>]*stroke-dasharray/)
    expect(svg).not.toContain('data-part="fill"')
  })

  test('52% fills 0.52 of the track width', () => {
    const svg = horizontalGauge(0.52, FILL.done, false, 474, 12)
    const track = attrOf(svg, 'track', 'width')
    const fill = attrOf(svg, 'fill', 'width')

    expect(track).toBeGreaterThan(0)
    expect(Math.abs(fill / track - 0.52)).toBeLessThan(0.01)
  })

  test('stale gauge uses hatched pattern fill', () => {
    const svg = horizontalGauge(0.52, FILL.done, true)

    expect(svg).toContain('<pattern id="hatch"')
    expect(svg).toContain('fill="url(#hatch)"')
  })
})

/** WCAG relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(at => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255

    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio of two `#rrggbb` colors. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]

  return (hi + 0.05) / (lo + 0.05)
}

// An Svg is drawn as an image, so it sees neither the theme nor currentColor: the extremes of each theme stand in for its background.
const BACKGROUNDS = { light: '#FFFFFF', dark: '#000000' } as const
const TONES: Tone[] = ['running', 'done', 'failed', 'stale']
const DRAWN = [
  ...TONES.flatMap(tone => [elapsedBar(60, 300, tone, true), elapsedBar(150, 300, tone, false), elapsedBar(null, 300, tone, true)]),
  horizontalGauge(0.52, FILL.done, false),
  horizontalGauge(0.76, MEMORY, false),
  horizontalGauge(0.52, FILL.done, true),
  horizontalGauge(null, FILL.done, false),
]

describe('readable on a light and a dark theme', () => {
  test('the contrast measure spans 1:1 to 21:1', () => {
    expect(contrast(BACKGROUNDS.light, BACKGROUNDS.light)).toBe(1)
    expect(Math.abs(contrast(BACKGROUNDS.light, BACKGROUNDS.dark) - 21)).toBeLessThan(1e-9)
  })

  for (const [theme, background] of Object.entries(BACKGROUNDS)) {
    test(`every color an Svg draws keeps 3:1 or more against the ${theme} background`, () => {
      const colors = new Set(
        DRAWN.flatMap(svg => [...svg.matchAll(/ (?:fill|stroke)="([^"]+)"/g)].map(m => m[1] ?? '')).filter(
          c => c !== 'none' && !c.startsWith('url('),
        ),
      )

      expect([...colors].sort(), 'every fill, memory, and the track are drawn').toEqual(
        [TRACK, MEMORY, ...Object.values(FILL)].sort(),
      )

      for (const color of colors) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/i)
        expect(contrast(color, background), color).toBeGreaterThanOrEqual(3)
      }
    })
  }
})
