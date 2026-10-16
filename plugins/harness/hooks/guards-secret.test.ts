import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { refusal, stage, world } from './guards-kit'
import type { World } from './guards-kit'

const TMP = '/t'
const HOME = '/t/home'
const PROJ = '/t/proj'

/** A home holding fake key files, a project with a link to one of them, and the plain files around them. */
const secretWorld = (fields: Partial<World> = {}): World =>
  world({
    cwd: HOME,
    env: { HOME },
    files: [
      ...['.claude.json', '.claude.json.backup', '.claude/backups/x.json', '.claude/settings.json', '.claude/settings.local.json', '.claude/CLAUDE.md',
        '.codex/config.toml', '.codex/auth.json', '.openviking/x', '.grok/auth.json', 'harness/a.md', 'proj/a.md'].map(rel => `${HOME}/${rel}`),
      `${PROJ}/.claude/settings.json`, `${PROJ}/config.toml`, `${TMP}/srv/a.py`, `${TMP}/ovdir/ov.conf`,
    ],
    dirs: ['/tmp'],
    links: { [`${PROJ}/link.json`]: `${HOME}/.codex/auth.json` },
    ...fields,
  })

async function call($: Engine, on: On, tool: string, input: Record<string, unknown>, cwd = HOME): Promise<string | undefined> {
  const w = secretWorld({ cwd })
  stage(on, w)
  return refusal($, w, tool, input)
}

const firstLine = (command: string) => command.split('\n')[0]

function shell(name: string, commands: string[], isRefused: boolean, cwd = HOME): void {
  for (const command of commands) {
    test(`${name} [${firstLine(command)}]${cwd === HOME ? '' : ` in ${cwd}`}`, async ($, on) => {
      expect((await call($, on, 'Bash', { command, description: 'd' }, cwd)) !== undefined).toBe(isRefused)
    })
  }
}

function grep(name: string, inputs: Record<string, unknown>[], isRefused: boolean): void {
  for (const input of inputs) {
    test(`${name} ${JSON.stringify(input)}`, async ($, on) => {
      expect((await call($, on, 'Grep', { pattern: 'k', ...input })) !== undefined).toBe(isRefused)
    })
  }
}

describe('secret-files guard: Read, Edit, Write', () => {
  for (const path of [
    `${HOME}/.claude.json`, `${HOME}/.claude/settings.json`, `${HOME}/.claude.json.backup`, `${HOME}/.claude/backups/x.json`, `${HOME}/.codex/config.toml`,
    `${PROJ}/link.json`, '~/.claude/settings.local.json', '$HOME/.codex/config.toml.bak', '${HOME}/.codex/auth.json', `${HOME}/.openviking/x`,
    `${HOME}/.grok/auth.json`, `${HOME}/.claude/file-history/s/a@v1`, `${HOME}/.codex/shell_snapshots/a.sh`, '.claude.json', '/srv/ov/ovcli.conf', 'ov.conf',
  ]) {
    test(`Read refused [${path}]`, async ($, on) => {
      expect(await call($, on, 'Read', { file_path: path })).toBeDefined()
    })
  }
  for (const tool of ['Edit', 'Write']) {
    test(`${tool} of ~/.claude/settings.json refused`, async ($, on) => {
      const rest = tool === 'Edit' ? { old_string: 'a', new_string: 'b' } : { content: 'c' }
      expect(await call($, on, tool, { file_path: `${HOME}/.claude/settings.json`, ...rest })).toBeDefined()
    })
  }
  for (const path of [`${HOME}/.claude/CLAUDE.md`, `${PROJ}/.claude/settings.json`, `${HOME}/harness/a.md`, 'prov.conf']) {
    test(`Read let through [${path}]`, async ($, on) => {
      expect(await call($, on, 'Read', { file_path: path })).toBeUndefined()
    })
  }
  test('Read of a relative .claude/settings.json in a project is let through', async ($, on) => {
    expect(await call($, on, 'Read', { file_path: '.claude/settings.json' }, PROJ)).toBeUndefined()
  })
  // The default macOS volume is case-insensitive: a path in other case is the same file
  for (const path of ['~/.Codex/auth.json', `${HOME}/.CLAUDE/Settings.json`, 'deploy/OV.conf']) {
    test(`Read refused, case aside [${path}]`, async ($, on) => {
      expect(await call($, on, 'Read', { file_path: path })).toBeDefined()
    })
  }
})

describe('secret-files guard: Grep', () => {
  grep('content refused', [HOME + '/.codex', HOME, `${HOME}/.claude`, `${HOME}/.claude/backups`, `${HOME}/.openviking`, `${HOME}/.grok`, TMP, `${HOME}/.claude.json`].map(path => ({ path, output_mode: 'content' })), true)
  grep('content with no path, the cwd being HOME, refused', [{ output_mode: 'content' }], true)
  grep('let through', [{ path: HOME, output_mode: 'files_with_matches' }, { path: HOME, output_mode: 'count' }, { path: HOME }, { path: `${HOME}/harness`, output_mode: 'content' }], false)
  grep('content refused', [{ path: `${TMP}/srv`, output_mode: 'content', glob: 'ovcli.conf' }, { path: `${TMP}/ovdir`, output_mode: 'content' }, { path: `${TMP}/srv`, output_mode: 'content', glob: '**/ov.conf' }], true)
  grep('content let through, no key file in the directory', ['*.py', '*', '*.conf'].map(glob => ({ path: `${TMP}/srv`, output_mode: 'content', glob })), false)
  grep('content refused, case aside', [{ path: `${HOME}/.CODEX`, output_mode: 'content' }, { path: `${TMP}/srv`, output_mode: 'content', glob: 'OVCLI.conf' }], true)
})

describe('secret-files guard: Bash', () => {
  shell(
    'refused',
    [
      'cat ~/.claude.json', 'jq .env ~/.claude/settings.json', 'ls ~/.codex && cat ~/.codex/config.toml', 'ssh host cat /srv/openviking/ovcli.conf',
      "bash -c 'head ~/.codex/auth.json'", `python3 - <<'EOF'\nprint(open('${HOME}/.claude.json').read())\nEOF`, 'diff $HOME/.claude/settings.json /tmp/x',
      'grep token ~/.codex/config.toml', 'rg -n key ~/.openviking/', 'rg -L key ~/.codex/', 'grep -rn token ~/.codex', 'grep -R key $HOME',
      'sudo -n tail ~/.grok/auth.json', 'X=1 less ~/.claude/settings.local.json', 'echo "$(cat ~/.claude.json)"', 'cp ~/.claude/backups/a.json /tmp/',
      'cat ov.conf', 'cat ~/.codex/shell_snapshots/a.sh', 'rg KEY ~/.claude/file-history', 'env', 'env | sort', 'env -0', 'printenv',
      'printenv OPENVIKING_API_KEY', 'printenv GH_TOKEN', 'export', 'export -p', 'declare -x', 'declare -p', 'typeset -x', 'set', 'true; set',
      "cat <<'EOF' | bash\ncat ~/.claude.json\nEOF", 'cat <<EOF\n$(cat ~/.claude.json)\nEOF', 'gh pr create --title t --body-file ~/.codex/config.toml',
      "bash <<'EOF'\nset\nEOF", "sh <<'EOF'\nenv\nEOF",
    ],
    true,
  )
  shell(
    'let through',
    [
      'stat ~/.claude.json', 'grep -c token ~/.codex/config.toml', 'ls -la ~/.openviking', 'chmod 600 ~/.claude/settings.json', 'env -i PATH=/usr/bin ls',
      'printenv HOME', 'cat README.md', 'git commit -m "docs: mention settings.json"', 'cat prov.conf', 'grep -l key ~/.claude.json',
      'rg --files-with-matches key ~/.codex/', 'grep -qi token ~/.codex/auth.json', 'wc -c ~/.claude.json', 'test -f ~/.codex/auth.json && echo yes',
      'env FOO=1 ls', 'grep -rn todo ~/proj', 'grep -rl token ~/.codex', 'set -e', 'export A=1', 'declare -x A=1',
      `git commit -m "$(cat <<'EOF'\ndocs: explain the hook in ~/.claude/settings.json\nEOF\n)"`, "cat > docs/setup.md <<'EOF'\nAdd the hook to ~/.claude/settings.json\nEOF",
      "gh pr create --title t --body 'Reads ~/.codex/config.toml only via stat'", "python3 - <<'EOF'\nimport collections\nd = collections.defaultdict(set)\nEOF",
      "node - <<'EOF'\nconst set = new Set()\nEOF",
    ],
    false,
  )
  // Bypasses external reviewers found: env paths and assignments, declare/typeset, echo of a key variable, cd and relative paths, globs
  shell(
    'refused',
    ['/usr/bin/env', 'env FOO=1', 'env -u FOO', 'declare', 'typeset', 'typeset -p', 'declare -p OPENAI_API_KEY', 'echo $OPENAI_API_KEY', `printf '%s\\n' "$GH_TOKEN"`, 'echo "${GH_TOKEN:-none}"', 'cd ~/.codex && cat auth.json', 'cat ~/.codex/*', 'head ~/.claude/*'],
    true,
  )
  shell('refused', ['cat config.toml'], true, `${HOME}/.codex`)
  shell(
    'let through',
    ['env FOO=1 python3 x.py', '/usr/bin/env python3 x.py', 'declare -a arr', 'typeset -i n=1', 'declare -f fn', 'echo $PATH', "echo '$OPENAI_API_KEY'", 'curl -H "Authorization: Bearer $GH_TOKEN" https://example.com', 'cd ~/.codex && ls', 'cd /tmp && cat notes.txt', 'cat ~/proj/*.md', 'ls ~/.codex/*'],
    false,
  )
  shell('let through', ['cat config.toml'], false, PROJ)
  // A cd in a subshell leaves the outer cwd; declare/typeset and echo are refused only in the forms that print a value
  shell('refused', ['(cd /tmp && pwd); grep -R token .'], true, `${HOME}/.codex`)
  shell(
    'refused',
    ['typeset OPENAI_API_KEY', 'declare -p OPENAI_API_KEY', 'typeset -p GH_TOKEN', 'echo $OPENAI_API_KEY', 'echo "${OPENAI_API_KEY}"', 'echo "${OPENAI_API_KEY:-none}"', 'declare -px OPENAI_API_KEY', 'declare -p -x OPENAI_API_KEY', 'echo "\\\\$OPENAI_API_KEY"'],
    true,
  )
  shell('let through', ['declare -x OPENAI_API_KEY', 'typeset -x OPENAI_API_KEY', 'echo "\\$OPENAI_API_KEY"', 'echo "${OPENAI_API_KEY:+configured}"', 'echo "${OPENAI_API_KEY+configured}"', 'echo "${GH_TOKEN_PATH:+set}"'], false)
  shell('refused, case aside', ['cat ~/.Codex/auth.json', 'cat ~/.CLAUDE.json', 'cat deploy/OV.conf', 'grep -rn token ~/.CODEX'], true)
})

describe('secret-files guard: reasons and the log', () => {
  test('a refusal names the file and the alternatives', async ($, on) => {
    const got = await call($, on, 'Read', { file_path: `${HOME}/.claude.json` })
    expect(got).toContain('API keys')
    expect(got).toContain('.claude.json')
    expect(got).toContain('rg -l in Bash')
  })

  test('an environment dump is told to print one named variable', async ($, on) => {
    expect(await call($, on, 'Bash', { command: 'env | sort', description: 'd' })).toContain('named variable')
  })

  test('a refusal logs a deny line of guard secret-files', async ($, on) => {
    const w = secretWorld()
    stage(on, w)
    await refusal($, w, 'Read', { file_path: `${HOME}/.claude.json` })
    await refusal($, w, 'Bash', { command: 'env | sort', description: 'd' })
    expect(w.log.map(line => [line.guard, line.decision, line.op])).toEqual([
      ['secret-files', 'deny', `Read ${HOME}/.claude.json`],
      ['secret-files', 'deny', 'env'],
    ])
  })

  test('both guards refusing one command: each is logged and named', async ($, on) => {
    const w = secretWorld({
      cwd: '/t/repo',
      dirs: ['/t/repo'],
      repos: [{ top: '/t/repo', gitDir: '/t/repo/.git', commonDir: '.git', refs: ['HEAD'], tracked: [] }],
    })
    w.dirs.push('/t/repo/.git')
    stage(on, w)
    const got = await refusal($, w, 'Bash', { command: 'git stash; cat ~/.claude.json', description: 'd' })
    expect(got).toContain('`git stash` would take away uncommitted changes')
    expect(got).toContain('would put the contents of .claude.json into the transcript')
    expect(w.log.map(line => line.guard)).toEqual(['shared-tree-git', 'secret-files'])
  })
})

describe('secret-files guard: the event ledger', () => {
  const MAIN = '/t/repo'
  const WT = '/t/repo-wt'
  const NOW = new Date(2026, 9, 14, 12).getTime()
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const DAY = `${new Date(NOW).getFullYear()}-${pad2(new Date(NOW).getMonth() + 1)}-${pad2(new Date(NOW).getDate())}`
  const ledger = (project: string, session: string) => `${HOME}/.claude/harness/events/${project}/${DAY}/${session}.guard.jsonl`
  const MAIN_LEDGER = ledger('-t-repo', 's-1')

  /** A session s-1 in a linked worktree of /t/repo. */
  const ledgerWorld = (fields: Partial<World> = {}): World =>
    secretWorld({
      cwd: WT,
      session: 's-1',
      now: NOW,
      dirs: ['/tmp', MAIN, `${MAIN}/.git/worktrees/repo-wt`, WT],
      repos: [
        { top: MAIN, gitDir: `${MAIN}/.git`, commonDir: '.git', refs: ['HEAD'], tracked: [] },
        { top: WT, gitDir: `${MAIN}/.git/worktrees/repo-wt`, commonDir: `${MAIN}/.git`, refs: ['HEAD'], tracked: [] },
      ],
      ...fields,
    })
  const lines = (w: World, path: string) => (w.texts[path] ?? '').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
  const bash = (command: string) => ({ command, description: 'd' })

  test('each refusal appends a guard.block line to the session file under the main tree project and the local day', async ($, on) => {
    const w = ledgerWorld()
    stage(on, w)
    expect(await refusal($, w, 'Bash', bash('cat   ~/.claude.json'))).toBeDefined()
    expect(await refusal($, w, 'Bash', bash('head ~/.codex/auth.json'))).toBeDefined()
    expect(Object.keys(w.texts)).toEqual([MAIN_LEDGER])
    const got = lines(w, MAIN_LEDGER)
    expect(got.map(line => [Object.keys(line).sort(), line.event_name, line.severity_text])).toEqual(
      Array(2).fill([['attributes', 'event_name', 'severity_text', 'timestamp'], 'guard.block', 'WARN']),
    )
    expect(got[0]?.attributes).toEqual({ 'session.id': 's-1', 'rule.id': 'secret-file', 'rule.name': 'guard-secret-files', tool: 'Bash', target: 'cat ~/.claude.json', decision: 'deny' })
    expect(got[0]?.timestamp).toBe(new Date(NOW).toISOString())
    expect(String(got[0]?.timestamp)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  })

  test('a Read outside a repository records the file under the cwd project', async ($, on) => {
    const w = ledgerWorld({ cwd: HOME })
    stage(on, w)
    await refusal($, w, 'Read', { file_path: `${HOME}/.claude.json` })
    expect(lines(w, ledger('-t-home', 's-1')).map(line => line.attributes)).toEqual([
      { 'session.id': 's-1', 'rule.id': 'secret-file', 'rule.name': 'guard-secret-files', tool: 'Read', target: `${HOME}/.claude.json`, decision: 'deny' },
    ])
  })

  for (const session of ['', '../x']) {
    test(`session id ${JSON.stringify(session)}: the line goes to unknown-session, an environment dump cut to 120 characters`, async ($, on) => {
      const w = ledgerWorld({ session })
      stage(on, w)
      expect(await refusal($, w, 'Bash', bash(`env ${'A=1 '.repeat(50)}`))).toBeDefined()
      const [line] = lines(w, ledger('-t-repo', 'unknown-session'))
      const attributes = line?.attributes as Record<string, string> | undefined
      expect([attributes?.['session.id'], attributes?.['rule.id'], attributes?.target?.length]).toEqual(['unknown-session', 'env-dump', 120])
    })
  }

  test('lines already in the file are kept', async ($, on) => {
    const w = ledgerWorld({ texts: { [MAIN_LEDGER]: '{"x":1}' } })
    stage(on, w)
    await refusal($, w, 'Bash', bash('cat ~/.claude.json'))
    const [kept, added, end] = String(w.texts[MAIN_LEDGER]).split('\n')
    expect([kept, end]).toEqual(['{"x":1}', ''])
    expect(added).toContain('"guard.block"')
  })

  test('a file that exists but cannot be read is left as it is; the call is still refused', async ($, on) => {
    const w = ledgerWorld({ texts: { [MAIN_LEDGER]: null } })
    stage(on, w)
    expect(await refusal($, w, 'Bash', bash('cat ~/.claude.json'))).toContain('API keys')
    expect(w.texts).toEqual({ [MAIN_LEDGER]: null })
  })

  test('a ledger that cannot be written: the call is still refused', async ($, on) => {
    const w = ledgerWorld({ isLogWritable: false })
    stage(on, w)
    expect(await refusal($, w, 'Bash', bash('cat ~/.claude.json'))).toContain('API keys')
    expect(w.texts).toEqual({})
  })

  test('a refusal of the git guard alone records nothing', async ($, on) => {
    const w = ledgerWorld({ cwd: MAIN })
    stage(on, w)
    expect(await refusal($, w, 'Bash', bash('git stash'))).toBeDefined()
    expect(w.texts).toEqual({})
  })
})
