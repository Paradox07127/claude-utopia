import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On, RenderInput, SessionStartInput } from 'claude-code'

import { daySum, dayOf, equivalentOf, lastDays, parseUsageDay } from '../hooks/usage'

const PLUGIN = 'dashboard'
const NOW = 1_790_922_800_000
const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const BOTTOM = { type: 'Text', props: {}, children: ['engine'] }
// Core's own drawing of a question dialog: AskUserQuestion is drawn by exactly one engine node.
const ENGINE_DIALOG = { type: 'engine', ref: 0 }
// The main worktree's root, as `$.session.repo()` gives it from a linked worktree.
const DIR = '/h/.claude/dashboard/usage/-r'
const ZH = { options: { language: 'zh-CN' } }

const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: 'dashboard',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: { title: '工作台', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}

/** What each request's final turn.step usage reports, and how the ledger counts one. */
const STEP_USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 200 }
const ONE = { requests: 1, input: 100, output: 50, cacheRead: 1_000, cacheWrite: 200 }
/** A turn's summed usage, as turn.complete reports it: never added on top. */
const TURN_USAGE = { input_tokens: 9_999, output_tokens: 9_999, cache_read_input_tokens: 9_999, cache_creation_input_tokens: 9_999, model: 'claude-opus-5-5' }

type World = { files: Record<string, string>; session: string; toasts: string[]; clips: number }

/** The engine beneath the plugin, in memory: files by absolute path, the session id as `world.session` says. */
function seat(on: On): World {
  const world: World = { files: {}, session: 'sa', toasts: [], clips: 0 }

  mock.env(on, { HOME: '/h' })
  on('session.id', () => ({ value: world.session }))
  on('session.root', () => ({ value: '/r/.claude/worktrees/agent-x' }))
  on('session.repo', () => ({ value: { root: '/r', remote: null, internal: false, name: null } }))
  on('fs.write', ($, e) => {
    world.files[e.path] = e.text

    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = world.files[e.path]

    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.list', ($, e) => {
    const entries = Object.entries(world.files)
      .filter(([path]) => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
      .map(([path, text]) => ({ name: path.slice(e.path.length + 1), kind: 'file', size: text.length, mtimeMs: NOW, isLink: false }) as FsEntry)

    return entries.length > 0 ? { value: entries } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', ($, e) => ({ deny: `ENOENT ${e.path}` }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('settings.read', () => ({ value: {} }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'hi' }

    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: { ...STEP_USAGE, model: e.model } }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  on('classic.PermissionDenied', () => ({}))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('audio.play', () => {
    world.clips += 1

    return { value: undefined }
  })
  on('ui.render', { component: 'AskUserQuestion' }, () => ENGINE_DIALOG as never)
  on('ui.render', () => BOTTOM as never)

  return world
}

/** Runs a turn.step stream to its end. */
async function drain(stream: AsyncGenerator<unknown, unknown>): Promise<void> {
  while ((await stream.next()).done !== true) {}
}

const step = ($: Engine, turnId: string, model: string, agentId?: string) =>
  drain($.turn.step({ turnId, index: 0, model, messageCount: 2, ...(agentId !== undefined && { agentId }) } as never))

const end = ($: Engine, sessionId: string, reason = 'other') => $.session.end({ reason, sessionId, resume: { sessionId } } as never)

/** This day's ledger file of `session`, parsed; null when none was written. */
const fileOf = (world: World, session: string) => JSON.parse(world.files[`${DIR}/${dayOf(NOW)}/${session}.json`] ?? 'null') as { models: unknown; skills: unknown; asks?: unknown } | null

/** An AskUserQuestion question with an option per label. */
const question = (text: string, labels: string[], multiSelect = false) => ({ question: text, header: 'Pick', options: labels.map(label => ({ label, description: 'd' })), multiSelect })

/** The dialog of an AskUserQuestion call shows: its PermissionRequest, which the hooks beneath leave to the person. */
const shown = ($: Engine, questions: unknown[], agentId?: string) =>
  $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: { questions }, ...(agentId !== undefined && { agent_id: agentId }) } as never)

/** The call's result once answered: `answers` maps each question's text to the label chosen, the labels comma-joined, or the text typed. */
const answered = ($: Engine, id: string, questions: unknown[], answers: Record<string, string>, agentId?: string) =>
  $.classic.PostToolUse({
    tool_name: 'AskUserQuestion',
    tool_input: { questions, answers },
    tool_response: { questions, answers },
    tool_use_id: id,
    ...(agentId !== undefined && { agent_id: agentId }),
  } as never)

const NO_ASKS = { dialogs: 0, questions: 0, recommended: 0, option: 0, typed: 0, declined: 0, under1m: 0, under2m: 0, under5m: 0, under10m: 0, over10m: 0 }

/** The dialog of an AskUserQuestion call as the terminal draws it. */
const dialogOf = (questions: unknown[]) =>
  ({ plugin: PLUGIN, surface: 'terminal', component: 'AskUserQuestion', requestId: 'toolu_q', viewport: { columns: 100, rows: 40 }, props: { tool: 'AskUserQuestion', questions } }) as never

/** Every `$.ui.log` line. */
function logsOf(on: On): string[] {
  const lines: string[] = []

  on('ui.log', ($, e) => {
    lines.push(e.text)

    return { value: undefined }
  })

  return lines
}

/** Every string a drawn tree holds, one per Text directly under a Box. */
function linesOf(node: unknown): string[] {
  const tree = node as { type?: string; children?: unknown[] }
  const textOf = (one: unknown): string =>
    typeof one === 'string' || typeof one === 'number' ? String(one) : ((one as { children?: unknown[] } | null)?.children ?? []).map(textOf).join('')

  if (tree.type === 'Text') {
    return [textOf(tree)]
  }

  return (tree.children ?? []).flatMap(child => (typeof child === 'object' && child !== null ? linesOf(child) : []))
}

describe('usage ledger', () => {
  test('a main request and a subagent request fold into their buckets, each once though turn.complete reports usage too', ZH, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await $.turn.start({ text: 'go', turnId: 'm1' })
    await step($, 'm1', 'claude-opus-5-5')
    await step($, 's1', 'claude-haiku-5', 'a1')
    await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 's1', agentId: 'a1', reason: 'answer', usage: TURN_USAGE } as never)
    await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 'm1', reason: 'answer', usage: TURN_USAGE } as never)
    await end($, 'sa')

    expect(fileOf(world, 'sa')?.models).toEqual({ 'claude-opus-5-5': { main: ONE }, 'claude-haiku-5': { subagent: ONE } })
  })

  test('the file is written a few seconds after a change, not at each request', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await step($, 'm1', 'claude-opus-5-5')
    await step($, 'm1', 'claude-opus-5-5')
    expect(fileOf(world, 'sa'), 'nothing yet').toBeNull()
    await clock.advance(5_000)
    expect(fileOf(world, 'sa')?.models).toEqual({ 'claude-opus-5-5': { main: { requests: 2, input: 200, output: 100, cacheRead: 2_000, cacheWrite: 400 } } })
  })

  test('a session that finds its own file for the day goes on from it', ZH, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    world.files[`${DIR}/${dayOf(NOW)}/sa.json`] = JSON.stringify({ session: 'sa', day: dayOf(NOW), models: { 'claude-opus-5-5': { main: ONE } }, skills: {} })
    await $.session.start(SESSION)
    await step($, 'm1', 'claude-opus-5-5')
    await end($, 'sa')

    expect(fileOf(world, 'sa')?.models).toEqual({ 'claude-opus-5-5': { main: { requests: 2, input: 200, output: 100, cacheRead: 2_000, cacheWrite: 400 } } })
  })

  test('Skill calls: resolved inline, completed in a fork, launched in the background, failed; no arguments kept', ZH, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)
    const skill = (name: string, tool_response: unknown) =>
      $.classic.PostToolUse({ tool_name: 'Skill', tool_input: { skill: name, args: 'secret' }, tool_response, tool_use_id: `toolu_${name}` } as never)

    await $.session.start(SESSION)
    await skill('review', { success: true, commandName: 'review', status: 'inline' })
    await skill('review', { success: true, commandName: 'review', status: 'forked', agentId: 'a1', result: 'done' })
    await skill('review', { success: true, commandName: 'review', status: 'forked', agentId: 'a2', result: 'launched', background: true })
    await skill('ship', { success: false, commandName: 'ship' })
    await $.classic.PostToolUseFailure({ tool_name: 'Skill', tool_input: { skill: 'ship' }, tool_use_id: 'toolu_f', error: 'no such skill' } as never)
    await $.classic.PostToolUse({ tool_name: 'Read', tool_input: { file_path: '/w/x' }, tool_response: 'ok', tool_use_id: 'toolu_r' } as never)
    await end($, 'sa')

    expect(fileOf(world, 'sa')?.skills).toEqual({ review: { invocations: 3, inline: 1, forked: 1, errors: 0 }, ship: { invocations: 2, inline: 0, forked: 0, errors: 2 } })
    expect(world.files[`${DIR}/${dayOf(NOW)}/sa.json`]).not.toContain('secret')
  })

  test('two sessions write two files; the page sums both and skips one cut mid-write', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)

    await $.session.start(SESSION)
    await step($, 'm1', 'claude-opus-5-5')
    await end($, 'sa', 'clear')
    world.session = 'sb'
    await step($, 'm2', 'claude-opus-5-5')
    await clock.advance(5_000)
    world.files[`${DIR}/${dayOf(NOW)}/sc.json`] = '{"session":"sc","models":{"claude-opus'

    expect(Object.keys(world.files).filter(path => path.startsWith(DIR)).length).toBe(3)

    const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await pane.press({ key: 'page-usage' })

    const lines = linesOf(await pane.drawn())
    const today = lines.find(line => line.startsWith(dayOf(NOW).slice(5)))

    // Two requests of 100 input, 1k cache read, 200 cache write, 50 output: 700 equivalent each.
    expect(today).toMatch(/1\.4k\s+200\s+2k\s+400\s+100$/)
    expect(lines.find(line => /^主线程\s+\d/.test(line))).toMatch(/^主线程\s+2\s+1\.4k\s+100%$/)
    await pane.unmount()
  })

  test('the session id changes in process (/clear) with the page read before: the previous session counts as others, nothing lost', ZH, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)

    await $.session.start(SESSION)
    await step($, 'm1', 'claude-opus-5-5')

    const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE } as never)

    await pane.press({ key: 'page-usage' })
    await step($, 'm2', 'claude-opus-5-5')
    world.session = 'sb'
    await step($, 'm3', 'claude-opus-5-5')

    const lines = linesOf(await pane.drawn())

    expect(fileOf(world, 'sa')?.models).toEqual({ 'claude-opus-5-5': { main: { requests: 2, input: 200, output: 100, cacheRead: 2_000, cacheWrite: 400 } } })
    expect(lines.find(line => /^主线程\s+\d/.test(line))).toMatch(/^主线程\s+3\s+2\.1k\s+100%$/)
    await pane.unmount()
  })
})

describe('question dialogs', () => {
  test('each question by its answer: the recommended option, another option, typed text, a multiSelect; a subagent asks too; no text kept', ZH, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)
    const main = [question('Which way?', ['Bold (Recommended)', 'Careful']), question('Which lib?', ['dayjs', 'luxon (Recommended)']), question('Name?', ['a', 'b'])]
    const sub = [question('Which parts?', ['A (Recommended)', 'B', 'C'], true), question('Which more?', ['A (Recommended)', 'B'], true)]

    await $.session.start(SESSION)
    await shown($, main)
    await answered($, 'toolu_m', main, { 'Which way?': 'Bold (Recommended)', 'Which lib?': 'dayjs', 'Name?': 'secret words' })
    await shown($, sub, 'a1')
    await answered($, 'toolu_s', sub, { 'Which parts?': 'A (Recommended), B', 'Which more?': 'A (Recommended)' }, 'a1')
    await end($, 'sa')

    expect(fileOf(world, 'sa')?.asks).toEqual({ ...NO_ASKS, dialogs: 2, questions: 5, recommended: 2, option: 2, typed: 1, under1m: 2 })
    expect(world.files[`${DIR}/${dayOf(NOW)}/sa.json`]).not.toMatch(/secret|Which/)
  })

  test('declined: a call that failed, a turn cancelled while its dialog waited; a result with no dialog shown is not counted', ZH, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)
    const two = [question('One?', ['x (Recommended)', 'y']), question('Two?', ['x', 'y'])]

    await $.session.start(SESSION)
    await shown($, two)
    await $.classic.PostToolUseFailure({ tool_name: 'AskUserQuestion', tool_input: { questions: two }, tool_use_id: 'toolu_f', error: 'rejected' } as never)
    await shown($, [question('Three?', ['x', 'y'])], 'a1')
    await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: true, turnId: 's1', agentId: 'a1', reason: 'aborted' } as never)
    await answered($, 'toolu_x', two, { 'One?': 'x (Recommended)' })
    await end($, 'sa')

    expect(fileOf(world, 'sa')?.asks).toEqual({ ...NO_ASKS, dialogs: 2, questions: 3, declined: 3, under1m: 2 })
  })

  test('each wait from the dialog shown to its result lands in its bucket: 30 s, 90 s, 4 min, 12 min', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const one = [question('Go?', ['yes (Recommended)', 'no'])]

    await $.session.start(SESSION)

    for (const [i, ms] of [30_000, 90_000, 240_000, 720_000].entries()) {
      await shown($, one)
      await clock.advance(ms)
      await answered($, `toolu_${i}`, one, { 'Go?': 'no' })
    }

    await end($, 'sa')

    expect(fileOf(world, 'sa')?.asks).toEqual({ ...NO_ASKS, dialogs: 4, questions: 4, option: 4, under1m: 1, under2m: 1, under5m: 1, over10m: 1 })
  })

  test('a file written before asks were kept still parses; with asks, two sessions sum', () => {
    const old = { session: 'sa', day: '2026-10-03', models: {}, skills: { review: { invocations: 1, inline: 1, forked: 0, errors: 0 } } }
    const asks = { ...NO_ASKS, dialogs: 1, questions: 2, recommended: 1, typed: 1, under2m: 1 }

    expect(parseUsageDay(JSON.stringify(old))).toEqual({ models: {}, skills: old.skills })

    const a = parseUsageDay(JSON.stringify({ ...old, asks }))
    const b = parseUsageDay(JSON.stringify({ session: 'sb', models: {}, skills: {}, asks: { ...asks, declined: 3, questions: 5, over10m: 1, under2m: 0 } }))

    expect(daySum(daySum(a!, b!), parseUsageDay(JSON.stringify(old))!).asks).toEqual({ ...NO_ASKS, dialogs: 2, questions: 7, recommended: 2, typed: 2, declined: 3, under2m: 1, over10m: 1 })
    expect(parseUsageDay(JSON.stringify({ ...old, asks: { dialogs: 'x' } })), 'asks of another shape').toBeNull()
  })

  test('a dialog unanswered for 3 min chimes and toasts once; one answered at 170 s, or ended with the session, never', ZH, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = seat(on)
    const one = [question('Go?', ['yes (Recommended)', 'no'])]

    await $.session.start(SESSION)
    await shown($, one)
    await clock.advance(179_000)
    expect(world.toasts, 'not yet').toEqual([])
    await clock.advance(1_000)
    expect(world.toasts).toEqual(['还在等你回答问题'])
    expect(world.clips).toBe(1)
    await clock.advance(600_000)
    expect(world.toasts, 'once per dialog').toEqual(['还在等你回答问题'])
    await answered($, 'toolu_1', one, { 'Go?': 'yes (Recommended)' })

    await shown($, one, 'a1')
    await clock.advance(170_000)
    await answered($, 'toolu_2', one, { 'Go?': 'no' }, 'a1')
    await clock.advance(600_000)

    await shown($, one)
    await clock.advance(60_000)
    await end($, 'sa')
    await clock.advance(600_000)

    expect(world.toasts).toEqual(['还在等你回答问题'])
    expect(world.clips).toBe(1)
  })

  test('the use-recommended button pressed while the dialog waits answers each question with its recommended option; the ledger counts them recommended', ZH, async ($, on) => {
    mock.clock(on, { now: NOW })

    const world = seat(on)
    const logs = logsOf(on)
    const two = [question('Which way?', ['Bold (Recommended)', 'Careful']), question('Which lib?', ['dayjs', 'luxon (Recommended)'])]
    let isClosed = false

    // The dialog beneath: open until a hook above settles the call.
    on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) =>
      new Promise(resolve =>
        next.signal.addEventListener('abort', () => {
          isClosed = true
          resolve({ deny: 'closed' })
        }),
      ) as never,
    )

    await $.session.start(SESSION)

    const call = $.tool.call({ tool: 'AskUserQuestion', questions: two } as never)

    await shown($, two)

    const dialog = await $.ui.mount(dialogOf(two))

    await dialog.press({ key: 'ask-recommended' })

    expect(await call).toEqual({ result: { questions: two, answers: { 'Which way?': 'Bold (Recommended)', 'Which lib?': 'luxon (Recommended)' } }, context: [expect.stringContaining('use-recommended button')] })
    expect(isClosed, 'the dialog beneath is closed').toBe(true)
    expect(logs).toContain('ask: answered with the recommended options')

    // The closed dialog may still report itself interrupted: the answer already counted stands.
    await $.classic.PostToolUseFailure({ tool_name: 'AskUserQuestion', tool_input: { questions: two }, tool_use_id: 'toolu_q', error: 'interrupted', is_interrupt: true } as never)
    await end($, 'sa')

    expect(fileOf(world, 'sa')?.asks).toEqual({ ...NO_ASKS, dialogs: 1, questions: 2, recommended: 2, under1m: 1 })
    await dialog.unmount()
  })

  test('a dialog answered first passes its result through unchanged; a later press does nothing', ZH, async ($, on) => {
    mock.clock(on, { now: NOW })
    seat(on)

    const logs = logsOf(on)
    const one = [question('Go?', ['yes (Recommended)', 'no'])]
    const typed = { result: { questions: one, answers: { 'Go?': 'not yet' } }, text: 'User answered: not yet' }
    let answer: (result: unknown) => void = () => undefined

    on('tool.call', { tool: 'AskUserQuestion' }, () => new Promise(resolve => (answer = resolve)) as never)
    await $.session.start(SESSION)

    const call = $.tool.call({ tool: 'AskUserQuestion', questions: one } as never)
    const dialog = await $.ui.mount(dialogOf(one))

    answer(typed)

    expect(await call).toEqual(typed)
    await dialog.press({ key: 'ask-recommended' })
    expect(logs).toEqual([])
    await dialog.unmount()
  })

  test('the button shows only when every question has exactly one recommended option', ZH, async ($, on) => {
    seat(on)

    const scenes: [string, unknown[], boolean][] = [
      ['all recommended', [question('A?', ['x (Recommended)', 'y']), question('B?', ['p', 'q (Recommended)'])], true],
      ['one without', [question('A?', ['x (Recommended)', 'y']), question('B?', ['p', 'q'])], false],
      ['one with two', [question('A?', ['x (Recommended)', 'y (Recommended)'])], false],
    ]

    for (const [where, questions, isDrawn] of scenes) {
      const dialog = await $.ui.mount(dialogOf(questions))

      expect((await dialog.find({ key: 'ask-recommended' })) !== undefined, where).toBe(isDrawn)

      if (!isDrawn) {
        expect(await dialog.drawn(), `${where}: the engine's dialog alone`).toEqual(ENGINE_DIALOG)
      }

      await dialog.unmount()
    }
  })
})

describe('usage figures', () => {
  test('等价量 weighs input 1×, cache read 0.1×, cache write 1.25×, output 5×', () => {
    expect(equivalentOf({ requests: 1, input: 1_000, output: 200, cacheRead: 10_000, cacheWrite: 800 })).toBe(4_000)
  })

  test('the last seven local days, newest first', () => {
    const days = lastDays(NOW)

    expect(days.length).toBe(7)
    expect(days[0]).toBe(dayOf(NOW))
    expect(new Set(days).size).toBe(7)
    expect([...days].sort().reverse()).toEqual(days)
  })
})
