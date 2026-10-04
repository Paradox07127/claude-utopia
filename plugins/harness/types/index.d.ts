/** The main thread's idle time, for compacting before the prompt cache expires. */
export type HarnessIdle = {
  /** Epoch ms the cache expiry counts from (the main thread's last request); null when no idle waits to be compacted. */
  lastReplyAt: number | null
  /** Epoch ms the main thread's last model request was sent; missing in state saved before it existed. */
  lastStepAt: number | null
  /** The cache TTL the transcript or a PostModelSwitch reported; null (or missing) keeps the default 1h. */
  ttl: '5m' | '1h' | null
}

declare module 'claude-code' {
  interface PluginState {
    harness: {
      idle: HarnessIdle
    }
  }
}
