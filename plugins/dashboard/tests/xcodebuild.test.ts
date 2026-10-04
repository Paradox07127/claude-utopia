import { describe, expect, test } from 'claude-code/testing'

import { summarizeXcodebuild } from '../hooks/xcodebuild'
import buildOk from './fixtures/xcode/build-ok'
import compileError from './fixtures/xcode/compile-error'
import linkError from './fixtures/xcode/link-error'
import partialTruncation from './fixtures/xcode/partial-truncation'
import persistedPreview from './fixtures/xcode/persisted-preview'
import signingNoProfiles from './fixtures/xcode/signing-no-profiles'

describe('summarizeXcodebuild', () => {
  test('compile errors: deduped file:line:col errors, the rendered `- error: copies skipped', async () => {
    const got = summarizeXcodebuild(compileError)
    expect(got?.verdict).toBe('failed')
    expect(got?.markers).toEqual(['TEST BUILD FAILED'])
    expect(got?.errorCount).toBe(16)
    expect(got?.errors[0]).toEqual({ loc: 'TokenizerTests.swift:42:31', message: "cannot infer contextual base in reference to member 'trailingWhitespace'" })
    expect(got?.errors.some(e => e.message.includes('`-'))).toBe(false)
    expect(got?.truncation).toBe('none')
  })

  test('the same error twice counts once', async () => {
    const line = '/work/App/A.swift:3:5: error: cannot find x in scope'
    const got = summarizeXcodebuild([line, line, '/work/App/B.m:9:1: error: expected ;', '** BUILD FAILED **'].join('\n'))
    expect(got?.errorCount).toBe(2)
    expect(got?.errors).toEqual([
      { loc: 'A.swift:3:5', message: 'cannot find x in scope' },
      { loc: 'B.m:9:1', message: 'expected ;' },
    ])
  })

  test('link errors without a marker: failed, no location', async () => {
    const got = summarizeXcodebuild(linkError)
    expect(got?.verdict).toBe('failed')
    expect(got?.markers).toEqual([])
    expect(got?.errors).toEqual([
      { loc: null, message: 'Undefined symbol: static (extension in DemoKit):__C.NSBundle.demoResources.getter : __C.NSBundle' },
      { loc: null, message: 'ld: symbol(s) not found for architecture arm64' },
      { loc: null, message: 'linker command failed with exit code 1 (use -v to see invocation)' },
    ])
  })

  test('signing: No profiles under the project, then TEST FAILED', async () => {
    const got = summarizeXcodebuild(signingNoProfiles)
    expect(got?.verdict).toBe('failed')
    expect(got?.markers).toEqual(['TEST FAILED'])
    expect(got?.errorCount).toBe(1)
    expect(got?.errors[0]?.loc).toBeNull()
    expect(got?.errors[0]?.message).toMatch(/^No profiles for 'com\.example\.demoapp' were found/)
  })

  test('signing: Command CodeSign failed, the failed commands counted', async () => {
    const text = [
      'Command CodeSign failed with a nonzero exit code',
      'Testing failed:',
      '\tCommand CodeSign failed with a nonzero exit code',
      '** TEST FAILED **',
      'The following build commands failed:',
      "\tCodeSign /work/Build/App.app (in target 'App' from project 'App')",
      '(2 failures)',
    ].join('\n')
    const got = summarizeXcodebuild(text)
    expect(got?.verdict).toBe('failed')
    expect(got?.errors).toEqual([{ loc: null, message: 'Command CodeSign failed with a nonzero exit code' }])
    expect(got?.failedCommands).toBe(2)
  })

  test('xcodebuild: error: is an error with no location', async () => {
    const got = summarizeXcodebuild('xcodebuild: error: Scheme DemoApp is not currently configured for the test action.')
    expect(got?.verdict).toBe('failed')
    expect(got?.errors).toEqual([{ loc: null, message: 'Scheme DemoApp is not currently configured for the test action.' }])
  })

  test('build succeeded: the bare warnings counted', async () => {
    const got = summarizeXcodebuild(buildOk)
    expect(got).toEqual({ tool: 'xcodebuild', markers: ['BUILD SUCCEEDED'], verdict: 'ok', errors: [], errorCount: 0, warnings: 2, failedCommands: null, truncation: 'none' })
  })

  test('file warnings are deduped; the rendered copies are not counted', async () => {
    const warn = '/work/App/A.swift:3:5: warning: var never mutated'
    const got = summarizeXcodebuild([warn, '  |     `- warning: var never mutated', warn, 'ld: warning: dup rpath', '** BUILD SUCCEEDED **'].join('\n'))
    expect(got?.warnings).toBe(2)
    expect(got?.verdict).toBe('ok')
  })

  test('the failed-commands list alone is a failure, never a pass', async () => {
    const list = ['The following build commands failed:', "\tSwiftCompile normal arm64 /work/App/A.swift (in target 'App' from project 'App')", '(1 failure)'].join('\n')
    expect(summarizeXcodebuild(list)?.verdict).toBe('failed')
    expect(summarizeXcodebuild(list)?.failedCommands).toBe(1)
    expect(summarizeXcodebuild(`exit=0\n${list}`)?.verdict).toBe('failed')
    expect(summarizeXcodebuild('Testing failed:\n\tSome test')?.verdict).toBe('failed')
  })

  test('compiler lines without an xcodebuild marker are a build, not xcodebuild', async () => {
    const got = summarizeXcodebuild('/work/Sources/A.swift:3:5: error: cannot find x in scope')
    expect(got?.tool).toBe('build')
    expect(got?.verdict).toBe('failed')
    expect(summarizeXcodebuild('** BUILD SUCCEEDED **')?.tool).toBe('xcodebuild')
  })

  test('a failed run among succeeded ones fails; markers listed once each, in order', async () => {
    const got = summarizeXcodebuild(['** BUILD SUCCEEDED **', '** TEST FAILED **', '** BUILD SUCCEEDED **'].join('\n'))
    expect(got?.markers).toEqual(['BUILD SUCCEEDED', 'TEST FAILED'])
    expect(got?.verdict).toBe('failed')
  })

  test('persisted output: only a preview', async () => {
    const got = summarizeXcodebuild(persistedPreview)
    expect(got?.truncation).toBe('preview')
    expect(got?.markers).toEqual(['TEST BUILD FAILED'])
    expect(got?.verdict).toBe('failed')
  })

  test('an errored output cut in the middle: partial', async () => {
    const text = ['Exit code 65', '/work/App/A.swift:3:5: error: boom', '', '... [1948 characters truncated] ...', '', '** BUILD FAILED **'].join('\n')
    const got = summarizeXcodebuild(text)
    expect(got?.truncation).toBe('partial')
    expect(got?.errorCount).toBe(1)
  })

  for (const [name, text] of [
    ['ls', 'README.md\nsrc\nApp.xcodeproj'],
    ['a grep of error: in logs', 'app.log:12: error: connection refused\n2026-08-13 14:33:45 App[1:2] [XPC] Handle connection with error: Connection invalid\nsrc/x.ts:3:1: error: boom'],
    ['bun test', '(pass) a [1ms]\n(fail) b > breaks [2ms]\nerror: expect(received).toBe(expected)\n    at /work/hooks/a.test.ts:12:3\n\n 1 pass\n 1 fail'],
    ['Swift Testing alone', partialTruncation],
    ['a refused command naming xcodebuild', 'This agent is isolated in the worktree /work/wt, but this command runs xcodebuild with a value computed at runtime. Refusing to run it.'],
  ] as const) {
    test(`null for ${name}`, async () => {
      expect(summarizeXcodebuild(text)).toBeNull()
    })
  }
})
