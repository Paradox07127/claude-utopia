/**
 * `pass` is null when no line of the output gave a total; `fail` is null when a marker said failed with no failing test counted.
 * `unit` is `packages` when only go package lines were counted; absent, the counts are tests.
 */
export type TestSummary = { pass: number | null; fail: number | null; failed: boolean; failures: string[]; unit?: 'packages' }

type Parsed = Omit<TestSummary, 'failed' | 'fail'> & { fail: number; failed?: boolean }

// Real test output lines run far shorter; longer ones are cut so no pattern below backtracks over them for seconds.
const MAX_LINE = 2000
// The card shows a handful; `fail` keeps the real count.
export const MAX_FAILURES = 50

const lines = (text: string) => text.split('\n').map(l => l.trim().slice(0, MAX_LINE))

const sum = (all: RegExpMatchArray[]) => all.reduce((n, m) => n + Number(m[1]), 0)

// One `N pass` / `N fail` pair per run; sum them.
const bun = (text: string): Parsed | null => {
  const pass = [...text.matchAll(/^\s*(\d+) pass\s*$/gm)]
  const fail = [...text.matchAll(/^\s*(\d+) fail\s*$/gm)]
  if (pass.length === 0 || fail.length === 0) return null
  const failures = lines(text).filter(l => l.startsWith('✗') || l.startsWith('(fail)'))
  return { pass: sum(pass), fail: sum(fail), failures }
}

// One summary line per test binary; sum them.
const cargo = (text: string): Parsed | null => {
  const all = [...text.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/gm)]
  if (all.length === 0) return null
  return {
    pass: all.reduce((n, m) => n + Number(m[1]), 0),
    fail: all.reduce((n, m) => n + Number(m[2]), 0),
    failures: [],
  }
}

// XCTest prints one `Executed` line per suite; the last is the outermost suite's total. Its failure count
// counts assertions, so failing tests are counted by name when their error or `Test Case … failed` lines are there.
const xctest = (all: string[]) => {
  const last = all.map(l => /Executed (\d+) tests?, with (\d+) failures?/.exec(l)).filter(m => m !== null).at(-1)
  if (last === undefined) return null
  const named = new Map<string, string>()
  for (const l of all) {
    const name = /: error: -\[(\S+ \S+)\] : /.exec(l)?.[1]
    if (name !== undefined && !named.has(name)) named.set(name, l)
  }
  for (const l of all) {
    const name = /^Test Case '-\[(\S+ \S+)\]' failed\b/.exec(l)?.[1]
    if (name !== undefined && !named.has(name)) named.set(name, l)
  }
  return { total: Number(last[1]), fail: named.size > 0 ? named.size : Number(last[2]), failures: [...named.values()] }
}

// Swift Testing names a test in quotes, or by its function when it has no display name.
const ST_NAME = String.raw`(?:"(.+?)"|(\S+\(.*?\)))`
const ST_RUN = /Test run with (\d+) tests? in \d+ suites? (passed|failed) after/
const ST_FAILED = new RegExp(String.raw`\bTest ${ST_NAME}(?: with \d+ test cases?)? failed after`)
const ST_ISSUE = new RegExp(String.raw`\bTest ${ST_NAME} recorded an issue(?: with .+?)? at (\S+?:\d+:\d+):`)

const swiftTesting = (all: string[]) => {
  const runs = all.map(l => ST_RUN.exec(l)).filter(m => m !== null)
  // Failing test → where its first issue was recorded.
  const named = new Map<string, string | null>()
  for (const l of all) {
    const issue = ST_ISSUE.exec(l)
    const failed = issue ?? ST_FAILED.exec(l)
    if (failed === null) continue
    const name = failed[1] ?? failed[2]!
    if (!named.has(name) || named.get(name) === null) named.set(name, issue?.[3] ?? null)
  }
  const last = runs.at(-1)
  if (last === undefined && named.size === 0) return null
  return {
    total: last === undefined ? null : Number(last[1]),
    fail: named.size,
    failures: [...named].map(([name, at]) => (at === null ? name : `${name}  ${at}`)),
    isFailed: runs.some(m => m[2] === 'failed'),
  }
}

// xcodebuild's own list after a failed test action, covering both frameworks.
const failingTests = (text: string) => {
  const section = /^Failing tests:\n((?:[ \t]+\S.*(?:\n|$))+)/m.exec(text)
  return section === null ? null : lines(section[1]!).filter(l => l !== '')
}

const xcode = (text: string): Parsed | null => {
  const all = lines(text)
  const xct = xctest(all)
  const st = swiftTesting(all)
  if (xct === null && st === null) return null
  const failed = st?.isFailed === true
  // Failure lines alone, with neither an `Executed` nor a `Test run with` line: how many passed is unknown.
  const isCounted = xct !== null || (st?.total ?? null) !== null
  const listed = failingTests(text)
  if (listed !== null) {
    const fail = listed.length
    return { pass: isCounted ? Math.max(0, (xct?.total ?? 0) + (st?.total ?? 0) - fail) : null, fail, failed, failures: listed }
  }
  return {
    pass: isCounted ? Math.max(0, (xct?.total ?? 0) - (xct?.fail ?? 0)) + Math.max(0, (st?.total ?? 0) - (st?.fail ?? 0)) : null,
    fail: (xct?.fail ?? 0) + (st?.fail ?? 0),
    failed,
    failures: [...(xct?.failures ?? []), ...(st?.failures ?? [])],
  }
}

// Each `Ran N tests in …s` line, then its `OK` / `FAILED (…)` verdict; skipped tests are neither passes nor failures.
const unittest = (text: string): Parsed | null => {
  let total: number | null = null
  let runs = 0
  let pass = 0
  let fail = 0
  for (const l of lines(text)) {
    const ran = /^Ran (\d+) tests? in [\d.]+s$/.exec(l)
    if (ran) {
      total = Number(ran[1])
      continue
    }
    const verdict = /^(?:OK(?: \(([^)]*)\))?|FAILED \(([^)]*)\))$/.exec(l)
    if (verdict === null || total === null) continue
    const counts = verdict[1] ?? verdict[2] ?? ''
    const count = (name: string) => Number(new RegExp(`\\b${name}=(\\d+)`).exec(counts)?.[1] ?? 0)
    const failed = count('failures') + count('errors')
    pass += Math.max(0, total - failed - count('skipped'))
    fail += failed
    runs += 1
    total = null
  }
  return runs === 0 ? null : { pass, fail, failures: [] }
}

// One summary line per run, ending with `in 0.12s`; `-q` drops the `===` rule around it. Errors count as failures.
// cargo's `test result:` line fits the same pattern and is cargo's.
const pytest = (text: string): Parsed | null => {
  const summaries = lines(text).filter(l => !l.startsWith('test result:') && /\b\d+ (?:passed|failed|errors?)\b.*\bin [\d.]+s\b/.test(l))
  if (summaries.length === 0) return null
  const count = (pattern: RegExp) => summaries.reduce((n, l) => n + Number(pattern.exec(l)?.[1] ?? 0), 0)
  const pass = count(/\b(\d+) passed\b/)
  const fail = count(/\b(\d+) failed\b/) + count(/\b(\d+) errors?\b/)
  const failures = lines(text).filter(l => /^FAILED \S+::\S+/.test(l) || /^ERROR \S+\.py\b/.test(l))
  return { pass, fail, failures }
}

// Per-package lines: `ok  pkg 0.01s` / `ok  pkg (cached)`, `FAIL pkg 0.01s` / `FAIL pkg [build failed]`.
// With -v, unindented `--- PASS:` / `--- FAIL:` lines count top-level tests; without, only packages are known.
const go = (text: string): Parsed | null => {
  const okPackages = (text.match(/^ok\s+\S+\s+(?:\(cached\)|[\d.]+s)/gm) ?? []).length
  const failPackages = (text.match(/^FAIL\s+\S+\s+(?:[\d.]+s|\[)/gm) ?? []).length
  if (okPackages + failPackages === 0) return null
  if (!/^(?:=== RUN\s|--- PASS: )/m.test(text)) return { pass: okPackages, fail: failPackages, failures: [], unit: 'packages' }
  const tests = (verdict: string) => (text.match(new RegExp(`^--- ${verdict}: `, 'gm')) ?? []).length
  return { pass: tests('PASS'), fail: tests('FAIL'), failed: failPackages > 0, failures: [] }
}

// plugins/mm/tests/test_mmrun.py and its kind: `ok   <name>` / `FAIL <name> (…)` lines, then `all passed` or `<N> failed` last.
const okFail = (text: string): Parsed | null => {
  const all = lines(text).filter(l => l !== '')
  const last = all.at(-1)
  const footer = last === undefined ? null : /^(\d+) failed$/.exec(last)
  if (last === undefined || (last !== 'all passed' && footer === null)) return null
  const failures = all.filter(l => l.startsWith('FAIL '))
  return { pass: all.filter(l => l.startsWith('ok ')).length, fail: footer === null ? 0 : Number(footer[1]), failures }
}

// An `ok   <name> 5s` line would pass for a go package.
const goUnlessOkFail = (text: string) => (okFail(text) === null ? go(text) : null)

const PARSERS = [bun, cargo, xcode, unittest, pytest, okFail, goUnlessOkFail]

// `** TEST FAILED **`, `** TEST EXECUTE FAILED **`…: xcodebuild failed even when every counted test passed.
const FAILED_MARKER = /\*\* [A-Z ]*FAILED \*\*/

// Every runner's summary counts, one output may hold several; any failure anywhere fails the whole.
export const summarizeTests = (text: string): TestSummary | null => {
  const parts = PARSERS.map(parse => parse(text)).filter(got => got !== null)
  if (parts.length === 0) return null
  // Package counts stand only when no runner counted tests; a failing package still fails the whole.
  const counted = parts.some(p => p.unit === undefined) ? parts.filter(p => p.unit === undefined) : parts
  const passes = counted.map(p => p.pass).filter(n => n !== null)
  const fail = counted.reduce((n, p) => n + p.fail, 0)
  const failed = parts.some(p => p.failed === true || p.fail > 0) || FAILED_MARKER.test(text)
  return {
    pass: passes.length === 0 ? null : passes.reduce((n, p) => n + p, 0),
    fail: failed && fail === 0 ? null : fail,
    failed,
    failures: parts.flatMap(p => p.failures).slice(0, MAX_FAILURES),
    ...(counted.every(p => p.unit === 'packages') && { unit: 'packages' as const }),
  }
}
