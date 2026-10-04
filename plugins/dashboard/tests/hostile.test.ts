import { describe, expect, test } from 'claude-code/testing'

import { MAX_FAILURES, summarizeTests } from '../hooks/summarize-tests'
import { MAX_ERRORS, summarizeXcodebuild } from '../hooks/xcodebuild'

const LIMIT_MS = 1000
const LONG_PATH = `/${Array.from({ length: 5000 }, (_, i) => `dir${i}`).join('/')}/File.swift`

const HOSTILE: [string, string][] = [
  ['a 100k-character line', 'x'.repeat(100_000)],
  ['a 100k-character error line', `/work/App/A.swift:1:1: error: ${'x'.repeat(100_000)}`],
  ['100k short lines', Array.from({ length: 100_000 }, (_, i) => `line ${i}`).join('\n')],
  ['100k distinct error lines', Array.from({ length: 100_000 }, (_, i) => `/work/App/A.swift:${i}:1: error: e${i}`).join('\n')],
  ['100k failing bun tests', `${Array.from({ length: 100_000 }, (_, i) => `(fail) t${i}`).join('\n')}\n 0 pass\n 100000 fail`],
  ['** BUILD FAILED ** 50k times', '** BUILD FAILED **\n'.repeat(50_000)],
  ['an error under a 40k-character path', `${LONG_PATH}:12:5: error: boom\n** BUILD FAILED **`],
  [
    'NUL and ANSI escapes',
    `${Array.from({ length: 10_000 }, (_, i) => `\x1b[31m/work/App/A.swift:${i}:1: error: x\0y\x1b[0m\0`).join('\n')}\n\x1b[1m** BUILD FAILED **\x1b[0m\n\0 3 pass\n\0 1 fail`,
  ],
  ['CJK and emoji only', Array.from({ length: 20_000 }, () => '测试失败😀🧪漢字テスト✗ 構建失敗 🔥').join('\n')],
  ['a Swift Testing issue line repeated 3000 times', 'Test "a" recorded an issue with '.repeat(3000)],
  ['a Swift Testing function name opened 20k times', 'Test f('.repeat(20_000)],
  ['a pytest count repeated 20k times', '1 passed '.repeat(20_000)],
]

const timed = <T>(run: () => T) => {
  const start = performance.now()
  const got = run()
  return { got, ms: performance.now() - start }
}

describe('hostile input', () => {
  for (const [name, text] of HOSTILE) {
    test(`summarizeTests: ${name}`, async () => {
      const { got, ms } = timed(() => summarizeTests(text))
      expect(ms).toBeLessThan(LIMIT_MS)
      expect(got?.failures.length ?? 0).toBeLessThanOrEqual(MAX_FAILURES)
    })

    test(`summarizeXcodebuild: ${name}`, async () => {
      const { got, ms } = timed(() => summarizeXcodebuild(text))
      expect(ms).toBeLessThan(LIMIT_MS)
      expect(got?.errors.length ?? 0).toBeLessThanOrEqual(MAX_ERRORS)
      expect(got?.errors.length ?? 0).toBe(Math.min(got?.errorCount ?? 0, MAX_ERRORS))
    })
  }
})
