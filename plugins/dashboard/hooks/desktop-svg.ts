/** Which state a chip or a chart shows; needs-action shares `stale`'s colors. */
export type Tone = 'running' | 'done' | 'failed' | 'stale'

/** The theme key each tone's text takes, so it follows the host's light or dark theme. */
export const TONE_KEYS: Record<Tone, string> = { running: 'permission', done: 'success', failed: 'error', stale: 'warning' }

/** Track, axis, and hatching in an Svg: mid gray keeps ≥3:1 against both light and dark. */
export const TRACK = '#71717A'

/** Dedicated color for VRAM / RAM memory in an Svg. */
export const MEMORY = '#8A6CC9'

/** Each fill's relative luminance keeps ≥3:1 against black and white backgrounds. */
export const FILL: Record<Tone, string> = {
  running: '#0284C7',
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

/** How long something has run against `scaleSecs`: square end when ended, open arrow when running, dashed outline when unknown. */
export function elapsedBar(
  secs: number | null,
  scaleSecs: number,
  tone: Tone,
  isRunning: boolean,
  width: number = BAR.width,
  height: number = BAR.height,
): string {
  const mid = height / 2
  const barH = 6
  const y = mid - barH / 2

  if (secs === null) {
    return svg(
      width,
      height,
      `<rect data-part="track" x="0.5" y="${y + 0.5}" width="${width - 1}" height="${barH - 1}" rx="1" fill="none" stroke="${TRACK}" stroke-dasharray="4 3"/>`,
    )
  }

  const end = clamp(secs / scaleSecs, 0, 1) * width
  const color = FILL[tone]
  const marker = endMarker(end, y, barH, width, color, isRunning)

  return svg(
    width,
    height,
    `<rect data-part="track" x="0.5" y="${y + 0.5}" width="${width - 1}" height="${barH - 1}" fill="none" stroke="${TRACK}"/>` +
      `<rect data-part="fill" x="0" y="${y}" width="${num(end)}" height="${barH}" fill="${color}"/>${marker}`,
  )
}

/** Horizontal 8 px rounded bar gauge: dashed outline when unknown, hatched fill when stale. */
export function horizontalGauge(
  frac: number | null,
  color: string,
  isStale = false,
  width: number = GAUGE.standard.width,
  height: number = GAUGE.standard.height,
): string {
  const mid = height / 2
  const barH = 8
  const y = mid - barH / 2
  const rx = barH / 2

  if (frac === null) {
    return svg(
      width,
      height,
      `<rect data-part="track" x="0.5" y="${y + 0.5}" width="${width - 1}" height="${barH - 1}" rx="${rx}" fill="none" stroke="${TRACK}" stroke-dasharray="4 3"/>`,
    )
  }

  const end = clamp(frac, 0, 1) * width
  const defs = isStale ? HATCH.defs : ''
  const fillAttr = isStale ? `fill="${HATCH.fill}"` : `fill="${color}"`
  const fillRect =
    end > 0
      ? `<rect data-part="fill" x="0" y="${y}" width="${num(end)}" height="${barH}" rx="${rx}" ${fillAttr}/>`
      : ''

  return svg(
    width,
    height,
    `${defs}<rect data-part="track" x="0.5" y="${y + 0.5}" width="${width - 1}" height="${barH - 1}" rx="${rx}" fill="none" stroke="${TRACK}"/>${fillRect}`,
  )
}
