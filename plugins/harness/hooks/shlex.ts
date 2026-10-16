// CPython's shlex (posix mode, comments off), ported line for line: the guards split shell text exactly as it does.
// plugins/harness/hooks/shlex.ts and plugins/mm/hooks/shlex.ts are the same file: each plugin ships on its own.

const QUOTES = `'"`
// Python's str.split() with no argument splits on these (str.isspace); JS \s lacks \x1c-\x1f and \x85, and adds \ufeff.
const PY_SPACE = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/

/** The words of shlex.shlex(text, posix=True, punctuation_chars=punctuation) with whitespace_split on and no commenters.
 * Throws where shlex raises ValueError (an open quote, a trailing backslash). */
export function shlexTokens(text: string, punctuation = '', whitespace = ' \t\r\n'): string[] {
  const chars = Array.from(text)
  const pushback: string[] = []
  const tokens: string[] = []
  let at = 0
  let state: string | null = ' '
  let token = ''
  const read = (): string => pushback.pop() ?? chars[at++] ?? ''

  for (;;) {
    let quoted = false
    let escapedState = ' '
    for (;;) {
      const c = read()
      if (state === null) {
        token = ''
        break
      }
      if (state === ' ') {
        if (c === '') {
          state = null
          break
        } else if (whitespace.includes(c)) {
          if (token !== '' || quoted) break
        } else if (c === '\\') {
          escapedState = 'a'
          state = c
        } else if (punctuation.includes(c)) {
          token = c
          state = 'c'
        } else if (QUOTES.includes(c)) {
          state = c
        } else {
          token = c
          state = 'a'
        }
      } else if (QUOTES.includes(state)) {
        quoted = true
        if (c === '') throw new Error('No closing quotation')
        if (c === state) {
          state = 'a'
        } else if (c === '\\' && state === '"') {
          escapedState = state
          state = c
        } else {
          token += c
        }
      } else if (state === '\\') {
        if (c === '') throw new Error('No escaped character')
        // Inside double quotes a backslash escapes only the quote and itself.
        if (QUOTES.includes(escapedState) && c !== state && c !== escapedState) token += state
        token += c
        state = escapedState
      } else {
        if (c === '') {
          state = null
          break
        } else if (whitespace.includes(c)) {
          state = ' '
          if (token !== '' || quoted) break
        } else if (state === 'c') {
          if (punctuation.includes(c)) {
            token += c
          } else {
            pushback.push(c)
            state = ' '
            break
          }
        } else if (QUOTES.includes(c)) {
          state = c
        } else if (c === '\\') {
          escapedState = 'a'
          state = c
        } else if (!punctuation.includes(c)) {
          token += c
        } else {
          pushback.push(c)
          state = ' '
          if (token !== '' || quoted) break
        }
      }
    }
    const word = token
    token = ''
    if (word === '' && !quoted) return tokens
    tokens.push(word)
  }
}

/** shlex.split(text); throws where it raises ValueError. */
export function shlexSplit(text: string): string[] {
  return shlexTokens(text)
}

/** Python's text.split(): the fallback the guards use when shlex refuses the text. */
export function pySplit(text: string): string[] {
  return text.split(PY_SPACE).filter(word => word !== '')
}

/** shlex.join(words). */
export function shlexJoin(words: readonly string[]): string {
  return words.map(word => (word === '' ? "''" : /[^\w@%+=:,./-]/.test(word) ? `'${word.replaceAll("'", `'"'"'`)}'` : word)).join(' ')
}
