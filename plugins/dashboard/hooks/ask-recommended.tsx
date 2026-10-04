import type { EngineInterface, HookFailure, On } from 'claude-code'

import { fit, widthOf } from './agent-model'
import { failureLine } from './failures'
import { t } from './i18n'

// The dialog's width when no surface has measured it.
const ASK_COLUMNS = 80

// What the button does: answers the pending AskUserQuestion call, the latest one whose every question has a recommended option.
let press: (() => void) | null = null

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Each question's one option whose label holds "(Recommended)", in order; null when any question has none or several. */
export function recommendedLabels(questions: readonly unknown[]): string[] | null {
  const labels = questions.map(one => {
    const options = isRecord(one) && Array.isArray(one.options) ? (one.options as unknown[]) : []
    const marked = options.map(option => (isRecord(option) ? option.label : undefined)).filter((label): label is string => typeof label === 'string' && label.includes('(Recommended)'))

    return marked.length === 1 ? marked[0]! : null
  })

  return labels.length > 0 && labels.every(label => label !== null) ? (labels as string[]) : null
}

/** Makes a call the pending dialog, replacing any before it: `pressed` resolves when the button is pressed; `done` clears it unless a later call took over. */
export function awaitPress(): { pressed: Promise<null>; done: () => void } {
  let mine: () => void = () => undefined
  const pressed = new Promise<null>(resolve => (mine = () => resolve(null)))

  press = mine

  return {
    pressed,
    done: () => {
      if (press === mine) {
        press = null
      }
    },
  }
}

/** A hook's `.catch`: its failure to the debug log, once per hook this load. Declared per file: validate follows $ into this file's functions only. */
function hookFailed($: EngineInterface, name: string, error: HookFailure): void {
  const line = failureLine(name, error)

  if (line !== undefined) {
    $.ui.log(line, { to: 'debug' })
  }
}

export function registerAskRecommended(on: On): void {
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const labels = recommendedLabels(e.props.questions)

    if (labels === null) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const label = t().useRecommended
    const columns = (e.viewport?.columns ?? ASK_COLUMNS) - widthOf(label) - 5

    return (
      <Box flexDirection="column">
        <Box columnGap={1}>
          <Text color="subtle" wrap="truncate">
            {fit(t().recommendedLine(labels), columns)}
          </Text>
          <Button key="ask-recommended" label={label} variant="secondary" onPress={() => press?.()} />
        </Box>
        {await next(e)}
      </Box>
    )
  }).catch(($, e, next) => {
    hookFailed($, 'ui.render AskUserQuestion', next.error)

    return next(e)
  })
}
