import { describe, expect, test } from 'claude-code/testing'

import { staticClocks } from '../hooks/register'
import { withClocks } from './clocks'

const EL = { Box: 'Box', Client: 'Client', Text: 'Text', Button: 'Button', Svg: 'Svg', Markdown: 'Markdown' } as never

type Drawn = { type: string; props: { color?: string; bold?: boolean }; children: unknown[] }

/** What a reader sees: the element, its color, whether bold, its text. */
const seen = (node: unknown) => {
  const one = JSON.parse(JSON.stringify(node)) as Drawn

  return { type: one.type, color: one.props.color, bold: one.props.bold === true, children: one.children }
}

describe('clock fallback after ui.fault', () => {
  test('a Client draws the static time its clock would show first', () => {
    const props = { module: '../clock-client.tsx', props: { from: 1_000, now: 91_000, format: 'duration', color: 'subtle', bold: false } }
    const Client = (staticClocks(EL) as unknown as { Client: (p: typeof props) => unknown }).Client

    expect(seen(Client(props))).toEqual(seen(withClocks({ type: 'Client', props, children: [] })))
  })

  test('an age clock draws as an age', () => {
    const props = { module: '../clock-client.tsx', props: { from: 0, now: 3 * 3_600_000, format: 'age', color: 'inactive', bold: true } }
    const Client = (staticClocks(EL) as unknown as { Client: (p: typeof props) => unknown }).Client

    expect(seen(Client(props))).toEqual(seen(withClocks({ type: 'Client', props, children: [] })))
  })
})
