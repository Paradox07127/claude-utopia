import type { EventsRead } from '../events'
import { t } from '../i18n'
import { drawEventsDesktop, drawHotspotsDesktop, drawTimelineDesktop, EVENTS_VIEW, latestMainTurnId } from '../timeline-view'
import type { El, PaneData } from './kit'

/** The pane's data with the event ledger as last read for the events view; absent while that view is not shown. */
export type TimelinePaneData = PaneData & { timelineEvents?: EventsRead }

/**
 * The steps and events buttons, then the events view; or the steps' view buttons, the current one `primary`, and
 * stepping between main turns, then the waterfall's page or the hotspots.
 */
export function timelineBody(el: El, data: TimelinePaneData) {
  const { Box, Button } = el
  const turns = data.timeline ?? []
  const isEvents = data.disclosures?.has(EVENTS_VIEW) === true
  const isHotspots = data.timelineView === 'hotspots'
  const modes = [
    <Button
      key="timeline-steps"
      label={t().timelineStepsView}
      variant={isEvents ? 'secondary' : 'primary'}
      onPress={() => {
        if (isEvents) {
          data.onToggleDisclosure?.(EVENTS_VIEW)
        }
      }}
    />,
    <Button
      key="timeline-events"
      label={t().timelineEventsView}
      variant={isEvents ? 'primary' : 'secondary'}
      onPress={() => {
        if (!isEvents) {
          data.onToggleDisclosure?.(EVENTS_VIEW)
        }
      }}
    />,
  ]

  if (isEvents) {
    return [<Box columnGap={1} flexWrap="wrap">{modes}</Box>, ...drawEventsDesktop(el, data.timelineEvents, data)]
  }

  const views = [
    ...modes,
    <Button
      key="timeline-waterfall"
      label={t().timelineViewWaterfall}
      variant={isHotspots ? 'secondary' : 'primary'}
      onPress={() => {
        if (isHotspots) {
          data.onTimelineView?.()
        }
      }}
    />,
    <Button
      key="timeline-hotspots"
      label={t().timelineViewHotspots}
      variant={isHotspots ? 'primary' : 'secondary'}
      onPress={() => {
        if (!isHotspots) {
          data.onTimelineView?.()
        }
      }}
    />,
  ]

  if (isHotspots) {
    const openTurn = (turnId: string) => {
      data.onTimelineTurn?.(turnId)
      data.onTimelineView?.()
    }

    return [<Box columnGap={1} flexWrap="wrap">{views}</Box>, ...drawHotspotsDesktop(el, turns, data.columns, openTurn)]
  }

  const id = data.timelineTurnId ?? latestMainTurnId(turns)
  const main = turns.filter(one => one.agentId === undefined).map(one => one.turnId)
  const at = id === undefined ? -1 : main.indexOf(id)
  const pick = (turnId: string | undefined) => data.onTimelineTurn?.(turnId)
  const buttons = [
    ...views,
    ...(at > 0 ? [<Button key="timeline-prev" label={t().timelinePrev} variant="secondary" onPress={() => pick(main[at - 1])} />] : []),
    ...(at >= 0 && at < main.length - 1 ? [<Button key="timeline-next" label={t().timelineNext} variant="secondary" onPress={() => pick(main[at + 1])} />] : []),
    ...(data.timelineTurnId === undefined ? [] : [<Button key="timeline-latest" label={t().timelineLatest} variant="secondary" onPress={() => pick(undefined)} />]),
  ]
  const back = id !== undefined && data.timelinePage?.turnId === id ? data.timelinePage.back : 0
  const ui = {
    back,
    onPage: (to: number) => data.onTimelinePage?.({ turnId: id ?? '', back: to }),
    disclosures: data.disclosures,
    onToggleDisclosure: data.onToggleDisclosure,
  }

  return [<Box columnGap={1} flexWrap="wrap">{buttons}</Box>, ...drawTimelineDesktop(el, turns, id ?? '', data.now, data.columns, data.agents, ui)]
}
