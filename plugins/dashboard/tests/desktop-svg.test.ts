import { describe, expect, test } from 'claude-code/testing'

import { dotsSvg, elapsedBar, FILL, fitText, horizontalGauge, icon, ICON_PATHS, MEMORY, ring, scaleOf, sparkBars, sparkText, stackedBar, textPx, TRACK } from '../hooks/desktop-svg'
import type { IconName } from '../hooks/desktop-svg'
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

  test('a running bar ends in a dot at its head, an ended one in its rounded fill alone', () => {
    expect(elapsedBar(60, 300, 'running', true)).toContain('<circle data-part="head"')
    expect(elapsedBar(60, 300, 'done', false)).not.toContain('data-part="head"')
    expect(elapsedBar(60, 300, 'done', false)).not.toContain('data-part="end"')
  })

  test('K1: the track is TRACK filled at 22% with round ends, never stroked; the fill is rounded too', () => {
    for (const svg of [elapsedBar(60, 300, 'done', false), elapsedBar(60, 300, 'running', true), horizontalGauge(0.5, FILL.done)]) {
      expect(svg).toMatch(new RegExp(`data-part="track"[^>]* rx="[1-9][^"]*" fill="${TRACK}" fill-opacity=".22"`))
      expect(svg).not.toMatch(/data-part="track"[^>]*stroke=/)
      expect(svg).toMatch(/data-part="fill"[^>]* rx="[1-9]/)
    }
  })

  test('the head dot stays inside the drawing at either end', () => {
    for (const secs of [0, 300]) {
      const svg = elapsedBar(secs, 300, 'running', true, 200, 10)
      const cx = attrOf(svg, 'head', 'cx')
      const r = attrOf(svg, 'head', 'r')

      expect(cx - r).toBeGreaterThanOrEqual(0)
      expect(cx + r).toBeLessThanOrEqual(200)
    }
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

describe('the kit drawings', () => {
  test('K2: a ring of radius 9 and stroke 3 that starts at the top with a round cap; half fills half the circumference', () => {
    const svg = ring(0.5, FILL.done)

    expect(svg).toContain('viewBox="0 0 24 24"')
    expect(svg).toMatch(/data-part="track"[^>]* r="9"[^>]*stroke-opacity=".22" stroke-width="3"/)
    expect(svg).toMatch(/data-part="fill"[^>]*stroke-width="3" stroke-linecap="round"[^>]*transform="rotate\(-90 12 12\)"/)

    const [filled, whole] = (svg.match(/stroke-dasharray="([^"]+)"/)?.[1] ?? '').split(' ').map(Number) as [number, number]

    expect(Math.abs(filled / whole - 0.5)).toBeLessThan(0.01)
    expect(ring(0, FILL.done), 'nothing filled draws no cap').not.toContain('data-part="fill"')
    expect(ring(null, FILL.done)).not.toContain('data-part="fill"')
  })

  test('K3: the terminal levels run ▁ to █, the largest at █; the columns put the largest at full height', () => {
    expect(sparkText([0, 4, 8])).toBe('▁▅█')
    expect(sparkText([0, 0])).toBe('▁▁')

    const svg = sparkBars([1, 2, 4, 0], FILL.running, 100, 20)
    const heights = [...svg.matchAll(/data-part="bar"[^>]* height="([^"]+)"/g)].map(m => Number(m[1]))

    expect(heights).toEqual([5, 10, 20, 2])
    expect(svg, 'a zero is a faint stub').toContain('fill-opacity=".22"')
  })

  test('K4: each part takes its share of the width, in its tone', () => {
    const svg = stackedBar([{ value: 1, tone: 'running' }, { value: 3, tone: 'done' }], 200)
    const parts = [...svg.matchAll(/data-part="part"[^>]* width="([^"]+)"[^>]* fill="([^"]+)"/g)].map(m => [Number(m[1]), m[2]])

    expect(parts).toEqual([[50, FILL.running], [150, FILL.done]])
    expect(stackedBar([{ value: 0, tone: 'done' }], 200)).not.toContain('data-part="part"')
  })

  test('K5: every icon is a stroked path on the 24 grid', () => {
    for (const name of Object.keys(ICON_PATHS) as IconName[]) {
      const svg = icon(name, FILL.stale)

      expect(svg, name).toContain('viewBox="0 0 24 24"')
      expect(svg, name).toContain(`stroke="${FILL.stale}"`)
      expect(svg, name).toContain('fill="none"')
    }

    expect(Object.keys(ICON_PATHS).sort()).toEqual(['agent', 'check', 'clock', 'gpu', 'running', 'shield', 'terminal', 'warning'])
  })

  test('K8: a CJK character counts 1em, so a Chinese title is cut where it fills the room', () => {
    expect(textPx('需要你', 10)).toBe(30)
    expect(textPx('abc', 10)).toBeLessThan(20)
    expect(fitText('需要你处理的任务', 10, 50)).toBe('需要你处…')
    expect(fitText('short', 10, 100)).toBe('short')
    expect(textPx(fitText('一二三四五六七八九十', 12, 70), 12)).toBeLessThanOrEqual(70)
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
  ring(0.4, FILL.done),
  ring(0.7, MEMORY),
  sparkBars([1, 0, 3], FILL.running, 60, 16),
  stackedBar([{ value: 1, tone: 'running' }, { value: 1, tone: 'done' }, { value: 1, tone: 'failed' }, { value: 1, tone: 'stale' }], 120),
  icon('warning', FILL.stale),
  dotsSvg(['running', 'done', 'idle', 'failed']),
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
        [...new Set([TRACK, MEMORY, ...Object.values(FILL)])].sort(),
      )

      for (const color of colors) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/i)
        expect(contrast(color, background), color).toBeGreaterThanOrEqual(3)
      }
    })
  }
})
