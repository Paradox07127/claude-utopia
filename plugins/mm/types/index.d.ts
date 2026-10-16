/** An mmrun run started by /mm:review, /mm:run, or a main-thread Bash `mmrun review|run|start|ask`, watched until every model has ended. */
export type MmWatch = {
  rid: string
  /** 'ask' stands for `mmrun start` and `mmrun ask` alike. */
  kind: 'review' | 'run' | 'ask'
  /** Epoch ms, from `$.clock.now()` when the run was started. */
  startedAt: number
  /** The run's conclusions once every model ended, waiting to be handed to the model; absent while it runs. */
  message?: string
  /** Each model's result the message was built from, so a read of one can rebuild it. */
  results?: { model: string; status: string; output: string; reason?: string; patch?: string }[]
  /** Models whose ended result the main thread already read; the message leaves their output out. */
  seen?: string[]
  /** Every run of the review this run is a part of, in part order (run.meta `group`); absent for an unsplit run. */
  group?: string[]
  /** The 60-minute reminder has been sent for this run. */
  reminded?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    mm: {
      watches: MmWatch[]
    }
  }
}
