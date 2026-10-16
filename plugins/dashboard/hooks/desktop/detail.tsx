import type { RenderChildren } from 'claude-code'

import { elapsedOf, fmtDuration } from '../agent-model'
import { usageText } from '../board'
import { TONE_KEYS } from '../desktop-svg'
import { t } from '../i18n'
import type { El, PaneData } from './kit'
import { reportReader } from './reviews'

export function detailBody(el: El, data: PaneData) {
  const { Box, Button, Code, Markdown, Text } = el
  const open = data.detail

  if (open === null || open.page !== data.page) {
    return null
  }

  if (open.page === 'agents') {
    const run = data.agents.find(one => one.agentId === open.agentId)

    if (run === undefined) {
      return null
    }

    const time = fmtDuration(elapsedOf(run, data.now))
    const peek = run.state === 'running' && data.peek?.agentId === run.agentId ? data.peek : undefined

    let statusNodes: RenderChildren
    if (run.state === 'running') {
      statusNodes = <Text color="permission" bold>● {t().stillRunning}</Text>
    } else if (run.state === 'done') {
      statusNodes = <Text color="success" bold>{t().returnedUnverified}</Text>
    } else if (run.state === 'aborted') {
      statusNodes = <Text color="warning" bold>⊘ {t().agentStates.aborted}</Text>
    } else if (run.state === 'idle') {
      statusNodes = <Text color={TONE_KEYS.idle} bold>○ {t().agentStates.idle}</Text>
    } else {
      statusNodes = <Text color="error" bold>✗ {t().agentStates[run.state]}</Text>
    }

    const statusRow = (
      <Box flexDirection="row" columnGap={1} flexWrap="wrap" alignItems="center">
        {statusNodes}
        {(run.denied ?? 0) > 0 && <Text color="error" bold>{t().denied(run.denied ?? 0)}</Text>}
      </Box>
    )

    const metricsRow = (
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        <Text color="text">{t().elapsedTime(time)}</Text>
        <Text color="text">{`${run.tools} tools`}</Text>
        <Text color="subtle">{`${run.subagentType} · ${run.model.replace(/^claude-/, '')}`}</Text>
      </Box>
    )

    const tokenUsage = (
      <Box flexDirection="column" gap={1}>
        <Text color="text" bold>{t().tokenUsageTitle}</Text>
        <Text color="subtle">{run.usage === undefined ? '—' : usageText(run.usage)}</Text>
      </Box>
    )

    let content: RenderChildren
    if (run.state === 'running') {
      if (peek?.failed === true) {
        content = <Text color="warning">{t().peekUnreadable}</Text>
      } else {
        content = (
          <Box flexDirection="column" gap={1}>
            <Text color="text" bold>{t().peekTask}</Text>
            <Text color="text" wrap="wrap">{peek?.task || run.description}</Text>
            <Text color="text" bold>{t().peekCalls}</Text>
            <Code source={(peek?.calls ?? []).join('  ') || '—'} />
            <Text color="text" bold>{t().peekText}</Text>
            <Text color="text" wrap="wrap">{peek?.text || '—'}</Text>
            <Text color="subtle">{t().ago(fmtDuration(data.now - run.lastActivityAt))}</Text>
          </Box>
        )
      }
    } else {
      content = (
        <Box flexDirection="column" gap={1}>
          <Text color="text" bold>{t().answerHead}</Text>
          <Markdown text={(run.answer ?? '').slice(0, 4000)} />
        </Box>
      )
    }

    return [
      <Button key="dash-back" label={t().back} variant="secondary" onPress={data.onBack} />,
      <Text color="text" bold wrap="wrap">{`${run.subagentType} · ${run.description}`}</Text>,
      statusRow,
      metricsRow,
      tokenUsage,
      content,
    ]
  }

  return reportReader(el, data, open)
}
