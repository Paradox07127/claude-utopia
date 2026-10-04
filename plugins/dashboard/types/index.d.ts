export type AgentRunState = 'running' | 'done' | 'aborted' | 'error' | 'refusal'

export type AgentRun = {
  agentId: string
  description: string
  subagentType: string
  model: string
  background: boolean
  /** The subagent whose loop spawned it; absent when the main loop did. */
  parentAgentId?: string
  /** Epoch ms. */
  startedAt: number
  tools: number
  lastTool: string
  state: AgentRunState
  /** Epoch ms of the spawn, the latest resume or the latest tool call that ended. */
  lastActivityAt: number
  /** Epoch ms; set once the agent's turn completes. */
  endedAt?: number
  /** Its turns' active time together, idle gaps between them left out. */
  durationMs?: number
  /** Once resumed: the active ms of its turns before the current one. */
  activeMs?: number
  /** Once resumed: epoch ms the current active segment began. */
  turnAt?: number
  outputTokens?: number
  /** Tool calls of this agent the engine answered with a deny; absent means 0. */
  denied?: number
  /** The agent's final answer, cut to its first 4000 characters. */
  answer?: string
  /** The Agent tool call that spawned it. */
  toolUseId?: string
  /** Its digit hotkey '1'–'9' on the workbench, given at spawn; absent when all nine were held or another took it since. */
  slot?: string
  /** What its last turn cost, as its turn.complete reported it. */
  usage?: AgentUsage
}

/** A subagent turn's four token counts and the model that answered last. */
export type AgentUsage = TimelineUsage & { model: string }

/** What the open running agent's transcript read gave, at its `lastActivityAt` then; `failed` when it could not be read. */
export type AgentPeek = {
  agentId: string
  activityAt: number
  /** The first user message's first line. */
  task: string
  /** The last three tool calls, each its name and arguments in one line. */
  calls: string[]
  /** The latest assistant text's first line. */
  text: string
  failed?: true
}

/** One GPU row from nvidia-smi; null where the driver reported `[N/A]` / `[Not Supported]`. */
export type NvidiaGpu = {
  index: number
  name: string
  /** Percent. */
  util: number | null
  /** MiB. */
  memUsed: number | null
  /** MiB. */
  memTotal: number | null
  /** Celsius. */
  temp: number | null
  /** Watts. */
  power: number | null
}

export type GpuProcess = {
  pid: number
  name: string
  /** MiB. */
  memMiB: number | null
}

export type GpuSample =
  | { kind: 'nvidia'; gpus: NvidiaGpu[]; procs: GpuProcess[] }
  /** tegrastats: util percent, RAM in MiB, temp in Celsius. */
  | { kind: 'tegra'; util: number | null; ramUsed: number | null; ramTotal: number | null; temp: number | null }
  | { kind: 'none' }
  | { kind: 'error'; message: string }

export type GpuWatch = {
  host: string
  /** Last successful sample (never an `error`). */
  sample: GpuSample | null
  /** Epoch ms of `sample`. */
  okAt: number | null
  /** First line of the latest failure; null once a poll succeeds again. */
  error: string | null
}

export type MmModel = {
  name: string
  /** RUNNING | DONE | FAIL:<rc> | STALE; STALE also when the file says RUNNING but the pid is dead. */
  status: string
  /** Epoch ms; 0 when <model>.started is missing. */
  startedAt: number
  /** Epoch ms the model stopped running; absent while RUNNING. */
  endedAt?: number
  /** secs= from <model>.meta. */
  secs?: number
  outputTokens?: number
}

export type MmRun = {
  runid: string
  tag: string
  workdir: string
  mode: string
  /** mtime of run.meta, epoch ms. */
  createdAt: number
  models: MmModel[]
}

export type MmSnapshot = {
  /** When the runs were read, epoch ms: the "now" every model duration is drawn against. */
  polledAt: number
  /** Newest first; on a failed read, the runs of the last read that worked. */
  runs: MmRun[]
  /** First line of why the last read of ~/.claude/mmruns failed; absent once a read works or when it was never there. */
  error?: string
}

export type DashPage = 'overview' | 'agents' | 'mmrun' | 'gpu' | 'timeline' | 'usage' | 'progress'

/** What the timeline page shows: one main turn's waterfall, or the hotspots of every main turn kept. */
export type DashTimelineView = 'turn' | 'hotspots'

/** The desktop waterfall's step page: `back` pages before the newest, for the turn it was picked on. */
export type DashTimelinePage = { turnId: string; back: number }

/** Epoch ms of the last visit to each page; an item that ended at or before it counts as read. */
export type DashSeen = { agents: number; runs: number }

/** The item the workbench shows in full instead of its page's list. */
export type DashDetail =
  | { page: 'agents'; agentId: string }
  /** `model` and `finding` are the desktop reader's: the model shown (absent, the first) and the index into its shown findings. */
  | { page: 'mmrun'; runid: string; showAll: boolean; model?: string; finding?: number }

/** One review finding as the desktop reader shows it. */
export type DashFinding = { severity: string; file: string; line: string; claim: string; quote: string; failureScenario: string; basis: string; suggestion: string }

/** A review JSON's fields the desktop reader shows, findings in severity order; `outPath` is where a cut leaf points. */
export type DashReview = { verdict: string; summary: string; findings: DashFinding[]; notChecked: string[]; notExpanded: number; outPath: string }

/** A run's model conclusions, read when the person pressed Read: markdown for the terminal, and the parsed review when the JSON was one. */
export type DashReport = { loadedAt: number; models: { name: string; status: string; markdown: string; review?: DashReview }[] }

/** One Bash call whose output read as a test run. */
export type GateRun = {
  /** Epoch ms the result came back. */
  at: number
  /** The command, whitespace folded, cut to 120 characters. */
  command: string
  /** The command as run, trimmed: what tells two commands apart; when absent, `command` does. */
  key?: string
  /** The worktree directory name it ran in, or `main`. */
  where: string
  agentId?: string
  /** null when no line of the output gave a total. */
  pass: number | null
  /** null when the summary or the exit said failed and no failing test was counted. */
  fail: number | null
  /** The summary or the exit said failed, whatever `fail` counts. */
  failed?: boolean
  failures: string[]
  /** `packages` when the counts are go packages, as TestSummary gave it; absent, tests. */
  unit?: 'packages'
  /** A file in its tree was edited after it ran: its result no longer speaks for the code there. */
  stale?: true
}

/** One linked worktree of the session's repository; the main tree is not one. */
export type WorktreeInfo = {
  /** Last segment of the worktree's path. */
  name: string
  /** Absolute, as `git worktree list` gave it. */
  path: string
  /** Without `refs/heads/`; `detached` for a detached HEAD. */
  branch: string
  /** Lines `git status --porcelain` printed. */
  dirty: number
  /** Commits on HEAD that the main tree's branch lacks. */
  ahead: number
  /** Commits on the main tree's branch that HEAD lacks. */
  behind: number
  /** Nothing ahead and nothing uncommitted. */
  merged: boolean
  /** The directory is `agent-<id>` of a subagent still running: its isolation worktree, in use however clean it looks. */
  running: boolean
  /** First stderr line of the git command that failed, the counts then 0; null when every one succeeded. */
  error: string | null
}

/** One line of ~/.claude/harness/guard.jsonl: a guard that denied a call. */
export type GuardBlock = {
  /** Epoch ms. */
  at: number
  guard: string
  decision: 'deny'
  op: string
  cwd: string | null
  agentId: string | null
}

/** The newest blocks of guard.jsonl as read at its `mtimeMs`. */
export type GuardLog = { mtimeMs: number; blocks: GuardBlock[] }

/** What a session's main thread is doing, as ~/.claude/dashboard/sessions/<id>.json holds it. */
export type SessionPresenceState = 'working' | 'permission' | 'replied' | 'failed' | 'idle' | 'ended'

/** One session's ~/.claude/dashboard/sessions/<id>.json: written by that session alone, read by the others. */
export type SessionPresence = {
  id: string
  /** Last segment of the session root. */
  name: string
  /** classic.SessionStart's session_title, else the first prompt's first 40 columns. */
  title?: string
  state: SessionPresenceState
  /** Epoch ms `state` was entered. */
  since: number
  /** Epoch ms the current or last turn's prompt was submitted. */
  turnStartedAt?: number
  /** While `permission`: the tool asking, at most 40 characters; while `replied`: the last message's first line, at most 60 columns. */
  detail?: string
  /** Epoch ms of the last write; the heartbeat rewrites it every 30 s. */
  updatedAt: number
  /** Epoch ms the person last typed or sent a prompt here, written at most every 15 s; absent before the first. */
  lastInputAt?: number
}

/** The main thread's prompt cache, for the cold-cache line. */
export type DashCache = {
  /** Epoch ms the TTL counts from: the ended main turn's last request (its end when none was timed), or a resume's last response; null before the first and while a turn runs. */
  lastReplyAt: number | null
  /** The context_tokens a resume's SessionStart gave, the last output in it: the cold line's figure until the next main reply; null otherwise. */
  resumeTokens: number | null
  /** The cache TTL the transcript's last main reply wrote at, else the one a PostModelSwitch reported; null keeps the cacheTtlMinutes option. */
  ttlMs: number | null
}

/** The engine's last session.measure, as it gave it. */
export type DashUsage = {
  /** The model's window, and the last response's input tokens and their whole percent of it once one came; null before the first measurement and after a /clear. */
  context: { tokens?: number; window: number; percent?: number } | null
  /** Each rate-limit window (`five_hour`, `seven_day`, `spend_limit`): percent used, and when it resets as ISO 8601. */
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  /** US dollars so far; null where the host keeps no ledger. */
  cost: { usd: number } | null
}

/** A step's token counts as the API reported them. */
export type TimelineUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** One model request of a turn, timed off its turn.step stream. Times are epoch ms; a field left out was not known. */
export type TimelineStep = {
  turnId: string
  index: number
  agentId?: string
  /** The model the request named; a fallback's when the engine fell back. */
  model: string
  effort?: string | number
  messageCount: number
  /** When the step's hook was entered, just before the request went down. */
  sentAt: number
  /** From sentAt to the first thinking, text or tool chunk; absent when none came. */
  ttftMs?: number
  firstKind?: 'thinking' | 'text' | 'tool'
  /** Set once the stream ended, closed or failed. */
  endedAt?: number
  stepMs?: number
  /** As the step's result carried them (null: no response); absent while running or when the stream ended without a result. */
  stopReason?: string | null
  usage?: TimelineUsage | null
  /** The tool calls the stream began, in order. */
  toolUseIds: string[]
}

export type TimelineToolOutcome = 'ok' | 'error' | 'interrupted' | 'denied'

/** One tool call: requested when its tool chunk arrived, ended when a classic PostToolUse / PostToolUseFailure / PermissionDenied said so. */
export type TimelineTool = {
  toolUseId: string
  name: string
  agentId?: string
  turnId?: string
  stepIndex?: number
  requestedAt?: number
  endedAt?: number
  /** The engine's duration_ms: the tool's execution alone, permission prompts and hooks excluded. */
  durationMs?: number
  outcome?: TimelineToolOutcome
}

/** A subagent started from a turn's loop. */
export type TimelineFork = {
  toolUseId?: string
  parentAgentId?: string
  childAgentId: string
  background: boolean
  /** When agent.spawn resolved: the child had started. */
  at: number
  subagentType: string
  description: string
}

/** A compaction of the loop's transcript that stood; `at` after `endedAt` means it ran between turns. */
export type TimelineCompaction = {
  at: number
  trigger: 'manual' | 'auto' | 'plugin'
  tokensBefore?: number
  tokensAfter?: number
}

/** One turn of the main loop or of a subagent's (which has no turn.start: its first step opens it). */
export type TimelineTurn = {
  turnId: string
  agentId?: string
  startedAt: number
  steps: TimelineStep[]
  tools: TimelineTool[]
  forks: TimelineFork[]
  compactions?: TimelineCompaction[]
  endedAt?: number
  durationMs?: number
  reason?: string
  apiError?: { error: string; details?: string }
}

/** One model's requests on one kind of thread, as their final turn.step usage reported them. */
export type UsageCounts = {
  requests: number
  input: number
  output: number
  cacheRead: number
  /** Both cache TTLs together: turn.step's usage does not split cache creation into 5m and 1h. */
  cacheWrite: number
}

export type UsageThread = 'main' | 'subagent'

/** One skill's Skill calls: `inline` resolved inline, `forked` completed in a fork, `errors` failed or did not resolve. */
export type SkillCounts = { invocations: number; inline: number; forked: number; errors: number }

/** The AskUserQuestion dialogs shown: each question by how it was answered, each dialog by its wait from shown to the tool's result. */
export type AskCounts = {
  dialogs: number
  questions: number
  /** The option whose label holds "(Recommended)". */
  recommended: number
  /** Another listed option; a multiSelect answer other than the recommended label alone. */
  option: number
  /** Text matching no label. */
  typed: number
  /** The dialog was rejected or failed, or its turn ended while it waited; or the question was left unanswered. */
  declined: number
  under1m: number
  under2m: number
  under5m: number
  under10m: number
  over10m: number
}

/** One session's usage on one local day, per model and kind of thread, per skill, and its question dialogs; no prompt, argument or answer. */
export type UsageDay = { models: Record<string, Partial<Record<UsageThread, UsageCounts>>>; skills: Record<string, SkillCounts>; asks?: AskCounts }

/** This session's ledger by local day `YYYY-MM-DD`; each day is ~/.claude/dashboard/usage/<project>/<day>/<session>.json, written by this session alone. */
export type UsageLedger = { session: string; project: string; days: Record<string, UsageDay> }

/** The ledger files of the last 7 days as last read, per day: the other sessions' summed, and `session`'s own. */
export type UsageRead = { session: string; others: Record<string, UsageDay>; own: Record<string, UsageDay> }

export type BoardStatus = 'todo' | 'doing' | 'done' | 'blocked'

export type BoardKind = 'feature' | 'fix' | 'research' | 'infra' | 'docs'

/** A node that must finish first: `confirmed` once the person said so, else proposed. */
export type BoardLink = { id: string; confirmed: boolean }

/** What an event sets on its node; an update carries only what changed. */
export type BoardFields = { title?: string; summary?: string; status?: BoardStatus; kind?: BoardKind; builds_on?: string[]; depends_on?: BoardLink[] }

/** One entry of a progress board's `<events dir>/<session>.json`, written by that session alone; `commit` is HEAD's short sha then, null when none was read. */
export type BoardEvent = { type: 'add' | 'update'; node: string; at: number; session: string; commit: string | null; fields: BoardFields }

/** A node as the events fold to it: `at` when it was added, `updatedAt` and `commit` of its latest event. */
export type BoardNode = Required<BoardFields> & { id: string; at: number; updatedAt: number; commit: string | null }

/** The progress board as last read: where it is kept, null before the person chose, and its nodes. */
export type BoardRead = { storage: 'local' | 'git' | null; dir: string | null; nodes: BoardNode[] }

declare module 'claude-code' {
  interface PluginState {
    dashboard: {
      agents: Shaped<AgentRun[]>
      gpu: Shaped<GpuWatch | null>
      runs: Shaped<MmSnapshot | null>
      /** The workbench page last shown; null before the first visit. */
      page: DashPage | null
      seen: Shaped<DashSeen>
      /** Set once the person closes the workbench: no more opening it unasked this session. */
      noAutoOpen: boolean
      /** Open report; null shows the page's list. */
      detail: Shaped<DashDetail | null>
      /** Per runid. */
      reports: Shaped<Record<string, DashReport>>
      /** Per tool_use_id: whether an Agent call's row shows its prompt under it. */
      expandedTask: StateFamily<boolean>
      /** Per tool_use_id: whether a test-summary ToolResult, or a desktop guard denial, shows the raw output under it. */
      expandedTests: StateFamily<boolean>
      /** Test runs seen in Bash results, oldest first, the last 30. */
      gates: Shaped<GateRun[]>
      /** Linked worktrees at the last collection, [] when the session root is no readable repository; null before the first collection. */
      trees: Shaped<WorktreeInfo[] | null>
      /** ~/.claude/harness/guard.jsonl's newest blocks; null while there is no such file. */
      guards: Shaped<GuardLog | null>
      /** Other sessions at the last read of ~/.claude/dashboard/sessions, ended and silent ones left out; null before the first read. */
      peers: Shaped<SessionPresence[] | null>
      /** `${id}:${state}:${since}` of the other sessions' states already seen or toasted, the last 200. */
      toasted: Shaped<string[]>
      /** What this session last wrote to its own presence file; null before the first write. */
      presence: Shaped<SessionPresence | null>
      cache: Shaped<DashCache>
      usage: Shaped<DashUsage>
      /** Turns oldest first: the last 30, and fewer while their steps number over 400. */
      timeline: Shaped<TimelineTurn[]>
      /** The main-loop turn the timeline page shows; null follows the latest. */
      timelineTurn: string | null
      timelineView: DashTimelineView
      /** null, or another turn than the one shown: its newest steps. */
      timelinePage: Shaped<DashTimelinePage | null>
      /** Epoch ms of the last redraw tick: the band, the prompt hint and the workbench read it, the transcript rows do not. */
      tick: number
      /** The open running agent's transcript as last read; null before the first. */
      peek: Shaped<AgentPeek | null>
      /** Whether the Agents page shows its folded ended agents. */
      agentsFoldOpen: boolean
      /** `seen.agents` as it was before the current visit to the Agents page: what ended after it is listed as unread. */
      agentsSeenBefore: number
      /** This session's token and skill ledger; null before its first request or Skill call. */
      ledger: Shaped<UsageLedger | null>
      /** The usage page's read of the ledger files; null before the first visit. */
      usageRead: Shaped<UsageRead | null>
      /** The progress page's read of the board, and the board after this session's own call; null before either. */
      progress: Shaped<BoardRead | null>
    }
    /** mm's own; dashboard only hears that it was written. */
    mm: {
      watches: unknown
    }
  }
}
