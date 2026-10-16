import { agentCards } from './desktop/agents'
import { detailBody } from './desktop/detail'
import { gpuBody } from './desktop/gpu'
import { tabs } from './desktop/kit'
import type { El, PaneData } from './desktop/kit'
import { overview } from './desktop/overview'
import { progressBody } from './desktop/progress'
import { runCards } from './desktop/reviews'
import { timelineBody } from './desktop/timeline'
import { usageBody } from './desktop/usage'

export { drawDesktopBand } from './desktop/band'
export { card, chip, MODEL_GLYPHS, modelTone, PIXELS_PER_COLUMN, posixQuote, textCells, widthTierOf } from './desktop/kit'
export type { PaneData } from './desktop/kit'

export function drawDesktopPaneError(el: El, data: Pick<PaneData, 'page' | 'pages' | 'onPage' | 'onClose'> & { message: string }) {
  const { Box, Text } = el

  return (
    <Box flexDirection="column" rowGap={1}>
      {tabs(el, data)}
      <Text color="error" wrap="truncate">{`✗ ${data.message}`}</Text>
    </Box>
  )
}

export function drawDesktopPane(el: El, data: PaneData) {
  const { Box } = el
  const body =
    detailBody(el, data) ??
    (data.page === 'overview'
      ? overview(el, data)
      : data.page === 'agents'
        ? agentCards(el, data)
        : data.page === 'mmrun'
          ? runCards(el, data)
          : data.page === 'timeline'
            ? timelineBody(el, data)
            : data.page === 'usage'
              ? usageBody(el, data)
              : data.page === 'progress'
                ? progressBody(el, data)
                : gpuBody(el, data))

  return (
    <Box flexDirection="column" rowGap={1}>
      {tabs(el, data)}
      {body}
    </Box>
  )
}
