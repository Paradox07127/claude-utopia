import type { Register } from 'claude-code'

import { register as registerEvents } from './events-hooks'
import { register as registerWorkbench } from './register'

// The source tree's entry, as the engine loads one module per plugin; a release ships each half as a plugin of its own.
export const register: Register = (on, options) => {
  registerWorkbench(on, options)
  registerEvents(on, options)
}
