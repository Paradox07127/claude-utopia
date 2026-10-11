import type { ClientModule } from 'claude-code'

import { fmtAge, fmtDuration } from './agent-model'

type ClockProps = { from: number; now: number; format: 'duration' | 'age'; color: string; bold: boolean }
/** The hook's clock it counts on from, and the seconds counted since. */
type ClockState = { now: number; ticks: number }

const TICK_MS = 1000

// The desktop rebuilds a pane's buttons on every redraw, which drops a click caught mid-redraw; a time that moves itself spares the pane its redraw each second.
/** A time counted from `from`, moving each second on the desktop's own clock until the pane hands it a new `now`. */
const Clock: ClientModule<ClockProps, ClockState> = (props, surface) => {
  const { Text } = surface.elements
  const was = surface.state

  if (was === undefined) {
    surface.every(TICK_MS, () => {
      const counted = surface.state

      if (counted !== undefined) {
        surface.setState({ now: counted.now, ticks: counted.ticks + 1 })
      }
    })
  }

  if (was?.now !== props.now) {
    surface.setState({ now: props.now, ticks: 0 })
  }

  const ms = props.now + (was?.now === props.now ? was.ticks : 0) * TICK_MS - props.from

  return (
    <Text color={props.color} bold={props.bold}>
      {(props.format === 'age' ? fmtAge : fmtDuration)(ms)}
    </Text>
  )
}

export default Clock
