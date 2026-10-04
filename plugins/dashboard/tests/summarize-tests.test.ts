import { describe, expect, test } from 'claude-code/testing'

import { summarizeTests } from '../hooks/summarize-tests'
import falseGreen from './fixtures/xcode/false-green'
import partialTruncation from './fixtures/xcode/partial-truncation'
import stFailingTests from './fixtures/xcode/st-failing-tests'
import xctestAndStFail from './fixtures/xcode/xctest-and-st-fail'
import xctestAssertions from './fixtures/xcode/xctest-assertions'

const BUN = `hooks/register.test.ts:
(pass) agent.spawn > denies sonnet [12.05ms]
(fail) agent.offer > hides general-purpose [5.27ms]
✗ agent.offer > keeps Explore
(pass) agent.offer > keeps general-purpose [4.60ms]

 22 pass
 2 fail
Ran 24 tests across 1 file. [0.17s]`

const PYTEST = `============================= test session starts ==============================
collected 24 items

tests/test_a.py ..F.....F...............                                 [100%]

=========================== short test summary info ============================
FAILED tests/test_a.py::test_one - AssertionError: assert 1 == 2
FAILED tests/test_a.py::test_two - KeyError: 'x'
========================= 2 failed, 22 passed in 0.31s =========================`

const XCODE = `Test Suite 'All tests' started at 2026-10-02 10:00:00.000.
Test Suite 'AppTests' started at 2026-10-02 10:00:00.001.
/src/AppTests/FooTests.swift:12: error: -[AppTests.FooTests testA] : XCTAssertEqual failed: ("1") is not equal to ("2")
/src/AppTests/FooTests.swift:30: error: -[AppTests.FooTests testB] : failed - boom
Test Suite 'AppTests' failed at 2026-10-02 10:00:01.000.
\t Executed 24 tests, with 2 failures (0 unexpected) in 0.912 (0.915) seconds
Test Suite 'All tests' failed at 2026-10-02 10:00:01.001.
\t Executed 24 tests, with 2 failures (0 unexpected) in 0.912 (0.916) seconds
** TEST FAILED **`

const CARGO = `running 3 tests
test a ... ok
test b ... FAILED
test c ... ok

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

running 4 tests
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s`

const GO = `ok  \texample.com/app/a\t0.012s
ok  \texample.com/app/b\t(cached)
--- FAIL: TestC (0.00s)
FAIL
FAIL\texample.com/app/c\t0.020s
?   \texample.com/app/d\t[no test files]
FAIL`

const UNITTEST_OK = `..........
----------------------------------------------------------------------
Ran 10 tests in 0.004s

OK`

const UNITTEST_FAILED = `..F.E.....
======================================================================
FAIL: test_x (test_mod.T)
----------------------------------------------------------------------
Ran 10 tests in 0.004s

FAILED (failures=1, errors=1)`

const MMRUN = `ok   review 起跑
ok   status 读 RUNNING
ok   wait 超时
FAIL ask --with 匿名 (得到 'codex',应为 'A')

1 failed`

describe('summarizeTests', () => {
  test('bun / claude plugin test', async () => {
    expect(summarizeTests(BUN)).toEqual({
      pass: 22,
      fail: 2,
      failed: true,
      failures: ['(fail) agent.offer > hides general-purpose [5.27ms]', '✗ agent.offer > keeps Explore'],
    })
  })

  test('pytest', async () => {
    expect(summarizeTests(PYTEST)).toEqual({
      pass: 22,
      fail: 2,
      failed: true,
      failures: [
        'FAILED tests/test_a.py::test_one - AssertionError: assert 1 == 2',
        "FAILED tests/test_a.py::test_two - KeyError: 'x'",
      ],
    })
  })

  test('pytest -q, all passing', async () => {
    expect(summarizeTests('........\n8 passed in 0.05s')).toEqual({ pass: 8, fail: 0, failed: false, failures: [] })
  })

  test('xcodebuild / XCTest', async () => {
    expect(summarizeTests(XCODE)).toEqual({
      pass: 22,
      fail: 2,
      failed: true,
      failures: [
        '/src/AppTests/FooTests.swift:12: error: -[AppTests.FooTests testA] : XCTAssertEqual failed: ("1") is not equal to ("2")',
        '/src/AppTests/FooTests.swift:30: error: -[AppTests.FooTests testB] : failed - boom',
      ],
    })
  })

  test('cargo sums every test binary', async () => {
    expect(summarizeTests(CARGO)).toEqual({ pass: 6, fail: 1, failed: true, failures: [] })
  })

  test('go counts ok / FAIL package lines', async () => {
    expect(summarizeTests(GO)).toEqual({ pass: 2, fail: 1, failed: true, failures: [], unit: 'packages' })
  })

  test('go without -v: two passing packages are packages, not tests', async () => {
    const text = 'ok  \texample.com/app/a\t0.012s\nok  \texample.com/app/b\t(cached)'
    expect(summarizeTests(text)).toEqual({ pass: 2, fail: 0, failed: false, failures: [], unit: 'packages' })
  })

  test('go -v counts top-level tests', async () => {
    const text = [
      '=== RUN   TestA',
      '--- PASS: TestA (0.00s)',
      '=== RUN   TestB',
      '=== RUN   TestB/sub',
      '    --- PASS: TestB/sub (0.00s)',
      '--- PASS: TestB (0.00s)',
      'PASS',
      'ok  \texample.com/app/a\t0.012s',
      '=== RUN   TestC',
      '--- FAIL: TestC (0.00s)',
      'FAIL',
      'FAIL\texample.com/app/c\t0.020s',
    ].join('\n')
    expect(summarizeTests(text)).toEqual({ pass: 2, fail: 1, failed: true, failures: [] })
  })

  test('go packages beside counted tests: the packages do not count as tests, a failing one still fails', async () => {
    const text = [' 5 pass', ' 0 fail', 'Ran 5 tests across 1 file. [0.10s]', 'FAIL\texample.com/app/c\t0.020s'].join('\n')
    expect(summarizeTests(text)).toEqual({ pass: 5, fail: null, failed: true, failures: [] })
  })

  test('every runner summary counts: bun passing, then cargo failing', async () => {
    const text = [' 5 pass', ' 0 fail', 'Ran 5 tests across 1 file. [0.10s]', '', 'test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'].join('\n')
    expect(summarizeTests(text)).toEqual({ pass: 8, fail: 1, failed: true, failures: [] })
  })

  test('python unittest skipped tests are not passes', async () => {
    expect(summarizeTests('....ssss..\n----------------------------------------------------------------------\nRan 10 tests in 0.004s\n\nOK (skipped=4)')).toEqual({ pass: 6, fail: 0, failed: false, failures: [] })
  })

  test('ok / FAIL lines: the `N failed` footer counts when no FAIL line shows', async () => {
    expect(summarizeTests('ok   a\n2 failed')).toEqual({ pass: 1, fail: 2, failed: true, failures: [] })
  })

  test('python unittest OK', async () => {
    expect(summarizeTests(UNITTEST_OK)).toEqual({ pass: 10, fail: 0, failed: false, failures: [] })
  })

  test('python unittest FAILED counts failures and errors', async () => {
    expect(summarizeTests(UNITTEST_FAILED)).toEqual({ pass: 8, fail: 2, failed: true, failures: [] })
  })

  test('ok / FAIL lines ending in `N failed`', async () => {
    expect(summarizeTests(MMRUN)).toEqual({ pass: 3, fail: 1, failed: true, failures: ["FAIL ask --with 匿名 (得到 'codex',应为 'A')"] })
  })

  test('ok lines ending in `all passed`', async () => {
    expect(summarizeTests('ok   a\nok   b\n\nall passed\n')).toEqual({ pass: 2, fail: 0, failed: false, failures: [] })
  })

  test('xcodebuild: Swift Testing passed but TEST FAILED, XCTest ran 0, is not green; how many failed is unknown, not 0', async () => {
    expect(summarizeTests(falseGreen)).toEqual({ pass: 312, fail: null, failed: true, failures: [] })
  })

  test('Swift Testing whose run line says failed with no failing test named: unknown, not 0', async () => {
    expect(summarizeTests('Test run with 4 tests in 1 suite failed after 0.1 seconds with 1 issue.')).toEqual({ pass: 4, fail: null, failed: true, failures: [] })
  })

  test('Swift Testing alone, passing; known issues do not fail it', async () => {
    const text = ['Test run with 117 tests in 11 suites passed after 36.787 seconds with 6 known issues.', '** TEST EXECUTE SUCCEEDED **'].join('\n')
    expect(summarizeTests(text)).toEqual({ pass: 117, fail: 0, failed: false, failures: [] })
  })

  test('Swift Testing alone, failing: failed tests by name, the first issue location beside it', async () => {
    const text = [
      'Exit code 65',
      'Test "Header shows the title" recorded an issue at HeaderTests.swift:19:9: Expectation failed: title',
      'Test "Header shows the title" recorded an issue at HeaderTests.swift:20:9: Expectation failed: subtitle',
      'Test "Header shows the title" failed after 0.010 seconds with 2 issues.',
      'Test "Both list rows align" with 2 test cases failed after 0.001 seconds with 10 issues.',
      'Test parsesNumbers() recorded an issue with 1 argument input → 3 at ParserTests.swift:53:6: Caught error',
      'Test run with 57 tests in 7 suites failed after 0.073 seconds with 13 issues.',
    ].join('\n')
    expect(summarizeTests(text)).toEqual({
      pass: 54,
      fail: 3,
      failed: true,
      failures: ['Header shows the title  HeaderTests.swift:19:9', 'Both list rows align', 'parsesNumbers()  ParserTests.swift:53:6'],
    })
  })

  test('Swift Testing: the Failing tests list names the failures', async () => {
    expect(summarizeTests(stFailingTests)).toEqual({
      pass: 237,
      fail: 3,
      failed: true,
      failures: [
        'TokenizerTests.splitsOnUnicodeWordBoundaries()',
        'TokenizerTests.keepsEscapedQuotesInsideAString()',
        'LayoutEngineTests.clampsNegativeInsetsToZero()',
      ],
    })
  })

  test('Swift Testing without its run line (output cut short) still fails', async () => {
    const got = summarizeTests(partialTruncation)
    expect(got?.failed).toBe(true)
    expect(got?.fail).toBe(9)
    expect(got?.pass, 'no line gave a total: unknown, not 0').toBeNull()
  })

  test('Swift Testing failure lines alone: pass unknown', async () => {
    expect(summarizeTests('Test "x" failed after 0.010 seconds with 1 issue.')).toEqual({ pass: null, fail: 1, failed: true, failures: ['x'] })
  })

  test('XCTest counts failing tests, not assertions', async () => {
    const got = summarizeTests(xctestAssertions)
    expect(got?.pass).toBe(39)
    expect(got?.fail).toBe(1)
    expect(got?.failed).toBe(true)
    expect(got?.failures).toHaveLength(1)
  })

  test('XCTest `Test Case … failed` lines name the failing tests', async () => {
    const text = [
      "Test Case '-[AppTests.FooTests testA]' started.",
      'Test Case \'-[AppTests.FooTests testA]\' failed (0.002 seconds).',
      "Test Case '-[AppTests.FooTests testB]' passed (0.001 seconds).",
      '\t Executed 2 tests, with 3 failures (0 unexpected) in 0.003 (0.004) seconds',
    ].join('\n')
    expect(summarizeTests(text)).toEqual({ pass: 1, fail: 1, failed: true, failures: ["Test Case '-[AppTests.FooTests testA]' failed (0.002 seconds)."] })
  })

  test('XCTest and Swift Testing both ran: their counts add up', async () => {
    const got = summarizeTests(xctestAndStFail)
    expect(got?.pass).toBe(2573)
    expect(got?.fail).toBe(7)
    expect(got?.failed).toBe(true)
  })

  test('pytest errors count as failures', async () => {
    const text = [
      'FAILED tests/test_a.py::test_one - AssertionError',
      'ERROR tests/test_b.py::test_two - fixture not found',
      'ERROR tests/test_c.py - ImportError: no module x',
      '=================== 1 failed, 5 passed, 2 errors in 0.31s ===================',
    ].join('\n')
    expect(summarizeTests(text)).toEqual({
      pass: 5,
      fail: 3,
      failed: true,
      failures: ['FAILED tests/test_a.py::test_one - AssertionError', 'ERROR tests/test_b.py::test_two - fixture not found', 'ERROR tests/test_c.py - ImportError: no module x'],
    })
    expect(summarizeTests('ERROR tests/test_c.py\n1 error in 0.05s')).toEqual({ pass: 0, fail: 1, failed: true, failures: ['ERROR tests/test_c.py'] })
  })

  for (const [name, text] of [
    ['ok / FAIL lines without a verdict last', 'ok   a\nFAIL b (x)\n1 failed\ndone'],
    ['empty output', ''],
    ['plain command output', 'total 8\ndrwxr-xr-x  5 me  staff  160 Oct  2 03:03 .\nok'],
    ['unknown runner', 'Tests: 3 succeeded, 1 broken'],
    ['unittest without a verdict', 'Ran 3 tests in 0.1s'],
  ] as const) {
    test(`null for ${name}`, async () => {
      expect(summarizeTests(text)).toBeNull()
    })
  }
})
