import { t } from './i18n'
import { projectKey } from './usage'

// E3: notices to every session of a repository, one JSON file each beside the presence files; none lives past NOTICE_TTL_MS.

export const NOTICE_CHARS = 120
export const NOTICE_TTL_MS = 24 * 3_600_000
export const NOTICES_MS = 15_000
const SHA = /^[0-9a-f]{40}$/

/** `author` the session that posted it, `at` epoch ms. */
export type Notice = { id: string; author: string; at: number; text: string }

/** This repository's notice directory; `root` its main worktree. */
export const noticesDir = (home: string, root: string) => `${home}/.claude/dashboard/notices/${projectKey(root)}`

/** The notice `/notice <text>` posts, its text trimmed and cut to NOTICE_CHARS; null for no text. */
export function noticeOf(author: string, at: number, text: string): Notice | null {
  const cut = [...text.trim().replace(/\s+/g, ' ')].slice(0, NOTICE_CHARS).join('')

  return cut === '' ? null : { id: `${at}-${author}`, author, at, text: cut }
}

/** A notice file's record when each field has its kind; null otherwise. */
export function parseNotice(text: string): Notice | null {
  let one: Record<string, unknown>

  try {
    one = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }

  const isValid = typeof one?.id === 'string' && typeof one.author === 'string' && typeof one.at === 'number' && Number.isFinite(one.at) && typeof one.text === 'string'

  return isValid ? { id: one.id as string, author: one.author as string, at: one.at as number, text: one.text as string } : null
}

export const isExpired = (notice: Notice, now: number) => now - notice.at > NOTICE_TTL_MS

/** The newest notice still shown: not expired, and posted after this session's `/notice clear`. */
export function newestNotice(notices: readonly Notice[], clearedAt: number, now: number): Notice | null {
  return notices.filter(one => !isExpired(one, now) && one.at > clearedAt).reduce<Notice | null>((best, one) => (best === null || one.at > best.at ? one : best), null)
}

/** A `git rev-parse` answer's sha; null when it gave none. */
export function shaOf(stdout: string): string | null {
  const sha = stdout.trim()

  return SHA.test(sha) ? sha : null
}

/**
 * What a new main sha means: `notice` when it moved from a known sha and not by this session; `sha` the baseline from then on.
 * `isOwn`: this session's own git command moved it.
 */
export function mainMoved(was: string | null, sha: string, isOwn: boolean, branch: string, author: string, now: number): { sha: string; notice: Notice | null } {
  if (was === null || was === sha || isOwn) {
    return { sha, notice: null }
  }

  return { sha, notice: { id: `main-${sha}`, author, at: now, text: t().mainAdvanced(branch, sha.slice(0, 7)) } }
}

/** The band's notice row: `公告 · <text>`. */
export const noticeText = (notice: Notice) => `${t().noticeWord} · ${notice.text}`
