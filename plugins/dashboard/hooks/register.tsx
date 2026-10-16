import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, HookFailure, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, RenderChildren, RenderSurface, Timer } from 'claude-code'

import type {
  AgentPeek,
  AgentRun,
  BoardEvent,
  BoardRead,
  BoardRequest,
  DashCache,
  DashConversation,
  DashDetail,
  DashPage,
  DashReport,
  DashSeen,
  DashTimelinePage,
  DashTimelineView,
  DashUsage,
  GateRun,
  GpuSample,
  GpuWatch,
  GuardLog,
  MmModel,
  MmRun,
  MmSnapshot,
  RequestFields,
  SessionPresence,
  SessionPresenceState,
  TimelineTurn,
  UsageLedger,
  UsageRead,
  WorktreeInfo,
} from '../types'
import { elapsedOf, fit, fmtAge, fmtDuration, fmtTokens, MAX_AGENTS, noteDenied, noteDone, noteListed, noteResumed, noteSpawn, noteTool, peekOf, toolLabel, widthOf } from './agent-model'
import { registerAskRecommended } from './ask-recommended'
import {
  agentFold,
  agentTable,
  alignRight,
  bandLines,
  boardOf,
  CACHE_GROUP,
  endedText,
  fitLine,
  flightText,
  foldText,
  FRESH_MS,
  GATE_COMMAND_COLUMNS,
  gateCounts,
  HOTKEY_COLUMNS,
  idleLine,
  isFailedGate,
  isStalled,
  limitText,
  MAX_BAND_ROWS,
  nextBandChange,
  nextOverviewChange,
  OVERVIEW_GATES,
  OVERVIEW_TREES,
  overviewCounts,
  overviewOf,
  padTo,
  peerToasts,
  pendingGateLine,
  pendingLine,
  progressLines,
  recentGates,
  runningLine,
  runTable,
  sessionLine,
  splitRow,
  usageLines,
  usageText,
} from './board'
import type { Board, ButtonRow, ColdCache, Line, OverviewItem, Seg } from './board'
import { drawDesktopBand, drawDesktopPane, drawDesktopPaneError, posixQuote } from './desktop'
import type { GpuFill } from './desktop/gpu'
import type { TimelinePaneData } from './desktop/timeline'
import type { BandRow } from './desktop/band'
import { gauge } from './desktop/kit'
import type { El } from './desktop/kit'
import { scaleOf, TONE_KEYS } from './desktop-svg'
import type { Tone } from './desktop-svg'
import { attentionChime } from './chime'
import { CI_GROUP, CI_POLL_MS, CI_RETRY_MS, ciEvents, ciLine, isNoAuth, isNoPr, isNotFound, nextCi, parseChecks, parsePr, PR_CHECKS, PR_VIEW } from './ci'
import type { CiStatus } from './ci'
import { conversationOf } from './conversation'
import { capped, eventLine, eventsDir as eventLedgerDir, groupEvents, parseLedger, serially, sessionOfFile } from './events'
import type { EventsRead, LedgerEvent, LedgerRecord } from './events'
import { failureLine, isFirstTime } from './failures'
import { bar, hostsOf, isHostName, sshArgv, sshHostOf, takeSamples } from './gpu-probe'
import { pickLang, setLang, t } from './i18n'
import type { Lang } from './i18n'
import { isExpired, mainMoved, newestNotice, NOTICE_TTL_MS, noticeOf, NOTICES_MS, noticesDir, noticeText, parseNotice, shaOf } from './notices'
import type { Notice } from './notices'
import { boardDir, canvasBatches, canvasPath, canvasProject, canvasWrites, closeEvents, eventsDir, foldBoard, foldLines, foldRequests, NO_CHECKS, parseBoardEvents, parseStorage } from './progress'
import type { BoardStorage } from './progress'
import { onRecording } from './progress-hooks'
import { endToast, parseKv, reportOf, reviewOf, runLabel, RUNID } from './runs'
import { SHAPE } from './shapes'
import { summarizeTests } from './summarize-tests'
import { applyEvents, runSession } from './tasks'
import { toolsInFlight } from './timeline'
import type { Flight } from './timeline'
import { registerTimeline } from './timeline-hooks'
import { eventLines, EVENTS_VIEW, hotspotLines, latestMainTurnId, timelineLines } from './timeline-view'
import { bashText, registerTranscript } from './transcript'
import { dayOf, daySum, daysOf, emptyDay, lastDays, ledgerDir, parseUsageDay, projectKey, weekOf } from './usage'
import type { UsageWeek } from './usage'
import { GUARD_COLORS, guardText, parseGuards, parseWorktrees, treeMarks, treeOf } from './workspace'
import type { Mark, PorcelainTree } from './workspace'

const PANE_ID = 'dashboard'
const pages = () =>
  [
    { page: 'overview', label: t().pageOverview },
    { page: 'agents', label: 'Agents' },
    { page: 'mmrun', label: t().pageMmrun },
    { page: 'gpu', label: 'GPU' },
    { page: 'timeline', label: t().pageTimeline },
    { page: 'usage', label: t().pageUsage },
    { page: 'progress', label: t().pageProgress },
  ] as const
// Tabs drawn only while their data exists (tabsWithData), or while their page is open.
const ON_DEMAND: readonly DashPage[] = ['mmrun', 'gpu', 'progress']
// The progress page reads the board again this often while it is the current page: recordings land there from any session.
const PROGRESS_READ_MS = 5_000
// Each only opens a page or posts a notice, so each runs mid-turn instead of waiting for the turn to end.
const COMMANDS = [
  { name: 'dashboard', description: 'Open the workbench on its last page: subagents, reviews, GPU', immediate: true },
  // Not `agents`: the engine refuses a built-in's name, and /agents is one.
  { name: 'subagents', description: "Open the workbench's Agents page: this session's subagents", immediate: true },
  { name: 'mmrun', description: "Open the workbench's Reviews page: recent mmrun runs and their status", immediate: true },
  { name: 'gpu', description: "Open the workbench's GPU page to watch an ssh host's GPUs", argumentHint: '<host>', immediate: true },
  { name: 'timeline', description: "Open the workbench's Timeline page: the main loop's turns as a waterfall of requests and tools", immediate: true },
  { name: 'progress', description: "Open the workbench's Progress page: this project's progress board", immediate: true },
  { name: 'notice', description: 'Post a notice to every session of this repository; /notice clear hides the current ones in this session', argumentHint: '<text> | clear', immediate: true },
] as const
const OPEN_PROGRESS = {
  name: 'open_progress',
  description:
    "Open the workbench's Progress page (this project's progress board) for the person, and show a button in the transcript that opens it again. Call it when the person asks to see progress or the board.",
  inputSchema: { type: 'object', properties: {} },
}
const OPEN_PROGRESS_TOOL = 'mcp__dashboard__open_progress'
// The GPU ssh sends a pass this often (gpu-probe.ts); a dropped one is retried after it, doubling up to GPU_RETRY_MAX_MS.
const GPU_POLL_MS = 3000
const GPU_RETRY_MAX_MS = 60_000
const DAY_MS = 86_400_000
// cmd_status in plugins/mm/bin/mmrun gives a RUNNING model without a pid file this long before calling it STALE.
const PID_GRACE_MS = 30_000
// Every 3 s while a model runs; with none running, a 15 s cadence is enough to notice a new run.
const RUNS_BUSY_MS = 3000
const RUNS_IDLE_MS = 15_000
const MAX_RUNS = 20
const MODEL_NAME = /^[A-Za-z0-9_-]+$/
const PANE_RUNS = 10
// "[ <label> ]" plus the space before it.
const buttonColumns = () => widthOf(t().workbench) + 5
const copyColumns = () => widthOf(t().copyResume) + 5
const cdColumns = () => widthOf(t().copyCd) + 5
// Band running rows: the title at most this wide and not cut below the least, the step label at most this wide, the text bar this many cells.
const BAND_TITLE_COLUMNS = 24
const BAND_MIN_TITLE_COLUMNS = 8
const BAND_STEP_COLUMNS = 16
const BAND_BAR_CELLS = 10
// A session asking a permission as a card on the terminal: its frame, head, two kv rows and buttons.
const ASK_CARD_ROWS = 6
// Below this many columns SessionMode draws each window's ring and percent without its label.
const MODE_LABEL_COLUMNS = 90
const MODE_RING_PX = 18
const WINDOW_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
// Below this many columns a GPU row draws its utilization without the bar.
const GPU_BAR_COLUMNS = 64
const MAX_GATES = 30
const GATE_COMMAND_CHARS = 120
const WORKTREE_DIR = /\/\.claude\/worktrees\/([^/\s'"]+)/
const CD_DIR = /\bcd\s+(?:'([^']*)'|"([^"]*)"|(\S+))\s*&&/
const WORKSPACE_MS = 15_000
const GIT_TIMEOUT_MS = 10_000
// The overview lists this many of guard.jsonl's newest blocks, from at most its last 64 KB.
const GUARD_ROWS = 5
const GUARD_TAIL_BYTES = 65_536
const GIT_CHANGE = /\bgit (merge|worktree|commit|checkout|switch|rebase)\b/
// A Bash call of this session that may move main: the new sha is its own, no notice.
const MAIN_CHANGE = /\bgit\b[^|;&]*\b(merge|commit|rebase|pull|cherry-pick|reset)\b/
// A Bash call that writes files is not seen: only these tools' successes make a tree's gates stale.
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const PEERS_MS = 5000
const HEARTBEAT_MS = 30_000
// While a running agent is quiet, how often `$.agent.list()` is asked whether it ended unreported.
const AGENT_LIST_MS = 15_000
// Three missed heartbeats: the session is taken as closed.
const PEER_SILENT_MS = 90_000
const DETAIL_CHARS = 40
const PROMPT_TITLE_COLUMNS = 40
const REPLY_COLUMNS = 60
const PRESENCE_STATES: SessionPresenceState[] = ['working', 'permission', 'replied', 'failed', 'idle', 'ended']
const MINUTE_MS = 60_000
// Typing rewrites the presence file at most this often; the heartbeat carries a later key between.
const INPUT_WRITE_MS = 15_000
// A session typed in within this long counts as the one the person is at.
const INPUT_RECENT_MS = 2 * MINUTE_MS
const CACHE_TTL_MS = { '5m': 5 * MINUTE_MS, '1h': 60 * MINUTE_MS } as const
// The last main-thread reply sits within this tail; $.fs.read refuses files over 4 MiB and transcripts grow past that.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024
// The newest task_progress lines: each stays under 1 KB, its tool name cut to 80 characters and its summary to 200.
const EVENTS_TAIL_BYTES = 4096
const MARK_STYLES: Record<Mark['tone'], Omit<Seg, 'text'>> = {
  stale: { color: 'warning' },
  done: { color: 'success' },
  failed: { color: 'error' },
  running: { color: 'permission' },
  plain: {},
  dim: { dim: true },
}

const agents = atom({ plugin: 'dashboard', key: 'agents' } as const, [] as AgentRun[], { shape: SHAPE })
const gpu = atom({ plugin: 'dashboard', key: 'gpu' } as const, null as GpuWatch | null, { shape: SHAPE })
const runs = atom({ plugin: 'dashboard', key: 'runs' } as const, null as MmSnapshot | null, { shape: SHAPE })
const page = atom({ plugin: 'dashboard', key: 'page' } as const, null as DashPage | null)
const seen = atom({ plugin: 'dashboard', key: 'seen' } as const, { agents: 0, runs: 0 } as DashSeen, { shape: SHAPE })
const noAutoOpen = atom({ plugin: 'dashboard', key: 'noAutoOpen' } as const, false)
const detail = atom({ plugin: 'dashboard', key: 'detail' } as const, null as DashDetail | null, { shape: SHAPE })
const reports = atom({ plugin: 'dashboard', key: 'reports' } as const, {} as Record<string, DashReport>, { shape: SHAPE })
const conversation = atom({ plugin: 'dashboard', key: 'conversation' } as const, null as DashConversation | null, { shape: SHAPE })
const gates = atom({ plugin: 'dashboard', key: 'gates' } as const, [] as GateRun[], { shape: SHAPE })
const trees = atom({ plugin: 'dashboard', key: 'trees' } as const, null as WorktreeInfo[] | null, { shape: SHAPE })
const guards = atom({ plugin: 'dashboard', key: 'guards' } as const, null as GuardLog | null, { shape: SHAPE })
const peers = atom({ plugin: 'dashboard', key: 'peers' } as const, null as SessionPresence[] | null, { shape: SHAPE })
const toasted = atom({ plugin: 'dashboard', key: 'toasted' } as const, [] as string[], { shape: SHAPE })
const ownPresence = atom({ plugin: 'dashboard', key: 'presence' } as const, null as SessionPresence | null, { shape: SHAPE })
const cache = atom({ plugin: 'dashboard', key: 'cache' } as const, { lastReplyAt: null, resumeTokens: null, ttlMs: null } as DashCache, { shape: SHAPE })
const measured = atom({ plugin: 'dashboard', key: 'usage' } as const, { context: null, rateLimits: [], cost: null } as DashUsage, { shape: SHAPE })
const timeline = atom({ plugin: 'dashboard', key: 'timeline' } as const, [] as TimelineTurn[], { shape: SHAPE })
const timelineTurn = atom({ plugin: 'dashboard', key: 'timelineTurn' } as const, null as string | null)
const timelineView = atom({ plugin: 'dashboard', key: 'timelineView' } as const, 'turn' as DashTimelineView)
const timelinePage = atom({ plugin: 'dashboard', key: 'timelinePage' } as const, null as DashTimelinePage | null, { shape: SHAPE })
const tick = atom({ plugin: 'dashboard', key: 'tick' } as const, 0)
const paneWake = atom({ plugin: 'dashboard', key: 'paneWake' } as const, 0)
const peek = atom({ plugin: 'dashboard', key: 'peek' } as const, null as AgentPeek | null, { shape: SHAPE })
const agentsFoldOpen = atom({ plugin: 'dashboard', key: 'agentsFoldOpen' } as const, false)
const runsFoldOpen = atom({ plugin: 'dashboard', key: 'runsFoldOpen' } as const, false)
const agentsSeenBefore = atom({ plugin: 'dashboard', key: 'agentsSeenBefore' } as const, 0)
const ledger = atom({ plugin: 'dashboard', key: 'ledger' } as const, null as UsageLedger | null, { shape: SHAPE })
const usageRead = atom({ plugin: 'dashboard', key: 'usageRead' } as const, null as UsageRead | null, { shape: SHAPE })
const progress = atom({ plugin: 'dashboard', key: 'progress' } as const, null as BoardRead | null, { shape: SHAPE })
const SHAPED_KEYS = new Set([agents, gpu, runs, seen, detail, reports, conversation, gates, trees, guards, peers, toasted, ownPresence, cache, measured, timeline, timelinePage, peek, ledger, usageRead, progress].map(one => one.ref.key))

// Module timers die with the module on reload; session.start, or the first band drawing of a reload that raised none, restarts them.
let ticker: Timer | null = null
let progressReadAt = 0
// The loops of an interactive session are running; started once per module.
let isStarted = false
// session.start's isInteractive: a -p or SDK session writes no presence file.
let isInteractive = true
// When `$.agent.list()` was last asked; 0 before the first time.
let agentsListedAt = 0
let runsPoll: Poll | null = null
// The GPU page's ssh while one is wanted.
let gpuLink: GpuLink | null = null
// When the runs were last polled; the snapshot's polledAt lags it while an unchanged poll is not written.
let runsPolledAt = 0
// mm wrote its watches since the runs were last read: the next poll reads them past the idle wait.
let isRunsAsked = false
let isCollecting = false
// What this session last wrote to its own presence file; null before the first write.
let presence: SessionPresence | null = null
// The subagent whose ask put the presence in `permission`; undefined for the main thread.
let askedBy: string | undefined
// What the main thread's last Stop said of background work in flight; the main turn.complete reads and clears it.
let isAwaitingTasks = false
// What the main turn.complete wrote for a turn ended by Esc or a failure, which a later Stop leaves; prompt.submit clears it.
let turnEnd: 'idle' | 'failed' | undefined
// The first line of the main thread's last Stop message, the detail of `replied`; prompt.submit clears it.
let replyLine: string | undefined
// Other sessions' files as last read, by file name: a file whose mtime did not move is not read again.
let peerFiles = new Map<string, { mtimeMs: number; peer: SessionPresence | null }>()
// The results the person marked read on the band (resultKey), the last MAX_AGENTS.
let bandDismissed: string[] = []
// A clock Client failed: the workbench draws its times as static text from then on.
let isClockFailed = false
// The last band drawing's viewport.isFullscreen: whether a pane opened unasked docks beside the transcript.
let docksPanes: boolean | undefined
let sessionTitle: string | undefined
// The cacheTtlMinutes option; the TTL in `cache`, from the transcript or a PostModelSwitch, overrides it.
let optionTtlMs = 60 * MINUTE_MS
// A resume the engine judged prompt_cache_likely_expired: cold whatever the TTL, until the next main reply or a /clear.
let isResumeExpired = false
// Fires when the cache turns cold, then each minute while it stays cold.
let coldTimer: Timer | null = null
let coldMinute: Timer | null = null
// Fires when a pending gate on the band expires or a limit countdown turns a minute: neither keeps the ticker going.
let bandWake: Timer | null = null
let bandWakeAt: number | null = null
// Fires when the overview next changes with time alone (nextOverviewChange): it reads no tick, its times moving by themselves.
let overviewWake: Timer | null = null
let overviewWakeAt: number | null = null
// When the person last typed or sent a prompt in this session; undefined before the first.
let inputAt: number | undefined
// What `$.ui.status` was last set to.
let statusText: string | undefined
// The askSound and toast* options.
let toastOptions = { askSound: false, peerAsks: true, peerReplies: true, runs: true }
// Whether the gpuHosts option names a host.
let hasGpuHosts = false
// The on-demand tabs whose data existed when the workbench last opened; null before the first check this load.
let shownTabs: ReadonlySet<DashPage> | null = null
// The progress page's re-read of the board; null while another page is current or the pane is closed.
let progressRead: Timer | null = null
// The branch PR's checks as last polled; null without a PR that has checks.
let ciStatus: CiStatus | null = null
// `gh` missing or not logged in: no `gh` is run before this time.
let ghBlockedUntil = 0
// The lines of this session's CI file last written; null until the first write of this load.
let ciKept: { path: string; lines: string[] } | null = null
const ciChain = serially()
// The events view's last read of each ledger file of the day: one whose size and mtime did not change is not read again.
let ledgerFiles = new Map<string, { size: number; mtimeMs: number; records: LedgerRecord[] }>()
// The repository's notice files, this session's main-advanced notice, main's sha last read and the root it was read in, and when /notice clear ran.
let noticeBoard: { list: Notice[]; auto: Notice | null; mainSha: string | null; mainRoot: string | null; clearedAt: number } = { list: [], auto: null, mainSha: null, mainRoot: null, clearedAt: 0 }
// The notice files as last read, by file name: a name read as a notice is not read again.
let noticeFiles = new Map<string, Notice | null>()
// Runs whose report the Reviews list is reading for its legend.
const listLoads = new Set<string>()

// Ephemeral desktop command disclosure states: which command boxes are open.
export const openDisclosures = new Set<string>()

export function toggleDisclosure($: EngineInterface, key: string): void {
  if (openDisclosures.has(key)) {
    openDisclosures.delete(key)
  } else {
    openDisclosures.add(key)
  }
  void update($, paneWake, was => was + 1)
}

// Lives here, not in i18n.ts: validate only follows $ into functions declared in the same file.
async function resolveLang($: EngineInterface, option: unknown): Promise<Lang> {
  const settings = await $.settings.read()
  return pickLang(option, settings.language, (await $.env.get('LC_ALL')) || (await $.env.get('LANG')))
}

/** A loop `poll` started: `now()` runs it at once, or once more as a run in flight ends; `cancel()` arms no further run. */
export type Poll = { now: () => Promise<void>; cancel: () => void }

/**
 * Runs `fn` `ms` after the last run ended, one run at a time.
 * A run that throws goes to the debug log; what it last wrote stands.
 */
export function poll($: EngineInterface, name: string, ms: number, fn: () => Promise<void>): Poll {
  let isPolling = false
  let isCancelled = false
  // A now() that came while a run was in flight: the run that ended may have read too early.
  let isAsked = false
  let timer: Timer | null = null
  const run = async () => {
    if (isPolling) {
      return
    }

    isPolling = true

    try {
      do {
        isAsked = false

        try {
          await fn()
        } catch (error) {
          $.ui.log(`dashboard: the ${name} poll failed: ${errorText(error)}`, { to: 'debug' })
        }
      } while (isAsked && !isCancelled)
    } finally {
      isPolling = false
    }
  }
  const arm = () => {
    timer = $.clock.after(ms, () => {
      void run()
        .then(() => {
          if (!isCancelled) {
            arm()
          }
        })
        .catch(() => undefined)
    })
  }

  arm()

  return {
    now: () => {
      isAsked = true

      return run()
    },
    cancel: () => {
      isCancelled = true
      timer?.cancel()
    },
  }
}

/** The main thread idle past the TTL since its last request; null while it works. */
async function coldNow($: EngineInterface, now: number): Promise<ColdCache | null> {
  const { lastReplyAt, resumeTokens, ttlMs } = await read($, cache)
  const isWorking = presence?.state === 'working' || presence?.state === 'permission'

  if (lastReplyAt === null || isWorking || (!isResumeExpired && now - lastReplyAt < (ttlMs ?? optionTtlMs))) {
    return null
  }

  return { idleMs: now - lastReplyAt, tokens: (await read($, measured)).context?.tokens ?? resumeTokens ?? null }
}

function stopCold(): void {
  coldTimer?.cancel()
  coldTimer = null
  coldMinute?.cancel()
  coldMinute = null
}

function stopBandWake(): void {
  bandWake?.cancel()
  bandWake = null
  bandWakeAt = null
}

/** Sets the band's one wake timer for `at`, unless it is set for that time already; none for null. */
function armBandWake($: EngineInterface, at: number | null, now: number): void {
  if (at === bandWakeAt) {
    return
  }

  stopBandWake()

  if (at !== null) {
    bandWakeAt = at
    bandWake = $.clock.after(at - now, () => {
      bandWake = null
      bandWakeAt = null
      void redraw($)
    })
  }
}

function armOverviewWake($: EngineInterface, at: number | null, now: number): void {
  if (at === overviewWakeAt) {
    return
  }

  overviewWake?.cancel()
  overviewWake = null
  overviewWakeAt = at

  if (at !== null) {
    overviewWake = $.clock.after(Math.max(0, at - now), () => {
      overviewWake = null
      overviewWakeAt = null
      void update($, paneWake, was => was + 1)
    })
  }
}

/** Redraws the band, the prompt hint and the workbench, which read `tick`; a transcript row does not, so it is left alone. */
async function redraw($: EngineInterface): Promise<void> {
  const now = await $.clock.now()

  await update($, tick, () => now)
  await syncStatus($)
}

/** While the workbench is not on screen, the status line counts running subagents and the sessions, this one too, asking or failed; set only on a change. */
async function syncStatus($: EngineInterface): Promise<void> {
  const isShown = (await $.ui.panes()).find(one => one.id === PANE_ID)?.isShown === true
  const running = (await read($, agents)).filter(one => one.state === 'running').length
  const isWaiting = (one: SessionPresence | null) => one?.state === 'permission' || one?.state === 'failed'
  const waiting = ((await read($, peers)) ?? []).filter(isWaiting).length + (isWaiting(presence) ? 1 : 0)
  const parts = [running > 0 ? t().statusRunning(running) : '', waiting > 0 ? t().statusWaiting(waiting) : ''].filter(part => part !== '')
  const text = isShown || parts.length === 0 ? undefined : parts.join(' · ')

  if (text !== statusText) {
    statusText = text
    $.ui.status(text)
  }
}

/** Redraws the band; keeps a minute timer for the idle time while the cache is cold, drops it once not. */
async function tickCold($: EngineInterface): Promise<void> {
  await redraw($)

  if ((await coldNow($, await $.clock.now())) === null) {
    stopCold()
  } else {
    coldMinute ??= $.clock.every(MINUTE_MS, () => void tickCold($))
  }
}

/** Sets the timer for the moment the cache turns cold, from the last request and the TTL. */
async function armCold($: EngineInterface): Promise<void> {
  stopCold()

  const { lastReplyAt, ttlMs } = await read($, cache)

  if (lastReplyAt === null) {
    return
  }

  const left = lastReplyAt + (ttlMs ?? optionTtlMs) - (await $.clock.now())

  if (left > 0 && !isResumeExpired) {
    coldTimer = $.clock.after(left, () => void tickCold($))
  } else {
    await tickCold($)
  }
}

type TranscriptLine = {
  type?: string
  isSidechain?: boolean
  message?: { usage?: { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } } }
}

/** The TTL the last main-thread reply of a transcript tail wrote the cache at; null when the tail holds none. */
function transcriptTtl(tail: string): keyof typeof CACHE_TTL_MS | null {
  for (const text of tail.split('\n').reverse()) {
    let line: TranscriptLine | null

    try {
      line = JSON.parse(text) as TranscriptLine | null
    } catch {
      // A `tail -c` read's first line is usually cut, its last may still be being written.
      continue
    }

    const written = line?.type === 'assistant' && line.isSidechain !== true ? line.message?.usage?.cache_creation : undefined

    if ((written?.ephemeral_1h_input_tokens ?? 0) > 0) {
      return '1h'
    }

    if ((written?.ephemeral_5m_input_tokens ?? 0) > 0) {
      return '5m'
    }
  }

  return null
}

/** When the main turn `turnId` sent its last request; undefined when the timeline kept none. */
function lastSentAt(turns: readonly TimelineTurn[], turnId: string): number | undefined {
  return turns.find(one => one.turnId === turnId && one.agentId === undefined)?.steps.at(-1)?.sentAt
}

/** The subagents' calls still running; none when the timeline cannot be read, so its failure stays on the timeline page. */
async function flightsNow($: EngineInterface): Promise<Map<string, Flight>> {
  return read($, timeline).then(toolsInFlight, () => new Map<string, Flight>())
}

/** The board of the band; a result the person marked read on it counts neither on the band nor as unread. */
async function boardNow($: EngineInterface) {
  const now = await $.clock.now()
  const marked = await read($, seen)
  const board = boardOf(
    (await read($, agents)).filter(one => one.state === 'running' || !bandDismissed.includes(resultKey(one))),
    await read($, runs),
    marked,
    now,
    await read($, gates),
    (await read($, peers)) ?? [],
    await coldNow($, now),
    await flightsNow($),
    await read($, trees),
  )
  return ciStatus === null ? board : withCi(board, ciStatus, marked.ci ?? 0)
}

/** The board with the CI row: a failure at P1, running checks at P3, a pass at P2 for FRESH_MS and unread until the workbench is opened after it. */
function withCi(board: Board, status: CiStatus, seenAt: number): Board {
  const tier = status.outcome === 'fail' ? 1 : status.outcome === 'pending' ? 3 : board.now - status.changedAt < FRESH_MS ? 2 : null
  const counts = { ...board.counts }

  if (status.outcome === 'fail') {
    counts.pending += 1
  } else if (status.outcome === 'pending') {
    counts.running += 1
  } else if (status.changedAt > seenAt) {
    counts.unread += 1
  }

  if (tier === null) {
    return { ...board, counts }
  }

  const line = ciLine(status, board.now)
  const entry: BandEntry = { tier, startedAt: status.changedAt, group: CI_GROUP, full: line, compact: line, counts: { 1: tier === 1 ? 1 : 0, 2: tier === 2 ? 1 : 0, 3: tier === 3 ? 1 : 0, aborted: 0, failed: 0 } }
  // The cold cache stays last, as boardOf puts it.
  const work = [...board.entries.filter(one => one.group !== CACHE_GROUP), entry].sort((a, b) => a.tier - b.tier || a.startedAt - b.startedAt)

  return { ...board, counts, entries: [...work, ...board.entries.filter(one => one.group === CACHE_GROUP)] }
}

/** The main-loop turn the timeline page shows: the one picked while it is still kept, else the latest. */
function shownTurnId(turns: readonly TimelineTurn[], picked: string | null): string | undefined {
  return turns.some(one => one.turnId === picked && one.agentId === undefined) ? (picked ?? undefined) : latestMainTurnId(turns)
}

/** The band's idle line: the last item that ended and the last gate. */
async function idleNow($: EngineInterface): Promise<Line> {
  const now = await $.clock.now()
  const all = await read($, gates)
  const recent = overviewOf(await read($, agents), await read($, runs), await read($, seen), now, (await read($, peers)) ?? [], all).recent[0]

  return idleLine(recent, all.at(-1), now)
}

type BandEntry = Board['entries'][number]
type RunningRow = Extract<BandRow, { kind: 'running' }>
type AskRow = Extract<BandRow, { kind: 'ask' }>
type NoticeRow = Extract<BandRow, { kind: 'notice' }>
type PlanRow = Extract<BandRow, { kind: 'plan' }>

/** The entries bandLines draws one per line, in its order: all of them when they fit whole, else the failures it keeps apart. */
function entriesShown(board: Board, rows: number): BandEntry[] {
  const { entries } = board

  if (entries.length <= Math.min(rows, 3)) {
    return entries
  }

  return rows <= 1 ? [] : entries.filter(entry => entry.tier === 1).slice(0, rows - 1)
}

/** The tone of a line's first colored segment; `idle` when none is colored. */
function toneOfLine(line: Line): Tone {
  const color = line.find(seg => seg.color !== undefined)?.color

  return (Object.keys(TONE_KEYS) as Tone[]).find(tone => TONE_KEYS[tone] === color) ?? 'idle'
}

/**
 * The band's rows from bandLines' `lines`: a running agent with its elapsed time on the shared scale, a fresh agent result the person may mark read,
 * the first session asking a permission as a card while `maxRows` has room for it; any other line as given.
 */
function bandRowsOf(board: Board, lines: readonly Line[], rows: number, sessions: readonly SessionPresence[], maxRows: number): BandRow[] {
  const shown = entriesShown(board, rows)
  const running = shown.flatMap(entry => (entry.tier === 3 && entry.run?.state === 'running' ? [entry.run] : []))
  const scale = scaleOf(Math.max(0, ...running.map(run => elapsedOf(run, board.now) / 1000)))
  const asking = sessions.filter(one => one.state === 'permission')
  let hasCardRoom = maxRows - lines.length >= ASK_CARD_ROWS - 1

  return lines.map((line, index): BandRow => {
    const entry = shown[index]
    const run = entry?.run

    if (entry !== undefined && run !== undefined && entry.tier === 3 && run.state === 'running') {
      const ms = elapsedOf(run, board.now)
      const time = fmtDuration(ms)
      const denied: Line = (run.denied ?? 0) > 0 ? [{ text: '  ' }, { text: t().denied(run.denied ?? 0), color: 'error' }] : []
      const quiet: Line = isStalled(run, board.now, entry.flight) ? [{ text: '  ' }, { text: t().quiet(fmtDuration(board.now - run.lastActivityAt)), color: 'warning' }] : []
      const step = entry.flight === undefined ? run.lastTool : flightText(entry.flight, board.now)

      return { kind: 'running', title: run.description, step, time, frac: ms / 1000 / scale.secs, alt: t().elapsedAlt(time, scale.label), tail: [...denied, ...quiet] }
    }

    if (entry !== undefined && run !== undefined && entry.tier === 2) {
      return { kind: 'result', line, tone: toneOfLine(line), agentId: run.agentId }
    }

    // A failed session is a tier 1 sessions entry too: only one counted as no failure asks.
    const at = entry?.tier === 1 && entry.group === 'sessions' && entry.counts.failed === 0 ? asking.findIndex(one => one.since === entry.startedAt) : -1
    const peer = at < 0 ? undefined : asking.splice(at, 1)[0]

    if (peer !== undefined && hasCardRoom) {
      hasCardRoom = false

      return { kind: 'ask', id: peer.id, head: `${peer.name} ${t().peerWords.permission}`, waited: t().askWaited(fmtDuration(board.now - peer.since)), task: peer.title ?? peer.name, request: peer.detail ?? '—' }
    }

    return { kind: 'line', line, tone: toneOfLine(line) }
  })
}

/** This session's current request while open with a piece not done: its pieces not dropped, in board order; else null. */
function planRowOf(board: BoardRead | null): PlanRow | null {
  const request = board?.requests.find(one => one.id === board.current && one.status === 'open')

  if (board === null || request === undefined) {
    return null
  }

  const statuses = board.nodes.filter(node => node.request === request.id && node.status !== 'dropped').map(node => node.status)
  const done = statuses.filter(status => status === 'done').length

  if (statuses.length === 0 || done === statuses.length) {
    return null
  }

  return { kind: 'plan', title: request.title, statuses, done, total: statuses.length, alt: t().planAlt(done, statuses.length, request.title) }
}

/** The plan row on the terminal: the title bold, a text bar of its done pieces, `done/total` subtle. */
function planText(row: PlanRow): Line {
  const done = Math.round((row.done / row.total) * BAND_BAR_CELLS)

  return [
    { text: fit(row.title, BAND_TITLE_COLUMNS), bold: true },
    { text: ' ' },
    { text: '▰'.repeat(done), color: 'success' },
    { text: '▱'.repeat(BAND_BAR_CELLS - done), color: 'inactive' },
    { text: '  ' },
    { text: `${row.done}/${row.total}`, color: 'subtle' },
  ]
}

/** `rows` less trailing idle, line, result and notice rows, then the plan row, until at most `count` rows weigh at most `maxRows`, an ask card ASK_CARD_ROWS. */
function withinBand(rows: readonly BandRow[], count: number, maxRows: number): BandRow[] {
  const kept = [...rows]
  const weight = () => kept.reduce((sum, row) => sum + (row.kind === 'ask' ? ASK_CARD_ROWS : 1), 0)

  while (kept.length > count || weight() > maxRows) {
    const trailing = kept.findLastIndex(row => row.kind === 'idle' || row.kind === 'line' || row.kind === 'result' || row.kind === 'notice')
    const at = trailing >= 0 ? trailing : kept.findIndex(row => row.kind === 'plan')

    if (at < 0) {
      break
    }

    kept.splice(at, 1)
  }

  return kept
}

/** The idle line on the terminal: `✓ 空闲` in success, the rest subtle, its glyphs keeping their own colors. */
function idleText(line: Line): Line {
  const [word, ...rest] = line

  return [{ text: '✓', color: 'success' }, { text: ' ' }, { text: word?.text ?? t().idleBand, color: 'success', bold: true }, ...rest.map(seg => ({ text: seg.text, color: seg.color ?? 'subtle' }))]
}

/** A running row on the terminal: its glyph, the title `titleColumns` wide, a text bar, the step bold, the time dim. */
function runningText(row: RunningRow, titleColumns: number): Line {
  const done = Math.round(Math.min(1, Math.max(0, row.frac)) * BAND_BAR_CELLS)

  return [
    { text: '●', color: 'permission' },
    { text: ` ${padTo(fit(row.title, titleColumns), titleColumns)} ` },
    { text: '▰'.repeat(done), color: 'permission' },
    { text: '▱'.repeat(BAND_BAR_CELLS - done), color: 'inactive' },
    { text: '  ' },
    ...(row.step === '' ? [] : [{ text: fit(row.step, BAND_STEP_COLUMNS), bold: true }, { text: ' ' }]),
    { text: row.time, dim: true },
    ...row.tail,
  ]
}

/** One title width for every running row: the widest title up to BAND_TITLE_COLUMNS, less what `columns` cannot hold beside the rest. */
function runningTitleColumns(rows: readonly BandRow[], columns: number): number {
  const running = rows.filter((row): row is RunningRow => row.kind === 'running')
  const rest = Math.max(0, ...running.map(row => widthOf(runningText(row, 0).map(seg => seg.text).join(''))))
  const widest = Math.min(BAND_TITLE_COLUMNS, Math.max(0, ...running.map(row => widthOf(row.title))))

  return Math.max(Math.min(widest, BAND_MIN_TITLE_COLUMNS), Math.min(widest, columns - rest))
}

/**
 * A session asking a permission on the terminal: a `╭─ 需要你 ─╮` frame in warning `width` wide, the head, the task and the request,
 * then the button, and 工作台 after it when `onOpen` is given.
 */
function askCard(el: ElementTable, row: AskRow, width: number, onAsk: () => void, onOpen?: () => void) {
  const { Box, Button, Text } = el
  const inner = Math.max(0, width - 4)
  const title = ` ${t().needsYou} `
  const labelColumns = Math.max(widthOf(t().askTask), widthOf(t().askRequest)) + 2
  const framed = (body: RenderChildren, used: number) => (
    <Text wrap="truncate">
      <Text color="warning">{'│ '}</Text>
      {body}
      {' '.repeat(Math.max(0, inner - used))}
      <Text color="warning">{' │'}</Text>
    </Text>
  )
  const lineRow = (line: Line) => {
    const fitted = fitLine(line, inner)

    return framed(
      fitted.map(seg => (
        <Text {...(seg.color !== undefined && { color: seg.color })} {...(seg.bold === true && { bold: true })} {...(seg.dim === true && { dimColor: true })}>
          {seg.text}
        </Text>
      )),
      widthOf(fitted.map(seg => seg.text).join('')),
    )
  }
  const kvRow = (label: string, value: string): Line => [{ text: padTo(label, labelColumns), color: 'subtle' }, { text: value, bold: true }]

  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text color="warning">{'╭─'}</Text>
        <Text color="warning" bold>
          {title}
        </Text>
        <Text color="warning">{`${'─'.repeat(Math.max(0, width - 3 - widthOf(title)))}╮`}</Text>
      </Text>
      {lineRow([{ text: '!', color: 'warning' }, { text: ` ${row.head}`, bold: true }, { text: `  · ${row.waited}`, dim: true }])}
      {lineRow(kvRow(t().askTask, row.task))}
      {lineRow(kvRow(t().askRequest, row.request))}
      <Box>
        <Text color="warning">{'│ '}</Text>
        <Button key={`ask-${row.id}`} label={t().askHandle} onPress={onAsk} />
        {onOpen === undefined ? null : <Text> </Text>}
        {onOpen === undefined ? null : <Button key="dash-open" label={t().workbench} onPress={onOpen} />}
        <Text>{' '.repeat(Math.max(0, inner - widthOf(t().askHandle) - 4 - (onOpen === undefined ? 0 : buttonColumns())))}</Text>
        <Text color="warning">{' │'}</Text>
      </Box>
      <Text color="warning" wrap="truncate">{`╰${'─'.repeat(Math.max(0, width - 2))}╯`}</Text>
    </Box>
  )
}

/** One result of an agent: an agent sent on ends again under the same id. */
const resultKey = (run: AgentRun) => `${run.agentId}@${run.endedAt ?? ''}`

/** Marks an agent's new result read: off the band and out of its unread count; the agents that ended before it stay as they were. */
async function dismissResult($: EngineInterface, agentId: string): Promise<void> {
  const run = (await read($, agents)).find(one => one.agentId === agentId)

  if (run !== undefined) {
    bandDismissed = [...bandDismissed.filter(key => key !== resultKey(run)), resultKey(run)].slice(-MAX_AGENTS)
  }

  await redraw($)
}

/** A usage gauge's tone: normal under 80%, a warning to 95%, an error from there. */
const usageTone = (percent: number): Tone => (percent < 80 ? 'running' : percent < 95 ? 'stale' : 'failed')

/** The time to a reset: `42m`, `1h05`, `3d4h` past a day. */
function countdown(ms: number): string {
  if (ms < 3_600_000) {
    return ms < 60_000 ? '<1m' : `${Math.floor(ms / 60_000)}m`
  }

  return ms < DAY_MS ? `${Math.floor(ms / 3_600_000)}h${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}` : `${Math.floor(ms / DAY_MS)}d${Math.floor((ms % DAY_MS) / 3_600_000)}h`
}

/** The element table with each Client, the pane's only ones being lineText's clocks, drawn as the static time the clock would show first. */
export function staticClocks(el: El): El {
  const { Text } = el

  return {
    ...el,
    Client: props => {
      const clock = props.props as { from: number; now: number; format: 'duration' | 'age'; color: string; bold: boolean }

      return (
        <Text color={clock.color} bold={clock.bold}>
          {(clock.format === 'age' ? fmtAge : fmtDuration)(clock.now - clock.from)}
        </Text>
      )
    },
  }
}

/** The timeline page is on screen with a turn that has not ended: its running times move. */
async function isTimelineLive($: EngineInterface): Promise<boolean> {
  if ((await read($, page)) !== 'timeline' || (await $.ui.panes()).find(one => one.id === PANE_ID)?.isShown !== true) {
    return false
  }

  const turns = await read($, timeline)
  const id = shownTurnId(turns, await read($, timelineTurn))

  return turns.some(one => one.turnId === id && one.endedAt === undefined)
}

/**
 * Something moves with time: on the band a running agent or model, or a result still inside its 20 s; or the timeline page's open turn.
 * The cold cache has its own minute timer.
 */
async function isLive($: EngineInterface): Promise<boolean> {
  return (
    (await read($, agents)).some(one => one.state === 'running') ||
    // Running checks show no time.
    (await boardNow($)).entries.some(entry => entry.tier !== 1 && entry.group !== CACHE_GROUP && !(entry.group === CI_GROUP && entry.tier === 3)) ||
    (await isTimelineLive($))
  )
}

/** Shows `turnId` on the timeline page from its newest steps; null, or the newest main turn, follows the latest. */
async function pickTurn($: EngineInterface, turnId: string | null): Promise<void> {
  const latest = latestMainTurnId(await read($, timeline))

  await update($, timelineTurn, () => (turnId === latest ? null : turnId))
  await update($, timelinePage, () => null)
  await ensureTicker($)
}

/** Closes the agents the engine lists as ended (killed ones get no turn.complete), asking at most every AGENT_LIST_MS while one is quiet or idle. */
async function reconcileAgents($: EngineInterface): Promise<void> {
  const now = await $.clock.now()

  // Quiet by its last tool end alone: a killed agent's call in flight never ends on the timeline.
  if (now - agentsListedAt < AGENT_LIST_MS || !(await read($, agents)).some(one => one.state === 'idle' || isStalled(one, now))) {
    return
  }

  agentsListedAt = now

  // A list that cannot be read tells nothing: every agent stays as it was.
  const listed = await $.agent.list().catch(() => null)

  if (listed !== null) {
    await update($, agents, list => noteListed(list, listed, now))
  }
}

/** Redraws once a second while anything on the band is live, so elapsed times move and fresh results expire. */
async function ensureTicker($: EngineInterface): Promise<void> {
  if (ticker !== null || !(await isLive($))) {
    return
  }

  // Another call may have started one while isLive was read.
  ticker ??= $.clock.every(1000, () => {
    void (async () => {
      await redraw($)
      await reconcileAgents($)

      if (!(await isLive($)) && ticker !== null) {
        ticker.cancel()
        ticker = null
        // An agent spawned while isLive was read found this timer still set and started none.
        await ensureTicker($)
      }
    })()
  })
}

/** Where a leading `cd <dir> &&` moves, a relative dir taken from `cwd` and an unquoted `~` from `home`; else `cwd`. */
function dirOf(command: string, cwd: string, home: string): string {
  const [, single, double, bare] = CD_DIR.exec(command) ?? []
  const dir = single ?? double ?? (bare === '~' || bare?.startsWith('~/') ? `${home}${bare.slice(1)}` : bare)

  if (dir === undefined) {
    return cwd
  }

  const parts: string[] = []

  for (const part of (dir.startsWith('/') || dir.startsWith('~') ? dir : `${cwd}/${dir}`).split('/')) {
    if (part === '..') {
      parts.pop()
    } else if (part !== '.' && part !== '') {
      parts.push(part)
    }
  }

  return `/${parts.join('/')}`
}

/** The linked worktree `path` lies in: the deepest of `listed` holding it, else by its `.claude/worktrees/<name>` (one made since the last collection); null for none. */
function treeAt(path: string, listed: readonly WorktreeInfo[] | null): string | null {
  const holding = (listed ?? []).filter(tree => path === tree.path || path.startsWith(`${tree.path}/`))

  return holding.sort((a, b) => b.path.length - a.path.length)[0]?.name ?? WORKTREE_DIR.exec(path)?.[1] ?? null
}

/** Records a Bash result that reads as a test run; `where` is the worktree the command ran in; `isFailure`: it ended in PostToolUseFailure. */
async function noteGate($: EngineInterface, command: unknown, text: string | null, cwd: string, agentId: string | undefined, isFailure: boolean): Promise<void> {
  const summary = text === null ? null : summarizeTests(text)

  if (summary === null || typeof command !== 'string') {
    return
  }

  const failed = summary.failed || isFailure
  const gate: GateRun = {
    // An edit in its tree after this time makes it stale.
    at: await $.clock.now(),
    command: command.trim().replace(/\s+/g, ' ').slice(0, GATE_COMMAND_CHARS),
    key: command.trim(),
    where: treeAt(dirOf(command, cwd, (await $.env.get('HOME')) ?? ''), await read($, trees)) ?? 'main',
    ...(agentId !== undefined && { agentId }),
    ...summary,
    // An exit alone called it failed: how many failed is unknown, not 0.
    fail: failed && summary.fail === 0 ? null : summary.fail,
    failed,
  }

  await update($, gates, list => [...list, gate].slice(-MAX_GATES))
}

/** A file edited at `path`: the gates of its tree, a worktree or else the session root's, run before now go stale; a file outside both is no tree's. */
async function noteEdit($: EngineInterface, path: unknown): Promise<void> {
  if (typeof path !== 'string') {
    return
  }

  const where = treeAt(path, await read($, trees)) ?? (path.startsWith(`${await $.session.root()}/`) ? 'main' : null)

  if (where === null) {
    return
  }

  const now = await $.clock.now()
  const isTurning = (gate: GateRun) => gate.where === where && gate.at < now && gate.stale !== true

  // Every edit lands here: the atom is written, and the band redrawn, only when a gate turns stale.
  if ((await read($, gates)).some(isTurning)) {
    await update($, gates, list => list.map(gate => (isTurning(gate) ? { ...gate, stale: true } : gate)))
  }
}

// mmrun runs, read from ~/.claude/mmruns; never written.

/** Equal by value; for the small polled arrays only. */
const isSame = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function readText($: EngineInterface, path: string): Promise<string> {
  try {
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

/** This session's id, which mmrun writes into the runs it starts; null when the engine does not give it. */
async function sessionIdOf($: EngineInterface): Promise<string | null> {
  try {
    return await $.session.id()
  } catch {
    return null
  }
}

/** The model with what <name>.events.jsonl says, its first line read only while the session it names is not known yet; a read that fails adds nothing. */
async function readModelEvents($: EngineInterface, dir: string, name: string, mtimes: Map<string, number>, old: MmModel | undefined, model: MmModel): Promise<MmModel> {
  if (!mtimes.has(`${name}.events.jsonl`)) {
    return model
  }

  const path = `${dir}/${name}.events.jsonl`
  const head = old?.claudeSession === undefined ? await $.process.run(['head', '-n', '1', path], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => null) : null
  const tail = await $.process.run(['tail', '-c', String(EVENTS_TAIL_BYTES), path], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
  const known = old?.claudeSession === undefined ? model : { ...model, claudeSession: old.claudeSession }

  return applyEvents(known, [head, tail].map(read => (read?.exitCode === 0 ? read.stdout : '')).join('\n'))
}

async function readModel($: EngineInterface, dir: string, name: string, mtimes: Map<string, number>, now: number, old: MmModel | undefined): Promise<MmModel> {
  return readModelEvents($, dir, name, mtimes, old, await readStatus($, dir, name, mtimes, now, old))
}

async function readStatus($: EngineInterface, dir: string, name: string, mtimes: Map<string, number>, now: number, old: MmModel | undefined): Promise<MmModel> {
  const started = Number((await readText($, `${dir}/${name}.started`)).trim())
  const model: MmModel = {
    name,
    status: (await readText($, `${dir}/${name}.status`)).trim() || 'RUNNING',
    startedAt: Number.isFinite(started) && started > 0 ? started * 1000 : 0,
  }

  if (model.status === 'RUNNING') {
    const raw = mtimes.has(`${name}.pid`) ? (await readText($, `${dir}/${name}.pid`)).trim() : ''
    const pid = /^\d+$/.test(raw) ? raw : ''
    const isAlive = pid !== '' ? (await $.process.run(['kill', '-0', pid])).exitCode === 0 : model.startedAt === 0 || now - model.startedAt <= PID_GRACE_MS

    return isAlive ? model : { ...model, status: 'STALE', endedAt: old?.endedAt ?? mtimes.get(`${name}.raw`) ?? now }
  }

  model.endedAt = mtimes.get(`${name}.status`) ?? now

  // `mmrun status` rewrites a dead RUNNING as STALE whenever it runs, so the status file's time says nothing.
  if (model.status === 'STALE') {
    model.endedAt = mtimes.get(`${name}.raw`) ?? mtimes.get(`${name}.started`) ?? (model.startedAt || model.endedAt)
  }

  if (mtimes.has(`${name}.meta`)) {
    const meta = parseKv(await readText($, `${dir}/${name}.meta`))
    const secs = Number(meta.secs)

    if (meta.secs && Number.isFinite(secs)) {
      model.secs = secs
    }

    try {
      const tokens = (JSON.parse(meta.usage ?? '') as { output_tokens?: unknown }).output_tokens

      if (typeof tokens === 'number') {
        model.outputTokens = tokens
      }
    } catch {}
  }

  return model
}

const errorText = (error: unknown) => firstLine(error instanceof Error ? error.message : String(error))

/** A listing refused for want of the directory: mmrun never ran here, which is no runs rather than a failed read. */
const isMissing = (error: unknown) => (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') || /\bENOENT\b/.test(errorText(error))

/** A status no later poll can change; STALE can still turn DONE. */
const isFinal = (model: MmModel) => model.status === 'DONE' || model.status === 'CANCELLED' || model.status.startsWith('FAIL:') || model.status.startsWith('SKIP:')

/** Reads the newest 20 runs from the last 24 hours; runs whose every model was final in `prev` are reused as they were. Rejects when a listing fails, a missing root aside. */
async function pollRuns($: EngineInterface, prev: MmSnapshot | null): Promise<MmSnapshot> {
  const now = await $.clock.now()
  const root = `${(await $.env.get('HOME')) ?? ''}/.claude/mmruns`
  let ids: string[]

  try {
    ids = (await $.fs.list(root))
      .filter(entry => entry.kind === 'dir' && RUNID.test(entry.name))
      .map(entry => entry.name)
      .sort()
      .reverse()
      .slice(0, MAX_RUNS)
  } catch (error) {
    if (isMissing(error)) {
      return { polledAt: now, runs: [] }
    }

    throw error
  }

  const found: MmRun[] = []

  for (const runid of ids) {
    const old = prev?.runs.find(run => run.runid === runid)

    if (old !== undefined && old.models.length > 0 && old.models.every(isFinal)) {
      if (now - old.createdAt <= DAY_MS) {
        found.push(old)
      }

      continue
    }

    const dir = `${root}/${runid}`
    let createdAt: number

    try {
      createdAt = (await $.fs.stat(`${dir}/run.meta`)).mtimeMs
    } catch {
      continue
    }

    if (now - createdAt > DAY_MS) {
      continue
    }

    const mtimes = new Map((await $.fs.list(dir)).map(entry => [entry.name, entry.mtimeMs]))
    const meta = parseKv(await readText($, `${dir}/run.meta`))
    const models: MmModel[] = []

    // Model names become file names inside the run directory, so nothing that could step out of it.
    for (const name of (meta.models ?? '').split(',').filter(one => MODEL_NAME.test(one))) {
      models.push(await readModel($, dir, name, mtimes, now, old?.models.find(m => m.name === name)))
    }

    found.push({ runid, tag: meta.tag ?? '', workdir: meta.workdir ?? '', mode: meta.mode ?? '', createdAt, models })
  }

  return { polledAt: now, runs: found }
}

/** Reads each model's <m>.json and <m>.out of a listed run into `reports`. */
async function loadReport($: EngineInterface, runid: string, showAll: boolean): Promise<void> {
  const run = (await read($, runs))?.runs.find(one => one.runid === runid)

  if (run === undefined) {
    return
  }

  const dir = `${(await $.env.get('HOME')) ?? ''}/.claude/mmruns/${runid}`
  const models: DashReport['models'] = []

  for (const model of run.models) {
    let json: unknown = null

    try {
      json = JSON.parse(String(await $.fs.read(`${dir}/${model.name}.json`)))
    } catch {}

    const outPath = `${dir}/${model.name}.out`
    const review = reviewOf(json, run.mode, outPath)

    models.push({ name: model.name, status: model.status, markdown: reportOf(json, await readText($, outPath), run.mode, showAll, outPath), ...(review !== null && { review }) })
  }

  const loadedAt = await $.clock.now()
  const open = await read($, detail)

  // The severity toggled while this read: the toggle's own load writes the report.
  if (open?.page === 'mmrun' && open.runid === runid && open.showAll !== showAll) {
    return
  }

  await update($, reports, was => ({ ...was, [runid]: { loadedAt, models } }))
}

/** The legend of the Reviews list: each finished run shown there read once, again when read before it moved; the reader reads its own run. */
async function loadListed($: EngineInterface): Promise<void> {
  const loaded = await read($, reports)

  for (const run of (await read($, runs))?.runs.slice(0, PANE_RUNS) ?? []) {
    const isDone = run.models.length > 0 && run.models.every(model => model.status !== 'RUNNING')
    const report = loaded[run.runid]

    if (isDone && (report === undefined || isReportStale(run, report)) && !listLoads.has(run.runid)) {
      listLoads.add(run.runid)

      try {
        await loadReport($, run.runid, false)
      } finally {
        listLoads.delete(run.runid)
      }
    }
  }
}

async function readRun($: EngineInterface, runid: string): Promise<void> {
  await update($, detail, (): DashDetail => ({ page: 'mmrun', runid, showAll: false }))
  await loadReport($, runid, false)
}

async function readAgent($: EngineInterface, agentId: string): Promise<void> {
  await update($, detail, (): DashDetail => ({ page: 'agents', agentId }))
  await peekAgent($)
}

/** Reads the open running agent's transcript into `peek`, once per lastActivityAt: a failed read too stays until the agent moves. */
async function peekAgent($: EngineInterface): Promise<void> {
  const open = await read($, detail)
  const run = open?.page === 'agents' ? (await read($, agents)).find(one => one.agentId === open.agentId) : undefined

  if (run === undefined || run.state !== 'running') {
    return
  }

  const was = await read($, peek)

  if (was?.agentId === run.agentId && was.activityAt === run.lastActivityAt) {
    return
  }

  const base = { agentId: run.agentId, activityAt: run.lastActivityAt }
  const found = await $.session.messages({ agentId: run.agentId }).catch((error: unknown) => ({ deny: errorText(error) }))
  const now = await read($, detail)

  // Left for another agent while reading: that one's read owns `peek`.
  if (now?.page !== 'agents' || now.agentId !== run.agentId) {
    return
  }

  const isNewer = (was: AgentPeek | null) => was?.agentId === run.agentId && was.activityAt > run.lastActivityAt

  if (Array.isArray(found)) {
    await update($, peek, (was): AgentPeek | null => (isNewer(was) ? was : { ...base, ...peekOf(found) }))
  } else {
    $.ui.log(`dashboard: cannot read agent ${run.agentId}: ${found.deny}`, { to: 'debug' })
    await update($, peek, (was): AgentPeek | null => (isNewer(was) ? was : { ...base, task: '', calls: [], text: '', failed: true }))
  }
}

/** An overview row pressed: the agent's answer on the Agents page, or the model's run on the Reviews page. */
async function openItem($: EngineInterface, item: OverviewItem): Promise<void> {
  if (item.kind === 'agent') {
    await goTo($, 'agents')
    await readAgent($, item.run.agentId)
  } else {
    await goTo($, 'mmrun')
    await readRun($, item.run.runid)
  }
}

async function closeDetail($: EngineInterface): Promise<void> {
  await update($, detail, () => null)
}

/** Flips the open run between critical/major only and every severity. */
async function toggleSeverity($: EngineInterface): Promise<void> {
  const open = await read($, detail)

  if (open?.page !== 'mmrun') {
    return
  }

  await update($, detail, () => ({ ...open, showAll: !open.showAll, finding: 0 }))
  await loadReport($, open.runid, !open.showAll)
}

/** The desktop reader's model picked: its first shown finding, or its transcript read again in the conversation view. */
async function pickReportModel($: EngineInterface, model: string): Promise<void> {
  await update($, detail, open => (open?.page === 'mmrun' ? { ...open, model, finding: 0 } : open))
  await readConversation($)
}

async function pickReportView($: EngineInterface, view: 'report' | 'conversation'): Promise<void> {
  await update($, detail, open => (open?.page === 'mmrun' ? { ...open, view } : open))
  await readConversation($)
}

/** The open reader's model, and its run: the one picked, else the first. */
async function readerModel($: EngineInterface): Promise<{ runid: string; model: MmModel } | null> {
  const open = await read($, detail)

  if (open?.page !== 'mmrun') {
    return null
  }

  const { runid, model: picked } = open
  const run = (await read($, runs))?.runs.find(one => one.runid === runid)
  const model = run?.models.find(one => one.name === picked) ?? run?.models[0]

  return model === undefined ? null : { runid, model }
}

/** Only under the codex and grok session roots, so an events line cannot point the read anywhere else. */
async function isTranscriptPath($: EngineInterface, path: string): Promise<boolean> {
  const home = (await $.env.get('HOME')) ?? ''
  const codexHome = await $.env.get('CODEX_HOME')
  const roots = [...(home === '' ? [] : [`${home}/.codex/sessions/`, `${home}/.grok/sessions/`]), ...(codexHome ? [`${codexHome}/sessions/`] : [])]

  return path.startsWith('/') && !path.includes('/../') && roots.some(root => path.startsWith(root))
}

/** Reads the open reader's model transcript into `conversation` while the reader shows its conversation view; a path outside the roots reads as unreadable. */
async function readConversation($: EngineInterface): Promise<void> {
  const open = await read($, detail)
  const shown = await readerModel($)
  const path = shown?.model.transcriptPath

  if (open?.page !== 'mmrun' || open.view !== 'conversation' || shown === null || path === undefined) {
    return
  }

  const tail = (await isTranscriptPath($, path)) ? await $.process.run(['tail', '-c', String(TRANSCRIPT_TAIL_BYTES), path], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => null) : null
  const found = tail?.exitCode === 0 ? conversationOf(tail.stdout) : null
  const readAt = await $.clock.now()
  const now = await readerModel($)

  // Another model or run picked while this read: that one's read owns `conversation`.
  if (now?.runid !== shown.runid || now.model.name !== shown.model.name) {
    return
  }

  await update($, conversation, () => ({ runid: shown.runid, model: shown.model.name, readAt, items: found?.items ?? null, dropped: found?.dropped ?? 0 }))
}

async function pickFinding($: EngineInterface, finding: number): Promise<void> {
  await update($, detail, open => (open?.page === 'mmrun' ? { ...open, finding } : open))
}

/** Whether the run's models moved since its report was read: a status changed, or a status file was written after. */
function isReportStale(run: MmRun, report: DashReport): boolean {
  return !isSame(run.models.map(m => [m.name, m.status]), report.models.map(m => [m.name, m.status])) || run.models.some(m => (m.endedAt ?? 0) > report.loadedAt)
}

async function tickRuns($: EngineInterface): Promise<void> {
  try {
    const prev = await read($, runs)
    const isBusy = prev?.runs.some(run => run.models.some(m => m.status === 'RUNNING')) ?? true

    if (prev !== null && !isBusy && !isRunsAsked && (await $.clock.now()) - runsPolledAt < RUNS_IDLE_MS) {
      return
    }

    isRunsAsked = false

    // A model that ended since the last poll may have written its last reply after that poll's read.
    const wasReaderRunning = (await readerModel($))?.model.status === 'RUNNING'
    const polled = await pollRuns($, prev)

    runsPolledAt = polled.polledAt

    // A running model's elapsed time is drawn against polledAt, so only an idle snapshot may stay as it was.
    if (prev === null || isBusy || prev.error !== undefined || !isSame(prev.runs, polled.runs)) {
      await update($, runs, () => polled)
    }

    // Only the open report is read again; the others are read when opened.
    const open = await read($, detail)

    if (open?.page === 'mmrun') {
      const run = polled.runs.find(one => one.runid === open.runid)
      const report = (await read($, reports))[open.runid]

      if (run !== undefined && report !== undefined && isReportStale(run, report)) {
        await loadReport($, open.runid, open.showAll)
      }

      if (open.view === 'conversation' && (wasReaderRunning || (await readerModel($))?.model.status === 'RUNNING')) {
        await readConversation($)
      }
    }

    // The first load of a session has nothing to compare with, so it never toasts; a run on screen is being read already.
    const shown = await runsOnScreen($, polled)
    const toast = prev === null ? null : endToast(prev, { ...polled, runs: polled.runs.filter(run => !shown.has(run.runid)) })

    if (toast !== null && toastOptions.runs) {
      $.ui.toast(toast)
    }

    await ensureTicker($)
  } catch (error) {
    const now = await $.clock.now()

    runsPolledAt = now
    // The runs last read stay, and their polledAt with them: no time is drawn past what was read.
    await update($, runs, was => ({ polledAt: was?.polledAt ?? now, runs: was?.runs ?? [], error: errorText(error) }))
  }
}

/** The runs the workbench shows now: the open one, else the Reviews page's list; none while it is hidden or on another page. */
async function runsOnScreen($: EngineInterface, snap: MmSnapshot): Promise<Set<string>> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE_ID)

  if (pane === undefined || !pane.isShown || !pane.isPlaced || (await read($, page)) !== 'mmrun') {
    return new Set()
  }

  const open = await read($, detail)

  if (open?.page === 'mmrun') {
    return new Set([open.runid])
  }

  const sessionId = await sessionIdOf($)
  const isFoldOpen = await read($, runsFoldOpen)

  return new Set(snap.runs.slice(0, PANE_RUNS).filter(run => isFoldOpen || runSession(run, sessionId) !== false).map(run => run.runid))
}

// Worktrees and the session state file, for the overview.

const firstLine = (text: string) => text.split('\n')[0] ?? ''

async function git($: EngineInterface, dir: string, args: string[]) {
  return $.process.run(['git', '-C', dir, ...args], { timeoutMs: GIT_TIMEOUT_MS })
}

async function readTree($: EngineInterface, tree: PorcelainTree, base: string, runningIds: ReadonlySet<string>): Promise<WorktreeInfo> {
  const name = tree.path.split('/').pop() ?? tree.path
  const running = name.startsWith('agent-') && runningIds.has(name.slice('agent-'.length))
  const failed = (error: string): WorktreeInfo => ({ name, path: tree.path, branch: tree.branch, dirty: 0, ahead: 0, behind: 0, merged: false, running, error })

  try {
    const status = await git($, tree.path, ['status', '--porcelain'])

    if (status.exitCode !== 0) {
      return failed(firstLine(status.stderr))
    }

    const counts = await git($, tree.path, ['rev-list', '--left-right', '--count', `${base}...HEAD`])

    return counts.exitCode === 0 ? { ...treeOf(name, tree.branch, status.stdout, counts.stdout, running), path: tree.path } : failed(firstLine(counts.stderr))
  } catch (error) {
    return failed(firstLine(error instanceof Error ? error.message : String(error)))
  }
}

/** The session root's linked worktrees; none when the root is not a readable repository. `runningIds`: agents still running. */
async function readTrees($: EngineInterface, runningIds: ReadonlySet<string>): Promise<WorktreeInfo[]> {
  const list = await git($, await $.session.root(), ['worktree', 'list', '--porcelain'])
  const [main, ...rest] = list.exitCode === 0 ? parseWorktrees(list.stdout) : []

  if (main === undefined) {
    return []
  }

  const base = main.branch === 'detached' ? main.head : main.branch
  const found: WorktreeInfo[] = []

  for (const tree of rest) {
    found.push(await readTree($, tree, base, runningIds))
  }

  return found
}

async function collectWorkspace($: EngineInterface): Promise<void> {
  if (isCollecting) {
    return
  }

  isCollecting = true

  try {
    // Without a session root there are no worktrees to show.
    const runningIds = new Set((await read($, agents)).filter(one => one.state === 'running').map(one => one.agentId))
    const found = await readTrees($, runningIds).catch(() => [])

    await update($, trees, () => found)
    // A guard log that cannot be read leaves the blocks as they were.
    await collectGuards($).catch(() => undefined)
  } finally {
    isCollecting = false
  }
}

/** ~/.claude/harness/guard.jsonl's newest blocks, read again only once its mtime moved; null while there is no file. */
async function collectGuards($: EngineInterface): Promise<void> {
  const path = `${(await $.env.get('HOME')) ?? ''}/.claude/harness/guard.jsonl`
  const stat = await $.fs.stat(path).catch(() => null)
  const was = await read($, guards)

  if (stat?.kind !== 'file') {
    if (was !== null) {
      await update($, guards, () => null)
    }

    return
  }

  if (was?.mtimeMs === stat.mtimeMs) {
    return
  }

  const tail = await $.process.run(['tail', '-c', String(GUARD_TAIL_BYTES), path], { timeoutMs: GIT_TIMEOUT_MS })

  if (tail.exitCode === 0) {
    await update($, guards, () => ({ mtimeMs: stat.mtimeMs, blocks: parseGuards(tail.stdout, GUARD_ROWS) }))
  }
}

async function tickWorkspace($: EngineInterface): Promise<void> {
  if (!(await isPaneOnScreen($)) || ((await read($, page)) ?? 'overview') !== 'overview') {
    return
  }

  await collectWorkspace($)
}

// The branch PR's CI (E2) and the repository's notices (E3): polled, drawn on the band, never a turn.

/** The repository's main worktree, which all its sessions share; else the session root. */
async function repoRoot($: EngineInterface): Promise<string> {
  return (await $.session.repo().catch(() => null))?.root ?? (await $.session.root())
}

/** `gh` run in `dir`; 'blocked', and no `gh` run for CI_RETRY_MS, when it is missing or not logged in; 'failed' when it timed out or else could not run this time. */
async function gh($: EngineInterface, dir: string, argv: string[]) {
  const r = await $.process.run(argv, { cwd: dir, timeoutMs: GIT_TIMEOUT_MS }).catch((error: unknown) => (isNotFound(error) ? null : ('failed' as const)))

  if (r === 'failed') {
    return r
  }

  if (r === null || r.exitCode === 127 || isNoAuth(r.exitCode, r.stderr)) {
    ghBlockedUntil = (await $.clock.now()) + CI_RETRY_MS

    return 'blocked' as const
  }

  return r
}

/** Keeps the status, with a ci.result line in the event ledger when the PR's overall state changed, and redraws the band. */
async function setCi($: EngineInterface, status: CiStatus | null): Promise<void> {
  const was = ciStatus

  if (was === null && status === null) {
    return
  }

  ciStatus = status
  await emitCi($, ciEvents(was, status))
  await redraw($)
}

/** Adds `events` to this session's CI file of today, `<session>.ci.jsonl`: one writer per file. The ledger only watches: its failure is never the CI row's. */
async function emitCi($: EngineInterface, events: readonly LedgerEvent[]): Promise<void> {
  if (events.length === 0) {
    return
  }

  try {
    const at = await $.clock.now()
    const session = await $.session.id()
    const path = `${eventLedgerDir((await $.env.get('HOME')) ?? '', projectKey(await repoRoot($)))}/${dayOf(at)}/${session}.ci.jsonl`
    const added = events.map(one => eventLine(at, session, one))

    await ciChain(async () => {
      // Only a missing file reads as empty: one that exists but will not read throws, so it is never written over.
      const lines = ciKept?.path === path ? ciKept.lines : (await $.fs.exists(path)) ? String(await $.fs.read(path)).split('\n').filter(line => line !== '') : []

      // Kept before the write: a write that fails is made again by the next.
      ciKept = { path, lines: capped([...lines, ...added]) }
      await $.fs.write(path, `${ciKept.lines.join('\n')}\n`)
    })
  } catch {
    // Dropped: a missing line beats a broken CI row.
  }
}

/** Today's event ledger of this project, every writer's `*.jsonl` of the date directory; a file that cannot be read is left out. */
async function readEventLedger($: EngineInterface): Promise<EventsRead> {
  const dir = `${eventLedgerDir((await $.env.get('HOME')) ?? '', projectKey(await repoRoot($)))}/${dayOf(await $.clock.now())}`
  const session = await $.session.id()
  const kept = new Map<string, { size: number; mtimeMs: number; records: LedgerRecord[] }>()

  for (const entry of await $.fs.list(dir).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) {
      continue
    }

    const path = `${dir}/${entry.name}`
    const was = ledgerFiles.get(path)

    if (was !== undefined && was.size === entry.size && was.mtimeMs === entry.mtimeMs) {
      kept.set(path, was)
      continue
    }

    const text = await $.fs.read(path).then(String, () => null)

    if (text !== null) {
      kept.set(path, { size: entry.size, mtimeMs: entry.mtimeMs, records: parseLedger(text, sessionOfFile(entry.name)) })
    }
  }

  ledgerFiles = kept

  return groupEvents([...kept.values()].flatMap(one => one.records), session)
}

/** The checks of the open PR of the session root's branch; no row without a branch, a PR or a check. */
async function pollCi($: EngineInterface): Promise<void> {
  const now = await $.clock.now()

  if (now < ghBlockedUntil) {
    return
  }

  const root = await $.session.root()
  const head = await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
  const branch = head?.exitCode === 0 ? head.stdout.trim() : ''

  if (!/^\S+$/.test(branch) || branch === 'HEAD') {
    await setCi($, null)

    return
  }

  const view = await gh($, root, PR_VIEW)

  // This fetch failed: the row stays as last polled.
  if (view === 'failed' || (view !== 'blocked' && view.exitCode !== 0 && !isNoPr(view.stderr))) {
    return
  }

  const pr = view !== 'blocked' && view.exitCode === 0 ? parsePr(view.stdout) : null
  const checks = pr === null ? null : await gh($, root, PR_CHECKS)

  if (checks === 'failed') {
    return
  }

  // gh exits nonzero while a check fails or runs: the list is read whatever the exit. gh missing or not logged in: no row.
  const list = checks === null || checks === 'blocked' ? null : parseChecks(checks.stdout)

  await setCi($, pr === null || list === null || list.length === 0 ? null : nextCi(ciStatus, pr, list, now))
  await ensureTicker($)
}

/** Reads main's sha, master's without a main: a move not made by this session leaves one notice per sha. `isOwn`: this session's git command just ran. */
async function checkMain($: EngineInterface, isOwn: boolean): Promise<void> {
  const root = await repoRoot($)

  // Another repository: its main is read as a new baseline, and its notices are another directory's.
  if (root !== noticeBoard.mainRoot) {
    noticeBoard = { ...noticeBoard, mainSha: null, mainRoot: root }
    noticeFiles = new Map()
  }

  for (const branch of ['main', 'master']) {
    const r = await git($, root, ['rev-parse', '--verify', '--quiet', branch]).catch(() => null)
    const sha = r?.exitCode === 0 ? shaOf(r.stdout) : null

    if (sha !== null) {
      const moved = mainMoved(noticeBoard.mainSha, sha, isOwn, branch, await $.session.id(), await $.clock.now())

      noticeBoard = { ...noticeBoard, mainSha: moved.sha, ...(moved.notice !== null && { auto: moved.notice }) }

      if (moved.notice !== null) {
        await redraw($)
      }

      return
    }
  }
}

async function tickRepo($: EngineInterface): Promise<void> {
  await checkMain($, false)
  await pollCi($)
}

async function noticesPath($: EngineInterface): Promise<string> {
  return noticesDir((await $.env.get('HOME')) ?? '', await repoRoot($))
}

/** This repository's notice files: each name read until it reads as a notice, an expired file removed. */
async function readNotices($: EngineInterface): Promise<void> {
  const dir = await noticesPath($)
  const now = await $.clock.now()
  const kept = new Map<string, Notice | null>()

  for (const entry of await $.fs.list(dir).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) {
      continue
    }

    const path = `${dir}/${entry.name}`
    const notice = noticeFiles.has(entry.name) ? (noticeFiles.get(entry.name) ?? null) : parseNotice(String(await $.fs.read(path).catch(() => '')))

    if (now - entry.mtimeMs > NOTICE_TTL_MS || (notice !== null && isExpired(notice, now))) {
      await $.process.run(['rm', '-f', path], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
      continue
    }

    // A file another session is still writing reads as none: it is read again next time.
    if (notice !== null) {
      kept.set(entry.name, notice)
    }
  }

  noticeFiles = kept

  const list = [...kept.values()].filter((one): one is Notice => one !== null)

  if (!isSame(noticeBoard.list.map(one => one.id), list.map(one => one.id))) {
    noticeBoard = { ...noticeBoard, list }
    await redraw($)
  }
}

/** The notice the band shows: the newest neither expired nor cleared. */
function noticeNow(now: number): Notice | null {
  const { list, auto, clearedAt } = noticeBoard

  return newestNotice(auto === null ? list : [...list, auto], clearedAt, now)
}

/** `/notice <text>` posts to every session of the repository; `/notice clear` hides the current ones in this session. */
async function postNotice($: EngineInterface, args: string): Promise<void> {
  const now = await $.clock.now()

  if (args.trim() === 'clear') {
    noticeBoard = { ...noticeBoard, clearedAt: now }
    await redraw($)
    $.ui.toast(t().noticeCleared)

    return
  }

  const notice = noticeOf(await $.session.id(), now, args)

  if (notice === null) {
    $.ui.toast(t().noticeUsage)

    return
  }

  const name = `${notice.id}.json`

  await $.fs.write(`${await noticesPath($)}/${name}`, JSON.stringify(notice))
  noticeFiles.set(name, notice)
  noticeBoard = { ...noticeBoard, list: [...noticeBoard.list.filter(one => one.id !== notice.id), notice] }
  await redraw($)
  $.ui.toast(t().noticePosted)
}

// Other sessions: each writes only its own ~/.claude/dashboard/sessions/<id>.json and reads the others'.
// Not $.store: that is one file for the whole plugin, and sessions writing it at once overwrite each other.

async function sessionsDir($: EngineInterface): Promise<string> {
  return `${(await $.env.get('HOME')) ?? ''}/.claude/dashboard/sessions`
}

/** A session that cannot write its file goes unseen by the others, nothing worse; a -p or SDK session writes none. */
async function writePresence($: EngineInterface, mine: SessionPresence): Promise<void> {
  await update($, ownPresence, () => mine)

  if (isInteractive) {
    try {
      await $.fs.write(`${await sessionsDir($)}/${mine.id}.json`, JSON.stringify(mine))
    } catch {}
  }

  await syncStatus($)
}

/**
 * Moves this session's main thread to `state`, written only when it or the detail changed; `id` is the session's own unless given.
 * `title` is taken only while the session has none.
 */
async function notePresence($: EngineInterface, state: SessionPresenceState, extra: { detail?: string; id?: string; title?: string } = {}): Promise<void> {
  try {
    const id = extra.id ?? (await $.session.id())
    const was = presence?.id === id ? presence : null
    // A reply's line comes cut to REPLY_COLUMNS already.
    const detail = state === 'replied' ? extra.detail : extra.detail?.slice(0, DETAIL_CHARS)

    if (was?.state === state && was.detail === detail) {
      return
    }

    const now = await $.clock.now()
    // A permission answered goes on with the same turn.
    const turnStartedAt = state === 'working' && was?.state !== 'permission' ? now : was?.turnStartedAt
    const title = sessionTitle ?? was?.title ?? extra.title

    presence = {
      id,
      name: was?.name ?? (await $.session.root()).split('/').pop() ?? '',
      ...(title !== undefined && { title }),
      state,
      // Stop and turn.complete each write `replied`, in either order: the later one adding the line is the same reply.
      since: was?.state === 'replied' && state === 'replied' ? was.since : now,
      ...(turnStartedAt !== undefined && { turnStartedAt }),
      ...(detail !== undefined && { detail }),
      updatedAt: now,
      ...(inputAt !== undefined && { lastInputAt: inputAt }),
    }
  } catch {
    return
  }

  await writePresence($, presence)
}

/** `text`'s first line cut to `columns`; undefined when it has none. */
function headLine(text: string | undefined, columns: number): string | undefined {
  const line = text?.trim().split('\n')[0]?.trim() ?? ''

  return line === '' ? undefined : fit(line, columns)
}

/** Puts the command resuming another session on the clipboard of the surface pressed. */
async function copyResume($: EngineInterface, sessionId: string, surface: RenderSurface): Promise<void> {
  if ((await $.ui.copy({ text: `claude --resume ${posixQuote(sessionId)}`, surface })).isCopied) {
    $.ui.toast(t().copied)
  }
}

/** Puts `cd '<path>'` on the clipboard of the surface pressed. */
async function copyCd($: EngineInterface, path: string, surface: RenderSurface): Promise<void> {
  if ((await $.ui.copy({ text: `cd ${posixQuote(path)}`, surface })).isCopied) {
    $.ui.toast(t().copied)
  }
}

/** A tool call of the thread that asked the permission ending: the ask was answered. */
async function noteAnswered($: EngineInterface, agentId: string | undefined): Promise<void> {
  if (agentId === askedBy && presence?.state === 'permission') {
    await notePresence($, 'working')
  }
}

/** Takes back what this session last wrote: a reload restarts the module, not the session, and the state holds it. False when there is none. */
async function restorePresence($: EngineInterface): Promise<boolean> {
  const kept = await read($, ownPresence)

  if (kept === null || kept.id !== (await $.session.id())) {
    return false
  }

  presence = kept
  inputAt = kept.lastInputAt

  return true
}

async function heartbeat($: EngineInterface): Promise<void> {
  // The band's idle line reads `12m ago` and no ticker runs while idle.
  if ((await boardNow($)).entries.length === 0) {
    await redraw($)
  }

  // Started by a drawing after a reload that raised no session.start.
  if (presence === null) {
    await restorePresence($)
  }

  if (presence === null || presence.state === 'ended') {
    return
  }

  presence = { ...presence, updatedAt: await $.clock.now(), ...(inputAt !== undefined && { lastInputAt: inputAt }) }
  await writePresence($, presence)
}

/** The person typed or sent a prompt at `now`: written to the presence file at most every INPUT_WRITE_MS. */
async function noteInput($: EngineInterface, now: number): Promise<void> {
  inputAt = now

  if (presence === null || presence.state === 'ended' || (presence.lastInputAt !== undefined && now - presence.lastInputAt < INPUT_WRITE_MS)) {
    return
  }

  presence = { ...presence, updatedAt: now, lastInputAt: now }
  await writePresence($, presence)
}

const isTime = (value: unknown) => typeof value === 'number' && Number.isFinite(value)

/** A session file's record when each field has its kind; null otherwise. */
function presenceOf(value: unknown): SessionPresence | null {
  const one = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const isValid =
    typeof one.id === 'string' &&
    typeof one.name === 'string' &&
    PRESENCE_STATES.includes(one.state as SessionPresenceState) &&
    isTime(one.since) &&
    isTime(one.updatedAt) &&
    (one.turnStartedAt === undefined || isTime(one.turnStartedAt)) &&
    (one.title === undefined || typeof one.title === 'string') &&
    (one.detail === undefined || typeof one.detail === 'string') &&
    (one.lastInputAt === undefined || isTime(one.lastInputAt))

  return isValid ? (one as SessionPresence) : null
}

/** Every other session's file, less the ended ones and those silent for PEER_SILENT_MS. */
async function readPeers($: EngineInterface, now: number): Promise<SessionPresence[]> {
  const dir = await sessionsDir($)
  const own = `${await $.session.id()}.json`
  const found: SessionPresence[] = []
  const kept = new Map<string, { mtimeMs: number; peer: SessionPresence | null }>()

  for (const entry of await $.fs.list(dir)) {
    // The heartbeat rewrites a live session's file every 30 s: one older than PEER_SILENT_MS is not worth reading.
    if (entry.kind !== 'file' || !entry.name.endsWith('.json') || entry.name === own || now - entry.mtimeMs > PEER_SILENT_MS) {
      continue
    }

    let file = peerFiles.get(entry.name)

    if (file === undefined || file.mtimeMs !== entry.mtimeMs) {
      try {
        file = { mtimeMs: entry.mtimeMs, peer: presenceOf(JSON.parse(String(await $.fs.read(`${dir}/${entry.name}`)))) }
      } catch {
        continue
      }
    }

    kept.set(entry.name, file)

    if (file.peer !== null && file.peer.state !== 'ended' && now - file.peer.updatedAt <= PEER_SILENT_MS) {
      found.push(file.peer)
    }
  }

  peerFiles = kept

  return found
}

/** Whether this session shows the other sessions' toasts: the one typed in last within INPUT_RECENT_MS (a tie too), or every one when none was. */
function isToaster(found: readonly SessionPresence[], now: number): boolean {
  const isRecent = (at: number | undefined): at is number => at !== undefined && now - at <= INPUT_RECENT_MS
  const others = found.map(one => one.lastInputAt).filter(isRecent)
  const own = inputAt

  return others.length === 0 || (isRecent(own) && own >= Math.max(...others))
}

/** Plays the attention chime; a clip that cannot play is no matter. */
function chime($: EngineInterface): void {
  void $.audio.play({ base64: attentionChime(), mime: 'audio/wav' }).catch(() => undefined)
}

async function tickPeers($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const found = await readPeers($, now).catch(() => [])
  const prev = await read($, peers)

  if (prev === null || !isSame(prev, found)) {
    await update($, peers, () => found)
  }

  const { toasts, toasted: keys } = peerToasts(await read($, toasted), prev ?? [], found)

  if (keys !== null) {
    await update($, toasted, () => keys)
  }

  const shown = isToaster(found, now) ? toasts.filter(one => (one.kind === 'ask' ? toastOptions.peerAsks : toastOptions.peerReplies)) : []

  for (const one of shown) {
    $.ui.toast(one.text)
  }

  if (toastOptions.askSound && shown.some(one => one.kind === 'ask')) {
    chime($)
  }

  await syncStatus($)
}

// GPU page

/** The GPU page's ssh: the stream it reads, else the timer of the next try; how long the try after a drop waits. */
type GpuLink = { host: string; stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null; retry: Timer | null; retryMs: number }

/** Ends the GPU page's ssh, a retry waiting included. goTo ends it on leaving the GPU page. */
function stopGpu(): void {
  const link = gpuLink

  gpuLink = null
  link?.retry?.cancel()
  // Closing the stream kills ssh.
  void link?.stream?.return({ code: null, signal: null }).catch(() => undefined)
}

/** Watches `host` on one ssh, in place of any before. */
function startGpu($: EngineInterface, host: string): void {
  stopGpu()
  gpuLink = { host, stream: null, retry: null, retryMs: GPU_POLL_MS }
  follow($, gpuLink)
}

/** Runs `link`'s ssh; a refused call (the module gone) ends the link, no retry armed. */
function follow($: EngineInterface, link: GpuLink): void {
  void streamGpu($, link).catch(() => {
    if (gpuLink === link) {
      stopGpu()
    }
  })
}

async function isPaneUp($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE_ID)
}

/** The workbench is drawn in front: open, placed, and not a tab behind another pane. */
async function isPaneOnScreen($: EngineInterface): Promise<boolean> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE_ID)

  return pane?.isShown === true && pane.isPlaced
}

/** The GPU page drawn again with its watch and no ssh, as after it hid behind another tab: connects again. */
async function resumeGpu($: EngineInterface): Promise<void> {
  if ((await read($, page)) !== 'gpu') {
    return
  }

  const watch = await read($, gpu)

  if (gpuLink === null && watch !== null && (await isPaneOnScreen($))) {
    startGpu($, watch.host)
  }
}

/** One ssh's life: each pass read into the watch. Once it drops, the watch keeps its sample under the error and the next ssh comes 3 s, 6 s, … 60 s later. */
async function streamGpu($: EngineInterface, link: GpuLink): Promise<void> {
  const stream = $.process.spawn({ argv: sshArgv(link.host) })
  let rest = ''
  let stderr = ''
  let failure: string

  link.stream = stream

  try {
    for await (const chunk of stream) {
      // The pane gone without a ui.close, or behind another tab: nobody is watching. A drawing on screen resumes it.
      if (gpuLink === link && !(await isPaneOnScreen($))) {
        stopGpu()
      }

      if (gpuLink !== link) {
        return
      }

      if (chunk.stream === 'stderr') {
        stderr += chunk.text
        continue
      }

      const taken = takeSamples(rest + chunk.text)

      rest = taken.rest

      for (const sample of taken.samples) {
        link.retryMs = GPU_POLL_MS
        await noteGpu($, link.host, sample)
      }
    }

    const end = await stream.result

    failure = firstLine(stderr.trim()) || `ssh exited ${end.code ?? end.signal}`
  } catch (error) {
    failure = firstLine(stderr.trim()) || errorText(error)
  }

  if (gpuLink !== link) {
    return
  }

  await noteGpu($, link.host, { kind: 'error', message: failure })
  link.stream = null
  link.retry = $.clock.after(link.retryMs, () => follow($, link))
  link.retryMs = Math.min(link.retryMs * 2, GPU_RETRY_MAX_MS)
}

/** A sample read into the watch of `host`; an error keeps the last good sample under it. */
async function noteGpu($: EngineInterface, host: string, sample: GpuSample): Promise<void> {
  const now = await $.clock.now()

  await update($, gpu, watch => {
    if (watch === null || watch.host !== host) {
      return watch
    }

    return sample.kind === 'error' ? { ...watch, error: sample.message } : { ...watch, sample, okAt: now, error: null }
  })
}

/** Points the GPU page at `host`; a different host replaces the current one. */
async function setWatch($: EngineInterface, host: string): Promise<void> {
  if ((await read($, gpu))?.host !== host) {
    await update($, gpu, () => ({ host, sample: null, okAt: null, error: null }))
  }
}

/** Connects the GPU page to rawHost, sharing the path between /gpu <host> and the empty GPU page. */
export async function connectGpu($: EngineInterface, rawHost: string): Promise<{ text?: string }> {
  const host = rawHost.trim() || ((await read($, gpu))?.host ?? '')

  if (host === '') {
    return { text: t().gpuUsage }
  }

  if (!isHostName(host)) {
    return { text: t().gpuNotHost(host) }
  }

  await setWatch($, host)
  await goTo($, 'gpu')

  return {}
}

/** The desktop's change-host button: ends the ssh and forgets the host, so the GPU page shows its host picker. */
async function forgetGpu($: EngineInterface): Promise<void> {
  stopGpu()
  await update($, gpu, () => null)
}

/** The on-demand tabs with data: Reviews once ~/.claude/mmruns exists, GPU for a gpuHosts option or a watch, Progress for the project's board config or events. */
async function tabsWithData($: EngineInterface): Promise<Set<DashPage>> {
  const shown = new Set<DashPage>()
  const home = (await $.env.get('HOME')) ?? ''
  const hasEvents = async (dir: string) => (await $.fs.list(dir).catch(() => [])).length > 0

  if (await $.fs.list(`${home}/.claude/mmruns`).then(() => true, error => !isMissing(error))) {
    shown.add('mmrun')
  }

  if (hasGpuHosts || (await read($, gpu)) !== null) {
    shown.add('gpu')
  }

  const place = await boardPlace($)

  if (place.storage !== null || (await hasEvents(eventsDir('local', place.home, place.project, place.root))) || (await hasEvents(eventsDir('git', place.home, place.project, place.root)))) {
    shown.add('progress')
  }

  return shown
}

/** The workbench's tabs: the on-demand ones with data at the last check, and `current` whatever it is. */
const pagesShown = (current: DashPage) => pages().filter(one => !ON_DEMAND.includes(one.page) || one.page === current || shownTabs?.has(one.page) === true)

/** The tightest rate-limit window with when it resets; with none, the cost; with neither, null. */
function limitOrCost({ rateLimits, cost }: DashUsage, now: number): string | null {
  const tightest = [...rateLimits].sort((a, b) => b.percentUsed - a.percentUsed)[0]

  return tightest !== undefined ? limitText(tightest, now) : cost !== null ? `$${cost.usd.toFixed(2)}` : null
}

/** The progress canvas's url from ~/.claude/progress/canvas.json; null when there is none or it is not https. */
async function canvasUrl($: EngineInterface): Promise<string | null> {
  const url: unknown = await $.fs.read(canvasPath((await $.env.get('HOME')) ?? '')).then(text => JSON.parse(text).url, () => null).catch(() => null)

  return typeof url === 'string' && url.startsWith('https://') ? url : null
}

/** Opens the workbench on `to`; visiting Agents or Reviews marks what has ended there as read, any page the CI result. */
async function goTo($: EngineInterface, to: DashPage): Promise<void> {
  const now = await $.clock.now()

  shownTabs = await tabsWithData($).catch(() => shownTabs)
  await update($, page, () => to)
  await update($, detail, () => null)

  if (to === 'agents') {
    const before = (await read($, seen)).agents

    await update($, agentsSeenBefore, () => before)
  }

  await update($, seen, was => (to === 'agents' ? { ...was, agents: now, ci: now } : to === 'mmrun' ? { ...was, runs: now, ci: now } : { ...was, ci: now }))

  await $.ui.open({ id: PANE_ID, title: t().workbench })
  await syncStatus($)

  if (to === 'overview') {
    await collectWorkspace($)
  }

  const watch = await read($, gpu)

  if (to === 'gpu' && watch !== null) {
    startGpu($, watch.host)
  } else {
    stopGpu()
  }

  if (to === 'timeline') {
    await ensureTicker($)
  }

  // Ledger files that cannot be read leave the page as it was.
  if (to === 'usage') {
    await collectUsage($).catch(() => undefined)
  }

  if (to === 'progress') {
    await collectProgress($).catch(() => undefined)
    startProgress($)
  } else {
    stopProgress()
  }
}

// Usage: each session writes only its own ~/.claude/dashboard/usage/<project>/<day>/<id>.json (timeline-hooks.ts); the page reads them all.

/** The repository's main worktree root, so a linked worktree's session shares its project; else the session root. */
async function ledgerRoot($: EngineInterface): Promise<string> {
  return (await $.session.repo().catch(() => null))?.root ?? (await $.session.root())
}

/** Sums the last 7 days of this project's ledger files, this session's own apart; a missing day is none, a file cut mid-write is skipped this time. */
async function collectUsage($: EngineInterface): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  const project = projectKey(await ledgerRoot($))
  const found: UsageRead = { session: await $.session.id(), others: {}, own: {} }

  for (const day of lastDays(await $.clock.now())) {
    const dir = ledgerDir(home, project, day)

    for (const entry of await $.fs.list(dir).catch(() => [])) {
      const usage = entry.kind === 'file' && entry.name.endsWith('.json') ? parseUsageDay(String(await $.fs.read(`${dir}/${entry.name}`).catch(() => ''))) : null

      if (usage !== null) {
        const into = entry.name === `${found.session}.json` ? found.own : found.others

        into[day] = daySum(into[day] ?? emptyDay(), usage)
      }
    }
  }

  await update($, usageRead, () => found)
}

/** The usage page's 7 days: the files as last read, with this session's live ledger over its own file. */
async function usageNow($: EngineInterface): Promise<UsageWeek> {
  return weekOf(daysOf(await read($, usageRead), await read($, ledger)), lastDays(await $.clock.now()))
}

// Progress: each session writes only its own <events dir>/<id>.json, whole after each recording; the board folds them all.

/** The project's board: its key and config dir under the home directory, the session root, and the storage chosen, null before the person chose. */
async function boardPlace($: EngineInterface): Promise<{ home: string; project: string; root: string; storage: BoardStorage | null }> {
  const home = (await $.env.get('HOME')) ?? ''
  const project = projectKey(await ledgerRoot($))
  const storage = parseStorage(String(await $.fs.read(`${boardDir(home, project)}/config.json`).catch(() => '')))

  return { home, project, root: await $.session.root(), storage }
}

/** Every session's events in `dir` by file name; a file that does not parse is skipped. */
async function readEvents($: EngineInterface, dir: string): Promise<Record<string, BoardEvent[]>> {
  const files: Record<string, BoardEvent[]> = {}

  for (const entry of await $.fs.list(dir).catch(() => [])) {
    const events = entry.kind === 'file' && entry.name.endsWith('.json') ? parseBoardEvents(String(await $.fs.read(`${dir}/${entry.name}`).catch(() => ''))) : null

    if (events !== null) {
      files[entry.name] = events
    }
  }

  return files
}

async function collectProgress($: EngineInterface): Promise<void> {
  const place = await boardPlace($)
  const dir = place.storage === null ? null : eventsDir(place.storage, place.home, place.project, place.root)
  const events = dir === null ? [] : Object.values(await readEvents($, dir)).flat()
  const requests = foldRequests(events, await $.clock.now())
  const name = (await ledgerRoot($)).split('/').pop() ?? place.project
  const current = currentRequest(events, requests, await $.session.id())

  await update($, progress, () => ({ storage: place.storage, dir, name, nodes: foldBoard(events), requests, lines: foldLines(events), current }))
}

/** The newest request stored open that has a request event or a piece event of `session`; null when none has. */
function currentRequest(events: readonly BoardEvent[], requests: readonly BoardRequest[], session: string): string | null {
  const own = events.filter(one => one.session === session)
  const isOwn = (request: BoardRequest) =>
    own.some(one => (one.type === 'request' && one.request === request.id) || ((one.type === 'add' || one.type === 'update') && request.pieces.includes(one.node)))

  return requests.find(request => request.status === 'open' && isOwn(request))?.id ?? null
}

/** The progress page's 验收 / 放弃请求: one request event in this session's file, mirrored to the canvas, then the board read again. */
async function closeRequest($: EngineInterface, id: string, fields: RequestFields): Promise<void> {
  await onRecording(() => writeRequest($, id, fields))
  await collectProgress($)
}

/** closeRequest's write, run on the recorder's chain. */
async function writeRequest($: EngineInterface, id: string, fields: RequestFields): Promise<void> {
  const place = await boardPlace($)

  if (place.storage !== null) {
    const dir = eventsDir(place.storage, place.home, place.project, place.root)
    const files = await readEvents($, dir)
    const before = Object.values(files).flat()
    const now = await $.clock.now()

    if (foldRequests(before, now).some(one => one.id === id)) {
      const session = await $.session.id()
      const event: BoardEvent = { type: 'request', request: id, at: now, session, commit: null, fields }
      const own = parseBoardEvents(String(await $.fs.read(`${dir}/${session}.json`).catch(() => ''))) ?? files[`${session}.json`] ?? []

      await $.fs.write(`${dir}/${session}.json`, JSON.stringify([...own, event]))
      await mirrorEvents($, place, [event], [...before, event], now)
    }
  }
}

/** The page's own events mirrored to the canvas when it has a url, the board folded from `after`: batches in order, up to the first that fails. */
async function mirrorEvents($: EngineInterface, place: { home: string; project: string }, events: readonly BoardEvent[], after: readonly BoardEvent[], now: number): Promise<void> {
  const url: unknown = await $.fs.read(canvasPath(place.home)).then(text => JSON.parse(text).url, () => null).catch(() => null)

  if (typeof url === 'string' && url !== '') {
    const sync = { url, project: canvasProject(place.project), name: (await ledgerRoot($)).split('/').pop() ?? place.project, at: now, isBackfill: false }
    const board = { nodes: foldBoard(after), requests: foldRequests(after, now), lines: foldLines(after) }

    for (const writes of canvasBatches(canvasWrites(events, board, sync))) {
      const r: { deny?: string; isError?: true } | undefined = await $.tool.call({ tool: 'ArtifactData', action: 'batch', url, writes } as never).catch(() => undefined)

      if (r === undefined || r.deny !== undefined || r.isError === true) {
        return
      }
    }
  }
}

/**
 * The progress page's Done / Drop: one update event in this session's file, mirrored to the canvas, then the board read again.
 * Written here, not through /progress-close: a plugin's own $.command.run passes beneath its own command.run hooks.
 */
async function closeNode($: EngineInterface, id: string, status: 'done' | 'dropped'): Promise<void> {
  await onRecording(() => writeClose($, id, status))
  await collectProgress($)
}

/** closeNode's write, run on the recorder's chain; the node's request closed too when that was its one piece. */
async function writeClose($: EngineInterface, id: string, status: 'done' | 'dropped'): Promise<void> {
  const place = await boardPlace($)

  if (place.storage !== null) {
    const dir = eventsDir(place.storage, place.home, place.project, place.root)
    const files = await readEvents($, dir)
    const before = Object.values(files).flat()

    if (foldBoard(before).some(one => one.id === id)) {
      const session = await $.session.id()
      const now = await $.clock.now()
      const event: BoardEvent = { type: 'update', node: id, at: now, session, commit: null, fields: { status } }
      const after = [...before, event]
      const closing = closeEvents(foldRequests(after, now), foldBoard(after), NO_CHECKS, now, session, null)
      const own = parseBoardEvents(String(await $.fs.read(`${dir}/${session}.json`).catch(() => ''))) ?? files[`${session}.json`] ?? []

      await $.fs.write(`${dir}/${session}.json`, JSON.stringify([...own, event, ...closing]))
      await mirrorEvents($, place, [event, ...closing], [...after, ...closing], now)
    }
  }
}

/** Ends the progress page's re-read. goTo ends it on leaving the page. */
function stopProgress(): void {
  progressRead?.cancel()
  progressRead = null
}

/** Reads the board every PROGRESS_READ_MS while the progress page is the current page and the pane is up. */
function startProgress($: EngineInterface): void {
  progressRead ??= $.clock.every(PROGRESS_READ_MS, () => {
    void (async () => {
      if ((await read($, page)) !== 'progress' || !(await isPaneUp($))) {
        stopProgress()

        return
      }

      await collectProgress($)
    })().catch(() => undefined)
  })
}

/** Opens the GPU page for an ssh to a listed host, only while the workbench is closed and the person never closed it. */
async function autoOpenGpu($: EngineInterface, host: string): Promise<void> {
  if (await read($, noAutoOpen)) {
    return
  }

  if (!(await isPaneUp($))) {
    // Unasked, a pane may only dock beside the transcript; on the main screen, or before a drawing said, it would take over.
    if (docksPanes === true) {
      await setWatch($, host)
      await goTo($, 'gpu')
    }
  } else if ((await read($, page)) === 'gpu' && (await read($, gpu))?.host !== host) {
    await setWatch($, host)
    startGpu($, host)
  }
}

/** The person closing the workbench, by its own button or the engine's close mark. */
async function closedByPerson($: EngineInterface): Promise<void> {
  stopGpu()
  await update($, noAutoOpen, () => true)
}

/** The terminal workbench's page buttons, `current` marked, and its close button. */
function paneTabs($: EngineInterface, el: Pick<ElementTable<'terminal'>, 'Box' | 'Button'>, current: DashPage) {
  const { Box, Button } = el

  return (
    <Box columnGap={1}>
      {pagesShown(current).map(one => (
        <Button
          key={`page-${one.page}`}
          label={one.label}
          {...(one.page === current && { variant: 'primary' as const })}
          onPress={() => void goTo($, one.page)}
        />
      ))}
      <Button
        key="dash-close"
        label={t().close}
        role="dismiss"
        onPress={() =>
          void (async () => {
            await closedByPerson($)
            await $.ui.close({ id: PANE_ID })
            await syncStatus($)
          })()
        }
      />
    </Box>
  )
}

const gib = (mib: number) => (mib / 1024).toFixed(1)
const shortName = (name: string) => name.replace(/^NVIDIA /, '').replace(/^GeForce /, '')
const MIN_BAR = 5
/** Bar cells left after the fixed text, at least MIN_BAR and at most 40. */
const barWidth = (columns: number, fixed: number) => Math.min(40, Math.max(MIN_BAR, columns - fixed))

type GpuLine = { text: string; dim?: boolean; color?: string }

/** The GPU page as plain lines, each cut to `columns`: error lines are red; after a failed poll the last sample stays, dim under a stale line. */
export function gpuLines(watch: GpuWatch | null, now: number, columns: number): GpuLine[] {
  const fitted = (lines: GpuLine[]) => lines.map(line => ({ ...line, text: fit(line.text, columns) }))

  if (watch === null) {
    return fitted([{ text: t().noHost, dim: true }])
  }

  const head = { text: `GPU · ${watch.host}`, dim: true }

  if (watch.error !== null && (watch.okAt === null || watch.sample === null)) {
    const ago = watch.okAt === null ? t().gpuNoSample : t().gpuLastOk(fmtDuration(now - watch.okAt))

    return fitted([head, { text: `✗ ${watch.error}`, color: 'error' }, { text: ago, dim: true }])
  }

  const lines = sampleLines(watch, columns)

  if (watch.error === null || watch.okAt === null) {
    return fitted([head, ...lines])
  }

  return fitted([head, { text: t().staleSince(fmtDuration(now - watch.okAt)), color: 'warning' }, { text: `✗ ${watch.error}`, color: 'error' }, ...lines.map(line => ({ text: line.text, dim: true }))])
}

/** The lines of the watch's sample, under the page's head. */
function sampleLines(watch: GpuWatch, columns: number): GpuLine[] {
  const sample = watch.sample

  if (sample === null || sample.kind === 'none' || sample.kind === 'error') {
    return [{ text: sample === null ? t().gpuConnecting(watch.host) : sample.kind === 'none' ? t().gpuNone : sample.message, dim: true }]
  }

  if (sample.kind === 'tegra') {
    const pct = sample.util === null ? 'N/A' : `${sample.util}%`
    const ram = sample.ramUsed !== null && sample.ramTotal !== null ? `  RAM ${gib(sample.ramUsed)}/${gib(sample.ramTotal)} GiB` : ''
    const temp = sample.temp === null ? '' : `  ${Math.round(sample.temp)}°C`
    const label = 'GR3D '
    const tail = ` ${pct.padStart(4)}${ram}${temp}`

    return [{ text: `${label}${bar((sample.util ?? 0) / 100, barWidth(columns, label.length + tail.length))}${tail}` }]
  }

  const heads = t().gpuColumns
  const isBar = columns >= GPU_BAR_COLUMNS
  const cells = sample.gpus.map(one => ({
    index: `${one.index}`,
    name: shortName(one.name),
    util: one.util,
    pct: one.util === null ? '-' : `${one.util}%`,
    mem: one.memUsed !== null && one.memTotal !== null ? `${gib(one.memUsed)}/${gib(one.memTotal)} GiB` : '-',
    temp: one.temp === null ? '-' : `${one.temp}°C`,
    power: one.power === null ? '-' : `${Math.round(one.power)}W`,
  }))
  const widest = (head: string, of: (one: (typeof cells)[number]) => string) => Math.max(widthOf(head), ...cells.map(one => widthOf(of(one))))
  const indexW = widest(heads.index, one => one.index)
  const pctW = widest('100%', one => one.pct)
  const memW = widest(heads.vram, one => one.mem)
  const tempW = widest(heads.temp, one => one.temp)
  const powerW = widest(heads.power, one => one.power)
  // The name gives way first: it gets what the other columns leave at their least, the bar at MIN_BAR.
  const othersW = indexW + (isBar ? MIN_BAR + 1 + pctW : Math.max(widthOf(heads.util), pctW)) + memW + tempW + powerW + 5 * 2
  const nameW = Math.max(1, Math.min(widest(heads.model, one => one.name), columns - othersW))
  // Every column but the bar, the five gaps between the six, and the space between the bar and its percentage.
  const barW = isBar ? barWidth(columns, indexW + nameW + pctW + memW + tempW + powerW + 5 * 2 + 1) : 0
  const utilW = isBar ? barW + 1 + pctW : Math.max(widthOf(heads.util), pctW)
  const row = (index: string, name: string, util: string, mem: string, temp: string, power: string) =>
    [padTo(index, indexW), padTo(name, nameW), util, padTo(mem, memW), padTo(temp, tempW), power].join('  ')
  const rows: GpuLine[] = [
    { text: row(heads.index, fit(heads.model, nameW), padTo(heads.util, utilW), heads.vram, heads.temp, heads.power), dim: true },
    ...cells.map(one => {
      const util = isBar ? `${one.util === null ? ' '.repeat(barW) : bar(one.util / 100, barW)} ${alignRight(one.pct, pctW)}` : alignRight(one.pct, utilW)

      return { text: row(one.index, fit(one.name, nameW), util, one.mem, one.temp, one.power) }
    }),
  ]
  const procs = [...sample.procs].sort((a, b) => (b.memMiB ?? 0) - (a.memMiB ?? 0)).slice(0, 5)

  return [
    ...rows,
    ...(procs.length > 0 ? [{ text: t().gpuTopProcs, dim: true }] : []),
    ...procs.map(one => ({ text: `${String(one.pid).padStart(8)}  ${(one.memMiB === null ? 'N/A' : `${gib(one.memMiB)} GiB`).padStart(9)}  ${one.name}`, dim: true })),
  ]
}

/** A hook's `.catch`: its failure to the debug log, once per hook this load. Declared per file: validate follows $ into this file's functions only. */
function hookFailed($: EngineInterface, name: string, error: HookFailure): void {
  const line = failureLine(name, error)

  if (line !== undefined) {
    $.ui.log(line, { to: 'debug' })
  }
}

/** Starts the loops of an interactive session, once per module: the runs, the worktrees, the other sessions, the heartbeat. Timers alone: a drawing may call it. */
function start($: EngineInterface): void {
  if (isStarted) {
    return
  }

  isStarted = true
  runsPoll = poll($, 'runs', RUNS_BUSY_MS, () => tickRuns($))
  poll($, 'workspace', WORKSPACE_MS, () => tickWorkspace($))
  poll($, 'peers', PEERS_MS, () => tickPeers($))
  poll($, 'heartbeat', HEARTBEAT_MS, () => heartbeat($))
  // The redraw timer stops with nothing live, idle agents included.
  poll($, 'agents', AGENT_LIST_MS, () => reconcileAgents($))
  void poll($, 'repo', CI_POLL_MS, () => tickRepo($)).now()
  void poll($, 'notices', NOTICES_MS, () => readNotices($)).now()
}

export const register: Register = (on, options) => {
  const autoHosts = hostsOf(options.gpuHosts)

  hasGpuHosts = autoHosts.length > 0
  optionTtlMs = Number(options.cacheTtlMinutes) * MINUTE_MS
  toastOptions = { askSound: options.askSound === true, peerAsks: options.toastPeerAsks === true, peerReplies: options.toastPeerReplies === true, runs: options.toastRuns === true }
  setLang(pickLang(options.language, undefined, undefined))

  registerTranscript(on)
  registerTimeline(on)
  registerAskRecommended(on)

  // A structured atom reads a value kept under another shape tag as its initial value: said once per key.
  on('state.get', { plugin: 'dashboard' }, async ($, e, next) => {
    const r = await next(e)
    const kept = r.value?.value

    if (SHAPED_KEYS.has(e.key) && kept !== undefined && (kept as { shape?: unknown } | null)?.shape !== SHAPE && isFirstTime(`state ${e.key}`)) {
      $.ui.log(`dashboard: kept ${e.key} is not of shape ${SHAPE}; read as its initial value`, { to: 'debug' })
    }

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'state.get', next.error)

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    setLang(await resolveLang($, options.language))

    for (const command of COMMANDS) {
      await $.command.register(command).catch((error: unknown) => {
        if (isFirstTime(`register ${command.name}`)) {
          $.ui.log(`dashboard: cannot register /${command.name}: ${errorText(error)}`, { to: 'debug' })
        }
      })
    }

    await $.tool.register(OPEN_PROGRESS).catch((error: unknown) => {
      if (isFirstTime(`register ${OPEN_PROGRESS.name}`)) {
        $.ui.log(`dashboard: cannot register the ${OPEN_PROGRESS.name} tool: ${errorText(error)}`, { to: 'debug' })
      }
    })

    // Runs that ended before this session count as read.
    if ((await read($, seen)).runs === 0) {
      const now = await $.clock.now()

      await update($, seen, was => ({ ...was, runs: now }))
    }

    isInteractive = e.isInteractive

    // A -p or SDK session: nobody watches, so nothing polls.
    if (isInteractive) {
      start($)
    }

    if (!(await restorePresence($))) {
      await notePresence($, 'idle')
    }

    await armCold($)
    await ensureTicker($)

    const watch = await read($, gpu)

    if ((await read($, page)) === 'gpu' && watch !== null && (await isPaneUp($))) {
      startGpu($, watch.host)
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'session.start', next.error)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopBandWake()

    // A /clear goes on in this process with an empty conversation: nothing is cached and nothing fills the context.
    if (e.reason === 'clear') {
      stopCold()
      isResumeExpired = false
      await update($, cache, was => ({ ...was, lastReplyAt: null, resumeTokens: null }))
      await update($, measured, was => ({ ...was, context: null }))
    } else {
      stopGpu()
    }

    await notePresence($, 'ended', { id: e.sessionId })

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'session.end', next.error)

    return next(e)
  })

  // mm writes its watches as a run starts or ends: the runs are read at once, the 3 s / 15 s poll left as the fallback.
  on('state.set', { plugin: 'mm', key: 'watches' }, async ($, e, next) => {
    const r = await next(e)

    // Past the idle wait.
    isRunsAsked = true
    void runsPoll?.now()

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'state.set mm watches', next.error)

    return next(e)
  })

  // This session's main thread, for the other sessions. Events of a subagent (agentId / agent_id) leave it alone.

  on('classic.SessionStart', async ($, e, next) => {
    if (e.agent_id === undefined && e.session_title !== undefined) {
      sessionTitle = e.session_title

      if (presence !== null) {
        presence = { ...presence, title: sessionTitle }
        await writePresence($, presence)
      }
    }

    // resume / fork: the resumed transcript's last response counts as this session's.
    if (e.agent_id === undefined && e.seconds_since_last_response !== undefined) {
      const lastReplyAt = (await $.clock.now()) - e.seconds_since_last_response * 1000
      const tail = e.transcript_path === '' ? null : await $.process.run(['tail', '-c', String(TRANSCRIPT_TAIL_BYTES), e.transcript_path], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
      const ttl = tail?.exitCode === 0 ? transcriptTtl(tail.stdout) : null

      isResumeExpired = e.prompt_cache_likely_expired === true
      await update($, cache, was => ({ ...was, lastReplyAt, resumeTokens: e.context_tokens ?? null, ...(ttl !== null && { ttlMs: CACHE_TTL_MS[ttl] }) }))
      await armCold($)
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.SessionStart', next.error)

    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, cache, was => ({ ...was, ttlMs: CACHE_TTL_MS[e.cache_ttl] }))
    await armCold($)

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PostModelSwitch', next.error)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    // Only the person's own Enter: a notification, a peer, a schedule or a plugin is not the person at this session.
    const isTyped = e.origin.kind === 'composer'

    // Set before notePresence, so a state it writes carries the input.
    if (isTyped) {
      inputAt = now
    }

    if (r.drop === undefined) {
      const title = headLine(e.text, PROMPT_TITLE_COLUMNS)

      turnEnd = undefined
      replyLine = undefined
      await notePresence($, 'working', title === undefined ? {} : { title })
      stopCold()
      // The new turn's requests refresh the cache; its turn.complete counts again.
      await update($, cache, was => ({ ...was, lastReplyAt: null }))
      await redraw($)
    }

    if (isTyped) {
      await noteInput($, now)
    }

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'prompt.submit', next.error)

    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    await noteInput($, await $.clock.now())

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'prompt.edit', next.error)

    return next(e)
  })

  // A new turn the timeline page follows starts its redraw timer. The matcher selects every turn: timeline-hooks.ts holds the matcher-less hook.
  on('turn.start', { turnId: /^/ }, async ($, e, next) => {
    const r = await next(e)

    await ensureTicker($)

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'turn.start', next.error)

    return next(e)
  })

  // Its hook runs before the dialog shows; a decision from the hooks beneath means no dialog at all.
  on('classic.PermissionRequest', async ($, e, next) => {
    const r = await next(e)
    const agentId = e.agent_id

    if (r.decision === undefined && r.block === undefined) {
      const asker = agentId === undefined ? undefined : ((await read($, agents)).find(one => one.agentId === agentId)?.subagentType ?? agentId.slice(0, 8))

      // AskUserQuestion's dialog is the permission component (its `answers` input): a question waits on the person like an ask.
      const tool = e.tool_name === 'AskUserQuestion' ? t().askDetail : e.tool_name

      askedBy = agentId
      await notePresence($, 'permission', { detail: asker === undefined ? tool : `${asker}: ${tool}` })
    }

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PermissionRequest', next.error)

    return next(e)
  })

  // Background work in flight wakes the session later: it is still working, not waiting on the person.
  // Either of Stop and turn.complete may come first; whichever comes last leaves the state this Stop says, unless the turn ended by Esc or a failure.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)

    if (e.agent_id === undefined && r.block === undefined) {
      isAwaitingTasks = (e.background_tasks?.length ?? 0) > 0 || (e.session_crons?.length ?? 0) > 0
      replyLine = headLine(e.last_assistant_message, REPLY_COLUMNS)

      if (turnEnd === undefined) {
        await notePresence($, isAwaitingTasks ? 'working' : 'replied', isAwaitingTasks ? {} : { detail: replyLine })
      }

      // The TTL the main thread really gets (5m on an API key or past the plan limit), with or without a model switch.
      if (e.transcript_path !== '') {
        const tail = await $.process.run(['tail', '-c', String(TRANSCRIPT_TAIL_BYTES), e.transcript_path], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
        const ttl = tail?.exitCode === 0 ? transcriptTtl(tail.stdout) : null

        if (ttl !== null) {
          await update($, cache, was => ({ ...was, ttlMs: CACHE_TTL_MS[ttl] }))
          await armCold($)
        }
      }
    }

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'classic.Stop', next.error)

    return next(e)
  })

  // Subagent status

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)

    if (r.agentId !== undefined) {
      const startedAt = await $.clock.now()
      const run: AgentRun = {
        agentId: r.agentId,
        description: e.description,
        subagentType: e.subagentType,
        model: r.model,
        background: e.background,
        ...(e.parentAgentId !== undefined && { parentAgentId: e.parentAgentId }),
        toolUseId: e.tool_use_id,
        startedAt,
        tools: 0,
        lastTool: '',
        state: 'running',
        lastActivityAt: startedAt,
      }

      const seenAt = (await read($, seen)).agents

      await update($, agents, list => noteSpawn(list, run, seenAt))
      await ensureTicker($)
      await collectWorkspace($)
    }

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'agent.spawn', next.error)

    return next(e)
  })

  // SendMessage to an ended subagent resumes it; `to` may also be a name, which no run keeps, so only an id matches.
  on('session.send', async ($, e, next) => {
    const r = await next(e)

    if (r.isDelivered && (await read($, agents)).some(one => one.agentId === e.to && one.state !== 'running')) {
      const now = await $.clock.now()

      await update($, agents, list => noteResumed(list, e.to, now))
      await ensureTicker($)
    }

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'session.send', next.error)

    return next(e)
  })

  // Classic tool events, not `tool.call`: a mod hooking Bash there denies every Bash call of a worktree subagent (claude-code#92533).
  // Main read before this session's git command runs: a move made before it is another session's, and gets its notice.
  on('classic.PreToolUse', { tool: /^Bash$/ }, async ($, e, next) => {
    if (e.tool === 'Bash' && MAIN_CHANGE.test(e.command)) {
      await checkMain($, false)
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PreToolUse', next.error)

    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    const agentId = e.agent_id
    const input = typeof e.tool_input === 'object' && e.tool_input !== null ? (e.tool_input as Record<string, unknown>) : {}

    await noteAnswered($, agentId)

    if (agentId !== undefined && (await read($, agents)).some(one => one.agentId === agentId)) {
      const now = await $.clock.now()

      await update($, agents, list => noteTool(list, agentId, toolLabel({ ...input, tool: e.tool_name }), now))
      await ensureTicker($)
      await peekAgent($)
    }

    const host =e.tool_name === 'Bash' && typeof input.command === 'string' ? sshHostOf(input.command) : null

    if (host !== null && autoHosts.includes(host)) {
      void autoOpenGpu($, host)
    }

    if (e.tool_name === 'Bash') {
      await noteGate($, input.command, bashText(e.tool_response), e.cwd, agentId, false)
    }

    if (e.tool_name === 'Bash' && typeof input.command === 'string' && GIT_CHANGE.test(input.command)) {
      await collectWorkspace($)
    }

    if (e.tool_name === 'Bash' && typeof input.command === 'string' && MAIN_CHANGE.test(input.command)) {
      await checkMain($, true)
    }

    if (EDIT_TOOLS.includes(e.tool_name)) {
      await noteEdit($, input.file_path ?? input.notebook_path)
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PostToolUse', next.error)

    return next(e)
  })

  // A nonzero exit, a failing test run among them, ends here instead of PostToolUse.
  on('classic.PostToolUseFailure', async ($, e, next) => {
    const agentId = e.agent_id

    await noteAnswered($, agentId)

    if (agentId !== undefined && (await read($, agents)).some(one => one.agentId === agentId)) {
      const now = await $.clock.now()
      const input = typeof e.tool_input === 'object' && e.tool_input !== null ? (e.tool_input as Record<string, unknown>) : {}

      await update($, agents, list => noteTool(list, agentId, toolLabel({ ...input, tool: e.tool_name }), now))
      await ensureTicker($)
      await peekAgent($)
    }

    if (e.tool_name === 'Bash') {
      const input = typeof e.tool_input === 'object' && e.tool_input !== null ? (e.tool_input as Record<string, unknown>) : {}

      await noteGate($, input.command, e.error, e.cwd, e.agent_id, true)

      // A git command that failed part way may have moved main all the same.
      if (typeof input.command === 'string' && MAIN_CHANGE.test(input.command)) {
        await checkMain($, true)
      }
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PostToolUseFailure', next.error)

    return next(e)
  })

  on('classic.PermissionDenied', async ($, e, next) => {
    const agentId = e.agent_id

    await noteAnswered($, agentId)

    if (agentId !== undefined && (await read($, agents)).some(one => one.agentId === agentId)) {
      const now = await $.clock.now()
      const input = typeof e.tool_input === 'object' && e.tool_input !== null ? (e.tool_input as Record<string, unknown>) : {}

      await update($, agents, list => noteDenied(noteTool(list, agentId, toolLabel({ ...input, tool: e.tool_name }), now), agentId))
      await ensureTicker($)
      await peekAgent($)
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'classic.PermissionDenied', next.error)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId

    if (agentId === undefined) {
      // Esc leaves the session idle; an error or a refusal waits on the person until the next prompt.
      turnEnd = e.reason === 'aborted' ? 'idle' : e.reason === 'error' || e.reason === 'refusal' ? 'failed' : undefined
      await notePresence($, turnEnd ?? (isAwaitingTasks ? 'working' : 'replied'), turnEnd === undefined && !isAwaitingTasks ? { detail: replyLine } : {})
      isAwaitingTasks = false

      // A request refreshes the cache as it is read: it expires counting from the turn's last main request.
      const turns = await read($, timeline).catch(() => [] as TimelineTurn[])
      const lastReplyAt = lastSentAt(turns, e.turnId) ?? (await $.clock.now())

      // The tokens to rewrite come from session.measure from here on.
      isResumeExpired = false
      await update($, cache, was => ({ ...was, lastReplyAt, resumeTokens: null }))
      await armCold($)
    }

    if (agentId !== undefined && (await read($, agents)).some(one => one.agentId === agentId)) {
      const usage =
        e.usage === undefined
          ? undefined
          : { input: e.usage.input_tokens, output: e.usage.output_tokens, cacheRead: e.usage.cache_read_input_tokens, cacheWrite: e.usage.cache_creation_input_tokens, model: e.usage.model }
      const done = { reason: e.reason, durationMs: e.durationMs, outputTokens: e.usage?.output_tokens, endedAt: await $.clock.now(), answer: e.answer, usage }

      await update($, agents, list => noteDone(list, agentId, done))
      await ensureTicker($)
      await collectWorkspace($)
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'turn.complete', next.error)

    return next(e)
  })

  // Commands. A command's text is a transcript row the model reads: one that only opens a page prints none.

  on('command.run', { command: 'dashboard' }, async $ => {
    await goTo($, (await read($, page)) ?? 'overview')

    return {}
  }).catch(($, e, next) => {
    hookFailed($, 'command.run dashboard', next.error)

    return next(e)
  })

  on('command.run', { command: 'subagents' }, async $ => {
    await goTo($, 'agents')

    return {}
  }).catch(($, e, next) => {
    hookFailed($, 'command.run subagents', next.error)

    return next(e)
  })

  on('command.run', { command: 'mmrun' }, async $ => {
    await goTo($, 'mmrun')

    return {}
  }).catch(($, e, next) => {
    hookFailed($, 'command.run mmrun', next.error)

    return next(e)
  })

  on('command.run', { command: 'timeline' }, async $ => {
    await goTo($, 'timeline')

    return {}
  }).catch(($, e, next) => {
    hookFailed($, 'command.run timeline', next.error)

    return next(e)
  })

  on('command.run', { command: 'progress' }, async $ => {
    await goTo($, 'progress')

    const url = await canvasUrl($)

    return url === null ? {} : { text: `${t().progressCanvas}: ${url}` }
  }).catch(($, e, next) => {
    hookFailed($, 'command.run progress', next.error)

    return next(e)
  })

  on('tool.call', { tool: OPEN_PROGRESS_TOOL }, async $ => {
    await goTo($, 'progress')

    const url = await canvasUrl($)
    const text = url === null ? "Opened the workbench's Progress page for the person." : `Opened the workbench's Progress page for the person. The progress canvas: ${url}`

    return { result: [{ type: 'text', text }] }
  }).catch(($, e, next) => {
    hookFailed($, 'tool.call open_progress', next.error)

    return next(e)
  })

  on('command.run', { command: 'notice' }, async ($, e) => {
    await postNotice($, e.args)

    return {}
  }).catch(($, e, next) => {
    hookFailed($, 'command.run notice', next.error)

    return next(e)
  })

  on('command.run', { command: 'gpu' }, async ($, e) => {
    return connectGpu($, e.args)
  }).catch(($, e, next) => {
    hookFailed($, 'command.run gpu', next.error)

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE_ID) {
      return next(e)
    }

    stopProgress()

    if (e.origin.kind === 'person') {
      await closedByPerson($)
    } else {
      stopGpu()
    }

    const r = await next(e)

    await syncStatus($)

    return r
  }).catch(($, e, next) => {
    hookFailed($, 'ui.close', next.error)

    return next(e)
  })

  // Band

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A reload for a changed option raises no session.start: the first drawing starts the loops instead.
    start($)
    docksPanes = e.viewport?.isFullscreen
    await read($, tick)

    if (e.props.hasSurvey) {
      return next(e)
    }

    const bNow = await boardNow($)

    // A drawing may not write state: the read runs from a timer, and the atom's update draws the band again.
    if (bNow.now - progressReadAt >= PROGRESS_READ_MS) {
      progressReadAt = bNow.now
      $.clock.after(0, () => void collectProgress($).catch(() => undefined))
    }

    armBandWake($, nextBandChange(await read($, gates), bNow.now, await read($, trees)), bNow.now)

    const rows = Math.min(e.props.maxRows, MAX_BAND_ROWS)
    const columns = e.props.bodyColumns - buttonColumns()
    const lines = bandLines(bNow, rows, columns)
    const shown: BandRow[] = lines.length === 0 ? [{ kind: 'idle', line: await idleNow($) }] : bandRowsOf(bNow, lines, rows, (await read($, peers)) ?? [], e.props.maxRows)
    const notice = noticeNow(bNow.now)
    const used = shown.reduce((sum, row) => sum + (row.kind === 'ask' ? ASK_CARD_ROWS : 1), 0)
    // P4: the notice takes a row only while the budget has one left.
    const noticed: BandRow[] = notice !== null && shown.length < rows && used < e.props.maxRows ? [...shown, { kind: 'notice', text: noticeText(notice) }] : shown
    const plan = planRowOf(await read($, progress))
    const bandRows = withinBand(plan === null ? noticed : [plan, ...noticed], rows, e.props.maxRows)
    const needsYou = bNow.entries.some(entry => entry.tier === 1)
    const onOpen = () => void goTo($, 'overview')

    if (e.surface === 'desktop') {
      const el = $.ui.resolve(e)
      const { Box } = el

      return (
        <Box flexDirection="column">
          {drawDesktopBand(el, bandRows, { onOpen, onAsk: onOpen, onDismiss: agentId => void dismissResult($, agentId) }, needsYou)}
          {await next(e)}
        </Box>
      )
    }

    const el = $.ui.resolve(e)
    const { Box, Button, Text } = el
    const width = e.props.bodyColumns
    const titleColumns = runningTitleColumns(bandRows, columns)
    const segs = (line: Line) =>
      line.map(seg => (
        <Text
          {...(seg.color !== undefined && { color: seg.color })}
          {...(seg.bold === true && { bold: true })}
          {...(seg.dim === true && { dimColor: true })}
        >
          {seg.text}
        </Text>
      ))
    const draw = (line: Line, columns: number) => <Text wrap="truncate">{segs(fitLine(line, columns))}</Text>
    const lineOf = (row: Exclude<BandRow, AskRow | NoticeRow>) =>
      row.kind === 'idle' ? idleText(row.line) : row.kind === 'running' ? runningText(row, titleColumns) : row.kind === 'plan' ? planText(row) : row.line
    const opener = bandRows.findIndex(row => row.kind !== 'ask' && row.kind !== 'notice')

    return (
      <Box flexDirection="column">
        <Box flexDirection="column">
          {bandRows.map((row, index) =>
            row.kind === 'ask' ? (
              askCard(el, row, width, onOpen, opener < 0 ? onOpen : undefined)
            ) : row.kind === 'notice' ? (
              <Text dimColor wrap="truncate">
                {fit(row.text, width)}
              </Text>
            ) : index === opener ? (
              <Box>
                {draw(lineOf(row), width - buttonColumns())}
                <Text> </Text>
                <Button key="dash-open" label={t().workbench} onPress={onOpen} />
              </Box>
            ) : (
              draw(lineOf(row), width)
            ),
          )}
        </Box>
        {await next(e)}
      </Box>
    )
  }).catch(($, e, next) => {
    hookFailed($, 'ui.render AbovePrompt', next.error)

    return next(e)
  })

  // Context, rate limits and cost under the prompt, as the engine measured them

  on('session.measure', async ($, e, next) => {
    await update($, measured, () => ({ context: e.context, rateLimits: e.rateLimits, cost: e.cost ?? null }))

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'session.measure', next.error)

    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    await read($, tick)

    const usage = await read($, measured)
    const { context } = usage
    const limit = limitOrCost(usage, await $.clock.now())
    const parts = [
      t().context(context === null ? fmtTokens(null) : `${fmtTokens(context.tokens)}/${fmtTokens(context.window)}`),
      ...(context?.percent === undefined ? [] : [`${context.percent}%`]),
      ...(limit === null ? [] : [limit]),
    ]
    const note = parts.join(' · ')

    // Only the terminal draws `tail`; elsewhere the note has to ride in `hint`, which replaces the line.
    if (e.surface !== 'terminal') {
      const hint = e.props.hint === '' ? note : `${e.props.hint} · ${note}`

      return next({ ...e, props: { ...e.props, hint } })
    }

    const tail = e.props.tail === undefined ? note : `${e.props.tail} · ${note}`

    return next({ ...e, props: { ...e.props, tail } })
  }).catch(($, e, next) => {
    hookFailed($, 'ui.render PromptHint', next.error)

    return next(e)
  })

  // The desktop app requests SessionMode but never PromptHint, and shows only a tree the plugin draws: an engine node beneath draws nothing there.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'desktop') {
      return next(e)
    }

    await read($, tick)

    const { context, rateLimits, cost } = await read($, measured)
    const now = await $.clock.now()
    const order = (kind: string) => (kind === 'five_hour' ? 0 : kind === 'seven_day' ? 1 : 2)
    const windows = [...rateLimits].sort((a, b) => order(a.kind) - order(b.kind))
    const costText = windows.length === 0 && cost !== null ? [`$${cost.usd.toFixed(2)}`] : []
    const label = [...e.props.modes, ...costText].join(' & ')
    const el = $.ui.resolve(e)
    const { Box, Button, Text } = el
    const hasLabels = (e.viewport?.columns ?? MODE_LABEL_COLUMNS) >= MODE_LABEL_COLUMNS
    const gauges = [
      ...(context?.percent === undefined ? [] : [{ key: 'context', percent: context.percent, label: t().contextWord, alt: t().context(`${context.percent}%`) }]),
      ...windows.map(limit => {
        const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
        const name = WINDOW_NAMES[limit.kind] ?? limit.kind

        return {
          key: limit.kind,
          percent: limit.percentUsed,
          label: Number.isNaN(resetsAt) ? name : `${name} · ${t().limitReset(countdown(Math.max(0, resetsAt - now)))}`,
          alt: limitText(limit, now),
        }
      }),
    ]

    return (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {label === '' ? null : (
          <Text color="subtle" wrap="truncate-end">
            {label}
          </Text>
        )}
        {gauges.map(one => {
          const tone = usageTone(one.percent)

          return (
            <Box key={`limit-${one.key}`} flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
              {gauge(el, one.percent / 100, tone, one.alt, MODE_RING_PX)}
              <Text color={tone === 'running' ? 'text' : TONE_KEYS[tone]} bold>{`${one.percent}%`}</Text>
              {hasLabels ? <Text color="subtle">{one.label}</Text> : null}
            </Box>
          )
        })}
        <Box flexGrow={1} />
        <Button key="mode-workbench" label={t().workbench} variant="secondary" onPress={() => void goTo($, 'overview')} />
        <Button key="mode-progress" label={t().pageProgress} variant="secondary" onPress={() => void goTo($, 'progress')} />
      </Box>
    )
  }).catch(($, e, next) => {
    hookFailed($, 'ui.render SessionMode', next.error)

    return next(e)
  })

  on('ui.render', { component: 'ToolResult', props: { tool: OPEN_PROGRESS_TOOL } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)

    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const url = await canvasUrl($)

    // The terminal has no clickable button here: the line names the command instead.
    return e.surface === 'desktop' ? (
      <Box columnGap={1} flexWrap="wrap">
        <Button key="open-progress" label={t().pageProgress} variant="secondary" onPress={() => void goTo($, 'progress')} />
        {url === null ? null : <Link href={url} label={t().progressCanvas} />}
      </Box>
    ) : (
      <Text color="subtle">{[`${t().pageProgress} · /progress`, ...(url === null ? [] : [`${t().progressCanvas}: ${url}`])].join(' · ')}</Text>
    )
  }).catch(($, e, next) => {
    hookFailed($, 'ui.render ToolResult open_progress', next.error)

    return next(e)
  })

  // The fill from before a compaction no longer holds; the engine's next measurement sets it again.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId === undefined && e.trigger !== 'precompute' && done.skip === undefined) {
      await update($, cache, was => ({ ...was, resumeTokens: null }))
      await update($, measured, was => ({ ...was, context: was.context === null ? null : { window: was.context.window } }))
    }

    return done
  }).catch(($, e, next) => {
    hookFailed($, 'session.compact', next.error)

    return next(e)
  })

  // A failed clock Client: logged, and the times drawn as static text for the rest of the session.
  on('ui.fault', async ($, e, next) => {
    $.ui.log(`dashboard: ${e.component} Client ${e.module} failed (${e.phase}): ${e.reason}`, { to: 'debug' })

    if (e.module.endsWith('clock-client.tsx')) {
      isClockFailed = true
      await update($, paneWake, was => was + 1)
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailed($, 'ui.fault', next.error)

    return next(e)
  })

  // Workbench pane

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    await resumeGpu($)
    // A pane drawn before any opening this load, as after a reload, checks once here.
    shownTabs ??= await tabsWithData($).catch(() => null)

    if (e.surface === 'desktop') {
      const current = (await read($, page)) ?? 'overview'
      const open = await read($, detail)
      // Each read subscribes this drawing to the value: a page reads only what it draws, so a write elsewhere does not redraw it.
      const isOn = (...shown: DashPage[]) => shown.includes(current)

      await read($, paneWake)

      // A static time moves only as the pane redraws.
      if (isClockFailed || isOn('agents', 'mmrun', 'timeline', 'progress')) {
        await read($, tick)
      }

      const now = await $.clock.now()

      if (isOn('mmrun') && open?.page !== 'mmrun') {
        void loadListed($)
      }

      const data: TimelinePaneData & GpuFill = {
        page: current,
        pages: pagesShown(current),
        now,
        columns: e.props.bodyColumns,
        agents: isOn('overview', 'agents', 'timeline') ? await read($, agents) : [],
        snap: isOn('overview', 'mmrun') ? await read($, runs) : null,
        seen: isOn('overview', 'agents') ? await read($, seen) : { agents: 0, runs: 0 },
        gpu: isOn('gpu') ? await read($, gpu) : null,
        gpuHosts: autoHosts,
        onConnectGpu: host => void connectGpu($, host),
        onChangeGpuHost: () => void forgetGpu($),
        onFillGpu: () => void $.prompt.fill({ text: '/gpu ' }),
        disclosures: openDisclosures,
        onToggleDisclosure: key => toggleDisclosure($, key),
        gates: isOn('overview') ? await read($, gates) : [],
        trees: isOn('overview') ? await read($, trees) : null,
        guards: isOn('overview') ? ((await read($, guards))?.blocks ?? []) : [],
        peers: isOn('overview') ? ((await read($, peers)) ?? []) : [],
        paneRuns: PANE_RUNS,
        detail: open,
        reports: isOn('mmrun') ? await read($, reports) : {},
        conversation: open?.page === 'mmrun' && open.view === 'conversation' && isOn('mmrun') ? await read($, conversation) : null,
        timeline: isOn('timeline') ? await read($, timeline) : [],
        ...(isOn('timeline') && openDisclosures.has(EVENTS_VIEW) && { timelineEvents: await readEventLedger($) }),
        timelineTurnId: isOn('timeline') ? ((await read($, timelineTurn)) ?? undefined) : undefined,
        flights: isOn('overview', 'agents') ? await flightsNow($) : new Map(),
        agentsSeenBefore: isOn('agents') ? await read($, agentsSeenBefore) : 0,
        isFoldOpen: isOn('agents') ? await read($, agentsFoldOpen) : false,
        sessionId: isOn('mmrun') ? await sessionIdOf($) : null,
        isRunsFoldOpen: isOn('mmrun') ? await read($, runsFoldOpen) : false,
        peek: open?.page === 'agents' && isOn('agents') ? await read($, peek) : null,
        ...(isOn('usage') && { usage: await usageNow($) }),
        progress: isOn('progress') ? await read($, progress) : null,
        onCloseNode: (id, status) => void closeNode($, id, status),
        onAcceptRequest: id => void closeRequest($, id, { status: 'closed', resolution: { by: 'person', evidence: 'accepted on the progress page' } }),
        onDropRequest: id => void closeRequest($, id, { status: 'dropped' }),
        onToggleFold: () => void update($, agentsFoldOpen, was => !was),
        onToggleRunsFold: () => void update($, runsFoldOpen, was => !was),
        onTimelineTurn: turnId => void pickTurn($, turnId ?? null),
        timelineView: isOn('timeline') ? await read($, timelineView) : undefined,
        onTimelineView: () => void update($, timelineView, was => (was === 'hotspots' ? 'turn' : 'hotspots')),
        timelinePage: isOn('timeline') ? ((await read($, timelinePage)) ?? undefined) : undefined,
        onTimelinePage: to => void update($, timelinePage, () => to),
        onPage: to => void goTo($, to),
        onReadAgent: agentId => void readAgent($, agentId),
        onReadRun: runid => void readRun($, runid),
        onOpenItem: item => void openItem($, item),
        onBack: () => void closeDetail($),
        onToggleSeverity: () => void toggleSeverity($),
        onPickModel: model => void pickReportModel($, model),
        onPickView: view => void pickReportView($, view),
        onFinding: finding => void pickFinding($, finding),
        onCopyResume: (sessionId, surface) => void copyResume($, sessionId, surface),
        onCopyCd: (path, surface) => void copyCd($, path, surface),
        onClose: () =>
          void (async () => {
            await closedByPerson($)
            await $.ui.close({ id: PANE_ID })
            await syncStatus($)
          })(),
      }

      armOverviewWake($, isOn('overview') ? nextOverviewChange(data.agents, data.gates, data.peers, now, data.trees, data.flights ?? new Map()) : null, now)

      return drawDesktopPane(isClockFailed ? staticClocks($.ui.resolve(e)) : $.ui.resolve(e), data)
    }

    await read($, tick)
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const current = (await read($, page)) ?? 'overview'
    const now = await $.clock.now()
    const columns = e.props.bodyColumns
    const plain = (text: string, style: { dim?: boolean; color?: string; bold?: boolean } = {}) => (
      <Text
        wrap="truncate"
        {...(style.dim === true && { dimColor: true })}
        {...(style.color !== undefined && { color: style.color })}
        {...(style.bold === true && { bold: true })}
      >
        {fit(text, columns)}
      </Text>
    )
    const segText = (seg: Seg) => (
      <Text
        {...(seg.color !== undefined && { color: seg.color })}
        {...(seg.bold === true && { bold: true })}
        {...(seg.dim === true && { dimColor: true })}
      >
        {seg.text}
      </Text>
    )
    const draw = (line: Line) => <Text wrap="truncate">{fitLine(line, columns).map(segText)}</Text>
    const buttonRow = (row: ButtonRow, key: string, hotkey: string | undefined, onPress: () => void, isDim = false) => (
      <Box>
        {row.before.map(segText)}
        <Button key={key} label={row.label} plain {...(hotkey !== undefined && { hotkey })} {...(isDim && { dimColor: true })} onPress={onPress} />
        {row.after.map(segText)}
      </Box>
    )
    const tabs = paneTabs($, { Box, Button }, current)
    const backRow = (title: string) => (
      <Box columnGap={1}>
        <Button key="dash-back" label={t().back} onPress={() => void closeDetail($)} />
        <Text bold wrap="truncate">
          {title}
        </Text>
      </Box>
    )
    const open = await read($, detail)
    const openAgent = open?.page === 'agents' && current === 'agents' ? (await read($, agents)).find(one => one.agentId === open.agentId) : undefined
    const openRun = open?.page === 'mmrun' && current === 'mmrun' ? (await read($, runs))?.runs.find(one => one.runid === open.runid) : undefined
    const openReport = openRun === undefined ? undefined : (await read($, reports))[openRun.runid]
    let body

    if (openAgent !== undefined) {
      const last = await read($, peek)
      const peeked = openAgent.state === 'running' && last?.agentId === openAgent.agentId ? last : undefined
      const labelled = (label: string, text: string) => draw([{ text: `${label}  `, dim: true }, { text }])
      const peekRows =
        peeked === undefined
          ? []
          : peeked.failed === true
            ? [plain(t().peekUnreadable, { color: 'warning' })]
            : [
                ...(peeked.task === '' ? [] : [labelled(t().peekTask, peeked.task)]),
                ...(peeked.calls.length === 0 ? [] : [plain(t().peekCalls, { dim: true }), ...peeked.calls.map(call => plain(`  ${call}`))]),
                ...(peeked.text === '' ? [] : [labelled(t().peekText, peeked.text)]),
              ]

      body = [
        backRow(`${openAgent.subagentType} · ${openAgent.description}`),
        plain(openAgent.state === 'running' ? t().agentStillRunning : t().agentAnswerHead, { color: 'warning', bold: true }),
        ...(openAgent.usage === undefined ? [] : [plain(usageText(openAgent.usage), { dim: true })]),
        ...peekRows,
        <Markdown text={openAgent.answer ?? ''} />,
      ]
    } else if (open?.page === 'mmrun' && openRun !== undefined && openReport !== undefined) {
      body = [
        backRow(`${runLabel(openRun)} · ${openRun.runid}`),
        <Box columnGap={1}>
          <Text color="warning" bold>
            {t().modelReport}
          </Text>
          <Button key="dash-severity" label={open.showAll ? t().criticalMajorOnly : t().allSeverities} onPress={() => void toggleSeverity($)} />
        </Box>,
        ...openReport.models.flatMap(model => [
          <Text wrap="truncate">
            <Text bold>{model.name}</Text>
            <Text dimColor>{`  ${model.status}`}</Text>
          </Text>,
          <Markdown text={model.markdown} />,
        ]),
      ]
    } else if (current === 'overview') {
      const snap = await read($, runs)
      const polledAt = snap?.polledAt ?? now
      const allGates = await read($, gates)
      const found = await read($, trees)
      const overview = overviewOf(await read($, agents), snap, await read($, seen), now, (await read($, peers)) ?? [], allGates, found)
      const flights = await flightsNow($)
      const recent = recentGates(allGates, OVERVIEW_GATES)
      const blocks = (await read($, guards))?.blocks ?? []
      const section = (rows: RenderChildren) => (
        <Box flexDirection="column" marginTop={1}>
          {rows}
        </Box>
      )
      const done = [
        overview.returned > 0 ? `✓ ${t().returnedN(overview.returned)}` : '',
        overview.aborted > 0 ? `⊘ ${t().agentStates.aborted} ${overview.aborted}` : '',
        overview.reviewed > 0 ? `✓ ${t().reviewedN(overview.reviewed)}` : '',
      ]
        .filter(part => part !== '')
        .join(' · ')
      const needsYou = overview.pending.length + overview.gates.length
      const isIdle = needsYou === 0 && overview.running.length === 0 && done === ''
      const workspace =
        found === null
          ? [section([plain(t().worktrees, { bold: true }), plain(t().loading, { dim: true })])]
          : found.length === 0
            ? []
            : [
                section([
                  plain(`${t().worktrees} · ${found.length}`, { bold: true }),
                  ...found.slice(0, OVERVIEW_TREES).map(tree => (
                    <Box>
                      <Text wrap="truncate">
                        {fitLine(
                          [{ text: tree.name }, { text: ` ${tree.branch}`, dim: true }, ...treeMarks(tree).map(mark => ({ text: `  ${mark.text}`, ...MARK_STYLES[mark.tone] }))],
                          columns - cdColumns(),
                        ).map(segText)}
                      </Text>
                      <Text> </Text>
                      <Button key={`copy-cd-${tree.path}`} label={t().copyCd} onPress={press => void copyCd($, tree.path, press.surface)} />
                    </Box>
                  )),
                  ...(found.length > OVERVIEW_TREES ? [plain(t().moreTrees(found.length - OVERVIEW_TREES), { dim: true })] : []),
                ]),
              ]
      // An agent's row takes the digit it got at spawn; a model's row none.
      const itemRow = (item: OverviewItem, lineOf: (width: number) => Line) => {
        const hotkey = item.kind === 'agent' ? item.run.slot : undefined
        const key = item.kind === 'agent' ? `open-agent-${item.run.agentId}` : `open-model-${item.run.runid}-${item.model.name}`

        return buttonRow(splitRow(lineOf(columns - (hotkey === undefined ? 0 : HOTKEY_COLUMNS))), key, hotkey, () => void openItem($, item))
      }
      const counts = overviewCounts(overview, now, snap?.polledAt)
      const head = [
        ...(counts.length === 0 ? [] : [draw(counts)]),
        ...(needsYou === 0
          ? []
          : [
              section([
                plain(`${t().needsYou} · ${needsYou}`, { bold: true }),
                ...overview.pending.map(item => itemRow(item, width => fitLine(pendingLine(item, now, polledAt), width))),
                ...overview.gates.map(gate => draw(pendingGateLine(gate))),
              ]),
            ]),
      ]

      body = [
        ...head,
        ...(overview.sessions.length === 0
          ? []
          : [
              section([
                plain(`${t().otherSessions} · ${overview.sessions.length}`, { bold: true }),
                ...overview.sessions.map(peer => (
                  <Box>
                    {draw(sessionLine(peer, now, columns - copyColumns()))}
                    <Text> </Text>
                    <Button key={`copy-resume-${peer.id}`} label={t().copyResume} onPress={press => void copyResume($, peer.id, press.surface)} />
                  </Box>
                )),
              ]),
            ]),
        ...(overview.running.length === 0
          ? []
          : [
              section([
                plain(`${t().runningHeading} · ${overview.running.length}`, { bold: true }),
                ...overview.running.map(item => itemRow(item, width => runningLine(item, now, polledAt, width, item.kind === 'agent' ? flights.get(item.run.agentId) : undefined))),
              ]),
            ]),
        ...(done === ''
          ? []
          : [
              section([
                plain(t().doneHeading, { bold: true }),
                <Box columnGap={1}>
                  <Text wrap="truncate">{done}</Text>
                  {overview.returned + overview.aborted > 0 ? <Button key="overview-agents" label={t().viewAgents} onPress={() => void goTo($, 'agents')} /> : null}
                  {overview.reviewed > 0 ? <Button key="overview-mmrun" label={t().viewMmrun} onPress={() => void goTo($, 'mmrun')} /> : null}
                </Box>,
              ]),
            ]),
        ...(isIdle ? [section([plain(t().nothingPending, { dim: true }), ...overview.recent.map(item => plain(endedText(item, now), { dim: true }))])] : []),
        ...(recent.length === 0
          ? []
          : [
              section([
                plain(t().recentGates, { bold: true }),
                ...recent.map(gate => (
                  <Text wrap="truncate">
                    <Text color={gate.stale === true ? 'inactive' : isFailedGate(gate) ? 'error' : 'success'}>{isFailedGate(gate) ? '✗' : '✓'}</Text>
                    {` ${gateCounts(gate)}`}
                    {gate.stale === true ? <Text color="inactive">{` · ${t().gateStale}`}</Text> : null}
                    {`  ${fit(gate.command, GATE_COMMAND_COLUMNS)}  `}
                    <Text dimColor>{`${gate.where} · ${t().gateAgo(fmtDuration(now - gate.at))}`}</Text>
                  </Text>
                )),
              ]),
            ]),
        ...workspace,
        ...(blocks.length === 0
          ? []
          : [section([plain(t().recentBlocks, { bold: true }), ...blocks.map(block => plain(guardText(block, now), { color: GUARD_COLORS[block.decision] }))])]),
      ]

      // Placed inline above the prompt the pane has a few rows: what needs the person, nothing else.
      if (e.props.placement === 'inline') {
        body = head
      }
    } else if (current === 'agents') {
      const all = await read($, agents)
      // Running first as spawned, then the ended newest end first; a tie keeps the later spawn first.
      const ended = [...all].reverse().filter(one => one.state !== 'running')
      const list = [...all.filter(one => one.state === 'running'), ...ended.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))]
      const { listed, folded } = agentFold(list, await read($, agentsSeenBefore))
      const isFoldOpen = await read($, agentsFoldOpen)
      const shown = isFoldOpen ? [...listed, ...folded] : listed
      const table = agentTable(shown, now, columns, await flightsNow($))
      const row = (one: (typeof table.rows)[number]) => {
        const hotkey = one.run.slot
        // Without a hotkey the label starts where the others' `1: ` does not.
        const lined = hotkey === undefined ? { ...one, before: [...one.before, { text: ' '.repeat(HOTKEY_COLUMNS) }] } : one

        return buttonRow(lined, `read-agent-${one.run.agentId}`, hotkey, () => void readAgent($, one.run.agentId), one.isDim)
      }
      const foldRow =
        folded.length === 0 ? [] : [<Button key="agents-fold" label={foldText(folded)} plain onPress={() => void update($, agentsFoldOpen, was => !was)} />]

      body =
        list.length === 0
          ? [plain(t().noSubagents, { dim: true })]
          : [plain(table.head, { dim: true }), ...table.rows.slice(0, listed.length).map(row), ...foldRow, ...table.rows.slice(listed.length).map(row)]
    } else if (current === 'mmrun') {
      const snap = await read($, runs)
      // A failed read keeps the runs it had below this line.
      const unreadable = snap?.error === undefined ? [] : [plain(t().runsUnreadable(snap.error), { color: 'warning' })]
      const sessionId = await sessionIdOf($)
      // Runs another session started fold under one row; the rest keep their order.
      const shownRuns = snap?.runs.slice(0, PANE_RUNS) ?? []
      const listed = shownRuns.filter(run => runSession(run, sessionId) !== false)
      const folded = shownRuns.filter(run => runSession(run, sessionId) === false)
      const isFoldOpen = await read($, runsFoldOpen)
      const foldRow =
        folded.length === 0 ? [] : [<Button key="runs-fold" label={t().otherSessionRuns(folded.length)} plain onPress={() => void update($, runsFoldOpen, was => !was)} />]
      // Every run goes down, the pane scrolls them; a run's head carries its Read button, "[ <label> ]" after a space.
      const blocks = runTable(isFoldOpen ? [...listed, ...folded] : listed, snap?.polledAt ?? now, columns - widthOf(t().read) - 5).map(block => (
        <Box flexDirection="column">
          <Box>
            {draw(block.head)}
            <Text> </Text>
            <Button key={`read-run-${block.run.runid}`} label={t().read} onPress={() => void readRun($, block.run.runid)} />
          </Box>
          {block.rows.map(draw)}
        </Box>
      ))

      body =
        snap === null || snap.runs.length === 0
          ? unreadable.length > 0
            ? unreadable
            : [plain(snap === null ? t().loading : t().noRecentRuns, { dim: true })]
          : [...unreadable, ...blocks.slice(0, listed.length), ...foldRow, ...blocks.slice(listed.length)]
    } else if (current === 'timeline') {
      const turns = await read($, timeline)
      const mains = turns.filter(one => one.agentId === undefined).map(one => one.turnId)
      const shown = shownTurnId(turns, await read($, timelineTurn))
      const at = shown === undefined ? -1 : mains.indexOf(shown)
      const isHotspots = (await read($, timelineView)) === 'hotspots'
      // The steps or events toggle is a disclosure, which redraws through paneWake.
      await read($, paneWake)

      const isEvents = openDisclosures.has(EVENTS_VIEW)
      const events = (
        <Button key="timeline-events" label={isEvents ? t().timelineStepsView : t().timelineEventsView} onPress={() => toggleDisclosure($, EVENTS_VIEW)} />
      )
      const toggle = (
        <Button
          key="timeline-view"
          label={isHotspots ? t().timelineViewTurn : t().timelineViewHotspots}
          onPress={() => void update($, timelineView, was => (was === 'hotspots' ? 'turn' : 'hotspots'))}
        />
      )
      const nav = [
        at > 0 ? <Button key="timeline-prev" label={t().timelinePrev} onPress={() => void pickTurn($, mains[at - 1]!)} /> : null,
        at >= 0 && at < mains.length - 1 ? <Button key="timeline-next" label={t().timelineNext} onPress={() => void pickTurn($, mains[at + 1]!)} /> : null,
        at >= 0 && at < mains.length - 1 ? <Button key="timeline-latest" label={t().timelineLatest} onPress={() => void pickTurn($, null)} /> : null,
      ].filter(button => button !== null)

      // Stepping between turns is the single turn's; the hotspots take every main turn.
      body = isEvents
        ? [<Box columnGap={1}>{events}</Box>, ...eventLines(await readEventLedger($), columns).map(draw)]
        : [<Box columnGap={1}>{[events, toggle, ...(isHotspots ? [] : nav)]}</Box>, ...(isHotspots ? hotspotLines(turns, columns) : timelineLines(turns, shown ?? '', now, columns, await read($, agents))).map(draw)]
    } else if (current === 'usage') {
      body = usageLines(await usageNow($), columns).map(draw)
    } else if (current === 'progress') {
      body = progressLines(await read($, progress), columns, now).map(draw)
    } else {
      body = gpuLines(await read($, gpu), now, columns).map(line => plain(line.text, line))
    }

    return (
      <Box flexDirection="column">
        {tabs}
        {body}
      </Box>
    )
  }).catch(async ($, e, next) => {
    // Only this page is lost: the page buttons stay, so the person can move on.
    const current = (await read($, page)) ?? 'overview'
    const message = next.error.message ?? next.error.kind

    await read($, tick)
    $.ui.log(`dashboard: the ${current} page failed to draw (${next.error.kind}): ${next.error.message ?? 'no message'}`, { to: 'debug' })

    if (e.surface === 'desktop') {
      return drawDesktopPaneError($.ui.resolve(e), {
        page: current,
        pages: pagesShown(current),
        message,
        onPage: to => void goTo($, to),
        onClose: () =>
          void (async () => {
            await closedByPerson($)
            await $.ui.close({ id: PANE_ID })
            await syncStatus($)
          })(),
      })
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {paneTabs($, { Box, Button }, current)}
        <Text color="error" wrap="truncate">
          {fit(`✗ ${message}`, e.props.bodyColumns)}
        </Text>
      </Box>
    )
  })
}
