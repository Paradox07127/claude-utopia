import { fmtAge } from './agent-model'
import type { Line } from './board'
import type { LedgerEvent } from './events'
import { t } from './i18n'

// E2: the CI of the open PR of the session root's branch, from `gh`; a status row on the band, never a turn.

export const CI_POLL_MS = 60_000
// `gh` missing or not logged in: asked again no earlier than this.
export const CI_RETRY_MS = 10 * 60_000
export const CI_GROUP = 'CI'
export const PR_VIEW = ['gh', 'pr', 'view', '--json', 'number,url,headRefName,state']
export const PR_CHECKS = ['gh', 'pr', 'checks', '--json', 'name,state,bucket']

export type CiPr = { number: number; url: string; branch: string }
export type CiCheck = { name: string; state: string; bucket: string }
export type CiOutcome = 'fail' | 'pending' | 'pass'
/** The PR's checks as last polled; `changedAt` when its outcome last changed. */
export type CiStatus = { pr: CiPr; checks: CiCheck[]; outcome: CiOutcome; changedAt: number; polledAt: number }

const NO_AUTH = /gh auth login|not logged in|authentication required/i

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** `gh pr view --json number,url,headRefName,state`'s PR; null when it printed none or the PR is merged or closed. */
export function parsePr(stdout: string): CiPr | null {
  const one = jsonOf(stdout) as { number?: unknown; url?: unknown; headRefName?: unknown; state?: unknown } | null

  if (typeof one?.number !== 'number' || typeof one.url !== 'string' || typeof one.headRefName !== 'string' || one.state !== 'OPEN') {
    return null
  }

  return { number: one.number, url: one.url, branch: one.headRefName }
}

/** `gh pr checks --json name,state,bucket`'s checks; null when it printed no list. */
export function parseChecks(stdout: string): CiCheck[] | null {
  const list = jsonOf(stdout)

  if (!Array.isArray(list)) {
    return null
  }

  return list.flatMap(item => {
    const one = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>

    return typeof one.name === 'string' && typeof one.bucket === 'string' ? [{ name: one.name, state: typeof one.state === 'string' ? one.state : '', bucket: one.bucket }] : []
  })
}

/** Whether `gh` answered that it is not logged in. */
export const isNoAuth = (exitCode: number, stderr: string) => exitCode === 4 || NO_AUTH.test(stderr)

/** Whether a run rejected because the command could not be found, not because it timed out. */
export const isNotFound = (error: unknown) => /ENOENT|not found/i.test(String(error))

/** Whether `gh pr view` failed because the branch has no PR. */
export const isNoPr = (stderr: string) => /no pull requests found/i.test(stderr)

const isFailed = (check: CiCheck) => check.bucket === 'fail' || check.bucket === 'cancel'

/** Any check failed: fail; else any still running: pending; else pass. */
export function ciOutcome(checks: readonly CiCheck[]): CiOutcome {
  return checks.some(isFailed) ? 'fail' : checks.some(check => check.bucket === 'pending') ? 'pending' : 'pass'
}

/** The status after a poll: `changedAt` moves only when the PR or its outcome changed. */
export function nextCi(was: CiStatus | null, pr: CiPr, checks: CiCheck[], now: number): CiStatus {
  const outcome = ciOutcome(checks)
  const isSame = was !== null && was.pr.number === pr.number && was.outcome === outcome

  return { pr, checks, outcome, changedAt: isSame ? was.changedAt : now, polledAt: now }
}

/** The band's line: `CI ✗ build · PR #12 · 2m前`, `CI ● 3/7 · PR #12`, `CI ✓ PR #12`. */
export function ciLine(ci: CiStatus, now: number): Line {
  const pr = `PR #${ci.pr.number}`

  if (ci.outcome === 'fail') {
    const failing = ci.checks.find(isFailed)?.name ?? ''

    return [{ text: 'CI ' }, { text: '✗', color: 'error' }, { text: ` ${failing} · ${pr} · ${t().ciAgo(fmtAge(now - ci.changedAt))}` }]
  }

  if (ci.outcome === 'pending') {
    const done = ci.checks.filter(check => check.bucket !== 'pending').length

    return [{ text: 'CI ' }, { text: '●', color: 'permission' }, { text: ` ${done}/${ci.checks.length} · ${pr}` }]
  }

  return [{ text: 'CI ' }, { text: '✓', color: 'success' }, { text: ` ${pr}` }]
}

/** A `ci.result` event when a PR's overall state changed between two writes. */
export function ciEvents(before: CiStatus | null, after: CiStatus | null): LedgerEvent[] {
  if (after === null || (before?.pr.number === after.pr.number && before.outcome === after.outcome)) {
    return []
  }

  const failing = after.checks.find(isFailed)?.name ?? null

  return [
    {
      name: 'ci.result',
      severity: after.outcome === 'fail' ? 'WARN' : 'INFO',
      attributes: { 'pr.number': after.pr.number, 'pr.url': after.pr.url, branch: after.pr.branch, outcome: after.outcome, failing, checks: after.checks.length },
    },
  ]
}
