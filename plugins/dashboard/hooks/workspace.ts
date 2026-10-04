import type { GuardBlock, WorktreeInfo } from '../types'
import { fmtDuration } from './agent-model'
import { t } from './i18n'

export type PorcelainTree = { path: string; head: string; branch: string }

/** `git worktree list --porcelain`, the main tree first; the branch without `refs/heads/`, or `detached`. */
export function parseWorktrees(text: string): PorcelainTree[] {
  return text
    .split(/\n\s*\n/)
    .map(block => block.split('\n'))
    .filter(lines => lines[0]?.startsWith('worktree ') === true)
    .map(lines => {
      const field = (key: string) => lines.find(line => line.startsWith(`${key} `))?.slice(key.length + 1) ?? ''

      return { path: field('worktree'), head: field('HEAD'), branch: lines.includes('detached') ? 'detached' : field('branch').replace(/^refs\/heads\//, '') }
    })
}

/** `rev-list --left-right --count main...HEAD` prints `behind<TAB>ahead`. */
export function parseAheadBehind(text: string): { behind: number; ahead: number } {
  const [behind, ahead] = text.trim().split(/\s+/).map(Number)

  return { behind: behind ?? 0, ahead: ahead ?? 0 }
}

/** A worktree from its `status --porcelain` and `rev-list --left-right --count` output. */
export function treeOf(name: string, branch: string, status: string, counts: string, running: boolean): Omit<WorktreeInfo, 'path'> {
  const dirty = status.split('\n').filter(line => line.trim() !== '').length
  const { behind, ahead } = parseAheadBehind(counts)

  return { name, branch, dirty, ahead, behind, merged: ahead === 0 && dirty === 0, running, error: null }
}

/** A block is the guard working, not a failure: a deny is quiet. */
export const GUARD_COLORS: Record<GuardBlock['decision'], string> = { deny: 'inactive' }

/** The newest `count` lines of guard.jsonl's tail that read as a deny, newest first; a line the tail cut, no JSON or another decision is skipped. */
export function parseGuards(text: string, count: number): GuardBlock[] {
  const blocks: GuardBlock[] = []

  for (const line of text.split('\n').reverse()) {
    if (blocks.length === count) {
      break
    }

    let one: Record<string, unknown>

    try {
      one = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    const isText = (value: unknown) => value === null || typeof value === 'string'

    if (
      typeof one === 'object' &&
      one !== null &&
      typeof one.at === 'number' &&
      typeof one.guard === 'string' &&
      one.decision === 'deny' &&
      typeof one.op === 'string' &&
      isText(one.cwd) &&
      isText(one.agent_id)
    ) {
      blocks.push({ at: one.at, guard: one.guard, decision: one.decision, op: one.op, cwd: one.cwd as string | null, agentId: one.agent_id as string | null })
    }
  }

  return blocks
}

/** `op · worktree · agent · 3m ago`: the cwd's last segment, the agent's first 8 characters or the main thread. */
export function guardText(block: GuardBlock, now: number): string {
  const tree = block.cwd?.split('/').filter(part => part !== '').pop() ?? '—'
  const agent = block.agentId === null ? t().mainThread : block.agentId.slice(0, 8)

  return [block.op, tree, agent, t().gateAgo(fmtDuration(now - block.at))].join(' · ')
}

export type Mark = { text: string; tone: 'stale' | 'done' | 'failed' | 'running' | 'plain' | 'dim' }

/** A worktree's state words, in the order a row shows them. */
export function treeMarks(tree: Omit<WorktreeInfo, 'path'>): Mark[] {
  if (tree.error !== null) {
    return [
      { text: t().readFailed, tone: 'failed' },
      { text: tree.error, tone: 'dim' },
    ]
  }

  return [
    ...(tree.dirty > 0 ? [{ text: t().dirty(tree.dirty), tone: 'stale' as const }] : []),
    ...(tree.ahead > 0 ? [{ text: t().ahead(tree.ahead), tone: 'plain' as const }] : []),
    ...(tree.behind > 0 ? [{ text: t().behind(tree.behind), tone: 'dim' as const }] : []),
    ...(tree.running ? [{ text: t().running, tone: 'running' as const }] : tree.merged ? [{ text: t().mergedRemovable, tone: 'done' as const }] : []),
  ]
}
