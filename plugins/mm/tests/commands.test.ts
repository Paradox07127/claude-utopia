import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On, SessionStartInput } from 'claude-code'

const NOW = 1_790_922_800_000
const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/r' }
// The engine gives the mod `$.plugin.root` = this plugin's directory, so the mod runs the mmrun shipped in it.
const MMRUN = decodeURIComponent(new URL('../bin/mmrun', (import.meta as { url: string }).url).pathname)
const RID = '20261002-120000-a1b2'
// The session id the engine reports; the watched mark carries it.
const SID = 'sess-a'
const DIR = `/h/.claude/mmruns/${RID}`
const REVIEW_OUT = [
  `RUN ${RID}  models=codex,grok  mode=review  dir=/r`,
  `NEXT  mmrun wait ${RID} --timeout 3600   # \u653e\u540e\u53f0\u8dd1,\u5b8c\u6210\u65f6\u81ea\u52a8\u5524\u9192`,
  `THEN  mmrun result <model> ${RID}`,
  '',
].join('\n')
const CODEX_TOP = '## CRITICAL\n- src/a.ts:3 \u4e24\u4e2a\u5199\u5165\u8def\u5f84\u6ca1\u4e0a\u9501\n\nNot expanded: 2'

type Reply = { exitCode: number; stdout: string; stderr?: string }

const command = (name: string, args = '') => ({
  command: name,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 180 },
})

/** The engine beneath the plugin: mmrun answers from `replies` by argv, run directories hold `files`. */
function seat(on: On) {
  const world = {
    replies: new Map<string, Reply>([[`${MMRUN} review --staged --models codex,grok --dir /r`, { exitCode: 0, stdout: REVIEW_OUT }]]),
    files: new Map<string, string>(),
    // What fs.write last wrote, by path; kept apart from `files` so a mark does not make a run directory exist.
    marks: new Map<string, string>(),
    runs: [] as string[][],
    submitted: [] as string[],
    contexts: [] as string[][],
    nexted: [] as string[],
    logs: [] as { text: string; to: string }[],
    // How long a submitted prompt's turn runs before prompt.submit settles.
    turnMs: 0,
    // Set: every process.run is refused with it.
    processDeny: null as string | null,
    // How many of the next fs.list / fs.read calls fail with EIO, and prompt.submit calls are dropped / throw.
    listFails: 0,
    readFails: 0,
    writeFails: 0,
    submitDrops: 0,
    submitThrows: 0,
    // Set: prompt.submit waits for it before it decides.
    submitHold: null as Promise<void> | null,
    // Set: $.session.id() is refused.
    isIdDenied: false,
  }
  const clock = mock.clock(on, { now: NOW })

  mock.env(on, { HOME: '/h' })
  on('session.root', () => ({ value: '/r' }))
  on('session.id', () => (world.isIdDenied ? { deny: 'no session' } : { value: SID }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.run', ($, e) => {
    world.nexted.push(`${e.command} ${e.args}`)

    return { text: 'markdown command' }
  })
  on('tool.call', ($, e) => {
    const skill = e.tool === 'Skill' ? e.skill : undefined
    const args = e.tool === 'Skill' ? e.args : undefined

    world.nexted.push(`${e.tool} ${String(skill)} ${String(args ?? '')}`)

    return { result: { success: true, commandName: String(skill) } } as never
  })
  on('classic.PostToolUse', () => ({}))
  on('process.run', ($, e) => {
    if (world.processDeny !== null) {
      return { deny: world.processDeny }
    }

    const argv = e.argv.join(' ')
    const reply = world.replies.get(argv) ?? { exitCode: 0, stdout: '' }

    world.runs.push([...e.argv])

    return { value: { exitCode: reply.exitCode, stdout: reply.stdout, stderr: reply.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', ($, e) => {
    if (world.listFails > 0) {
      world.listFails--

      return { deny: `EIO ${e.path}` }
    }

    const names: FsEntry[] = [...world.files.keys()]
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: NOW, isLink: false }))

    return names.length > 0 ? { value: names } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.exists', ($, e) => ({ value: [...world.files.keys()].some(path => path === e.path || path.startsWith(`${e.path}/`)) }))
  on('fs.read', ($, e) => {
    const text = world.files.get(e.path)

    if (world.readFails > 0) {
      world.readFails--

      return { deny: `EIO ${e.path}` }
    }

    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    if (world.writeFails > 0) {
      world.writeFails--

      return { deny: `EACCES ${e.path}` }
    }

    world.marks.set(e.path, e.text)

    return { value: undefined }
  })
  on('prompt.submit', async ($, e) => {
    if (world.submitHold !== null) {
      await world.submitHold
    }

    if (world.submitDrops > 0) {
      world.submitDrops--

      return { drop: 'not now' }
    }

    if (world.submitThrows > 0) {
      world.submitThrows--

      throw new Error('submit refused')
    }

    world.submitted.push(e.text)
    world.contexts.push([...(e.context ?? [])])

    if (world.turnMs > 0) {
      await clock.sleep(world.turnMs)
    }

    return { text: e.text }
  })
  on('classic.Stop', () => ({}))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('ui.log', ($, e) => {
    world.logs.push({ text: e.text, to: e.to })

    return { value: undefined }
  })

  return { world, clock }
}

/** The runs in state `watches`, seen from outside: the ones the next 5 s tick runs `mmrun status` on. */
async function watched(world: ReturnType<typeof seat>['world'], clock: ReturnType<typeof seat>['clock']): Promise<string[]> {
  const from = world.runs.length

  await clock.advance(5_000)

  return world.runs.slice(from).filter(argv => argv[0] === MMRUN && argv[1] === 'status').map(argv => argv[2] ?? '')
}

describe('/mm:review and /mm:run', () => {
  test('options only: mmrun review starts in the session root, the run is watched', async ($, on) => {
    const { world, clock } = seat(on)
    const r = await $.command.run(command('mm:review', '--staged'))

    expect(world.runs[0]).toEqual([MMRUN, 'review', '--staged', '--models', 'codex,grok', '--dir', '/r'])
    expect(r.text).toContain(`RUN ${RID}`)
    expect(r.text).not.toContain('NEXT')
    expect(r.text).not.toContain('THEN')
    expect((r.context ?? []).join('\n')).toContain('do not run `mmrun wait` yourself')
    expect(world.nexted).toEqual([])
    expect(await watched(world, clock)).toEqual([RID])
  })

  test('natural language goes to the markdown command, no mmrun', async ($, on) => {
    const { world } = seat(on)
    const r = await $.command.run(command('mm:review', '看看并发'))

    expect(r.text).toBe('markdown command')
    expect(world.nexted).toEqual(['mm:review 看看并发'])
    expect(world.runs).toEqual([])
  })

  test('/mm:run without --task goes to the markdown command', async ($, on) => {
    const { world } = seat(on)

    await $.command.run(command('mm:run', '--model codex'))
    expect(world.nexted).toEqual(['mm:run --model codex'])
    expect(world.runs).toEqual([])
  })

  test('/mm:run with --model and --task starts mmrun run', async ($, on) => {
    const { world, clock } = seat(on)

    world.replies.set(`${MMRUN} run --model codex --task /tmp/t.md --dir /r`, { exitCode: 0, stdout: `RUN ${RID}  models=codex  mode=run  dir=/r\nNEXT  x\nTHEN  y\n` })

    const r = await $.command.run(command('mm:run', '--model codex --task /tmp/t.md'))

    expect(world.runs[0]).toEqual([MMRUN, 'run', '--model', 'codex', '--task', '/tmp/t.md', '--dir', '/r'])
    expect(r.text).toContain(`RUN ${RID}`)
    expect(world.nexted).toEqual([])
    expect(await watched(world, clock)).toEqual([RID])
  })

  test('reviewModels set: mmrun review gets those models', { options: { reviewModels: 'agy' } }, async ($, on) => {
    const { world } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    expect(world.runs[0]).toEqual([MMRUN, 'review', '--staged', '--models', 'agy', '--dir', '/r'])
  })

  test('--models given by the user wins over reviewModels', async ($, on) => {
    const { world } = seat(on)

    await $.command.run(command('mm:review', '--staged --models grok'))
    expect(world.runs[0]).toEqual([MMRUN, 'review', '--staged', '--models', 'grok', '--dir', '/r'])
  })

  test('--dir given by the user is kept: no session root appended after it', async ($, on) => {
    const { world } = seat(on)

    await $.command.run(command('mm:review', '--staged --dir /other'))
    expect(world.runs[0]).toEqual([MMRUN, 'review', '--staged', '--dir', '/other', '--models', 'codex,grok'])
  })

  test('mmrun failing: its first stderr line, nothing watched', async ($, on) => {
    const { world, clock } = seat(on)

    world.replies.set(`${MMRUN} review --staged --models codex,grok --dir /r`, { exitCode: 1, stdout: '', stderr: 'mmrun: 没有可审的变更\nmore' })

    const r = await $.command.run(command('mm:review', '--staged'))

    expect(r.text).toBe('mmrun review failed: mmrun: 没有可审的变更')
    expect(await watched(world, clock)).toEqual([])
  })
})

const skill = (name: string, args?: string, agentId?: string) => ({
  tool: 'Skill' as const,
  skill: name,
  ...(args !== undefined && { args }),
  ...(agentId !== undefined && { agentId }),
})

/** A main-session Bash call that exited 0, as PostToolUse reports it. */
const bashRan = (command: string, stdout: string, agentId?: string) => ({
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: { stdout, stderr: '', interrupted: false },
  tool_use_id: 'toolu_b',
  cwd: '/r',
  ...(agentId !== undefined && { agent_id: agentId }),
})

describe('the model calling the mm skills', () => {
  test('mm:review with options: mmrun starts, the call answers with the run, the end is handed over', async ($, on) => {
    const { world, clock } = seat(on)
    const r = await $.tool.call(skill('mm:review', '--staged') as never)

    expect(world.runs[0]).toEqual([MMRUN, 'review', '--staged', '--models', 'codex,grok', '--dir', '/r'])
    expect(r.result).toEqual({ success: true, commandName: 'mm:review' })

    const context = (r.context ?? []).join('\n')

    expect(context).toContain(RID)
    expect(context).toContain('do not run `mmrun wait` yourself')
    expect(world.nexted).toEqual([])

    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.files.set(`${DIR}/grok.status`, 'DONE\n')
    await clock.advance(5_000)
    expect(world.submitted.length).toBe(1)
  })

  test('mm:review failing to start: the markdown loads, carrying the failure, nothing watched', async ($, on) => {
    const { world, clock } = seat(on)

    world.replies.set(`${MMRUN} review --staged --models codex,grok --dir /r`, { exitCode: 1, stdout: '', stderr: 'mmrun: 没有可审的变更' })

    const r = await $.tool.call(skill('mm:review', '--staged') as never)

    expect(r.result).toEqual({ success: true, commandName: 'mm:review' })
    expect((r.context ?? []).join('\n')).toContain('mmrun failed to start: mmrun review failed: mmrun: 没有可审的变更')
    expect(world.nexted).toEqual(['Skill mm:review --staged'])
    expect(await watched(world, clock)).toEqual([])
  })

  test('mmrun printing only its RUN, NEXT and THEN lines: the context names the run once, no mmrun output', async ($, on) => {
    const { world } = seat(on)
    const r = await $.tool.call(skill('mm:review', '--staged') as never)
    const context = (r.context ?? []).join('\n')

    expect(context).not.toContain('mmrun output')
    expect(context.split(RID).length).toBe(2)

    world.replies.set(`${MMRUN} review --staged --models codex,grok --dir /r`, { exitCode: 0, stdout: `warning: grok skipped (no key)\n${REVIEW_OUT}` })

    const warned = await $.tool.call(skill('mm:review', '--staged') as never)

    expect((warned.context ?? []).join('\n')).toContain(`mmrun output:\nwarning: grok skipped (no key)\nRUN ${RID}`)
  })

  test('no args or natural language: the skill expands, no mmrun', async ($, on) => {
    const { world } = seat(on)

    await $.tool.call(skill('mm:review') as never)
    await $.tool.call(skill('mm:review', '看看并发') as never)
    expect(world.nexted).toEqual(['Skill mm:review ', 'Skill mm:review 看看并发'])
    expect(world.runs).toEqual([])
  })

  test('mm:run without --task expands', async ($, on) => {
    const { world } = seat(on)

    await $.tool.call(skill('mm:run', '--model codex') as never)
    expect(world.nexted).toEqual(['Skill mm:run --model codex'])
    expect(world.runs).toEqual([])
  })

  test('a subagent calling the skill, or another skill: passed through', async ($, on) => {
    const { world } = seat(on)

    await $.tool.call(skill('mm:review', '--staged', 'agent-1') as never)
    await $.tool.call(skill('commit', '--staged') as never)
    expect(world.nexted).toEqual(['Skill mm:review --staged', 'Skill commit --staged'])
    expect(world.runs).toEqual([])
  })
})

describe('mmrun started through Bash', () => {
  const RID2 = '20261002-130000-beef'
  const OUT2 = `RUN ${RID2}  models=codex,grok  mode=review\n`

  test('a main-session `mmrun review` is watched once, and handed over when done', async ($, on) => {
    const { world, clock } = seat(on)

    await $.classic.PostToolUse(bashRan('mmrun review --staged', OUT2) as never)
    await $.classic.PostToolUse(bashRan('mmrun review --staged', OUT2) as never)
    world.files.set(`/h/.claude/mmruns/${RID2}/codex.status`, 'RUNNING\n')
    expect(await watched(world, clock)).toEqual([RID2])

    world.files.set(`/h/.claude/mmruns/${RID2}/codex.status`, 'DONE\n')
    await clock.advance(5_000)
    await clock.advance(5_000)
    expect(world.submitted.length).toBe(1)
    expect(world.submitted[0]?.split('\n')[0]).toBe(`mm plugin: /mm:review review ${RID2} has finished`)
  })

  test('a subagent, or a command that starts nothing: not watched', async ($, on) => {
    const { world, clock } = seat(on)

    await $.classic.PostToolUse(bashRan('mmrun review --staged', OUT2, 'agent-1') as never)
    await $.classic.PostToolUse(bashRan('mmrun status x', OUT2) as never)
    expect(await watched(world, clock)).toEqual([])
  })

  test('a main-session `mmrun start` or `mmrun ask` is watched, and each answer handed over as `--top` prints it', async ($, on) => {
    const { world, clock } = seat(on)
    const RID3 = '20261002-140000-cafe'

    await $.classic.PostToolUse(bashRan('mmrun start --models codex --dir /r <<< "q"', `RUN ${RID2}  models=codex  mode=ask  dir=/r\n`) as never)
    await $.classic.PostToolUse(bashRan(`mmrun ask grok ${RID2} "and?"`, `RUN ${RID3}  models=grok  mode=ask  dir=/r\n`) as never)
    await $.classic.PostToolUse(bashRan('mmrun ask grok x "q"', OUT2, 'agent-1') as never)
    world.files.set(`/h/.claude/mmruns/${RID2}/codex.status`, 'RUNNING\n')
    world.files.set(`/h/.claude/mmruns/${RID3}/grok.status`, 'RUNNING\n')
    expect(await watched(world, clock)).toEqual([RID2, RID3])

    world.files.set(`/h/.claude/mmruns/${RID2}/codex.status`, 'DONE\n')
    world.replies.set(`${MMRUN} result codex ${RID2} --top`, { exitCode: 0, stdout: 'the compact answer\n' })
    await clock.advance(5_000)
    expect(world.submitted.length).toBe(1)

    const text = world.submitted[0] ?? ''

    expect(text.split('\n')[0]).toBe(`mm plugin: mmrun start/ask run ${RID2} has finished`)
    expect(text).toContain('## codex(DONE)\nthe compact answer')
    expect(text).not.toContain('Judge rules')
    expect(await watched(world, clock)).toEqual([RID3])
  })

  test('one command starting several runs: each RUN line is watched, its kind from its mode', async ($, on) => {
    const { world, clock } = seat(on)
    const RID3 = '20261002-140000-cafe'

    await $.classic.PostToolUse(
      bashRan('for t in a b; do mmrun review --staged; done', `RUN ${RID2}  models=codex  mode=review  dir=/r\nRUN ${RID3}  models=codex  mode=run  dir=/r\n`) as never,
    )
    world.files.set(`/h/.claude/mmruns/${RID2}/codex.status`, 'RUNNING\n')
    world.files.set(`/h/.claude/mmruns/${RID3}/codex.status`, 'RUNNING\n')
    expect(await watched(world, clock)).toEqual([RID2, RID3])

    world.files.set(`/h/.claude/mmruns/${RID2}/codex.status`, 'DONE\n')
    world.files.set(`/h/.claude/mmruns/${RID3}/codex.status`, 'DONE\n')
    await clock.advance(5_000)
    expect(world.submitted.map(text => text.split('\n')[0]).sort()).toEqual([
      `mm plugin: /mm:review review ${RID2} has finished`,
      `mm plugin: /mm:run run ${RID3} has finished`,
    ])
  })

  test('`mmrun ask --from` a delegated run: watched as a run', async ($, on) => {
    const { world, clock } = seat(on)

    await $.classic.PostToolUse(bashRan(`mmrun ask codex --from ${RID} "go on"`, `RUN ${RID2}  models=codex  mode=run  dir=/r\n`) as never)
    world.files.set(`/h/.claude/mmruns/${RID2}/codex.status`, 'DONE\n')
    await clock.advance(5_000)
    expect(world.submitted.map(text => text.split('\n')[0])).toEqual([`mm plugin: /mm:run run ${RID2} has finished`])
    expect(world.runs.filter(argv => argv[1] === 'result')).toEqual([[MMRUN, 'result', 'codex', RID2]])
  })
})

describe('watching a run', () => {
  test('when every model has ended, the conclusions go to the model once', async ($, on) => {
    const { world, clock } = seat(on)

    await $.session.start(SESSION)
    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'RUNNING\n')
    world.files.set(`${DIR}/grok.status`, 'RUNNING\n')
    world.files.set(`${DIR}/run.meta`, `runid=${RID}\ntag=review:worktree:brief\nmodels=codex,grok\n`)
    expect(await watched(world, clock)).toEqual([RID])
    expect(world.submitted).toEqual([])

    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.files.set(`${DIR}/grok.status`, 'FAIL:1\n')
    world.replies.set(`${MMRUN} result codex ${RID} --top`, { exitCode: 0, stdout: `${CODEX_TOP}\n` })
    await clock.advance(5_000)

    expect(world.submitted.length).toBe(1)

    const text = world.submitted[0] ?? ''

    expect(text.split('\n')[0]).toBe(`mm plugin: /mm:review review ${RID} has finished`)
    expect(text).toContain('## codex(DONE)')
    expect(text).toContain('## grok(FAIL:1)')
    expect(text).toContain(CODEX_TOP)
    expect(text).toContain(`\`tail -n 20 ~/.claude/mmruns/${RID}/grok.raw | cut -c1-300\``)
    expect(text).toContain('confidence 80 or above')
    expect(text).toContain('no voting')
    expect(text).toContain('`Not expanded`')
    expect(text).not.toContain('--exhaustive run')
    expect(text.indexOf('Judge rules:')).toBeLessThan(text.indexOf('## codex(DONE)'))
    expect(world.runs.some(argv => argv.join(' ').startsWith(`${MMRUN} result grok`))).toBe(false)
    expect(await watched(world, clock)).toEqual([])

    await clock.advance(15_000)
    expect(world.submitted.length).toBe(1)
  })

  test('a model that failed with a reason: its section gives the reason', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.files.set(`${DIR}/grok.status`, 'FAIL:1\n')
    world.files.set(`${DIR}/grok.reason`, 'rate limited (429)\n')
    await clock.advance(5_000)
    expect(world.submitted[0]).toContain('## grok(FAIL:1)\nNo result: rate limited (429)')
    expect(world.submitted[0]).not.toContain('grok.raw')
  })

  test('a run model that failed but left a patch: the steps name the patch to read before discard', async ($, on) => {
    const { world, clock } = seat(on)
    const RID2 = '20261002-130000-beef'
    const RUN_DIR = `/h/.claude/mmruns/${RID2}`

    await $.classic.PostToolUse(bashRan('mmrun run --model codex,grok', `RUN ${RID2}  models=codex,grok  mode=run  dir=/r\n`) as never)
    world.files.set(`${RUN_DIR}/codex.status`, 'FAIL:timeout\n')
    world.files.set(`${RUN_DIR}/codex.patch`, 'diff --git a/x b/x\n')
    world.files.set(`${RUN_DIR}/grok.status`, 'FAIL:1\n')
    world.files.set(`${RUN_DIR}/grok.patch`, '\n')
    await clock.advance(5_000)

    const text = world.submitted[0] ?? ''

    expect(text).toContain(`- codex: FAIL:timeout, but it left a patch: ${RUN_DIR}/codex.patch; read it before \`mmrun discard ${RID2}\``)
    expect(text).toContain(`- grok: no patch; \`mmrun discard ${RID2}\` removes the worktree.`)
  })

  for (const tag of ['review:worktree:full', 'review:full:exhaustive']) {
    test(`an exhaustive review (tag ${tag}): minor/optional are read without --top`, async ($, on) => {
      const { world, clock } = seat(on)

      await $.command.run(command('mm:review', '--staged'))
      world.files.set(`${DIR}/run.meta`, `runid=${RID}\ntag=${tag}\nmodels=codex\n`)
      world.files.set(`${DIR}/codex.status`, 'DONE\n')
      world.replies.set(`${MMRUN} result codex ${RID} --top`, { exitCode: 0, stdout: `${CODEX_TOP}\n` })
      await clock.advance(5_000)
      expect(world.submitted[0]).toContain(`For an --exhaustive run, also read minor/optional: \`mmrun result <model> ${RID}\` without --top.`)
    })
  }

  test('a review with no critical or major finding: one line instead of the judge rules', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.replies.set(`${MMRUN} result codex ${RID} --top`, { exitCode: 0, stdout: 'verdict: ok\nfine\n\nNot expanded: 0\n' })
    await clock.advance(5_000)
    expect(world.submitted[0]).toContain('No critical or major findings: say plainly there are no issues; do not pad.')
    expect(world.submitted[0]).not.toContain('Judge rules')
  })

  test('a review message over 16000 characters is rebuilt from `--top --oneline`', async ($, on) => {
    const { world, clock } = seat(on)
    const ONELINE = `- src/a.ts:3 [critical] a race\nfull: mmrun result codex ${RID} --top`

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.files.set(`${DIR}/grok.status`, 'DONE\n')
    world.replies.set(`${MMRUN} result codex ${RID} --top`, { exitCode: 0, stdout: `## CRITICAL\n${'x'.repeat(20_000)}\n` })
    world.replies.set(`${MMRUN} result codex ${RID} --top --oneline`, { exitCode: 0, stdout: `${ONELINE}\n` })
    world.replies.set(`${MMRUN} result grok ${RID} --top`, { exitCode: 0, stdout: 'verdict: ok\nfine\n' })
    world.replies.set(`${MMRUN} result grok ${RID} --top --oneline`, { exitCode: 0, stdout: `full: mmrun result grok ${RID} --top\n` })
    await clock.advance(5_000)

    const text = world.submitted[0] ?? ''

    expect(text.length).toBeLessThanOrEqual(16_000)
    expect(text).toContain(`## codex(DONE)\n${ONELINE}`)
    expect(text).toContain(`## grok(DONE)\nfull: mmrun result grok ${RID} --top`)
    expect(text).toContain('Judge rules:')
    expect(text).not.toContain('[cut;')
  })

  test('a review still over 16000 characters under --oneline: each output cut to an equal share, saying where the whole one is', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.files.set(`${DIR}/grok.status`, 'DONE\n')

    for (const model of ['codex', 'grok']) {
      world.replies.set(`${MMRUN} result ${model} ${RID} --top`, { exitCode: 0, stdout: `## MAJOR\n${'x'.repeat(20_000)}\n` })
      world.replies.set(`${MMRUN} result ${model} ${RID} --top --oneline`, { exitCode: 0, stdout: `- src/a.ts:3 [major] a race\n${'y'.repeat(20_000)}\n` })
    }

    await clock.advance(5_000)

    const text = world.submitted[0] ?? ''

    expect(text.length).toBeLessThanOrEqual(16_000)
    expect(text).toContain(`## codex(DONE)\n- src/a.ts:3 [major] a race\nyyy`)
    expect(text).toContain(`\n[cut; full: mmrun result codex ${RID}]\nyyy`)
    expect(text).toContain(`yyy\n\n## grok(DONE)`)
    expect(text).toContain(`\n[cut; full: mmrun result grok ${RID}]\nyyy`)
    expect(text.endsWith('yyy')).toBe(true)
  })

  test('a run message over 16000 characters is cut without --oneline; a read rebuilds it from the cut outputs', async ($, on) => {
    const { world, clock } = seat(on)
    const RID2 = '20261002-130000-beef'
    const RUN_DIR = `/h/.claude/mmruns/${RID2}`

    await $.classic.PostToolUse(bashRan('mmrun run --model codex,grok', `RUN ${RID2}  models=codex,grok  mode=run  dir=/r\n`) as never)
    await $.prompt.submit(PROMPT('go'))
    world.files.set(`${RUN_DIR}/codex.status`, 'DONE\n')
    world.files.set(`${RUN_DIR}/grok.status`, 'DONE\n')
    world.replies.set(`${MMRUN} result codex ${RID2}`, { exitCode: 0, stdout: `status: done\n${'c'.repeat(30_000)}\n` })
    world.replies.set(`${MMRUN} result grok ${RID2}`, { exitCode: 0, stdout: `status: done\n${'g'.repeat(30_000)}\n` })
    await clock.advance(5_000)
    await $.classic.PostToolUse(bashRan(`mmrun result codex ${RID2}`, 'whole\n') as never)
    await $.prompt.submit(PROMPT('and now?'))

    const context = (world.contexts[1] ?? []).join('\n')

    expect(world.runs.some(argv => argv.includes('--oneline') || argv.includes('--top'))).toBe(false)
    expect(context.length).toBeLessThan(16_000)
    expect(context).toContain('## codex(DONE)\nYou already read this result.')
    expect(context).toContain(`## grok(DONE)\nstatus: done\nggg`)
    expect(context).toContain(`\n[cut; full: mmrun result grok ${RID2}]`)
  })

  test('a run directory that is gone: the watch is dropped, nothing sent', async ($, on) => {
    const { world, clock } = seat(on)

    await $.session.start(SESSION)
    await $.command.run(command('mm:review', '--staged'))
    expect(await watched(world, clock)).toEqual([RID])
    expect(await watched(world, clock)).toEqual([])
    expect(world.submitted).toEqual([])
  })

  test('a listing that fails while the directory is there: the watch stays, the next tick hands the end over', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.listFails = 1
    expect(await watched(world, clock)).toEqual([RID])
    expect(world.submitted).toEqual([])

    await clock.advance(5_000)
    expect(world.submitted.map(text => text.split('\n')[0])).toEqual([`mm plugin: /mm:review review ${RID} has finished`])
  })

  test('a status file that cannot be read is not an end: the next tick reads it', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'RUNNING\n')
    world.readFails = 1
    expect(await watched(world, clock)).toEqual([RID])
    expect(world.submitted).toEqual([])

    expect(await watched(world, clock)).toEqual([RID])
    expect(world.submitted).toEqual([])
  })

  test('a failed `mmrun result` is read again next tick', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.replies.set(`${MMRUN} result codex ${RID} --top`, { exitCode: 1, stdout: '', stderr: 'mmrun: locked' })
    await clock.advance(5_000)
    expect(world.submitted).toEqual([])

    world.replies.set(`${MMRUN} result codex ${RID} --top`, { exitCode: 0, stdout: `${CODEX_TOP}\n` })
    await clock.advance(5_000)
    expect(world.submitted.length).toBe(1)
    expect(world.submitted[0]).toContain(CODEX_TOP)
    expect(world.submitted[0]).not.toContain('mmrun: locked')
  })

  test('`mmrun result` failing three ticks running: the end says the result could not be read', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.replies.set(`${MMRUN} result codex ${RID} --top`, { exitCode: 1, stdout: '', stderr: 'mmrun: locked\nmore' })
    await clock.advance(5_000)
    await clock.advance(5_000)
    expect(world.submitted).toEqual([])

    await clock.advance(5_000)
    expect(world.submitted.length).toBe(1)
    expect(world.submitted[0]).toContain(`could not read the result of codex in ${RID}`)
    expect(world.submitted[0]).toContain('mmrun: locked')
    expect(await watched(world, clock)).toEqual([])
  })
})

const PROMPT = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never
const stopped = (backgroundTasks: number) =>
  ({
    stop_hook_active: false,
    background_tasks: Array.from({ length: backgroundTasks }, (_, i) => ({ id: `b${i}`, type: 'shell', status: 'running', description: 'sleep 600' })),
  }) as never
const HEAD = `mm plugin: /mm:review review ${RID} has finished`

describe('handing the end of a run over', () => {
  test('a turn running on the handed-over prompt does not hold up the next poll', async ($, on) => {
    const { world, clock } = seat(on)
    const RID2 = '20261002-130000-beef'

    world.turnMs = 60_000
    await $.command.run(command('mm:review', '--staged'))
    await $.classic.PostToolUse(bashRan('mmrun review --staged', `RUN ${RID2}  models=codex  mode=review\n`) as never)
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.files.set(`/h/.claude/mmruns/${RID2}/codex.status`, 'RUNNING\n')
    await clock.advance(5_000)
    expect(world.submitted.map(text => text.split('\n')[0])).toEqual([HEAD])
    expect(await watched(world, clock)).toEqual([RID2])
    await clock.advance(60_000)
  })

  test('a main-thread Stop with background tasks holds the result until a Stop without them', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    await $.classic.Stop(stopped(1))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    await clock.advance(5_000)
    expect(world.submitted).toEqual([])

    await $.classic.Stop(stopped(0))
    await clock.advance(5_000)
    expect(world.logs).toEqual([])
    expect(world.submitted.map(text => text.split('\n')[0])).toEqual([HEAD])
    await clock.advance(15_000)
    expect(world.submitted.length).toBe(1)
  })

  test('a prompt entering while the result waits carries it as context, and it is handed over once', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    await $.prompt.submit(PROMPT('go'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.replies.set(`${MMRUN} result codex ${RID} --top`, { exitCode: 0, stdout: `${CODEX_TOP}\n` })
    await clock.advance(5_000)
    expect(world.submitted).toEqual(['go'])

    await $.prompt.submit(PROMPT('and now?'))
    expect(world.submitted).toEqual(['go', 'and now?'])

    const context = (world.contexts[1] ?? []).join('\n')

    expect(context.split('\n')[0]).toBe(HEAD)
    expect(context).toContain(CODEX_TOP)

    await $.classic.Stop(stopped(0))
    await clock.advance(15_000)
    expect(world.submitted).toEqual(['go', 'and now?'])
    expect(world.contexts.flat().filter(text => text.includes(HEAD)).length).toBe(1)
  })

  test('results that together pass 32000 characters: a prompt takes them whole in order, the rest ride the next one', async ($, on) => {
    const { world, clock } = seat(on)
    const RIDS = ['20261002-130000-0001', '20261002-130000-0002', '20261002-130000-0003']

    for (const rid of RIDS) {
      await $.classic.PostToolUse(bashRan('mmrun run --model codex', `RUN ${rid}  models=codex  mode=run  dir=/r\n`) as never)
      world.replies.set(`${MMRUN} result codex ${rid}`, { exitCode: 0, stdout: `status: done\n${'x'.repeat(12_000)}\n` })
    }

    await $.prompt.submit(PROMPT('go'))

    for (const rid of RIDS) {
      world.files.set(`/h/.claude/mmruns/${rid}/codex.status`, 'DONE\n')
    }

    await clock.advance(5_000)
    await $.prompt.submit(PROMPT('and now?'))

    const first = (world.contexts[1] ?? []).join('\n')

    expect(first.length).toBeLessThanOrEqual(32_000)
    expect(first).toContain(`mm plugin: /mm:run run ${RIDS[0]} has finished`)
    expect(first).toContain(`mm plugin: /mm:run run ${RIDS[1]} has finished`)
    expect(first).not.toContain(RIDS[2])
    expect(first).toContain(`x\n\nNext: read the patch above`)
    expect(world.marks.get(`/h/.claude/mmruns/${RIDS[2]}/watched`)).toBe(`watched ${SID}\n`)

    await $.prompt.submit(PROMPT('more'))
    expect((world.contexts[2] ?? []).join('\n').split('\n')[0]).toBe(`mm plugin: /mm:run run ${RIDS[2]} has finished`)
  })

  test('a result waiting for its hand-over stays in state, so a reload keeps it', async ($, on) => {
    const { world, clock } = seat(on)
    let value: { rid: string; message?: string }[] | undefined

    on('state.set', async ($, e, next) => {
      if (e.plugin === 'mm' && e.key === 'watches') {
        value = e.value as typeof value
      }

      return next(e)
    })
    await $.command.run(command('mm:review', '--staged'))
    await $.prompt.submit(PROMPT('go'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    await clock.advance(5_000)

    expect(value?.map(one => [one.rid, one.message?.split('\n')[0]])).toEqual([[RID, HEAD]])
    expect(await watched(world, clock)).toEqual([])
  })

  test('an interrupted turn with no Stop lets the next poll hand the result over', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    await $.prompt.submit(PROMPT('go'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    await clock.advance(5_000)
    expect(world.submitted).toEqual(['go'])

    await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: true, turnId: 't', reason: 'aborted' } as never)
    await clock.advance(5_000)
    expect(world.submitted.map(text => text.split('\n')[0])).toEqual(['go', HEAD])
  })

  test('two prompts entering at once: the waiting result rides one of them', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    await $.prompt.submit(PROMPT('go'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    await clock.advance(5_000)
    await Promise.all([$.prompt.submit(PROMPT('a')), $.prompt.submit(PROMPT('b'))])
    expect(world.contexts.flat().filter(text => text.includes(HEAD)).length).toBe(1)
  })

  test('a result queued while a prompt takes the waiting ones is kept and handed over once', async ($, on) => {
    const { world, clock } = seat(on)
    const RID2 = '20261002-130000-beef'
    const HEAD2 = `mm plugin: /mm:review review ${RID2} has finished`
    let isArmed = false

    // The poll that queues RID2's result runs right after the prompt's hook read the waiting ones.
    on('state.get', async ($, e, next) => {
      const r = await next(e)

      if (isArmed && e.plugin === 'mm' && e.key === 'watches') {
        isArmed = false
        await clock.advance(5_000)
      }

      return r
    })
    await $.command.run(command('mm:review', '--staged'))
    await $.classic.PostToolUse(bashRan('mmrun review --staged', `RUN ${RID2}  models=codex  mode=review\n`) as never)
    world.files.set(`/h/.claude/mmruns/${RID2}/codex.status`, 'RUNNING\n')
    await $.prompt.submit(PROMPT('go'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    await clock.advance(5_000)
    world.files.set(`/h/.claude/mmruns/${RID2}/codex.status`, 'DONE\n')
    isArmed = true
    await $.prompt.submit(PROMPT('and now?'))
    await $.classic.Stop(stopped(0))
    await clock.advance(5_000)

    const seen = [...world.submitted, ...world.contexts.flat()]

    expect(seen.filter(text => text.includes(HEAD)).length).toBe(1)
    expect(seen.filter(text => text.includes(HEAD2)).length).toBe(1)
  })

  test('a submit dropped or refused keeps the result, and a later poll hands it over once', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.submitDrops = 1
    await clock.advance(5_000)
    expect(world.submitted).toEqual([])

    world.submitThrows = 1
    await clock.advance(5_000)
    expect(world.submitted).toEqual([])
    expect(world.logs.map(one => one.to)).toEqual(['debug'])
    expect(world.logs[0]?.text).toContain('mm: submitting a finished run failed')

    await clock.advance(5_000)
    expect(world.submitted.map(text => text.split('\n')[0])).toEqual([HEAD])
    await clock.advance(15_000)
    expect(world.submitted.length).toBe(1)
  })

  test('a prompt that is dropped leaves the result for the next prompt', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    await $.prompt.submit(PROMPT('go'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    await clock.advance(5_000)
    world.submitDrops = 1
    await $.prompt.submit(PROMPT('dropped'))
    await $.prompt.submit(PROMPT('and now?'))
    expect(world.submitted).toEqual(['go', 'and now?'])
    expect((world.contexts[1] ?? []).join('\n').split('\n')[0]).toBe(HEAD)
  })
})

describe('a result the model already read', () => {
  const RID2 = '20261002-130000-beef'
  const RUN_DIR = `/h/.claude/mmruns/${RID2}`

  /** A main-session `mmrun start` of codex and grok, both still running. */
  async function started($: Engine, on: On) {
    const seated = seat(on)

    await $.classic.PostToolUse(bashRan('mmrun start --models codex,grok --dir /r <<< "q"', `RUN ${RID2}  models=codex,grok  mode=start  dir=/r\n`) as never)
    seated.world.files.set(`${RUN_DIR}/codex.status`, 'RUNNING\n')
    seated.world.files.set(`${RUN_DIR}/grok.status`, 'RUNNING\n')
    seated.world.replies.set(`${MMRUN} result codex ${RID2} --top`, { exitCode: 0, stdout: 'answer of codex\n' })
    seated.world.replies.set(`${MMRUN} result grok ${RID2} --top`, { exitCode: 0, stdout: 'answer of grok\n' })

    return seated
  }

  test('read after its model ended: the end says so instead of the output', async ($, on) => {
    const { world, clock } = await started($, on)

    world.files.set(`${RUN_DIR}/codex.status`, 'DONE\n')
    await $.classic.PostToolUse(bashRan(`mmrun result codex ${RID2}`, 'answer of codex\n') as never)
    world.files.set(`${RUN_DIR}/grok.status`, 'DONE\n')
    await clock.advance(5_000)
    expect(world.submitted.length).toBe(1)

    const text = world.submitted[0] ?? ''

    expect(text).toContain('## codex(DONE)\nYou already read this result.')
    expect(text).not.toContain('answer of codex')
    expect(text).toContain('## grok(DONE)\nanswer of grok')
  })

  test('read while its model runs: the end carries the whole output', async ($, on) => {
    const { world, clock } = await started($, on)

    await $.classic.PostToolUse(bashRan(`mmrun result codex ${RID2}`, 'partial\n') as never)
    world.files.set(`${RUN_DIR}/codex.status`, 'DONE\n')
    world.files.set(`${RUN_DIR}/grok.status`, 'DONE\n')
    await clock.advance(5_000)
    expect(world.submitted[0]).toContain('## codex(DONE)\nanswer of codex')
  })

  test('read after the end was built but before it was handed over: the end is rebuilt', async ($, on) => {
    const { world, clock } = await started($, on)

    await $.prompt.submit(PROMPT('go'))
    world.files.set(`${RUN_DIR}/codex.status`, 'DONE\n')
    world.files.set(`${RUN_DIR}/grok.status`, 'DONE\n')
    await clock.advance(5_000)
    expect(world.submitted).toEqual(['go'])

    await $.classic.PostToolUse(bashRan(`cat ~/.claude/mmruns/${RID2}/codex.out`, 'answer of codex\n') as never)
    await $.prompt.submit(PROMPT('and now?'))

    const context = (world.contexts[1] ?? []).join('\n')

    expect(context).toContain('## codex(DONE)\nYou already read this result.')
    expect(context).not.toContain('answer of codex')
    expect(context).toContain('## grok(DONE)\nanswer of grok')
  })

  test('a read of another run, in a command that also names this one, marks nothing here', async ($, on) => {
    const { world, clock } = await started($, on)

    world.files.set(`${RUN_DIR}/codex.status`, 'DONE\n')
    await $.classic.PostToolUse(bashRan(`mmrun result codex 20261002-140000-cafe; mmrun status ${RID2}`, 'other\n') as never)
    world.files.set(`${RUN_DIR}/grok.status`, 'DONE\n')
    await clock.advance(5_000)
    expect(world.submitted[0]).toContain('## codex(DONE)\nanswer of codex')
  })

  test('`mmrun report -o` prints only the file it wrote, so it marks nothing', async ($, on) => {
    const { world, clock } = await started($, on)

    world.files.set(`${RUN_DIR}/codex.status`, 'DONE\n')
    world.files.set(`${RUN_DIR}/grok.status`, 'DONE\n')
    await $.prompt.submit(PROMPT('go'))
    await clock.advance(5_000)
    await $.classic.PostToolUse(bashRan(`mmrun report ${RID2} -o /tmp/x.md && mmrun report ${RID2} --out=/tmp/y.md`, '/tmp/x.md\n') as never)
    await $.prompt.submit(PROMPT('and now?'))

    const context = (world.contexts[1] ?? []).join('\n')

    expect(context).toContain('## codex(DONE)\nanswer of codex')
    expect(context).toContain('## grok(DONE)\nanswer of grok')
  })

  test('a read naming no run reads the latest run started', async ($, on) => {
    const { world, clock } = await started($, on)
    const RID3 = '20261002-140000-cafe'

    await $.classic.PostToolUse(bashRan('mmrun start --models codex --dir /r <<< "q2"', `RUN ${RID3}  models=codex  mode=start  dir=/r\n`) as never)
    world.files.set(`/h/.claude/mmruns/${RID3}/codex.status`, 'DONE\n')
    world.replies.set(`${MMRUN} result codex ${RID3} --top`, { exitCode: 0, stdout: 'answer of codex 3\n' })
    world.files.set(`${RUN_DIR}/codex.status`, 'DONE\n')
    world.files.set(`${RUN_DIR}/grok.status`, 'DONE\n')
    await $.prompt.submit(PROMPT('go'))
    await clock.advance(5_000)
    await $.classic.PostToolUse(bashRan('mmrun result codex', 'answer of codex 3\n') as never)
    await $.prompt.submit(PROMPT('and now?'))

    const context = (world.contexts[1] ?? []).join('\n')

    expect(context).toContain(`run ${RID3} has finished\n\n## codex(DONE)\nYou already read this result.`)
    expect(context).toContain(`run ${RID2} has finished\n\n## codex(DONE)\nanswer of codex`)
  })

  test('a read by a subagent changes nothing', async ($, on) => {
    const { world, clock } = await started($, on)

    world.files.set(`${RUN_DIR}/codex.status`, 'DONE\n')
    await $.classic.PostToolUse(bashRan(`mmrun result codex ${RID2}`, 'answer of codex\n', 'agent-1') as never)
    world.files.set(`${RUN_DIR}/grok.status`, 'DONE\n')
    await clock.advance(5_000)
    expect(world.submitted[0]).toContain('## codex(DONE)\nanswer of codex')
  })
})

describe('a run still running at 60 minutes', () => {
  const HOUR = 60 * 60_000
  const REMINDER = `mm plugin: run ${RID} has run for 60 minutes; still running: codex. mmrun ends a model on its own at 90 minutes. To stop it now: mmrun cancel ${RID}.`

  test('one reminder naming the run and the models still running rides the next prompt; an idle session is not woken', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'RUNNING\n')
    world.files.set(`${DIR}/grok.status`, 'DONE\n')
    await clock.advance(HOUR)
    await clock.advance(5_000)
    expect(world.submitted).toEqual([])

    await $.prompt.submit(PROMPT('go'))
    await $.prompt.submit(PROMPT('and now?'))
    expect(world.submitted).toEqual(['go', 'and now?'])
    expect(world.contexts).toEqual([[REMINDER], []])
  })

  test('short of 60 minutes: no reminder', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'RUNNING\n')
    await clock.advance(HOUR - 5_000)
    expect(world.submitted).toEqual([])
  })

  test('a busy main thread: the reminder is not submitted, the next prompt carries it', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'RUNNING\n')
    await $.prompt.submit(PROMPT('go'))
    await clock.advance(HOUR)
    expect(world.submitted).toEqual(['go'])

    await $.prompt.submit(PROMPT('and now?'))
    expect(world.submitted).toEqual(['go', 'and now?'])
    expect(world.contexts[1]).toEqual([REMINDER])

    await $.classic.Stop(stopped(0))
    await clock.advance(15_000)
    expect(world.submitted).toEqual(['go', 'and now?'])
  })

  test('a dropped prompt keeps the reminder for the next prompt', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'RUNNING\n')
    await clock.advance(HOUR)
    world.submitDrops = 1
    await $.prompt.submit(PROMPT('dropped'))
    await $.prompt.submit(PROMPT('go'))
    expect(world.submitted).toEqual(['go'])
    expect(world.contexts).toEqual([[REMINDER]])
  })

  test('the reminder leaves the mark and the watch alone; the end is handed over later as usual', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'RUNNING\n')
    await clock.advance(HOUR)
    expect(world.submitted).toEqual([])
    expect(world.marks.get(`${DIR}/watched`)).toBe(`watched ${SID}\n`)
    expect(await watched(world, clock)).toEqual([RID])

    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    await clock.advance(5_000)
    expect(world.submitted.map(text => text.split('\n')[0])).toEqual([HEAD])
    expect(world.marks.get(`${DIR}/watched`)).toBe('')
  })
})

describe('the session ending', () => {
  const RID2 = '20261002-130000-beef'
  const ended = (reason: string) => ({ reason, sessionId: 's1', resume: { id: 's1' } }) as never

  /** Two watches: RID still running, RID2 ended with its message waiting behind a busy main thread. */
  async function twoWatches($: Engine, world: ReturnType<typeof seat>['world'], clock: ReturnType<typeof seat>['clock']) {
    await $.command.run(command('mm:review', '--staged'))
    await $.classic.PostToolUse(bashRan('mmrun review --staged', `RUN ${RID2}  models=codex  mode=review\n`) as never)
    world.files.set(`${DIR}/codex.status`, 'RUNNING\n')
    world.files.set(`/h/.claude/mmruns/${RID2}/codex.status`, 'DONE\n')
    await $.prompt.submit(PROMPT('go'))
    await clock.advance(5_000)
    expect(world.submitted).toEqual(['go'])
  }

  test('/clear hands nothing over and leaves the runs running', async ($, on) => {
    const { world, clock } = seat(on)

    await twoWatches($, world, clock)

    const from = world.runs.length

    await $.session.end(ended('clear'))
    expect(world.runs.slice(from)).toEqual([])

    await $.classic.Stop(stopped(0))
    expect(await watched(world, clock)).toEqual([])
    await clock.advance(15_000)
    expect(world.submitted).toEqual(['go'])
  })

  test('a submit dropped after /clear does not put its run back', async ($, on) => {
    const { world, clock } = seat(on)
    let release = () => {}

    await twoWatches($, world, clock)
    world.submitHold = new Promise(resolve => (release = resolve))
    await $.classic.Stop(stopped(0))
    await clock.advance(5_000)
    await $.session.end(ended('clear'))
    world.submitDrops = 1
    release()
    await clock.advance(15_000)
    expect(await watched(world, clock)).toEqual([])
    expect(world.submitted).toEqual(['go'])
    await $.prompt.submit(PROMPT('next'))
    expect(world.contexts.at(-1)).toEqual([])
  })

  test('any other end cancels nothing and keeps the watches', async ($, on) => {
    const { world, clock } = seat(on)

    await twoWatches($, world, clock)
    await $.session.end(ended('other'))
    await $.session.end(ended('prompt_input_exit'))
    expect(world.runs.some(argv => argv[1] === 'cancel')).toBe(false)
    expect(await watched(world, clock)).toEqual([RID])

    await $.classic.Stop(stopped(0))
    await clock.advance(5_000)
    expect(world.submitted.map(text => text.split('\n')[0])).toEqual(['go', `mm plugin: /mm:review review ${RID2} has finished`])
  })
})

describe('a hook that fails', () => {
  test('logs one debug line, and the command goes to the markdown command', async ($, on) => {
    const { world } = seat(on)

    world.processDeny = 'mmrun missing'

    const r = await $.command.run(command('mm:review', '--staged'))

    expect(r.text).toBe('markdown command')
    expect(world.logs.length).toBe(1)
    expect(world.logs[0]?.to).toBe('debug')
    expect(world.logs[0]?.text).toContain('mm: command.run')
    expect(world.logs[0]?.text).toContain('mmrun missing')
  })

  test('mmrun started but its watch could not be written: no markdown, the run is reported and watched later', async ($, on) => {
    const { world, clock } = seat(on)
    let setFails = 1

    on('state.set', async ($, e, next) => {
      if (e.plugin === 'mm' && setFails > 0) {
        setFails--

        return { deny: 'disk full' } as never
      }

      return next(e)
    })

    const r = await $.command.run(command('mm:review', '--staged'))

    expect(world.nexted).toEqual([])
    expect(r.text).toContain(`RUN ${RID}`)
    expect((r.context ?? []).join('\n')).toContain(RID)
    expect(world.runs.filter(argv => argv[1] === 'review').length).toBe(1)
    expect(await watched(world, clock)).toEqual([RID])
  })

  test('a poll that fails logs one debug line, and the next poll runs', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    world.processDeny = 'mmrun gone'
    await clock.advance(5_000)
    expect(world.logs.map(one => one.to)).toEqual(['debug'])
    expect(world.logs[0]?.text).toContain('mmrun gone')

    world.processDeny = null
    expect(await watched(world, clock)).toEqual([RID])
  })
})

describe('the watched mark', () => {
  const MARK = `${DIR}/watched`

  test('a run started by /mm:review is marked watched, and the mark is emptied once its end is handed over', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    expect(world.marks.get(MARK)).toBe(`watched ${SID}\n`)

    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    await clock.advance(5_000)
    expect(world.submitted.length).toBe(1)
    expect(world.marks.get(MARK)).toBe('')
  })

  test('a run started through Bash is marked; an end riding a prompt empties the mark, a dropped one keeps it', async ($, on) => {
    const { world, clock } = seat(on)

    await $.classic.PostToolUse(bashRan('mmrun start --models codex', `RUN ${RID}  models=codex  mode=ask\n`) as never)
    expect(world.marks.get(MARK)).toBe(`watched ${SID}\n`)

    await $.prompt.submit(PROMPT('go'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    await clock.advance(5_000)
    world.submitDrops = 1
    await $.prompt.submit(PROMPT('dropped'))
    expect(world.marks.get(MARK)).toBe(`watched ${SID}\n`)

    await $.prompt.submit(PROMPT('and now?'))
    expect(world.marks.get(MARK)).toBe('')
  })

  test('the mark is emptied as the end is taken, before the submit carrying it returns', async ($, on) => {
    const { world, clock } = seat(on)
    let release = () => {}

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.submitHold = new Promise(resolve => (release = resolve))
    await clock.advance(5_000)
    expect(world.submitted).toEqual([])
    expect(world.marks.get(MARK)).toBe('')

    release()
    await clock.advance(5_000)
    expect(world.submitted.length).toBe(1)
    expect(world.marks.get(MARK)).toBe('')
  })

  test('a submit dropped after the end was taken marks the run watched again', async ($, on) => {
    const { world, clock } = seat(on)
    let release = () => {}

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.submitHold = new Promise(resolve => (release = resolve))
    await clock.advance(5_000)
    expect(world.marks.get(MARK)).toBe('')

    world.submitDrops = 1
    release()
    // Short of the next poll, which would submit it again.
    await clock.advance(1_000)
    expect(world.submitted).toEqual([])
    expect(world.marks.get(MARK)).toBe(`watched ${SID}\n`)
  })

  test('a submit dropped after /clear leaves the mark empty', async ($, on) => {
    const { world, clock } = seat(on)
    let release = () => {}

    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.submitHold = new Promise(resolve => (release = resolve))
    await clock.advance(5_000)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    world.submitDrops = 1
    release()
    await clock.advance(15_000)
    expect(world.submitted).toEqual([])
    expect(world.marks.get(MARK)).toBe('')
  })

  test('a watch written by a later poll is marked then', async ($, on) => {
    const { world, clock } = seat(on)
    let setFails = 1

    on('state.set', async ($, e, next) => {
      if (e.plugin === 'mm' && setFails > 0) {
        setFails--

        return { deny: 'disk full' } as never
      }

      return next(e)
    })
    await $.command.run(command('mm:review', '--staged'))
    expect(world.marks.has(MARK)).toBe(false)

    world.files.set(`${DIR}/codex.status`, 'RUNNING\n')
    expect(await watched(world, clock)).toEqual([RID])
    expect(world.marks.get(MARK)).toBe(`watched ${SID}\n`)
  })

  test('/clear empties the marks of every watch', async ($, on) => {
    const { world } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    expect(world.marks.get(MARK)).toBe('')
  })

  for (const reason of ['resume', 'other', 'logout', 'prompt_input_exit']) {
    test(`a ${reason} end empties the marks and keeps the watches`, async ($, on) => {
      const { world, clock } = seat(on)

      await $.command.run(command('mm:review', '--staged'))
      world.files.set(`${DIR}/codex.status`, 'RUNNING\n')
      await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } } as never)
      expect(world.marks.get(MARK)).toBe('')
      expect(await watched(world, clock)).toEqual([RID])
    })
  }

  test('without a session id the mark is the bare word', async ($, on) => {
    const { world } = seat(on)

    world.isIdDenied = true
    await $.command.run(command('mm:review', '--staged'))
    expect(world.marks.get(MARK)).toBe('watched\n')
  })

  test('a mark that cannot be written logs one debug line, and the run is still watched and handed over', async ($, on) => {
    const { world, clock } = seat(on)

    world.writeFails = 2
    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    await clock.advance(5_000)
    expect(world.submitted.map(text => text.split('\n')[0])).toEqual([HEAD])
    expect(world.logs.map(one => one.to)).toEqual(['debug', 'debug'])
    expect(world.logs[0]?.text).toContain('EACCES')
  })
})
