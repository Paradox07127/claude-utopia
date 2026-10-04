import { describe, expect, test } from 'claude-code/testing'

import { setLang } from '../hooks/i18n'
import { reportOf } from '../hooks/runs'

const OUT = '/r/codex.out'

/** `n` review findings of every severity, each with a long claim, quote and failure scenario. */
const manyFindings = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    severity: ['critical', 'major', 'minor', 'optional'][i % 4],
    file: `src/f${i}.ts`,
    line: i + 1,
    claim: `claim ${i} `.repeat(20),
    quote: `const x${i} = y\n`.repeat(15),
    failure_scenario: `breaks when ${i} `.repeat(30),
    basis: 'read',
    suggestion: `guard ${i} `.repeat(20),
  }))

describe('reportOf', () => {
  test('unvalidated-report-schema: a JSON of neither shape reads as the .out; bad findings and checks never throw', () => {
    setLang('en')

    expect(reportOf({ answer: 'yes' }, 'plain out', 'review', false, OUT)).toBe('plain out')
    expect(reportOf({ answer: 'yes' }, 'plain out', 'run', false, OUT)).toBe('plain out')
    expect(reportOf([1, 2], 'plain out', 'review', false, OUT)).toBe('plain out')
    expect(reportOf({ findings: 'none' }, 'plain out', 'review', false, OUT)).toBe('plain out')

    const review = reportOf({ verdict: 'approve', summary: 'ok', findings: 'none', not_checked: 'tests/' }, '', 'review', false, OUT)

    expect(review).toContain('**approve** · ok')
    expect(review).not.toContain('undefined')

    const skipped = reportOf({ verdict: 'needs_changes', summary: 's', findings: [null, 3, 'x', { severity: 'major', file: 'a.ts', line: 2, claim: 'C', quote: 'q', failure_scenario: 'f' }] }, '', 'review', false, OUT)

    expect(skipped).toContain('**a.ts:2** — C')
    expect(reportOf({ status: 'done', summary: 's', checks_run: 'bun test' }, '', 'run', false, OUT)).toContain('checks_run: none')
    expect(reportOf({ status: 'done', summary: 's', checks_run: [null, 'tsc', 7] }, '', 'run', false, OUT)).toContain('- tsc')
  })

  test('unenforced-render-budget: the markdown of a 40-finding review stays under 8000 characters, the cut named', () => {
    setLang('en')

    const md = reportOf({ verdict: 'needs_changes', summary: 'many', findings: manyFindings(40), not_expanded: 0 }, '', 'review', true, OUT)

    expect(md.length).toBeLessThanOrEqual(8000)
    expect(md).toContain(`…(truncated, full text in ${OUT})`)
    expect(md.startsWith('**needs_changes** · many')).toBe(true)
  })
})
