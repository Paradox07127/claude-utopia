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

/** One model's end of a run: its status file, `mmrun result` output when it is DONE, else the reason mmrun wrote and the non-empty patch a run left, if any. */
export type ModelResult = { model: string; status: string; output: string; reason?: string; patch?: string }

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

// A `--top` section, or a `--oneline` finding.
const SEVERE = /^## (CRITICAL|MAJOR)\b|\[(critical|major)\]/m
const NOT_EXPANDED = /^Not expanded: (\d+)/m

/** The judge rules a review's findings call for; one line when no DONE model reports a critical or major finding. */
function judge(rid: string, results: ModelResult[], isExhaustive: boolean): string[] {
  const outputs = results.filter(one => one.status === 'DONE').map(one => one.output)

  if (outputs.length === 0) {
    return []
  }

  if (!outputs.some(output => SEVERE.test(output))) {
    return ['No critical or major findings: say plainly there are no issues; do not pad.']
  }

  return [
    'Judge rules:',
    '- Settle each finding by reading the code it points at. Keep only those at confidence 80 or above: you read the code and can name the input that makes it fail. Mention the dropped ones only in one line at the end: `Dropped N low-confidence findings`.',
    '- Drop without scoring: what a linter, typechecker or compiler catches; style with no basis in CLAUDE.md; a generic "consider …" with no file:line. A suggestion to add an abstraction, a config option or a fallback is Optional at most.',
    '- For a diff review, also drop lines this change did not touch and old problems unrelated to it. For a `--full` review keep them: the existing code is what was asked for.',
    '- A finding both models report is high confidence, but still read the code. One that only a single model reports, settle by reading the code yourself: no voting, and do not drop it because the other model did not report it.',
    `- Act only on critical/major.${isExhaustive ? ` For an --exhaustive run, also read minor/optional: \`mmrun result <model> ${rid}\` without --top.` : ''}`,
    '- Coming back empty-handed is fine: with no finding at 80 or above, say plainly there are no issues; do not pad.',
    ...(outputs.some(output => Number(NOT_EXPANDED.exec(output)?.[1] ?? 0) > 0)
      ? ['- When the findings show `Not expanded` greater than 0, tell the user and let them decide whether to upgrade to --exhaustive.']
      : []),
    '- Do not change the code unless the user asked for it.',
  ]
}

/** A run's next steps, from what each model left: a patch to check and apply, or a worktree to discard. */
function runNext(rid: string, results: ModelResult[]): string[] {
  const patched = results.filter(one => one.status === 'DONE' && !/^patch: no changes/m.test(one.output))

  return [
    ...(patched.length > 0
      ? [
          `Next: read the patch above against the task's acceptance items, then \`mmrun check ${rid} -- <gate command>\`; if it passes, \`mmrun apply ${rid}\` and run the gate again in the main tree; otherwise \`mmrun discard ${rid}\`.`,
        ]
      : []),
    ...results
      .filter(one => !patched.includes(one))
      .map(one =>
        one.status !== 'DONE' && one.patch !== undefined
          ? `- ${one.model}: ${one.status}, but it left a patch: ${one.patch}; read it before \`mmrun discard ${rid}\`, which removes the worktree.`
          : `- ${one.model}: ${one.status === 'DONE' ? 'no changes' : 'no patch'}; \`mmrun discard ${rid}\` removes the worktree.`,
      ),
    ...(results.some(one => one.status === 'DONE' && one.output.split('\n')[0] === 'status: blocked')
      ? ['- status blocked: take the questions to the user; do not guess the answers and delegate again.']
      : []),
  ]
}

/** The message handed to the model when every model of a watched run has ended; the `seen` models' output is left out. */
export function doneMessage(kind: 'review' | 'run' | 'ask', rid: string, results: ModelResult[], seen: string[] = [], isExhaustive = false): string {
  // The engine refuses a submitted text that begins with `/`: it would run as a command.
  const head =
    kind === 'review'
      ? `mm plugin: /mm:review review ${rid} has finished`
      : kind === 'run'
        ? `mm plugin: /mm:run run ${rid} has finished`
        : `mm plugin: mmrun start/ask run ${rid} has finished`
  const sections = results.map(one =>
    seen.includes(one.model)
      ? `## ${one.model}(${one.status})\nYou already read this result.`
      : one.status === 'DONE'
        ? `## ${one.model}(${one.status})\n${one.output}`
        : one.reason !== undefined
          ? `## ${one.model}(${one.status})\nNo result: ${one.reason}`
          : `## ${one.model}(${one.status})\nNo result. \`tail -n 20 ~/.claude/mmruns/${rid}/${one.model}.raw | cut -c1-300\` shows the end of its log; report it to the user.`,
  )
  // Ahead of the model sections, so a reader that stops early still has them.
  const judged = kind === 'review' ? judge(rid, results, isExhaustive) : []
  const rules = judged.length > 0 ? [judged.join('\n')] : []
  const tail = kind === 'run' ? runNext(rid, results) : []

  return [head, ...rules, ...sections, ...(tail.length > 0 ? [tail.join('\n')] : [])].join('\n\n')
}

/** The results with each output the message shows cut to an equal share of the `max` characters its other parts leave, keeping its head and tail. */
export function cutOutputs(
  kind: 'review' | 'run' | 'ask',
  rid: string,
  results: ModelResult[],
  seen: string[],
  isExhaustive: boolean,
  max: number,
): ModelResult[] {
  const shown = results.filter(one => one.status === 'DONE' && !seen.includes(one.model))
  const rest = doneMessage(kind, rid, results, seen, isExhaustive).length - shown.reduce((sum, one) => sum + one.output.length, 0)
  const share = Math.floor((max - rest) / Math.max(shown.length, 1))

  return results.map(one => {
    const note = `\n[cut; full: mmrun result ${one.model} ${rid}]\n`
    const keep = Math.max(share - note.length, 0)
    // The tail holds the patch line and Not expanded, which the next steps and the judge rules read.
    const head = Math.floor(keep * 0.4)

    return shown.includes(one) && one.output.length > share
      ? { ...one, output: one.output.slice(0, head) + note + one.output.slice(one.output.length - (keep - head)) }
      : one
  })
}
