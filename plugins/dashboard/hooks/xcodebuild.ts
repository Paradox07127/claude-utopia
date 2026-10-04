export type XcodeError = { loc: string | null; message: string }

export type XcodeSummary = {
  /** `build` when only compiler or linker lines say so: `swift build` and `make` print them too. */
  tool: 'xcodebuild' | 'build'
  markers: string[]
  verdict: 'ok' | 'failed'
  errors: XcodeError[]
  errorCount: number
  warnings: number
  failedCommands: number | null
  truncation: 'none' | 'preview' | 'partial'
}

const MARKER = /\*\* ([A-Z]+(?: [A-Z]+)* (?:SUCCEEDED|FAILED)) \*\*/g
// A compiler diagnostic: `/path/File.swift:12:5: error: …`.
const DIAG = /^([\w./~][^:]*\.(?:swift|m|mm|h|hh|hpp|c|cc|cpp|cxx|metal|xib|storyboard|strings|xcstrings|plist|intentdefinition)):(\d+):(\d+): (?:fatal )?(error|warning): (.*)$/
// Errors with no source line: the tool's own, the linker's, signing's. A project-level one reads `/path/App.xcodeproj: [Target: ][clang: ]error: …`.
const PLAIN_ERRORS = [
  /^xcodebuild: error: (.+)$/,
  /\.xcodeproj: (?:[^:]+: )*?error: (.+)$/,
  /^(?:clang|swift-frontend|swiftc): error: (.+)$/,
  /^(ld: (?!warning:).+)$/,
  /^(Command CodeSign failed\b.*)$/,
  /^error: (No profiles for .+)$/,
]
const SYMBOL = /^"(.+)", referenced from:$/
// The card shows a handful; `errorCount` keeps the real count.
export const MAX_ERRORS = 50

export const summarizeXcodebuild = (text: string): XcodeSummary | null => {
  const lines = text.split('\n').map(l => l.trim())
  const markers = [...new Set([...text.matchAll(MARKER)].map(m => m[1]!))]
  const errors = new Map<string, XcodeError>()
  const warnings = new Set<string>()
  const add = (loc: string | null, message: string) => errors.set(`${loc}\0${message}`, { loc, message })
  const hasSymbols = lines.some(l => /^Undefined symbols for architecture \S+:$/.test(l))

  for (const line of lines) {
    // Swift prints each diagnostic again under a source excerpt, as `|  `- error: …`.
    if (line.startsWith('|') || /`- (?:error|warning):/.test(line)) continue
    const diag = DIAG.exec(line)
    if (diag !== null) {
      const loc = `${diag[1]!.split('/').at(-1)}:${diag[2]}:${diag[3]}`
      if (diag[4] === 'error') add(loc, diag[5]!)
      else warnings.add(`${diag[1]}:${diag[2]}:${diag[3]}: ${diag[5]}`)
      continue
    }
    if (/^(?:ld: )?warning: /.test(line)) {
      warnings.add(line)
      continue
    }
    const symbol = hasSymbols ? SYMBOL.exec(line) : null
    if (symbol !== null) {
      add(null, `Undefined symbol: ${symbol[1]}`)
      continue
    }
    const plain = PLAIN_ERRORS.find(re => re.test(line))?.exec(line)
    if (plain) add(null, plain[1]!)
  }

  const commandsFailed = /^The following build commands failed:?$/m.test(text)
  const testingFailed = /^Testing failed:$/m.test(text)
  const isXcode = markers.length > 0 || errors.size > 0 || hasSymbols || commandsFailed || testingFailed
  if (!isXcode) return null

  const exits = [...text.matchAll(/\bexit(?: code)?[= ](\d+)\b/gi)].map(m => Number(m[1]))
  const isFailed = markers.some(m => m.endsWith('FAILED')) || errors.size > 0 || hasSymbols || commandsFailed || testingFailed || exits.some(n => n !== 0)
  const isOwn = markers.length > 0 || commandsFailed || testingFailed || /^xcodebuild: error:|\.xcodeproj: /m.test(text)
  const failedCommands = [...text.matchAll(/^\((\d+) failures?\)$/gm)].at(-1)?.[1]

  return {
    tool: isOwn ? 'xcodebuild' : 'build',
    markers,
    verdict: isFailed ? 'failed' : 'ok',
    errors: [...errors.values()].slice(0, MAX_ERRORS),
    errorCount: errors.size,
    warnings: warnings.size,
    failedCommands: failedCommands === undefined ? null : Number(failedCommands),
    truncation: text.includes('<persisted-output>') ? 'preview' : /\.\.\. \[\d+ characters truncated\] \.\.\./.test(text) ? 'partial' : 'none',
  }
}
