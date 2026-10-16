/** Which state a chip or a chart shows; needs-action shares `stale`'s colors. */
export type Tone = 'running' | 'idle' | 'done' | 'failed' | 'stale'

/** The theme key each tone's text takes, so it follows the host's light or dark theme. */
export const TONE_KEYS: Record<Tone, string> = { running: 'permission', idle: 'inactive', done: 'success', failed: 'error', stale: 'warning' }

/** Track, axis, and hatching in an Svg: mid gray keeps ≥3:1 against both light and dark. */
export const TRACK = '#71717A'

/** Dedicated color for VRAM / RAM memory in an Svg. */
export const MEMORY = '#8A6CC9'

/** Each fill's relative luminance keeps ≥3:1 against black and white backgrounds. */
export const FILL: Record<Tone, string> = {
  running: '#0284C7',
  idle: TRACK,
  done: '#16A34A',
  failed: '#DC2626',
  stale: '#D97706',
}

export const BAR = { width: 360, height: 10 } as const
export const BAR_SIZES = {
  standard: { width: 360, height: 10 },
  narrow: { width: 224, height: 10 },
  wide: { width: 240, height: 10 },
} as const

export const GAUGES = { width: 474, height: 12 } as const
export const GAUGE = {
  standard: { width: 474, height: 12 },
  narrow: { width: 304, height: 12 },
} as const

/** One timeline lane, and the time axis above the lanes; the wide tier's lane sits right of a 280 px label column. */
export const LANE = {
  standard: { width: 498, height: 12 },
  narrow: { width: 328, height: 12 },
  wide: { width: 572, height: 12 },
} as const

/** Diagonal TRACK hatching: put `defs` in the Svg, give a shape `fill`. */
export const HATCH = {
  defs: `<defs><pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="6" stroke="${TRACK}" stroke-width="2"/></pattern></defs>`,
  fill: 'url(#hatch)',
} as const

const STEPS_MIN = [5, 10, 20, 30, 60, 120, 240]

const num = (n: number) => String(Number(n.toFixed(2)))

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n))

export const svg = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`

/** The end of a bar at x `end`, `barH` tall from `y`: an open arrow while it runs, else a square. */
export function endMarker(end: number, y: number, barH: number, width: number, color: string, isOpen: boolean): string {
  return isOpen
    ? `<path data-part="end" d="M ${num(clamp(end - 4, 0, width - 5))} ${y} L ${num(clamp(end, 4, width - 1))} ${y + barH / 2} L ${num(clamp(end - 4, 0, width - 5))} ${y + barH}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<rect data-part="end" x="${num(clamp(end - barH, 0, width - barH))}" y="${y}" width="${barH}" height="${barH}" fill="${color}"/>`
}

/** The scale a group of elapsed times shares: the first step of minutes that holds `maxSecs`, past 240 minutes whole hours. */
export function scaleOf(maxSecs: number): { secs: number; label: string } {
  const step = STEPS_MIN.find(one => one * 60 >= maxSecs)

  if (step !== undefined) {
    return { secs: step * 60, label: `0—${step} min` }
  }

  const hours = Math.ceil(maxSecs / 3600)

  return { secs: hours * 3600, label: `0—${hours} h` }
}

/** K1's options: the bar's thickness, the drawing's height (the head's diameter), a dot at the head while it runs, hatching when stale. */
export type BarShape = { barH?: number; height?: number; head?: boolean; isStale?: boolean }

/** K1: a filled rounded bar `frac` along a TRACK track at 22% opacity; null, a dashed empty track. */
export function roundedBar(frac: number | null, color: string, width: number, shape: BarShape = {}): string {
  const barH = shape.barH ?? 4
  const height = shape.height ?? (shape.head === true ? barH * 2 : barH)
  const y = (height - barH) / 2
  const rx = barH / 2

  if (frac === null) {
    return svg(
      width,
      height,
      `<rect data-part="track" x="0.5" y="${y + 0.5}" width="${width - 1}" height="${barH - 1}" rx="${rx}" fill="none" stroke="${TRACK}" stroke-dasharray="4 3"/>`,
    )
  }

  const end = clamp(frac, 0, 1) * width
  const paint = shape.isStale === true ? HATCH.fill : color
  const fill = end > 0 ? `<rect data-part="fill" x="0" y="${y}" width="${num(end)}" height="${barH}" rx="${rx}" fill="${paint}"/>` : ''
  const r = height / 2
  const head = shape.head === true ? `<circle data-part="head" cx="${num(clamp(end - rx, r, width - r))}" cy="${r}" r="${r}" fill="${paint}"/>` : ''

  return svg(
    width,
    height,
    `${shape.isStale === true ? HATCH.defs : ''}<rect data-part="track" x="0" y="${y}" width="${width}" height="${barH}" rx="${rx}" fill="${TRACK}" fill-opacity=".22"/>${fill}${head}`,
  )
}

/** How long something has run against `scaleSecs`, as a K1 bar: a dot at the head while running, a dashed track when unknown. */
export function elapsedBar(
  secs: number | null,
  scaleSecs: number,
  tone: Tone,
  isRunning: boolean,
  width: number = BAR.width,
  height: number = BAR.height,
): string {
  return roundedBar(secs === null ? null : secs / scaleSecs, FILL[tone], width, { barH: 6, height, head: isRunning })
}

/** Horizontal 8 px K1 gauge: dashed outline when unknown, hatched fill when stale. */
export function horizontalGauge(
  frac: number | null,
  color: string,
  isStale = false,
  width: number = GAUGE.standard.width,
  height: number = GAUGE.standard.height,
): string {
  return roundedBar(frac, color, width, { barH: 8, height, isStale })
}

const RING_R = 9
const RING_C = 2 * Math.PI * RING_R

/** K2: a ring gauge on the 24 grid, radius 9 and stroke 3, filling clockwise from the top with a round cap; null, the track alone. */
export function ring(frac: number | null, color: string, size = 24, isStale = false): string {
  const filled = clamp(frac ?? 0, 0, 1) * RING_C
  const paint = isStale ? HATCH.fill : color
  const arc =
    filled > 0
      ? `<circle data-part="fill" cx="12" cy="12" r="${RING_R}" fill="none" stroke="${paint}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${num(filled)} ${num(RING_C)}" transform="rotate(-90 12 12)"/>`
      : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">${isStale ? HATCH.defs : ''}<circle data-part="track" cx="12" cy="12" r="${RING_R}" fill="none" stroke="${TRACK}" stroke-opacity=".22" stroke-width="3"/>${arc}</svg>`
}

/** The terminal's sparkline levels, lowest first. */
export const SPARK_LEVELS = '▁▂▃▄▅▆▇█'

/** K3 on the terminal: one level per value, the largest at `█`. */
export function sparkText(values: readonly number[]): string {
  const top = Math.max(0, ...values)

  return values.map(value => SPARK_LEVELS[top <= 0 ? 0 : Math.round((clamp(value, 0, top) / top) * (SPARK_LEVELS.length - 1))]).join('')
}

/** K3: one rounded column per value, the largest at full height; a zero is a faint stub. */
export function sparkBars(values: readonly number[], color: string, width: number, height: number): string {
  const gap = 2
  const top = Math.max(0, ...values)
  const barW = values.length === 0 ? 0 : (width - gap * (values.length - 1)) / values.length
  const rx = Math.min(2, barW / 2)
  const bars = values.map((value, index) => {
    const h = top <= 0 || value <= 0 ? 2 : Math.max(2, (value / top) * height)
    const paint = top <= 0 || value <= 0 ? `fill="${TRACK}" fill-opacity=".22"` : `fill="${color}"`

    return `<rect data-part="bar" x="${num(index * (barW + gap))}" y="${num(height - h)}" width="${num(barW)}" height="${num(h)}" rx="${num(rx)}" ${paint}/>`
  })

  return svg(width, height, bars.join(''))
}

/** K4: the parts side by side across `width` in proportion to their values, inside one rounded track. */
export function stackedBar(parts: readonly { value: number; tone: Tone }[], width: number, barH = 8): string {
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0)
  let x = 0
  const segments = parts.map(part => {
    const w = total <= 0 ? 0 : (Math.max(0, part.value) / total) * width
    const rect = w > 0 ? `<rect data-part="part" x="${num(x)}" y="0" width="${num(w)}" height="${barH}" fill="${FILL[part.tone]}"/>` : ''

    x += w
    return rect
  })

  return svg(
    width,
    barH,
    `<defs><clipPath id="stack"><rect width="${width}" height="${barH}" rx="${barH / 2}"/></clipPath></defs>` +
      `<rect data-part="track" width="${width}" height="${barH}" rx="${barH / 2}" fill="${TRACK}" fill-opacity=".22"/><g clip-path="url(#stack)">${segments.join('')}</g>`,
  )
}

export type IconName = 'check' | 'warning' | 'running' | 'agent' | 'terminal' | 'shield' | 'gpu' | 'clock'

/** K5: line icons on the 24 grid, stroked by `icon`. */
export const ICON_PATHS: Record<IconName, string> = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  warning: '<path d="M12 3.8 21 19.5H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  running: '<circle cx="12" cy="12" r="8.5" stroke-opacity=".3"/><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5"/>',
  agent: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4.5V8"/><path d="M9.5 13.5h.01M14.5 13.5h.01"/><path d="M3 12.5v2.5M21 12.5v2.5"/>',
  terminal: '<path d="M5 7l5 5-5 5"/><path d="M12 18h7"/>',
  shield: '<path d="M12 3.5l7 2.8v5.2c0 4.3-2.9 7.7-7 9-4.1-1.3-7-4.7-7-9V6.3z"/>',
  gpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
}

/** K5: one icon `size` px square, stroked in `color`. */
export const icon = (name: IconName, color: string, size = 16) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><g fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</g></svg>`

/** One dot per tone, 20 px apart: a running one larger in a faint ring, an idle one faint. */
export function dotsSvg(tones: readonly Tone[]): string {
  const dots = tones.map((tone, index) => {
    const cx = index * 20 + 8

    if (tone === 'running') {
      return `<circle cx="${cx}" cy="8" r="6" fill="${FILL.running}"/><circle cx="${cx}" cy="8" r="7.5" fill="none" stroke="${FILL.running}" stroke-opacity=".35"/>`
    }

    return `<circle cx="${cx}" cy="8" r="5" fill="${FILL[tone]}"${tone === 'idle' ? ' fill-opacity=".45"' : ''}/>`
  })

  return svg(Math.max(16, tones.length * 20 - 4), 16, dots.join(''))
}

// CJK, fullwidth forms and emoji advance about 1em.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏！-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

const charEm = (ch: string) => (WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Z@%mw]/.test(ch) ? 0.72 : 0.56)

/** About how many px `text` takes at `size` px in the system UI font. */
export const textPx = (text: string, size: number) => [...text].reduce((sum, ch) => sum + charEm(ch) * size, 0)

/** K8: `text` cut with `…` to fit `maxPx` at `size` px, for text inside an Svg. */
export function fitText(text: string, size: number, maxPx: number): string {
  if (textPx(text, size) <= maxPx) {
    return text
  }

  let out = ''

  for (const ch of text) {
    if (textPx(`${out}${ch}…`, size) > maxPx) {
      break
    }

    out += ch
  }

  return `${out}…`
}
