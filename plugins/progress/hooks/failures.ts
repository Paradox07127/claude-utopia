import type { HookFailure } from 'claude-code'

// Keys already written this load: a hook that fails on every redraw writes one line.
const logged = new Set<string>()

/** True the first time `key` comes this load. */
export function isFirstTime(key: string): boolean {
  if (logged.has(key)) {
    return false
  }

  logged.add(key)

  return true
}

/** The debug line of a hook's failure; undefined after the first for `name` this load. `name` is the event and what its matcher picks. */
export function failureLine(name: string, error: HookFailure): string | undefined {
  return isFirstTime(`hook ${name}`) ? `dashboard: ${name} hook failed (${error.kind}): ${error.message ?? 'no message'}` : undefined
}
