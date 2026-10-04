/** An mmrun run started by /mm:review or /mm:run, watched until every model has ended. */
export type MmWatch = {
  rid: string
  kind: 'review' | 'run'
  /** Epoch ms, from `$.clock.now()` when the run was started. */
  startedAt: number
  /** The run's conclusions once every model ended, waiting to be handed to the model; absent while it runs. */
  message?: string
}

declare module 'claude-code' {
  interface PluginState {
    mm: {
      watches: MmWatch[]
    }
  }
}
