import type { Register } from 'claude-code'

import { register as registerMemory } from './memory-hooks'
import { register as registerReflect } from './reflect-hooks'
import { register as registerHarness } from './register'
import { register as registerRuleCheck } from './rule-check-hooks'

// The source tree's entry, as the engine loads one module per plugin; a release ships each half as a plugin of its own.
export const register: Register = (on, options) => {
  registerHarness(on, options)
  registerMemory(on, options)
  registerReflect(on, options)
  registerRuleCheck(on, options)
}
