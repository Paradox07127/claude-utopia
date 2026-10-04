import { describe, expect, test } from 'claude-code/testing'

import { fit, widthOf } from '../hooks/agent-model'

const FAMILY = '👨‍👩‍👧‍👦'
const LIMIT_MS = 1000

describe('display width by grapheme', () => {
  test('combining marks and zero-width code points take no cell; an emoji sequence or a wide character takes two', () => {
    expect(widthOf('é'), 'e and a combining acute').toBe(1)
    expect(widthOf(FAMILY), 'a ZWJ family').toBe(2)
    expect(widthOf('❤️'), 'a text heart turned emoji by VS16').toBe(2)
    expect(widthOf('🇨🇳'), 'a flag').toBe(2)
    expect(widthOf('1️⃣'), 'a keycap').toBe(2)
    expect(widthOf('a​b'), 'a zero-width space').toBe(2)
    expect(widthOf('构建ｶﾅ한글'), 'CJK and Hangul wide, half-width kana narrow').toBe(10)
    expect(widthOf('✓●⊘✗◐…—'), 'the band glyphs').toBe(7)
    expect(widthOf('')).toBe(0)
  })

  test('truncation never cuts inside a grapheme', () => {
    expect(fit('ab́cd', 3), 'the mark stays on its letter').toBe('ab́…')
    expect(fit(`ab${FAMILY}xyz`, 5), 'the family stays whole').toBe(`ab${FAMILY}…`)
    expect(fit(`ab${FAMILY}xyz`, 3), 'or goes whole').toBe('ab…')
    expect(fit(`é${FAMILY}`, 3), 'fits as it is').toBe(`é${FAMILY}`)
  })

  test('long lines stay fast: plain, wide, and one letter under 100k marks', () => {
    for (const text of ['x'.repeat(100_000), '测试😀'.repeat(30_000), `e${'́'.repeat(100_000)}`]) {
      const start = performance.now()

      widthOf(text)
      fit(text, 80)
      expect(performance.now() - start).toBeLessThan(LIMIT_MS)
    }

    expect(widthOf(`e${'́'.repeat(100_000)}`)).toBe(1)
  })
})
