import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { refusal, stage, world } from './guards-kit'
import type { World } from './guards-kit'

const MAIN = '/t/repo'
const WT = '/t/repo-wt'
const PLAIN = '/t/plain'
const HOME = '/t/home'
const REFS = ['HEAD', 'HEAD~1', 'main', 'feat']

/** A main tree holding a.swift (untracked) and a deleted tracked.swift, its linked worktree, a plain directory, and alias nuke. */
const repoWorld = (fields: Partial<World> = {}): World =>
  world({
    cwd: MAIN,
    env: { HOME },
    dirs: [MAIN, `${MAIN}/.git/worktrees/repo-wt`, WT, PLAIN, HOME, '/tmp'],
    files: [`${MAIN}/a.swift`],
    repos: [
      { top: MAIN, gitDir: `${MAIN}/.git`, commonDir: '.git', refs: REFS, tracked: ['tracked.swift'] },
      { top: WT, gitDir: `${MAIN}/.git/worktrees/repo-wt`, commonDir: `${MAIN}/.git`, refs: REFS, tracked: [] },
    ],
    aliases: { nuke: 'reset --hard' },
    ...fields,
  })

const bash = (command: string) => ({ command, description: 'd' })

/** The refusal of `command` run in cwd, or undefined when it ran. */
async function run($: Engine, on: On, command: string, cwd: string, fields: Partial<World> = {}): Promise<string | undefined> {
  const w = repoWorld({ cwd, ...fields })
  stage(on, w)
  return refusal($, w, 'Bash', bash(command))
}

const firstLine = (command: string) => command.split('\n')[0]

function cases(name: string, commands: string[], cwd: string, isRefused: boolean, fields: Partial<World> = {}): void {
  for (const command of commands) {
    test(`${name} [${firstLine(command)}]`, async ($, on) => {
      expect((await run($, on, command, cwd, fields)) !== undefined).toBe(isRefused)
    })
  }
}

describe('shared-tree git guard: refused on the main tree', () => {
  cases(
    'refused',
    [
      'git checkout -- a.swift', 'git checkout HEAD -- a.swift', 'git checkout .', 'git restore a.swift',
      'git restore --staged --worktree a.swift', 'git stash', 'git stash push -- a', 'git reset --hard', 'git commit -q --amend -m x',
      'git status && git checkout -- a', `cd ${MAIN} && git stash`, `git -C ${MAIN} checkout -- a`,
    ],
    MAIN,
    true,
  )
  cases('from the worktree, -C to the main tree', [`git -C ${MAIN} reset --hard`], WT, true)
  cases('from the worktree, cd by a variable to the main tree', [`W=${MAIN}; cd "$W" && git checkout -- a`], WT, true)
  // Bypasses external reviewers found
  cases(
    'refused',
    [
      'git commit --amend -m "fix; wording"', 'git \\\n  reset --hard', 'git -c core.quotepath=false reset --hard', 'git --no-pager stash',
      '/usr/bin/git reset --hard', 'env git reset --hard', 'sudo -E git stash', 'if true; then git reset --hard; fi',
      'cd /no/such/dir || git reset --hard', 'cd /no/such/dir; git stash', 'echo $(git stash)', 'cat <<EOF\n$(git reset --hard)\nEOF',
      'git restore --staged -SW a.swift', 'git checkout a.swift', 'git checkout HEAD a.swift', 'git checkout --ours a.swift',
      'git checkout -f main', 'git checkout --force main',
    ],
    MAIN,
    true,
  )
  cases('MAIN_REPO from the host environment, -C from the worktree', ['git -C "$MAIN_REPO" reset --hard'], WT, true, { env: { HOME, MAIN_REPO: MAIN } })
  cases('GIT_WORK_TREE to the main tree', [`GIT_WORK_TREE=${MAIN} git checkout -- a.swift`], WT, true)
  cases('a dangerous op where the directory cannot be told', ['cd "$(mktemp -d)" && git stash'], WT, true)
  cases('after a cd to an unknown directory, -C to the main tree', [`cd "$(mktemp -d)" && git -C ${MAIN} reset --hard`], WT, true)
  cases('a cd in a subshell does not reach outside it', [`(cd ${WT} && git status); git reset --hard`], MAIN, true)
  cases('GIT_WORK_TREE wins over -C', [`GIT_WORK_TREE=${MAIN} git -C ${WT} reset --hard`], WT, true)
  cases('an exported GIT_WORK_TREE holds', [`export GIT_WORK_TREE=${MAIN}; git reset --hard`], WT, true)
  cases('checkout of a glob pathspec', ["git checkout '*.swift'"], MAIN, true)
  cases('sudo -n does not swallow git', ['sudo -n git reset --hard'], MAIN, true)
  cases('the value of nice -n is no command', ['nice -n 5 git reset --hard'], MAIN, true)
  cases('after a cd to an unknown directory, -C to the worktree', [`cd "$(mktemp -d)" && git -C ${WT} reset --hard`], MAIN, false)
  cases('checkout of a deleted tracked file', ['git checkout tracked.swift'], MAIN, true)
  cases('${VAR:-default} expands from the host environment', ['cd "${MAIN_REPO:-.}" && git checkout -- a'], WT, true, { env: { HOME, MAIN_REPO: MAIN } })
  cases('${unset:-main tree} takes the default', [`cd "\${NO_SUCH_VAR_X:-${MAIN}}" && git stash`], WT, true)
  cases('${unset:-worktree} takes the default', [`cd "\${NO_SUCH_VAR_X:-${WT}}" && git stash`], MAIN, false)
  cases('git in a nested command substitution', ['echo "$(git stash -m "$(date +%F)")"'], MAIN, true)
  cases('a substitution after a cd is judged in the new directory', [`cd ${MAIN} && echo "$(git stash)"`], WT, true)
  cases('cd - back to the main tree', ['cd /tmp && cd - && git reset --hard'], MAIN, true)
  cases('git after xargs', ['git diff --name-only | xargs git checkout --'], MAIN, true)
  cases('git after find -exec', ["find . -name '*.swift' -exec git checkout -- {} +"], MAIN, true)
  cases('git in bash -c', ["bash -c 'git stash'"], MAIN, true)
  cases('env -u does not swallow git', ['env -u GIT_DIR git checkout -- a.swift'], MAIN, true)
  cases(
    'refused',
    ['git clean -fd', 'git switch --discard-changes main', 'git switch -f main', 'git status # inspect\ngit reset --hard', "bash -lc 'git reset --hard'", `cd ${MAIN} && git checkout tracked.swift | head`],
    MAIN,
    true,
  )
  cases('-C glued to its path', [`git -C${MAIN} reset --hard`], WT, true)
  cases('env -C to the main tree', [`env -C ${MAIN} git reset --hard`], WT, true)
  cases('checkout of a file where the directory is unknown', ['cd "$(git rev-parse --show-toplevel)" && git checkout tracked.swift'], MAIN, true)
  cases('a pipeline, then && cd to the main tree', [`git diff | head && cd ${MAIN} && git checkout -- a.swift`], WT, true)
  cases('cd to the main tree && … | head', [`cd ${MAIN} && git stash | head`], WT, true)
  cases('a cd after && may not run, so the old directory counts', ['false && cd /tmp; git reset --hard'], MAIN, true)
  cases('a cd after || may not run, nor the && after it', [`true || cd ${WT} && git reset --hard`], MAIN, true)
  cases('letters in an option value are no switches', ['git clean -fd -enode_modules', 'git clean -fd -e -n', 'git restore -sSTAGING a.swift', 'git restore -s STAGING -W a.swift'], MAIN, true)
  cases(
    'a git alias is expanded first',
    [`git -c alias.wipe="reset --hard" wipe`, "git -c alias.Wipe='reset --hard' wipe", "git -c alias.w2=wipe -c alias.wipe='reset --hard' w2", 'git nuke', "git -c alias.sh='!git reset' sh --hard", "git -c alias.sh='!f() { git stash; }; f' sh"],
    MAIN,
    true,
  )
  cases('an inherited GIT_WORK_TREE to the main tree', ['git reset --hard'], WT, true, { env: { HOME, GIT_WORK_TREE: MAIN } })
})

describe('shared-tree git guard: let through', () => {
  cases(
    'let through on the main tree',
    ['git clean -n', 'git clean --dry-run -d', 'git switch main', 'git restore -h', 'git stash --help', 'git stash create', '# echo "$(git stash)"\ngit status', 'cd "$(git rev-parse --show-toplevel)" && git checkout feat'],
    MAIN,
    false,
  )
  cases('a substitution after a cd into the worktree', [`cd ${WT} && echo "$(git stash)"`], WT, false)
  cases('find -exec of a read-only command', ["find . -name '*.swift' -exec grep -l x {} +"], MAIN, false)
  cases('bash -c of a read-only git', ["bash -c 'git status'"], MAIN, false)
  cases('in an && chain the cd ran before git, so its directory counts', [`true && cd ${WT} && git reset --hard`], MAIN, false)
  cases('an inherited GIT_WORK_TREE unset', ['unset GIT_WORK_TREE; git reset --hard', 'env -u GIT_WORK_TREE git reset --hard'], WT, false, { env: { HOME, GIT_WORK_TREE: MAIN } })
  cases('letters in an option value are no switches', ['git checkout -bfeature/fix', 'git switch -cfix', 'git switch -C fix-it', 'git clean -nd -efoo', 'git restore -SsHEAD a.swift'], MAIN, false)
  cases('a git alias is expanded first', ['git -c alias.st=status st', "git -c alias.sh='!git status' sh", "git -c alias.status='reset --hard' status"], MAIN, false)
  cases('a configured alias in the worktree', ['git nuke'], WT, false)
  cases(
    'let through on the main tree',
    [
      'git status', 'git stash list', 'git stash show -p', 'git restore --staged a.swift', 'git checkout main', 'git reset HEAD~1', 'git commit -m x',
      'echo "git stash"', "grep -n 'git checkout --' notes.md", "python3 - <<'EOF'\nimport os\nos.system('git stash')\nEOF",
      "cat > undo.sh <<'EOF'\ngit stash\ngit checkout -- a\nEOF\nchmod +x undo.sh",
      'echo "a; git stash; b"', 'git checkout -b feature/x', 'git checkout -', 'git checkout HEAD~1', 'git -c color.ui=never status', 'git --no-pager log -1',
      'cd /no/such/dir || echo miss', 'cat > x.sh <<EOF\ngit stash\nEOF', "python3 - <<'EOF'\nprint('$(git stash)')\nEOF", "echo '$(git stash)'",
      "grep -n '`git reset --hard`' notes.md", 'nice -n 5 git status',
    ],
    MAIN,
    false,
  )
  cases('let through in the worktree', ['git checkout -- a.swift', 'git stash', 'git reset --hard', 'git commit --amend -m x'], WT, false)
  cases('cd into the worktree', [`cd ${WT} && git checkout -- a`], MAIN, false)
  cases('cd by a variable into the worktree', [`W=${WT}; cd "$W" && git stash`], MAIN, false)
  cases('a directory outside any repository', ['git checkout -- a'], PLAIN, false)
})

describe('shared-tree git guard: reasons', () => {
  test('a refusal names the op and the way out', async ($, on) => {
    const got = await run($, on, 'git stash', MAIN)
    expect(got).toContain('Blocked on the shared main worktree: `git stash` would take away uncommitted changes')
    expect(got).toContain('open a temporary worktree')
  })

  test('--amend gets its own reason', async ($, on) => {
    expect(await run($, on, 'git commit --amend -m x', MAIN)).toContain('would rewrite a commit already on the main tree')
  })
})

describe('shared-tree git guard: the log and an unanswering git', () => {
  test('a refusal appends one deny line naming the agent; a call let through writes none', async ($, on) => {
    const w = repoWorld()
    stage(on, w)
    expect(await refusal($, w, 'Bash', bash('git stash'), 'a1')).toBeDefined()
    expect(await refusal($, w, 'Bash', bash('git status'), 'a1')).toBeUndefined()
    expect(w.log).toEqual([{ at: w.now, guard: 'shared-tree-git', decision: 'deny', op: 'git stash', cwd: MAIN, agent_id: 'a1' }])
  })

  test('a main-thread refusal logs agent_id null', async ($, on) => {
    const w = repoWorld()
    stage(on, w)
    await refusal($, w, 'Bash', bash(`git -C ${MAIN} stash`))
    expect(w.log.map(line => line.agent_id)).toEqual([null])
  })

  for (const git of ['missing', 'failing'] as const) {
    test(`git ${git}: a dangerous op is refused, says why, and is logged; a read-only one runs`, async ($, on) => {
      const w = repoWorld({ git })
      stage(on, w)
      expect(await refusal($, w, 'Bash', bash('git reset --hard'))).toContain('git could not tell')
      expect(await refusal($, w, 'Bash', bash('git status'))).toBeUndefined()
      expect(w.log.map(line => [line.guard, line.op])).toEqual([['shared-tree-git', 'git reset --hard']])
    })
  }

  test('git hanging: checkout of a file is refused within the 7 s the git calls share, each call cut at 5 s', async ($, on) => {
    const w = repoWorld({ git: 'hanging' })
    const start = w.now
    stage(on, w)
    expect(await refusal($, w, 'Bash', bash('git checkout a.swift'))).toContain('git could not tell')
    expect(w.now - start).toBe(7_000)
  })

  test('an unwritable log changes no refusal', async ($, on) => {
    const w = repoWorld({ isLogWritable: false })
    stage(on, w)
    expect(await refusal($, w, 'Bash', bash('git stash'))).toBe(
      'Blocked on the shared main worktree: `git stash` would take away uncommitted changes from other sessions or the user. ' +
        'Undo your own edit with a reverse Edit; for a clean baseline open a temporary worktree. Linked worktrees are exempt.',
    )
  })

  test('an unwritable log and no git: still refused', async ($, on) => {
    const w = repoWorld({ isLogWritable: false, git: 'missing' })
    stage(on, w)
    expect(await refusal($, w, 'Bash', bash('git stash'))).toContain('git could not tell')
  })
})

describe('shared-tree git guard: the sharedTreeGitGuard option', () => {
  test('false lets git stash through', { options: { sharedTreeGitGuard: false } }, async ($, on) => {
    expect(await run($, on, 'git stash', MAIN)).toBeUndefined()
  })

  test('true refuses it', { options: { sharedTreeGitGuard: true } }, async ($, on) => {
    expect(await run($, on, 'git stash', MAIN)).toBeDefined()
  })

  test('left unset refuses it', async ($, on) => {
    expect(await run($, on, 'git stash', MAIN)).toBeDefined()
  })
})

describe('the guard hook failing', () => {
  test('lets the call through and leaves one debug line', async ($, on) => {
    const w = repoWorld({ cwd: '' })
    stage(on, w)
    expect(await refusal($, w, 'Bash', bash('git stash'))).toBeUndefined()
    expect(w.debug.filter(line => line.startsWith('harness: classic.PreToolUse hook failed'))).toHaveLength(1)
  })
})
