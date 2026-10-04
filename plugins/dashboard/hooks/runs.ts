import type { DashReview, MmModel, MmRun, MmSnapshot } from '../types'
import { fmtDuration, fmtTokens } from './agent-model'
import { t } from './i18n'

export const RUNID = /^\d{8}-\d{6}-[0-9a-f]+$/

export function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {}

  for (const line of text.split('\n')) {
    const at = line.indexOf('=')

    if (at > 0) {
      out[line.slice(0, at)] = line.slice(at + 1)
    }
  }

  return out
}

export const isFailedModel = (model: MmModel) => model.status === 'STALE' || model.status.startsWith('FAIL')

export const runLabel = (run: MmRun) => run.tag || run.runid.slice(-4)

export const fmtSecs = (secs: number) => fmtDuration(Math.round(secs) * 1000)

/** `25.8k tok`; `— tok` when unknown. */
export function fmtRunTokens(n: number | undefined): string {
  return `${fmtTokens(n)} tok`
}

/** Seconds the model ran, or has run so far; undefined when its start is unknown. */
export function elapsedSecs(model: MmModel, now: number): number | undefined {
  if (model.secs !== undefined) {
    return model.secs
  }

  if (model.startedAt === 0) {
    return undefined
  }

  return ((model.endedAt ?? now) - model.startedAt) / 1000
}

const REPORT_CHARS = 6000
// The engine refuses a Markdown or Code leaf over 10000 characters.
const LEAF_CHARS = 8000
export const SEVERITIES = ['critical', 'major', 'minor', 'optional']

type Finding = { severity?: string; file?: string; line?: number | string; claim?: string; quote?: string; failure_scenario?: string; basis?: string; suggestion?: string }
type Check = string | { cmd?: string; exit_code?: number; result_line?: string }
type ReportJson = {
  verdict?: string
  summary?: string
  findings?: Finding[]
  not_expanded?: number
  not_checked?: string[]
  status?: string
  checks_run?: Check[]
  not_verified?: string[]
  decisions_made?: string[]
  questions?: string[]
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const itemsOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

export const listOf = (title: string, value: unknown) => {
  const items = itemsOf(value)

  return items.length > 0 ? [`${title}\n${items.map(item => `- ${String(item)}`).join('\n')}`] : []
}

/** `text` cut to fit one Markdown or Code leaf, the cut naming the file that holds the whole. */
export function capLeaf(text: string, outPath: string): string {
  if (text.length <= LEAF_CHARS) {
    return text
  }

  const note = `\n\n${t().truncated(outPath)}`

  return `${text.slice(0, LEAF_CHARS - note.length)}${note}`
}

/** A review needs findings or a verdict, a run a status; any other JSON reads as no JSON. */
function layoutOf(json: unknown, mode: string): 'review' | 'run' | null {
  if (!isObject(json)) {
    return null
  }

  if (mode === 'run') {
    return typeof json.status === 'string' ? 'run' : null
  }

  return Array.isArray(json.findings) || typeof json.verdict === 'string' ? 'review' : null
}

const findingsOf = (r: ReportJson) => itemsOf(r.findings).filter(isObject) as Finding[]

function findingOf(f: Finding): string {
  const head = `- **${f.file}:${f.line ?? '?'}** — ${f.claim}${f.basis ? ` [${f.basis}]` : ''}`
  const quote = String(f.quote ?? '')
    .split('\n')
    .map(line => `  > ${line}`)
    .join('\n')

  return [head, quote, `  ${t().failureScenario(String(f.failure_scenario))}`, ...(f.suggestion ? [`  ${t().fix(f.suggestion)}`] : [])].join('\n\n')
}

/** One model's conclusion as one markdown leaf: its review or run JSON when it is one (null otherwise), else the start of its .out. */
export function reportOf(json: unknown, out: string, mode: string, showAll: boolean, outPath: string): string {
  const layout = layoutOf(json, mode)

  if (layout === null) {
    return out.length > REPORT_CHARS ? `${out.slice(0, REPORT_CHARS)}\n\n${t().truncated(outPath)}` : out
  }

  const r = json as ReportJson

  if (layout === 'run') {
    const checks = itemsOf(r.checks_run).flatMap(check =>
      typeof check === 'string' ? [check] : isObject(check) ? [`${String(check.cmd)} → exit ${String(check.exit_code)} · ${String(check.result_line)}`] : [],
    )

    return capLeaf(
      [
        `**${r.status}** · ${r.summary}`,
        ...(checks.length > 0 ? listOf('checks_run:', checks) : [t().noChecks]),
        ...listOf('not_verified:', r.not_verified),
        ...listOf('decisions_made:', r.decisions_made),
        ...listOf('questions:', r.questions),
      ].join('\n\n'),
      outPath,
    )
  }

  const findings = findingsOf(r)
  const sections = (showAll ? SEVERITIES : SEVERITIES.slice(0, 2)).flatMap(severity => {
    const found = findings.filter(f => f.severity === severity)

    return found.length > 0 ? [`## ${severity.toUpperCase()}\n\n${found.map(findingOf).join('\n\n')}`] : []
  })

  return capLeaf([`**${r.verdict}** · ${r.summary}`, ...sections, ...listOf(t().notChecked, r.not_checked), t().notExpanded(r.not_expanded ?? 0)].join('\n\n'), outPath)
}

/** The review JSON's fields the desktop reader shows, findings of the four severities in their order; null when the JSON is no review. */
export function reviewOf(json: unknown, mode: string, outPath: string): DashReview | null {
  if (layoutOf(json, mode) !== 'review') {
    return null
  }

  const r = json as ReportJson
  const text = (value: unknown) => (value === undefined || value === null ? '' : String(value))
  const findings = findingsOf(r)

  return {
    verdict: text(r.verdict),
    summary: text(r.summary),
    findings: SEVERITIES.flatMap(severity =>
      findings
        .filter(f => f.severity === severity)
        .map(f => ({
          severity,
          file: text(f.file),
          line: text(f.line ?? '?'),
          claim: text(f.claim),
          quote: text(f.quote),
          failureScenario: text(f.failure_scenario),
          basis: text(f.basis),
          suggestion: text(f.suggestion),
        })),
    ),
    notChecked: itemsOf(r.not_checked).map(String),
    notExpanded: typeof r.not_expanded === 'number' ? r.not_expanded : 0,
    outPath,
  }
}

function endNote(model: MmModel): string {
  if (model.status === 'DONE') {
    return t().modelReturned(model.name)
  }

  return model.status === 'STALE' ? t().modelStale(model.name) : t().modelFailed(model.name, model.status)
}

/** One toast for every model that left RUNNING between two polls, `review-ui: grok returned; codex still running`; null when none did. */
export function endToast(prev: MmSnapshot, next: MmSnapshot): string | null {
  const parts: string[] = []

  for (const run of next.runs) {
    const was = prev.runs.find(one => one.runid === run.runid)
    const ended = run.models.filter(model => was?.models.find(one => one.name === model.name)?.status === 'RUNNING' && model.status !== 'RUNNING')

    if (ended.length === 0) {
      continue
    }

    const running = run.models.filter(model => model.status === 'RUNNING').map(model => model.name)

    parts.push(t().runToast(runLabel(run), ended.map(endNote), running))
  }

  return parts.length > 0 ? parts.join(t().toastSeparator) : null
}
