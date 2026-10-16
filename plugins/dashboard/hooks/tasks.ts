import type { AgentRun, AgentRunState, MmModel, MmRun, TaskRow } from '../types'

/** One line of <model>.events.jsonl, as far as the dashboard reads it. */
type TaskEvent = {
  type?: unknown
  claude_session?: unknown
  usage?: { tool_uses?: unknown; output_tokens?: unknown }
  last_tool_name?: unknown
  summary?: unknown
  transcript_path?: unknown
}

/** The line as an object; null for a line cut by the tail or one that is not a JSON object. */
function eventOf(line: string): TaskEvent | null {
  try {
    const parsed: unknown = JSON.parse(line)

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as TaskEvent) : null
  } catch {
    return null
  }
}

/** The model with what the events in `text` say: the session from task_started, the latest task_progress, the task_notification's summary, the latest tokens and transcript path. */
export function applyEvents(model: MmModel, text: string): MmModel {
  const next: MmModel = { ...model }

  for (const line of text.split('\n')) {
    const event = eventOf(line)
    const usage = typeof event?.usage === 'object' && event.usage !== null ? event.usage : {}

    if (event?.type === 'task_started' && typeof event.claude_session === 'string' && event.claude_session !== '') {
      next.claudeSession = event.claude_session
    }

    if ((event?.type === 'task_progress' || event?.type === 'task_notification') && typeof event.transcript_path === 'string') {
      next.transcriptPath = event.transcript_path
    }

    // <model>.meta's usage, read before, is the one mmrun settled on.
    if ((event?.type === 'task_progress' || event?.type === 'task_notification') && typeof usage.output_tokens === 'number' && model.outputTokens === undefined) {
      next.outputTokens = usage.output_tokens
    }

    if (event?.type === 'task_progress') {
      if (typeof usage.tool_uses === 'number') {
        next.tools = usage.tool_uses
      }

      if (typeof event.last_tool_name === 'string') {
        next.lastTool = event.last_tool_name
      }

      if (typeof event.summary === 'string') {
        next.summary = event.summary
      }
    }

    if (event?.type === 'task_notification') {
      if (typeof event.summary === 'string') {
        next.summary = event.summary
      }
    }
  }

  return next
}

const AGENT_STATUS: Record<AgentRunState, TaskRow['status']> = { running: 'running', idle: 'running', done: 'done', error: 'failed', refusal: 'failed', aborted: 'stopped' }

export function taskOfAgent(run: AgentRun): TaskRow {
  return {
    id: run.agentId,
    origin: 'subagent',
    provider: 'claude',
    kind: run.subagentType,
    title: run.description,
    model: run.model,
    status: AGENT_STATUS[run.state],
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
    tools: run.tools,
    lastTool: run.lastTool,
    ...(run.outputTokens !== undefined && { outputTokens: run.outputTokens }),
  }
}

function modelStatus(status: string): TaskRow['status'] {
  if (status === 'RUNNING') {
    return 'running'
  }

  if (status === 'DONE') {
    return 'done'
  }

  if (status.startsWith('FAIL:')) {
    return 'failed'
  }

  return status === 'CANCELLED' || status.startsWith('SKIP:') ? 'stopped' : 'stale'
}

/** `sessionId`: this session's, null when it could not be read. */
export function taskOfModel(run: MmRun, model: MmModel, sessionId: string | null): TaskRow {
  return {
    id: `${run.runid}/${model.name}`,
    origin: 'mm',
    provider: model.name,
    kind: run.mode,
    title: run.tag,
    model: model.name,
    status: modelStatus(model.status),
    startedAt: model.startedAt,
    ...(model.endedAt !== undefined && { endedAt: model.endedAt }),
    ...(model.tools !== undefined && { tools: model.tools }),
    ...(model.lastTool !== undefined && { lastTool: model.lastTool }),
    ...(model.summary !== undefined && { summary: model.summary }),
    ...(model.outputTokens !== undefined && { outputTokens: model.outputTokens }),
    ...(model.claudeSession !== undefined && sessionId !== null && { isThisSession: model.claudeSession === sessionId }),
  }
}

/** Whether this session started the run: true if one model says so, false if one names another session and none this one, undefined when none says. */
export function runSession(run: MmRun, sessionId: string | null): boolean | undefined {
  const marks = run.models.map(model => taskOfModel(run, model, sessionId).isThisSession)

  return marks.includes(true) ? true : marks.includes(false) ? false : undefined
}

/** A running task's `3 tools · Read x.ts`, either part alone when the other is unknown; '' once it ended or with neither. */
export function activityText(task: TaskRow): string {
  if (task.status !== 'running') {
    return ''
  }

  return [task.tools === undefined ? '' : `${task.tools} tools`, task.lastTool ?? ''].filter(part => part !== '').join(' · ')
}
