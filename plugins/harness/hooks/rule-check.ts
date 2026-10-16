// The reply-language rule, judged by code alone: the same stripping and threshold as reflect.py's is_language_violation.

export const HINT = '上一条回复不是简体中文。按用户的规则用简体中文回复，代码和标识符保持原样。'

const MIN_LETTERS = 40
const MIN_CJK_SHARE = 0.3
const MAX_SKIPPED = 16
const FENCE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g
const INLINE = /`[^`\n]*`/g
const URL = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g
const PATH = /\S*\/\S*/g
const WORD = /[A-Za-z0-9_.]+/g
// A word holding _, a digit, an inner dot or a lower-to-upper step is an identifier.
const IDENT = /[_0-9]|[a-z][A-Z]|[A-Za-z0-9]\.[A-Za-z0-9]/
const CJK = /[㐀-䶿一-鿿豈-﫿]/g
const LATIN = /[A-Za-z]/g

/** Below 0.3 CJK characters among the letters, over at least 40 letters, once code and identifiers are gone. */
export function isLanguageViolation(text: string): boolean {
  const prose = [FENCE, INLINE, URL, PATH].reduce((rest, re) => rest.replace(re, ' '), text).replace(WORD, word => (IDENT.test(word) ? ' ' : word))
  const cjk = prose.match(CJK)?.length ?? 0
  const latin = prose.match(LATIN)?.length ?? 0
  return cjk + latin >= MIN_LETTERS && cjk / (cjk + latin) < MIN_CJK_SHARE
}

/**
 * One session's check: `run` violations in a row, `skip` violations still to pass without a hint,
 * `lastHinted` whether the last violation got one, `owed` whether the next prompt carries it.
 */
export type RuleState = { run: number; skip: number; lastHinted: boolean; owed: boolean }

export const FRESH: RuleState = { run: 0, skip: 0, lastHinted: false, owed: false }

/** The state after a main-thread reply: once 2 hints in a row were each followed by another violation, the next min(16, 2^(n-3)) go unhinted, n the run. */
export function afterReply(state: RuleState, violated: boolean): RuleState {
  if (!violated) return FRESH
  const run = state.run + 1
  if (state.skip > 0) return { run, skip: state.skip - 1, lastHinted: false, owed: false }
  if (run >= 3 && state.lastHinted) return { run, skip: Math.min(MAX_SKIPPED, 2 ** (run - 3)) - 1, lastHinted: false, owed: false }
  return { run, skip: 0, lastHinted: true, owed: true }
}
