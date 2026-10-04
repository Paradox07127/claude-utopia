import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On, SessionStartInput } from 'claude-code'

const NOW = 1_790_922_800_000
const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/r' }
// The engine gives the mod `$.plugin.root` = this plugin's directory, so the mod runs the mmrun shipped in it.
const MMRUN = decodeURIComponent(new URL('../bin/mmrun', (import.meta as { url: string }).url).pathname)
const RID = '20261002-120000-a1b2'
const DIR = `/h/.claude/mmruns/${RID}`
const REVIEW_OUT = [
  `RUN ${RID}  models=codex,grok  mode=review  dir=/r`,
  `NEXT  mmrun wait ${RID} --timeout 3600   # \u653e\u540e\u53f0\u8dd1,\u5b8c\u6210\u65f6\u81ea\u52a8\u5524\u9192`,
  `THEN  mmrun result <model> ${RID}`,
  '',
].join('\n')
const CODEX_TOP = '### Critical\n- src/a.ts:3 \u4e24\u4e2a\u5199\u5165\u8def\u5f84\u6ca1\u4e0a\u9501'

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
    submitDrops: 0,
    submitThrows: 0,
    // Set: prompt.submit waits for it before it decides.
    submitHold: null as Promise<void> | null,
  }
  const clock = mock.clock(on, { now: NOW })

  mock.env(on, { HOME: '/h' })
  on('session.root', () => ({ value: '/r' }))
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

  test('mm:review failing to start: says so, no markdown, nothing watched', async ($, on) => {
    const { world, clock } = seat(on)

    world.replies.set(`${MMRUN} review --staged --models codex,grok --dir /r`, { exitCode: 1, stdout: '', stderr: 'mmrun: 没有可审的变更' })

    const r = await $.tool.call(skill('mm:review', '--staged') as never)

    expect(r.result).toEqual({ success: true, commandName: 'mm:review' })
    expect((r.context ?? []).join('\n')).toContain('mmrun failed to start')
    expect(world.nexted).toEqual([])
    expect(await watched(world, clock)).toEqual([])
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
})

describe('watching a run', () => {
  test('when every model has ended, the conclusions go to the model once', async ($, on) => {
    const { world, clock } = seat(on)

    await $.session.start(SESSION)
    await $.command.run(command('mm:review', '--staged'))
    world.files.set(`${DIR}/codex.status`, 'RUNNING\n')
    world.files.set(`${DIR}/grok.status`, 'RUNNING\n')
    world.files.set(`${DIR}/run.meta`, 'models=codex,grok\n')
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
    expect(text).toContain(`tail -20 ~/.claude/mmruns/${RID}/grok.raw`)
    expect(text).toContain('confidence below 80')
    expect(text).toContain('no voting')
    expect(text).toContain('`Not expanded`')
    expect(world.runs.some(argv => argv.join(' ').startsWith(`${MMRUN} result grok`))).toBe(false)
    expect(await watched(world, clock)).toEqual([])

    await clock.advance(15_000)
    expect(world.submitted.length).toBe(1)
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

  test('a result longer than 32000 characters rides the prompt cut, saying so', async ($, on) => {
    const { world, clock } = seat(on)

    await $.command.run(command('mm:review', '--staged'))
    await $.prompt.submit(PROMPT('go'))
    world.files.set(`${DIR}/codex.status`, 'DONE\n')
    world.replies.set(`${MMRUN} result codex ${RID} --top`, { exitCode: 0, stdout: 'x'.repeat(50_000) })
    await clock.advance(5_000)
    await $.prompt.submit(PROMPT('and now?'))

    const context = world.contexts[1] ?? []

    expect(context.join('').length).toBeLessThanOrEqual(32_000)
    expect(context.join('')).toContain('cut to 32000 characters')
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
