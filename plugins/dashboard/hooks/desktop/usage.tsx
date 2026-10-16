import type { RenderChildren } from 'claude-code'

import type { UsageCounts } from '../../types'
import { fit, fmtTokens } from '../agent-model'
import { askLines } from '../board'
import { FILL, MEMORY, svg, TRACK } from '../desktop-svg'
import { t } from '../i18n'
import { isEmptyWeek } from '../usage'
import { capped, EDGE_CELLS, frame, FRAME_CELLS, headerOf, kpis, pxWidth, textCells } from './kit'
import type { El, PaneData } from './kit'

// The week's columns: their drawing's height, the tallest column, the baseline under them and the day labels' baseline.
const WEEK_H = 76
const COLUMN_MAX_H = 52
const BASELINE_Y = 61
const LABEL_Y = 73
const COLUMN_MAX_W = 38
// A legend row's label and value, in layout columns.
const LABEL_COLUMNS = 10
const VALUE_COLUMNS = 7

type Share = { label: string; value: number; text: string; color: string; detail?: string }

const sum = (values: readonly number[]) => values.reduce((total, n) => total + n, 0)
const rawOf = (one: UsageCounts) => one.input + one.cacheRead + one.cacheWrite + one.output
const pctOf = (n: number, total: number) => (total > 0 ? `${Math.round((n * 100) / total)}%` : '—')

/** K3 with the day labels under it: today's column in full, the earlier days lighter; a day without a request a faint stub. */
function weekSvg(days: readonly { label: string; value: number; isKnown: boolean }[], width: number): string {
  const top = Math.max(0, ...days.map(one => one.value))
  const barW = Math.min(COLUMN_MAX_W, (width - 2 * (days.length - 1)) / days.length)
  const step = days.length <= 1 ? 0 : (width - barW) / (days.length - 1)
  const num = (n: number) => String(Number(n.toFixed(1)))
  const columns = days.map((one, i) => {
    const x = i * step
    const isToday = i === days.length - 1
    const h = !one.isKnown || top <= 0 || one.value <= 0 ? 2 : Math.max(3, (one.value / top) * COLUMN_MAX_H)
    const paint = h === 2 ? `fill="${TRACK}" fill-opacity=".22"` : `fill="${FILL.running}"${isToday ? '' : ' fill-opacity=".45"'}`

    return (
      `<rect data-part="bar" x="${num(x)}" y="${num(BASELINE_Y - 1 - h)}" width="${num(barW)}" height="${num(h)}" rx="4" ${paint}/>` +
      `<text x="${num(x + barW / 2)}" y="${LABEL_Y}" font-size="10" fill="${TRACK}" text-anchor="middle">${one.label}</text>`
    )
  })

  return svg(width, WEEK_H, `${columns.join('')}<rect x="0" y="${BASELINE_Y}" width="${width}" height="1" fill="${TRACK}" fill-opacity=".4"/>`)
}

/** K4 whose parts take any Svg color, cache write's MEMORY among them: the kit's stacked bar takes tones only. */
function sharesSvg(parts: readonly Share[], width: number, barH = 8): string {
  const total = sum(parts.map(part => Math.max(0, part.value)))
  let x = 0
  const rects = parts.map(part => {
    const w = total <= 0 ? 0 : (Math.max(0, part.value) / total) * width
    const rect = w > 0 ? `<rect data-part="part" x="${Number(x.toFixed(2))}" y="0" width="${Number(w.toFixed(2))}" height="${barH}" fill="${part.color}"/>` : ''

    x += w
    return rect
  })

  return svg(
    width,
    barH,
    `<defs><clipPath id="shares"><rect width="${width}" height="${barH}" rx="${barH / 2}"/></clipPath></defs>` +
      `<rect data-part="track" width="${width}" height="${barH}" rx="${barH / 2}" fill="${TRACK}" fill-opacity=".22"/><g clip-path="url(#shares)">${rects.join('')}</g>`,
  )
}

/** The last 7 days' tiles, their columns, today's composition and the main thread against the subagents; then the question dialogs and the skills by calls; a frame each. */
export function usageBody(el: El, data: PaneData) {
  const { Box, Svg, Text } = el
  const week = data.usage

  if (week === undefined || isEmptyWeek(week)) {
    return [<Text color="subtle" wrap="truncate-end">{fit(t().usageEmpty, textCells(data.columns - EDGE_CELLS))}</Text>]
  }

  const width = data.columns - FRAME_CELLS - EDGE_CELLS
  const px = pxWidth(width, 120, 720)
  const line = (text: string, color: 'text' | 'subtle') => (
    <Text color={color} wrap="truncate-end">
      {fit(text, textCells(width))}
    </Text>
  )
  const note = (text: string) => (
    <Text color="subtle" wrap="wrap">
      {text}
    </Text>
  )
  // A day without a request recorded is unknown, not 0.
  const figure = (one: UsageCounts, n: number) => (one.requests === 0 ? '—' : fmtTokens(n))
  const countsText = (one: UsageCounts) => t().usageCounts(figure(one, one.input), figure(one, one.cacheRead), figure(one, one.cacheWrite), figure(one, one.output))
  const swatch = (color: string) => <Svg source={svg(10, 10, `<rect width="10" height="10" rx="2.5" fill="${color}"/>`)} alt="" width={10} height={10} />

  /** The bar of `parts`, then a row each: its swatch, label, value bold, share subtle; its detail subtle under it. */
  const shares = (parts: readonly Share[], alt: string): RenderChildren[] => {
    const total = sum(parts.map(part => part.value))

    return [
      <Svg source={sharesSvg(parts, px)} alt={alt} width={px} height={8} />,
      ...parts.map(part => (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1} alignItems="center">
            {swatch(part.color)}
            <Box width={LABEL_COLUMNS} flexShrink={0}>
              <Text color="text" wrap="truncate-end">
                {part.label}
              </Text>
            </Box>
            <Box width={VALUE_COLUMNS} flexShrink={0}>
              <Text color="text" bold>
                {part.text}
              </Text>
            </Box>
            <Text color="subtle">{part.text === '—' ? '—' : pctOf(part.value, total)}</Text>
          </Box>
          {part.detail === undefined ? null : line(part.detail, 'subtle')}
        </Box>
      )),
    ]
  }

  const today = week.days[0]!
  const todayRaw = rawOf(today.counts)
  const isTodayKnown = today.counts.requests > 0
  const weekTotal = sum(week.days.map(one => one.equivalent))
  const threadTotal = sum(week.threads.map(one => one.equivalent))
  const subagents = week.threads.find(one => one.thread === 'subagent')?.equivalent ?? 0
  const cacheShare = isTodayKnown ? pctOf(today.counts.cacheRead, todayRaw) : '—'
  const subShare = pctOf(subagents, threadTotal)

  const tiles = kpis(el, [
    { label: t().usageToday, value: figure(today.counts, today.equivalent), color: 'text', isZero: !isTodayKnown },
    { label: t().usageColumns.cacheRead, value: cacheShare, color: 'success', isZero: cacheShare === '—' },
    { label: t().usageThreads.subagent, value: subShare, color: 'text', isZero: subShare === '—' },
    { label: t().usageWeek, value: fmtTokens(weekTotal), color: 'text', isZero: weekTotal === 0 },
  ])

  // Oldest first, so today is the rightmost column.
  const oldestFirst = [...week.days].reverse()
  const weekdayOf = (day: string) => t().usageWeekdays[new Date(`${day}T12:00:00Z`).getUTCDay()] ?? day.slice(5)
  const days = [
    headerOf(el, t().usageWeekTitle, undefined, <Text color="subtle">{`${t().usageToday} ${figure(today.counts, today.equivalent)}`}</Text>),
    ...t().usageWeights.map(note),
    <Svg
      source={weekSvg(
        oldestFirst.map((one, i) => ({ label: i === oldestFirst.length - 1 ? t().usageToday : weekdayOf(one.day), value: one.equivalent, isKnown: one.counts.requests > 0 })),
        px,
      )}
      alt={t().usageWeekAlt(oldestFirst.map(one => `${one.day.slice(5)} ${figure(one.counts, one.equivalent)}`).join(t().altSeparator))}
      width={px}
      height={WEEK_H}
    />,
  ]
  const kinds: Share[] = [
    { label: t().usageColumns.input, value: today.counts.input, text: figure(today.counts, today.counts.input), color: FILL.running },
    { label: t().usageColumns.cacheRead, value: today.counts.cacheRead, text: figure(today.counts, today.counts.cacheRead), color: FILL.done },
    { label: t().usageColumns.cacheWrite, value: today.counts.cacheWrite, text: figure(today.counts, today.counts.cacheWrite), color: MEMORY },
    { label: t().usageColumns.output, value: today.counts.output, text: figure(today.counts, today.counts.output), color: FILL.stale },
  ]
  const composition = [
    headerOf(el, t().usageTodayTitle, undefined, <Text color="subtle">{figure(today.counts, todayRaw)}</Text>),
    ...shares(kinds, kinds.map(one => `${one.label} ${one.text}`).join(t().altSeparator)),
  ]
  const threadParts: Share[] = week.threads.map(one => ({
    label: t().usageThreads[one.thread],
    value: one.equivalent,
    text: fmtTokens(one.equivalent),
    color: one.thread === 'main' ? FILL.running : MEMORY,
    detail: `${t().usageRequests(one.counts.requests)} · ${countsText(one.counts)}`,
  }))
  const threads = [
    headerOf(el, t().usageThreadsTitle),
    ...shares(threadParts, threadParts.map(one => `${one.label} ${one.text} ${t().usageShare(pctOf(one.value, threadTotal))}`).join(t().altSeparator)),
  ]
  const asks = week.asks.dialogs === 0 ? [] : [headerOf(el, t().usageAsksTitle), ...askLines(week.asks).map((text, i) => line(text, i === 0 ? 'text' : 'subtle'))]
  const skills =
    week.skills.length === 0
      ? []
      : [
          headerOf(el, t().usageSkillsTitle, week.skills.length),
          ...capped(
            el,
            data,
            'skills',
            week.skills.map(one => (
              <Box flexDirection="column">
                {line(one.name, 'text')}
                {line(t().usageSkillCounts(one.invocations, one.inline, one.forked, one.errors), 'subtle')}
              </Box>
            )),
          ),
        ]

  return [
    <Box flexDirection="column" gap={1}>
      {tiles}
      {[days, composition, threads, asks, skills].filter(rows => rows.length > 0).map(rows => frame(el, rows))}
      <Box flexDirection="column">{t().usageCoverage.map(note)}</Box>
    </Box>,
  ]
}
