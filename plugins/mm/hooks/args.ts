// Options of `mmrun review` and `mmrun run` that take the next word as their value; any other `--x` is a switch.
const VALUED = new Set([
  '--base',
  '--commit',
  '--paths',
  '--focus',
  '--notes-file',
  '--max',
  '--models',
  '--dir',
  '--grok-model',
  '--codex-model',
  '--agy-model',
  '--patch',
  '--model',
  '--task',
  '--model-name',
])

/** One model's end of a run: its status file, and `mmrun result` output when it is DONE. */
export type ModelResult = { model: string; status: string; output: string }

/** Splits like a shell: blanks separate words, '…' is literal, "…" and a bare \ escape; no expansion. */
export function splitArgs(args: string): string[] {
  const words: string[] = []
  let word = ''
  let isWord = false
  let quote: '' | "'" | '"' = ''

  for (let i = 0; i < args.length; i++) {
    const ch = args[i] ?? ''

    if (quote === "'") {
      if (ch === "'") {
        quote = ''
      } else {
        word += ch
      }
    } else if (quote === '"') {
      if (ch === '"') {
        quote = ''
      } else if (ch === '\\' && '"\\$`'.includes(args[i + 1] ?? '')) {
        word += args[++i]
      } else {
        word += ch
      }
    } else if (/\s/.test(ch)) {
      if (isWord) {
        words.push(word)
        word = ''
        isWord = false
      }
    } else {
      isWord = true

      if (ch === "'" || ch === '"') {
        quote = ch
      } else if (ch === '\\' && i + 1 < args.length) {
        word += args[++i]
      } else {
        word += ch
      }
    }
  }

  if (isWord) {
    words.push(word)
  }

  return words
}

/** Options only: the first word is an option, and every other word is the value of the option before it. */
export function isFlagForm(words: string[]): boolean {
  if (words.length === 0) {
    return true
  }

  return words.every((word, i) => (i === 0 ? word.startsWith('--') : word.startsWith('--') || VALUED.has(words[i - 1] ?? '')))
}

const JUDGE = [
  'Judge rules (as in step 4 of /mm:review):',
  '- Settle each finding by reading the code it points at; drop those with confidence below 80, and mention the dropped ones only in one line at the end: `Dropped N low-confidence findings`.',
  '- A finding both models report is high confidence; one that only a single model reports, settle by reading the code yourself: no voting, and do not drop it because the other model did not report it.',
  '- Act only on critical/major.',
  '- Coming back empty-handed is fine: with no finding at 80 or above, say plainly there are no issues; do not pad.',
  '- When the findings show `Not expanded` greater than 0, tell the user and let them decide whether to upgrade to --exhaustive.',
]

/** The message handed to the model when every model of a watched run has ended. */
export function doneMessage(kind: 'review' | 'run', rid: string, results: ModelResult[]): string {
  // The engine refuses a submitted text that begins with `/`: it would run as a command.
  const head = kind === 'review' ? `mm plugin: /mm:review review ${rid} has finished` : `mm plugin: /mm:run run ${rid} has finished`
  const sections = results.map(one =>
    one.status === 'DONE'
      ? `## ${one.model}(${one.status})\n${one.output}`
      : `## ${one.model}(${one.status})\nNo result. To troubleshoot, read the last lines: \`tail -20 ~/.claude/mmruns/${rid}/${one.model}.raw\`; do not read the whole raw.`,
  )
  const tail =
    kind === 'review'
      ? JUDGE
      : [
          'Next (as in step 4 of /mm:run):',
          ...results.map(one => `- Read the patch first: \`~/.claude/mmruns/${rid}/${one.model}.patch\`, against the task's acceptance items.`),
          `- For a cross review, \`mmrun review --patch ${rid}\`.`,
          `- If satisfied, \`mmrun apply ${rid}\`; if not, \`mmrun discard ${rid}\`.`,
          '- On `status: blocked`, take the questions to the user; do not guess the answers and delegate again.',
        ]

  return [head, ...sections, tail.join('\n')].join('\n\n')
}
