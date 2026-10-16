import type { RenderChildren } from 'claude-code'

import { fmtAge, fmtDuration } from '../agent-model'
import { MEMORY, ring } from '../desktop-svg'
import { t } from '../i18n'
import { card, gauge, iconOf, kpis } from './kit'
import type { El, PaneData } from './kit'

/** Fills `/gpu ` into the prompt; register.tsx passes it beside PaneData. */
export type GpuFill = { onFillGpu?: () => void }

const gib = (mib: number) => (mib / 1024).toFixed(1)
const shortName = (name: string) => name.replace(/^NVIDIA /, '').replace(/^GeForce /, '')
const pct = (n: number | null) => (n === null ? 'N/A' : `${n}%`)
const RING_PX = 22

/** One GPU's or the Tegra's numbers as its row draws them. */
type Gauges = { title: string; meta: string; util: number | null; utilAlt: string; memFrac: number | null; memText: string; memAlt: string }

export function gpuBody(el: El, data: PaneData & GpuFill) {
  const { Box, Button, Input, Select, Svg, Text } = el
  const watch = data.gpu
  const now = data.now

  if (watch === null) {
    const hosts = data.gpuHosts ?? []
    return [
      card(el, [
        <Box flexDirection="column" alignItems="center" rowGap={1} paddingY={1}>
          {iconOf(el, 'gpu', 'idle', t().watchGpu, 32)}
          <Text color="subtle" wrap="wrap">
            {t().noHost}
          </Text>
          <Button key="gpu-fill" label={t().gpuFill} variant="secondary" onPress={() => data.onFillGpu?.()} />
        </Box>,
      ]),
      <Box flexDirection="column" gap={1}>
        {hosts.length > 0 && (
          <Select
            key="gpu-select-host"
            label={t().gpuConfiguredHost}
            options={hosts.map(h => ({ value: h, label: h }))}
            onSelect={host => data.onConnectGpu?.(host)}
          />
        )}
        <Input
          key="gpu-input-host"
          label={t().gpuSshHost}
          placeholder="host"
          submitLabel={t().connect}
          onSubmit={host => data.onConnectGpu?.(host)}
        />
      </Box>,
    ]
  }

  const isStale = watch.error !== null
  const sample = watch.sample
  // Stale numbers keep their values, dimmed.
  const valueColor = isStale ? 'inactive' : 'text'
  const staleLines = isStale
    ? [
        <Text color="warning" wrap="truncate-end">
          {watch.okAt === null ? t().noSampleYet : t().gpuStaleAgo(fmtAge(now - watch.okAt))}
        </Text>,
        <Text color="subtle" wrap="truncate-end">{`✗ ${watch.error}`}</Text>,
      ]
    : []
  const gpuCount = sample?.kind === 'nvidia' ? sample.gpus.length : sample?.kind === 'tegra' ? 1 : 0
  const head = (
    <Box flexDirection="row" columnGap={1} alignItems="center" justifyContent="space-between">
      <Text color="text" bold wrap="truncate">
        {watch.host}
      </Text>
      <Text color="subtle" wrap="truncate-end">
        {[...(gpuCount === 0 ? [] : [`${gpuCount} GPU`]), ...(watch.okAt === null ? [] : [t().updatedAgo(fmtDuration(now - watch.okAt))])].join(' · ')}
      </Text>
    </Box>
  )
  const buttons = (
    <Box flexDirection="row" columnGap={1}>
      <Button key="gpu-change-host" label={t().changeHost} variant="secondary" onPress={() => data.onChangeGpuHost?.()} />
      <Button key="gpu-refresh" label={t().refresh} variant="secondary" onPress={() => data.onConnectGpu?.(watch.host)} />
    </Box>
  )
  const hostCard = (rows: RenderChildren[]) => [...staleLines, card(el, [head, ...rows, buttons])]

  if (sample === null) {
    return hostCard(isStale ? [] : [<Text color="subtle">{t().gpuConnecting(watch.host)}</Text>])
  }

  if (sample.kind === 'none' || sample.kind === 'error') {
    return hostCard([<Text color="subtle">{sample.kind === 'none' ? t().gpuNone : sample.message}</Text>])
  }

  /** K2 in MEMORY: the kit's gauge takes a tone, and memory has a color of its own. */
  const memoryRing = (frac: number | null, alt: string) => <Svg source={ring(frac, MEMORY, RING_PX, isStale)} alt={alt} width={RING_PX} height={RING_PX} />

  /** A ring, its percent bold (dim while stale), its label subtle. */
  const ringCell = (drawn: RenderChildren, value: string, label: string) => (
    <Box flexDirection="row" columnGap={1} alignItems="center">
      {drawn}
      <Text color={valueColor} {...(!isStale && { bold: true })}>
        {value}
      </Text>
      <Text color="subtle" wrap="truncate-end">
        {label}
      </Text>
    </Box>
  )

  const row = (one: Gauges) => (
    <Box flexDirection="column" rowGap={1}>
      <Text wrap="truncate-end">
        <Text color={valueColor} bold>
          {one.title}
        </Text>
        {one.meta === '' ? null : <Text color="subtle">{`  ${one.meta}`}</Text>}
      </Text>
      <Box flexDirection="row" columnGap={3} rowGap={1} flexWrap="wrap">
        {ringCell(gauge(el, one.util === null ? null : one.util / 100, 'running', one.utilAlt, RING_PX, isStale), pct(one.util), t().gpuUtilLabel)}
        {ringCell(memoryRing(one.memFrac, one.memAlt), one.memFrac === null ? 'N/A' : `${Math.round(one.memFrac * 100)}%`, t().vram(one.memText))}
      </Box>
    </Box>
  )

  const rows: Gauges[] =
    sample.kind === 'tegra'
      ? [
          (() => {
            const memFrac = sample.ramUsed !== null && sample.ramTotal !== null && sample.ramTotal > 0 ? sample.ramUsed / sample.ramTotal : null

            return {
              title: 'Tegra',
              meta: sample.temp === null ? '' : `${Math.round(sample.temp)}°C`,
              util: sample.util,
              utilAlt: t().tegraUtilAlt(pct(sample.util), isStale),
              memFrac,
              memText: sample.ramUsed !== null && sample.ramTotal !== null ? `${gib(sample.ramUsed)} / ${gib(sample.ramTotal)} GiB` : 'N/A',
              memAlt: t().tegraRamAlt(gib(sample.ramUsed ?? 0), gib(sample.ramTotal ?? 1), Math.round((memFrac ?? 0) * 100), isStale),
            }
          })(),
        ]
      : sample.gpus.map(one => {
          const memFrac = one.memUsed !== null && one.memTotal !== null && one.memTotal > 0 ? one.memUsed / one.memTotal : null

          return {
            title: `GPU${one.index}`,
            meta: [shortName(one.name), ...(one.temp === null ? [] : [`${one.temp}°C`]), ...(one.power === null ? [] : [`${Math.round(one.power)}W`])].join(' · '),
            util: one.util,
            utilAlt: t().gpuUtilAlt(one.index, pct(one.util), isStale),
            memFrac,
            memText: one.memUsed !== null && one.memTotal !== null ? `${gib(one.memUsed)} / ${gib(one.memTotal)} GiB` : 'N/A',
            memAlt: t().gpuMemAlt(one.index, gib(one.memUsed ?? 0), gib(one.memTotal ?? 1), Math.round((memFrac ?? 0) * 100), isStale),
          }
        })

  // The tiles: the mean of the utilizations known, memory used over the total known; a value unknown is `—`, never 0.
  const utils = rows.flatMap(one => (one.util === null ? [] : [one.util]))
  const mems = sample.kind === 'tegra' ? (sample.ramUsed !== null && sample.ramTotal !== null ? [[sample.ramUsed, sample.ramTotal]] : []) : sample.gpus.flatMap(one => (one.memUsed !== null && one.memTotal !== null ? [[one.memUsed, one.memTotal]] : []))
  const memTotal = mems.reduce((sum, [, total]) => sum + (total ?? 0), 0)
  const utilTile = utils.length === 0 ? '—' : `${Math.round(utils.reduce((sum, n) => sum + n, 0) / utils.length)}%`
  const memTile = memTotal <= 0 ? '—' : `${Math.round((mems.reduce((sum, [used]) => sum + (used ?? 0), 0) * 100) / memTotal)}%`
  const tiles = kpis(el, [
    { label: t().gpuKpiHosts, value: '1', color: valueColor, isZero: false },
    { label: t().gpuKpiGpus, value: String(rows.length), color: valueColor, isZero: rows.length === 0 },
    { label: t().gpuUtilLabel, value: utilTile, color: isStale ? 'inactive' : 'permission', isZero: utilTile === '—' },
    { label: t().gpuVramLabel, value: memTile, color: valueColor, isZero: memTile === '—' },
  ])

  const procs = sample.kind === 'nvidia' ? [...sample.procs].sort((a, b) => (b.memMiB ?? 0) - (a.memMiB ?? 0)).slice(0, 5) : []
  const top5 =
    procs.length === 0
      ? []
      : [
          <Text color={valueColor} bold>
            {t().topProcs}
          </Text>,
          ...procs.map(one => (
            <Box flexDirection="row" columnGap={1} justifyContent="space-between">
              <Box flexShrink={1} minWidth={0}>
                <Text color="subtle" wrap="truncate-end">
                  {one.name}
                </Text>
              </Box>
              <Box flexShrink={0}>
                <Text color="subtle">{`${one.memMiB === null ? 'N/A' : `${gib(one.memMiB)} GiB`} · PID ${one.pid}`}</Text>
              </Box>
            </Box>
          )),
        ]

  return [...staleLines, tiles, card(el, [head, ...rows.map(row), ...top5, buttons])]
}
