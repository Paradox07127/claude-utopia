import { describe, expect, test } from 'claude-code/testing'

import { cutOutputs, doneMessage, isFlagForm, splitArgs } from '../hooks/args'
import type { ModelResult } from '../hooks/args'

describe('splitArgs', () => {
  test('splits on blanks; single and double quotes hold a word together', () => {
    expect(splitArgs(`  --paths "src/api x"  --focus '并发 安全' a\\ b "" `)).toEqual(['--paths', 'src/api x', '--focus', '并发 安全', 'a b', ''])
    expect(splitArgs(`--focus "say \\"hi\\""`)).toEqual(['--focus', 'say "hi"'])
    expect(splitArgs(`'$HOME' "$HOME"`)).toEqual(['$HOME', '$HOME'])
    expect(splitArgs('')).toEqual([])
  })
})

describe('isFlagForm', () => {
  const form = (args: string) => isFlagForm(splitArgs(args))

  test('options only, values after the options that take one', () => {
    expect(form('--base main --paths "src/api"')).toBe(true)
    expect(form('--staged')).toBe(true)
    expect(form('--model codex --task /tmp/t.md')).toBe(true)
    expect(form('')).toBe(true)
  })

  test('every option mmrun review or run takes a value for holds that value', () => {
    const valued = ['--base', '--commit', '--paths', '--focus', '--notes-file', '--max', '--models', '--dir', '--grok-model', '--codex-model', '--agy-model', '--patch', '--model', '--task', '--model-name']

    for (const option of valued) {
      expect([option, form(`${option} v`)]).toEqual([option, true])
    }
  })

  test('natural language, or a word no option takes', () => {
    expect(form('提交前看看')).toBe(false)
    expect(form('--focus 并发 安全')).toBe(false)
    expect(form('--staged 看看')).toBe(false)
    expect(form('main --base')).toBe(false)
  })
})

describe('doneMessage', () => {
  const RID = '20261002-120000-a1b2'
  const ended = [
    { model: 'codex', status: 'DONE', output: 'answer of codex' },
    { model: 'grok', status: 'FAIL:1', output: '' },
  ]

  test('a model that did not end DONE: its reason, else the command that shows the end of its log; report it', () => {
    for (const kind of ['review', 'run', 'ask'] as const) {
      const text = doneMessage(kind, RID, ended)

      expect(text).toContain(
        `## grok(FAIL:1)\nNo result. \`tail -n 20 ~/.claude/mmruns/${RID}/grok.raw | cut -c1-300\` shows the end of its log; report it to the user.`,
      )
      expect(text).not.toContain('mmrun status')
      expect(text).toContain('## codex(DONE)\nanswer of codex')
      expect(doneMessage(kind, RID, [{ model: 'grok', status: 'FAIL:1', output: '', reason: 'rate limited (429)' }])).toContain(
        '## grok(FAIL:1)\nNo result: rate limited (429)',
      )
    }
  })

  describe('a run ends with steps for what each model left', () => {
    const PATCHED = `status: done\npatch: ~/.claude/mmruns/${RID}/codex.patch`
    const NEXT = `Next: read the patch above against the task's acceptance items, then \`mmrun check ${RID} -- <gate command>\`; if it passes, \`mmrun apply ${RID}\` and run the gate again in the main tree; otherwise \`mmrun discard ${RID}\`.`
    const steps = (results: ModelResult[]) => doneMessage('run', RID, results).split('\n\n').at(-1)?.split('\n')

    test('a patch: read it, gate on a clean worktree, apply, gate again, else discard', () => {
      expect(steps([{ model: 'codex', status: 'DONE', output: PATCHED }])).toEqual([NEXT])
    })

    test('no changes, or not DONE: discard removes the worktree', () => {
      expect(
        steps([
          { model: 'codex', status: 'DONE', output: 'status: done\npatch: no changes (no_changes)' },
          { model: 'grok', status: 'FAIL:1', output: '' },
        ]),
      ).toEqual([`- codex: no changes; \`mmrun discard ${RID}\` removes the worktree.`, `- grok: no patch; \`mmrun discard ${RID}\` removes the worktree.`])
    })

    test('not DONE but a patch left: read it before discard', () => {
      const PATCH = `/h/.claude/mmruns/${RID}/grok.patch`

      expect(
        steps([
          { model: 'grok', status: 'FAIL:timeout', output: '', patch: PATCH },
          { model: 'agy', status: 'FAIL:1', output: '' },
        ]),
      ).toEqual([
        `- grok: FAIL:timeout, but it left a patch: ${PATCH}; read it before \`mmrun discard ${RID}\`, which removes the worktree.`,
        `- agy: no patch; \`mmrun discard ${RID}\` removes the worktree.`,
      ])
    })

    test('status: blocked: the questions go to the user', () => {
      expect(steps([{ model: 'codex', status: 'DONE', output: `status: blocked\npatch: ~/.claude/mmruns/${RID}/codex.patch` }])).toEqual([
        NEXT,
        '- status blocked: take the questions to the user; do not guess the answers and delegate again.',
      ])
    })

    test('a model already read keeps its steps', () => {
      expect(steps([{ model: 'codex', status: 'DONE', output: PATCHED }])).toEqual(
        doneMessage('run', RID, [{ model: 'codex', status: 'DONE', output: PATCHED }], ['codex']).split('\n\n').at(-1)?.split('\n'),
      )
    })
  })

  test('a model already read: its section says so instead of the output; the others stay whole', () => {
    const text = doneMessage('ask', RID, [...ended, { model: 'agy', status: 'DONE', output: 'answer of agy' }], ['codex'])

    expect(text).toContain('## codex(DONE)\nYou already read this result.')
    expect(text).not.toContain('answer of codex')
    expect(text).toContain('## agy(DONE)\nanswer of agy')
    expect(text).toContain('## grok(FAIL:1)\nNo result.')
  })

  describe('a review with critical or major findings starts with the judge rules', () => {
    const FOUND = 'verdict: fix\nsummary\n\n## MAJOR\n- **src/a.ts:3** — a race\n\nNot expanded: 0'
    const RULES = [
      'Judge rules:',
      '- Settle each finding by reading the code it points at. Keep only those at confidence 80 or above: you read the code and can name the input that makes it fail. Mention the dropped ones only in one line at the end: `Dropped N low-confidence findings`.',
      '- Drop without scoring: what a linter, typechecker or compiler catches; style with no basis in CLAUDE.md; a generic "consider …" with no file:line. A suggestion to add an abstraction, a config option or a fallback is Optional at most.',
      '- For a diff review, also drop lines this change did not touch and old problems unrelated to it. For a `--full` review keep them: the existing code is what was asked for.',
      '- A finding both models report is high confidence, but still read the code. One that only a single model reports, settle by reading the code yourself: no voting, and do not drop it because the other model did not report it.',
      '- Act only on critical/major.',
      '- Coming back empty-handed is fine: with no finding at 80 or above, say plainly there are no issues; do not pad.',
      '- Do not change the code unless the user asked for it.',
    ]
    const blocks = (text: string) => text.split('\n\n')

    test('the rules come right after the head, before the model sections', () => {
      const text = doneMessage('review', RID, [{ model: 'codex', status: 'DONE', output: FOUND }])

      expect(blocks(text)[1]?.split('\n')).toEqual(RULES)
      expect(blocks(text)[2]?.startsWith('## codex(DONE)\nverdict: fix')).toBe(true)
      expect(text.endsWith('Not expanded: 0')).toBe(true)
    })

    test('a --oneline result with a [critical] or [major] line brings the rules too', () => {
      const oneline = `- src/a.ts:3 [critical] a race\nfull: mmrun result codex ${RID} --top`

      expect(blocks(doneMessage('review', RID, [{ model: 'codex', status: 'DONE', output: oneline }]))[1]?.split('\n')[0]).toBe('Judge rules:')
    })

    test('an exhaustive run: minor/optional are read without --top', () => {
      const lines = blocks(doneMessage('review', RID, [{ model: 'codex', status: 'DONE', output: FOUND }], [], true))[1]?.split('\n')

      expect(lines?.[5]).toBe(
        `- Act only on critical/major. For an --exhaustive run, also read minor/optional: \`mmrun result <model> ${RID}\` without --top.`,
      )
    })

    test('`Not expanded` greater than 0 in some result: the user decides on --exhaustive', () => {
      const lines = blocks(
        doneMessage('review', RID, [
          { model: 'codex', status: 'DONE', output: FOUND },
          { model: 'grok', status: 'DONE', output: 'verdict: ok\nfine\n\nNot expanded: 3' },
        ]),
      )[1]?.split('\n')

      expect(lines).toEqual([
        ...RULES.slice(0, -1),
        '- When the findings show `Not expanded` greater than 0, tell the user and let them decide whether to upgrade to --exhaustive.',
        RULES.at(-1),
      ])
    })

    test('no critical or major finding in any result: one line instead of the rules', () => {
      const text = doneMessage('review', RID, [
        { model: 'codex', status: 'DONE', output: 'verdict: ok\nfine\n\n## MINOR\n- **src/a.ts:3** — a name\n\nNot expanded: 2' },
        { model: 'grok', status: 'FAIL:1', output: '' },
      ])

      expect(blocks(text)[1]).toBe('No critical or major findings: say plainly there are no issues; do not pad.')
      expect(text).not.toContain('Judge rules')
    })
  })

  describe('cutOutputs', () => {
    const BIG = [
      { model: 'codex', status: 'DONE', output: 'c'.repeat(20_000) },
      { model: 'grok', status: 'DONE', output: 'g'.repeat(3_000) },
      { model: 'agy', status: 'FAIL:1', output: '' },
    ]

    test('each shown output gets an equal share of what the head and tail leave, ending with where the whole one is', () => {
      for (const kind of ['review', 'run', 'ask'] as const) {
        const cut = cutOutputs(kind, RID, BIG, [], false, 4_000)
        const text = doneMessage(kind, RID, cut)

        expect(text.length).toBeLessThanOrEqual(4_000)
        expect(cut[0]?.output).toContain(`\n[cut; full: mmrun result codex ${RID}]\n`)
        expect(cut[1]?.output).toContain(`\n[cut; full: mmrun result grok ${RID}]\n`)
        expect(cut[0]?.output.length).toBe(cut[1]?.output.length)
        expect(cut[2]).toEqual(BIG[2])
      }
    })

    test('a cut keeps the head and the tail of an output, where the patch and Not expanded lines are', () => {
      const long = [{ model: 'codex', status: 'DONE', output: `status: done\n${'x'.repeat(20_000)}\npatch: no changes (no_changes)` }]
      const out = cutOutputs('run', RID, long, [], false, 4_000)[0]?.output ?? ''

      expect(out.startsWith('status: done\n')).toBe(true)
      expect(out.endsWith('\npatch: no changes (no_changes)')).toBe(true)
      expect(out).toContain(`[cut; full: mmrun result codex ${RID}]`)
      expect(doneMessage('run', RID, [{ ...long[0]!, output: out }]).length).toBeLessThanOrEqual(4_000)
    })

    test('an output within its share, or one already read, is kept whole', () => {
      const cut = cutOutputs('ask', RID, BIG, ['codex'], false, 4_000)

      expect(cut[0]).toEqual(BIG[0])
      expect(cut[1]).toEqual(BIG[1])
    })
  })

  test('a review where no model ended DONE: no judge rules and no "no issues" line', () => {
    const text = doneMessage('review', RID, [
      { model: 'codex', status: 'FAIL:1', output: '' },
      { model: 'grok', status: 'FAIL:timeout', output: '', reason: 'timeout after 5400 s' },
    ])

    expect(text).not.toContain('Judge rules')
    expect(text).not.toContain('No critical or major findings')
  })

  test('a review whose verification was skipped or failed: its section gives the reason', () => {
    for (const [status, reason] of [
      ['SKIP', 'fewer than 2 models finished'],
      ['FAIL', 'every verifier failed: grok FAIL:1'],
    ] as const) {
      const text = doneMessage('review', RID, [
        { model: 'codex', status: 'DONE', output: 'verdict: approve' },
        { model: 'verify', status, output: '', reason },
      ])

      expect(text).toContain(`## verify(${status})\nNo result: ${reason}`)
    }
  })

  test('an ask run: its own head, each answer, no judge rules or run steps', () => {
    const text = doneMessage('ask', RID, ended)

    expect(text.split('\n')[0]).toBe(`mm plugin: mmrun start/ask run ${RID} has finished`)
    expect(text).toContain('answer of codex')
    expect(text).not.toContain('Judge rules')
    expect(text).not.toContain('Next:')
    expect(text.endsWith('report it to the user.')).toBe(true)
  })
})
