#!/usr/bin/env python3
"""harness hooks 的变异测试:坏输入被拦,好输入(对照组)放行,输入异常时报出来而不是静默。

跑法:python3 plugins/harness/hooks/test_hooks.py   (用 hooks.json 里写的解释器跑各 hook)
"""
import json
import os
import shutil
import pathlib
import re
import subprocess
import sys
import tempfile

HOOKS = pathlib.Path(__file__).resolve().parent
GUARD = HOOKS / "guard-shared-tree-git.py"
SECRET = HOOKS / "guard-secret-files.py"
HOOKS_JSON = HOOKS / "hooks.json"
failures = []
SCRATCH_HOME = tempfile.TemporaryDirectory()  # hook 的拦截日志默认写这里,不碰真实 ~/.claude


def interpreter(script):
    for groups in json.loads(HOOKS_JSON.read_text())["hooks"].values():
        for group in groups:
            for hook in group["hooks"]:
                if script.name in hook["command"]:
                    return shutil.which(hook["command"].split()[0])
    sys.exit(f"{script.name} 没挂在 {HOOKS_JSON} 里")


def run(script, stdin, env=None, home=None):
    env = dict(env or os.environ, HOME=home or SCRATCH_HOME.name)
    p = subprocess.run([interpreter(script), str(script)], input=stdin, capture_output=True, text=True,
                       timeout=10, env=env)
    return p.returncode, p.stdout, p.stderr


def expect(name, got, want):
    print(("ok  " if got == want else "FAIL"), name, "" if got == want else f"(得到 {got},应为 {want})")
    if got != want:
        failures.append(name)


def guard(cmd, cwd):
    return run(GUARD, json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": cwd}))[0]


with tempfile.TemporaryDirectory() as tmp:
    main, wt, plain = f"{tmp}/repo", f"{tmp}/repo-wt", f"{tmp}/plain"
    os.makedirs(plain)
    g = lambda *a: subprocess.run(["git", *a], check=True, capture_output=True)
    g("init", "-q", main); g("-C", main, "commit", "-q", "--allow-empty", "-m", "x")
    g("-C", main, "worktree", "add", "-q", "--detach", wt)

    # 该拦的(主树)
    for cmd in ["git checkout -- a.swift", "git checkout HEAD -- a.swift", "git checkout .",
                "git restore a.swift", "git restore --staged --worktree a.swift", "git stash", "git stash push -- a",
                "git reset --hard", "git commit -q --amend -m x", "git status && git checkout -- a",
                f"cd {main} && git stash", f"git -C {main} checkout -- a"]:
        expect(f"主树拦 [{cmd}]", guard(cmd, main), 2)
    expect("worktree 里 -C 指向主树也拦", guard(f"git -C {main} reset --hard", wt), 2)
    expect("变量 cd 到主树也拦", guard(f'W={main}; cd "$W" && git checkout -- a', wt), 2)
    # 外审(codex + grok)报出的绕过写法
    open(f"{main}/a.swift", "w").close()
    for cmd in ['git commit --amend -m "fix; wording"', "git \\\n  reset --hard",
                "git -c core.quotepath=false reset --hard", "git --no-pager stash",
                "/usr/bin/git reset --hard", "env git reset --hard", "sudo -E git stash",
                "if true; then git reset --hard; fi", "cd /no/such/dir || git reset --hard",
                "cd /no/such/dir; git stash", "echo $(git stash)", "cat <<EOF\n$(git reset --hard)\nEOF",
                "git restore --staged -SW a.swift", "git checkout a.swift", "git checkout HEAD a.swift",
                "git checkout --ours a.swift", "git checkout -f main", "git checkout --force main"]:
        expect(f"主树拦 [{cmd.splitlines()[0]}]", guard(cmd, main), 2)
    expect("MAIN 在进程环境里,从 worktree -C 过去也拦",
           run(GUARD, json.dumps({"tool_input": {"command": 'git -C "$MAIN_REPO" reset --hard'}, "cwd": wt}),
               dict(os.environ, MAIN_REPO=main))[0], 2)
    expect("GIT_WORK_TREE 指向主树也拦", guard(f"GIT_WORK_TREE={main} git checkout -- a.swift", wt), 2)
    expect("目录无法确定时危险操作拦", guard('cd "$(mktemp -d)" && git stash', wt), 2)
    # 第二轮外审(codex)
    expect("cd 到未知目录后 -C 绝对路径到主树也拦", guard(f'cd "$(mktemp -d)" && git -C {main} reset --hard', wt), 2)
    expect("子 shell 里的 cd 不影响外层", guard(f"(cd {wt} && git status); git reset --hard", main), 2)
    expect("GIT_WORK_TREE 优先于 -C", guard(f"GIT_WORK_TREE={main} git -C {wt} reset --hard", wt), 2)
    expect("export 的 GIT_WORK_TREE 生效", guard(f"export GIT_WORK_TREE={main}; git reset --hard", wt), 2)
    expect("checkout 通配 pathspec 拦", guard("git checkout '*.swift'", main), 2)
    expect("sudo -n 不吞掉 git", guard("sudo -n git reset --hard", main), 2)
    expect("nice -n 的参数不当成命令", guard("nice -n 5 git reset --hard", main), 2)
    expect("cd 到未知目录后 -C 绝对路径到 worktree 放行", guard(f'cd "$(mktemp -d)" && git -C {wt} reset --hard', main), 0)
    # 第二轮外审(grok)
    open(f"{main}/tracked.swift", "w").close()
    g("-C", main, "add", "tracked.swift"); g("-C", main, "commit", "-q", "-m", "t")
    os.remove(f"{main}/tracked.swift")
    g("-C", main, "branch", "feat")
    expect("checkout 已删除的跟踪文件拦", guard("git checkout tracked.swift", main), 2)
    expect("${VAR:-默认} 展开", run(GUARD, json.dumps({"tool_input": {"command": 'cd "${MAIN_REPO:-.}" && git checkout -- a'},
                                                  "cwd": wt}), dict(os.environ, MAIN_REPO=main))[0], 2)
    expect("${未设置:-主树} 取默认值", guard(f'cd "${{NO_SUCH_VAR_X:-{main}}}" && git stash', wt), 2)
    expect("${未设置:-worktree} 取默认值后放行", guard(f'cd "${{NO_SUCH_VAR_X:-{wt}}}" && git stash', main), 0)
    expect("嵌套命令替换里的 git 拦", guard('echo "$(git stash -m "$(date +%F)")"', main), 2)
    expect("cd 之后的命令替换按新目录判", guard(f'cd {main} && echo "$(git stash)"', wt), 2)
    expect("cd - 回到主树", guard("cd /tmp && cd - && git reset --hard", main), 2)
    expect("xargs 里的 git 拦", guard("git diff --name-only | xargs git checkout --", main), 2)
    expect("find -exec 里的 git 拦", guard("find . -name '*.swift' -exec git checkout -- {} +", main), 2)
    expect("bash -c 里的 git 拦", guard("bash -c 'git stash'", main), 2)
    expect("env -u 不吞掉 git", guard("env -u GIT_DIR git checkout -- a.swift", main), 2)
    # 第三轮外审(codex + grok)
    for cmd in ["git clean -fd", "git switch --discard-changes main", "git switch -f main",
                "git status # inspect\ngit reset --hard", "bash -lc 'git reset --hard'",
                f"cd {main} && git checkout tracked.swift | head"]:
        expect(f"主树拦 [{cmd.splitlines()[0]}]", guard(cmd, main), 2)
    expect("-C 紧贴路径", guard(f"git -C{main} reset --hard", wt), 2)
    expect("env -C 到主树", guard(f"env -C {main} git reset --hard", wt), 2)
    expect("目录未知时 checkout 文件拦", guard('cd "$(git rev-parse --show-toplevel)" && git checkout tracked.swift', main), 2)
    expect("管道后 && cd 到主树", guard(f"git diff | head && cd {main} && git checkout -- a.swift", wt), 2)
    expect("cd 主树 && … | head", guard(f"cd {main} && git stash | head", wt), 2)
    for cmd in ["git clean -n", "git clean --dry-run -d", "git switch main", "git restore -h", "git stash --help",
                "git stash create", "# echo \"$(git stash)\"\ngit status",
                'cd "$(git rev-parse --show-toplevel)" && git checkout feat']:
        expect(f"主树放行 [{cmd.splitlines()[0]}]", guard(cmd, main), 0)
    expect("cd 进 worktree 后的命令替换放行", guard(f'cd {wt} && echo "$(git stash)"', wt), 0)
    expect("find -exec 只读命令放行", guard("find . -name '*.swift' -exec grep -l x {} +", main), 0)
    expect("bash -c 只读 git 放行", guard("bash -c 'git status'", main), 0)
    # 第四轮外审(codex 4f8f)
    expect("&& 后的 cd 可能不跑,按原目录也判", guard("false && cd /tmp; git reset --hard", main), 2)
    expect("|| 后的 cd 可能不跑,后面 && 也按原目录判", guard(f"true || cd {wt} && git reset --hard", main), 2)
    expect("&& 链里 cd 跑过才轮到 git,按 cd 目录判放行", guard(f"true && cd {wt} && git reset --hard", main), 0)
    inherited = dict(os.environ, GIT_WORK_TREE=main)
    on_wt = lambda cmd: json.dumps({"tool_input": {"command": cmd}, "cwd": wt})
    expect("继承的 GIT_WORK_TREE 指向主树,从 worktree 也拦", run(GUARD, on_wt("git reset --hard"), inherited)[0], 2)
    expect("unset 掉继承的 GIT_WORK_TREE 放行", run(GUARD, on_wt("unset GIT_WORK_TREE; git reset --hard"), inherited)[0], 0)
    expect("env -u 掉继承的 GIT_WORK_TREE 放行", run(GUARD, on_wt("env -u GIT_WORK_TREE git reset --hard"), inherited)[0], 0)
    for cmd in ["git clean -fd -enode_modules", "git clean -fd -e -n", "git restore -sSTAGING a.swift",
                "git restore -s STAGING -W a.swift"]:
        expect(f"选项值里的字母不当开关,主树拦 [{cmd}]", guard(cmd, main), 2)
    for cmd in ["git checkout -bfeature/fix", "git switch -cfix", "git switch -C fix-it", "git clean -nd -efoo",
                "git restore -SsHEAD a.swift"]:
        expect(f"选项值里的字母不当开关,主树放行 [{cmd}]", guard(cmd, main), 0)
    g("-C", main, "config", "alias.nuke", "reset --hard")
    for cmd in ['git -c alias.wipe="reset --hard" wipe', "git -c alias.Wipe='reset --hard' wipe",
                "git -c alias.w2=wipe -c alias.wipe='reset --hard' w2", "git nuke",
                "git -c alias.sh='!git reset' sh --hard", "git -c alias.sh='!f() { git stash; }; f' sh"]:
        expect(f"git alias 展开后判,主树拦 [{cmd}]", guard(cmd, main), 2)
    for cmd in ["git -c alias.st=status st", "git -c alias.sh='!git status' sh", "git -c alias.status='reset --hard' status"]:
        expect(f"git alias 展开后判,主树放行 [{cmd}]", guard(cmd, main), 0)
    expect("配置里的 alias 在 worktree 放行", guard("git nuke", wt), 0)

    # 对照组(放行)
    for cmd in ["git status", "git stash list", "git stash show -p", "git restore --staged a.swift",
                "git checkout main", "git reset HEAD~1", "git commit -m x", 'echo "git stash"',
                "grep -n 'git checkout --' notes.md", "python3 - <<'EOF'\nimport os\nos.system('git stash')\nEOF",
                "cat > undo.sh <<'EOF'\ngit stash\ngit checkout -- a\nEOF\nchmod +x undo.sh"]:
        expect(f"主树放行 [{cmd.splitlines()[0]}]", guard(cmd, main), 0)
    for cmd in ['echo "a; git stash; b"', "git checkout -b feature/x", "git checkout -", "git checkout HEAD~1",
                "git -c color.ui=never status", "git --no-pager log -1", "cd /no/such/dir || echo miss",
                "cat > x.sh <<EOF\ngit stash\nEOF", "python3 - <<'EOF'\nprint('$(git stash)')\nEOF",
                "echo '$(git stash)'", "grep -n '`git reset --hard`' notes.md", "nice -n 5 git status"]:
        expect(f"主树放行 [{cmd}]", guard(cmd, main), 0)
    for cmd in ["git checkout -- a.swift", "git stash", "git reset --hard", "git commit --amend -m x"]:
        expect(f"worktree 放行 [{cmd}]", guard(cmd, wt), 0)
    expect("cd 进 worktree 放行", guard(f"cd {wt} && git checkout -- a", main), 0)
    expect("变量 cd 进 worktree 放行", guard(f'W={wt}; cd "$W" && git stash', main), 0)
    expect("非仓库目录放行", guard("git checkout -- a", plain), 0)

    # 拦截日志:拦截追加一行 deny,放行不写;git 跑不了时危险操作照样拦(说明原因)并写 deny;日志写不了不改结果
    home, nogit, badgit = f"{tmp}/home", f"{tmp}/nogit", f"{tmp}/badgit"
    os.makedirs(nogit)
    os.makedirs(badgit)
    pathlib.Path(badgit, "git").write_text("#!/bin/sh\nexit 1\n")
    os.chmod(f"{badgit}/git", 0o755)
    log = pathlib.Path(home, ".claude/harness/guard.jsonl")
    entries = lambda: [json.loads(l) for l in log.read_text().splitlines()] if log.exists() else []
    event = lambda cmd: json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": main, "agent_id": "a1"})
    fields = lambda e: ({k: e.get(k) for k in ("guard", "decision", "op", "cwd", "agent_id")}, type(e.get("at")))
    denied = run(GUARD, event("git stash"), home=home)
    expect("日志 拦截写一行 deny", (denied[0], [fields(e) for e in entries()]),
           (2, [({"guard": "shared-tree-git", "decision": "deny", "op": "git stash", "cwd": main, "agent_id": "a1"}, int)]))
    expect("日志 放行不写", (run(GUARD, event("git status"), home=home)[0], len(entries())), (0, 1))
    no_git = dict(os.environ, PATH=nogit)
    got = run(GUARD, event("git stash"), no_git, home=home)
    expect("日志 git 跑不了时危险操作拦、说明原因并写 deny",
           (got[0], "git could not tell" in got[2], [fields(e) for e in entries()[1:]]),
           (2, True, [({"guard": "shared-tree-git", "decision": "deny", "op": "git stash", "cwd": main,
                        "agent_id": "a1"}, int)]))
    expect("日志 git 跑不了时只读命令不写", (run(GUARD, event("git status"), no_git, home=home)[0], len(entries())), (0, 2))
    got = run(GUARD, event("git reset --hard"), dict(os.environ, PATH=f"{badgit}:{os.environ['PATH']}"), home=home)
    expect("git 探测失败(非零退出)时 reset --hard 拦并说明原因", (got[0], "git could not tell" in got[2]), (2, True))
    expect("git 探测失败时只读命令放行",
           run(GUARD, event("git status"), dict(os.environ, PATH=f"{badgit}:{os.environ['PATH']}"), home=home)[0], 0)
    code = run(GUARD, json.dumps({"tool_input": {"command": f"git -C {main} stash"}}), home=home)[0]
    last = (entries() or [{}])[-1]
    expect("日志 缺 cwd/agent_id 记 null", (code, len(entries()), last.get("cwd", 0), last.get("agent_id", 0)),
           (2, 4, None, None))
    readonly = f"{tmp}/home-ro"
    os.makedirs(readonly)
    open(f"{readonly}/.claude", "w").close()
    expect("日志写不了 拦截结果不变", run(GUARD, event("git stash"), home=readonly), denied)
    expect("日志写不了 git 跑不了时照样拦", run(GUARD, event("git stash"), no_git, home=readonly)[0], 2)

    # sharedTreeGitGuard 开关:false/0 放行,true 和未设置照拦
    stash = json.dumps({"tool_name": "Bash", "tool_input": {"command": "git stash"}, "cwd": main})
    unset = {k: v for k, v in os.environ.items() if k != "CLAUDE_PLUGIN_OPTION_SHAREDTREEGITGUARD"}
    for value, want in [("false", (0, "", "")), ("FALSE", (0, "", "")), ("0", (0, "", ""))]:
        got = run(GUARD, stash, dict(unset, CLAUDE_PLUGIN_OPTION_SHAREDTREEGITGUARD=value))
        expect(f"开关={value} 放行且无输出", got, want)
    expect("开关=true 照拦", run(GUARD, stash, dict(unset, CLAUDE_PLUGIN_OPTION_SHAREDTREEGITGUARD="true"))[0], 2)
    expect("开关未设置照拦", run(GUARD, stash, unset)[0], 2)

    # 输入异常:不拦,但要报出来(exit 1 = 非阻断错误,transcript 显示 hook error)
    for label, stdin in [("非法 JSON", "{not json"), ("空输入", ""), ("缺 command", '{"tool_input": {}}')]:
        code, _, err = run(GUARD, stdin)
        expect(f"guard {label} → exit 1 且有 stderr", (code, bool(err.strip())), (1, True))

# guard-secret-files:临时 HOME 里放假密钥文件,不碰本机真实配置
with tempfile.TemporaryDirectory() as tmp:
    home, proj = f"{tmp}/home", f"{tmp}/proj"
    for rel in [".claude.json", ".claude.json.backup", ".claude/backups/x.json", ".claude/settings.json",
                ".claude/settings.local.json", ".claude/CLAUDE.md", ".codex/config.toml", ".codex/auth.json",
                ".openviking/x", ".grok/auth.json", "harness/a.md", "../proj/.claude/settings.json"]:
        os.makedirs(os.path.dirname(f"{home}/{rel}"), exist_ok=True)
        pathlib.Path(home, rel).write_text("fake\n")
    os.symlink(f"{home}/.codex/auth.json", f"{proj}/link.json")
    secret = lambda tool, inp, cwd=home: run(SECRET, json.dumps({"tool_name": tool, "tool_input": inp, "cwd": cwd}),
                                             home=home)
    sh = lambda cmd: secret("Bash", {"command": cmd})[0]

    for path in [f"{home}/.claude.json", f"{home}/.claude/settings.json", f"{home}/.claude.json.backup",
                 f"{home}/.claude/backups/x.json", f"{home}/.codex/config.toml", f"{proj}/link.json",
                 "~/.claude/settings.local.json", "$HOME/.codex/config.toml.bak", "${HOME}/.codex/auth.json",
                 f"{home}/.openviking/x", f"{home}/.grok/auth.json", f"{home}/.claude/file-history/s/a@v1", f"{home}/.codex/shell_snapshots/a.sh", ".claude.json", "/srv/ov/ovcli.conf", "ov.conf"]:
        expect(f"secret 拦 Read [{path}]", secret("Read", {"file_path": path})[0], 2)
    for tool in ["Edit", "MultiEdit", "Write"]:
        expect(f"secret 拦 {tool} ~/.claude/settings.json", secret(tool, {"file_path": f"{home}/.claude/settings.json"})[0], 2)
    for path in [f"{home}/.claude/CLAUDE.md", f"{proj}/.claude/settings.json", f"{home}/harness/a.md", "prov.conf"]:
        expect(f"secret 放行 Read [{path}]", secret("Read", {"file_path": path})[0], 0)
    expect("secret 放行 相对路径 .claude/settings.json(项目里)", secret("Read", {"file_path": ".claude/settings.json"}, proj)[0], 0)

    for path in [f"{home}/.codex", home, f"{home}/.claude", f"{home}/.claude/backups", f"{home}/.openviking",
                 f"{home}/.grok", tmp, f"{home}/.claude.json"]:
        expect(f"secret 拦 Grep content [{path}]", secret("Grep", {"pattern": "k", "path": path, "output_mode": "content"})[0], 2)
    expect("secret 拦 Grep content 不给 path、cwd 是 HOME", secret("Grep", {"pattern": "k", "output_mode": "content"})[0], 2)
    for inp in [{"path": home, "output_mode": "files_with_matches"}, {"path": home, "output_mode": "count"},
                {"path": home}, {"path": f"{home}/harness", "output_mode": "content"}]:
        expect(f"secret 放行 Grep {inp}", secret("Grep", dict(inp, pattern="k"))[0], 0)

    for cmd in ["cat ~/.claude.json", "jq .env ~/.claude/settings.json", "ls ~/.codex && cat ~/.codex/config.toml",
                "ssh host cat /srv/openviking/ovcli.conf", "bash -c 'head ~/.codex/auth.json'",
                f"python3 - <<'EOF'\nprint(open('{home}/.claude.json').read())\nEOF",
                "diff $HOME/.claude/settings.json /tmp/x", "grep token ~/.codex/config.toml", "rg -n key ~/.openviking/", "rg -L key ~/.codex/", "grep -rn token ~/.codex", "grep -R key $HOME",
                "sudo -n tail ~/.grok/auth.json", "X=1 less ~/.claude/settings.local.json", "echo \"$(cat ~/.claude.json)\"",
                "cp ~/.claude/backups/a.json /tmp/", "cat ov.conf", "cat ~/.codex/shell_snapshots/a.sh", "rg KEY ~/.claude/file-history", "env", "env | sort", "env -0", "printenv",
                "printenv OPENVIKING_API_KEY", "printenv GH_TOKEN", "export", "export -p", "declare -x", "declare -p",
                "typeset -x", "set", "true; set", "cat <<'EOF' | bash\ncat ~/.claude.json\nEOF",
                "cat <<EOF\n$(cat ~/.claude.json)\nEOF", "gh pr create --title t --body-file ~/.codex/config.toml"]:
        expect(f"secret 拦 Bash [{cmd.splitlines()[0]}]", sh(cmd), 2)
    for cmd in ["stat ~/.claude.json", "grep -c token ~/.codex/config.toml", "ls -la ~/.openviking",
                "chmod 600 ~/.claude/settings.json", "env -i PATH=/usr/bin ls", "printenv HOME", "cat README.md",
                'git commit -m "docs: mention settings.json"', "cat prov.conf", "grep -l key ~/.claude.json",
                "rg --files-with-matches key ~/.codex/", "grep -qi token ~/.codex/auth.json", "wc -c ~/.claude.json",
                "test -f ~/.codex/auth.json && echo yes", "env FOO=1 ls", "grep -rn todo ~/proj", "grep -rl token ~/.codex", "set -e", "export A=1", "declare -x A=1",
                "git commit -m \"$(cat <<'EOF'\ndocs: explain the hook in ~/.claude/settings.json\nEOF\n)\"",
                "cat > docs/setup.md <<'EOF'\nAdd the hook to ~/.claude/settings.json\nEOF",
                "gh pr create --title t --body 'Reads ~/.codex/config.toml only via stat'"]:
        expect(f"secret 放行 Bash [{cmd.splitlines()[0]}]", sh(cmd), 0)

    code, _, err = secret("Read", {"file_path": f"{home}/.claude.json"})
    expect("secret 拒绝原因说明文件和替代做法", (code, "API keys" in err, ".claude.json" in err, "Grep tool" in err),
           (2, True, True, True))
    code, _, err = secret("Bash", {"command": "env | sort"})
    expect("secret env 拒绝原因说明改打一个变量", (code, "named variable" in err), (2, True))
    log = pathlib.Path(home, ".claude/harness/guard.jsonl")
    expect("secret 日志记 guard=secret-files 的 deny",
           {(e["guard"], e["decision"]) for e in map(json.loads, log.read_text().splitlines())},
           {("secret-files", "deny")})
    for label, stdin in [("非法 JSON", "{not json"), ("缺 tool_input", '{"tool_name": "Read"}'),
                         ("缺 file_path", '{"tool_name": "Read", "tool_input": {}}')]:
        code, _, err = run(SECRET, stdin, home=home)
        expect(f"secret {label} → exit 1 且有 stderr", (code, bool(err.strip())), (1, True))

# Any function hook on tool.call denies every Bash in isolation: worktree subagents (claude-code#92533).
p = subprocess.run(["claude", "plugin", "validate", str(HOOKS.parent)], capture_output=True, text=True, timeout=60)
hook_lines = [l for l in p.stdout.splitlines() if " hooks: " in l]
expect("validate 通过且列出 hooks 行", (p.returncode, bool(hook_lines)), (0, True))
expect("函数 hook 不挂 tool.call", any("tool.call" in l for l in hook_lines), False)


def tool_call_violations(source):
    """源码里会碰到 Bash 的 on('tool.call', …) 和 on('*', …)。matcher 的 tool 只认字面量字符串(或其数组)且不含 Bash。"""
    found = []
    for m in re.finditer(r"""\bon\(\s*(['"])(tool\.call|\*)\1\s*""", source):
        call = source[m.start():source.find("\n", m.start())]
        if m.group(2) == "*":
            found.append(f"on('*'): {call}")
            continue
        rest = source[m.end():]
        if not re.match(r",\s*\{", rest):
            found.append(f"tool.call 无 matcher: {call}")
            continue
        start, depth = rest.index("{"), 0
        for i, c in enumerate(rest[start:], start):
            depth += {"{": 1, "}": -1}.get(c, 0)
            if depth == 0:
                break
        tool = re.search(r"\btool\s*:\s*(.*)", rest[start + 1:i], re.S)
        value = tool.group(1).lstrip() if tool else ""
        if value.startswith("["):
            items = value[1:value.find("]")].split(",")
        else:
            items = [re.split(r"[,}\n]", value)[0]]
        literals = [re.fullmatch(r"""\s*(['"])([^'"]*)\1\s*""", s) for s in items if s.strip()]
        if not tool or not literals or not all(lit and "Bash" not in lit.group(2) for lit in literals):
            found.append(f"tool.call 可能匹配 Bash: {call}")
    return found


PLUGINS = HOOKS.parent.parent
sources = sorted(p for p in PLUGINS.glob("*/hooks/**/*") if p.suffix in (".ts", ".tsx"))
expect("#92533 扫到各插件的 hooks 源码(导出版另有拆出的插件)", {"dashboard", "harness", "mm"} <= {p.relative_to(PLUGINS).parts[0] for p in sources},
       True)
expect("#92533 hooks 源码无覆盖 Bash 的 tool.call 或 on('*')",
       [v for p in sources for v in tool_call_violations(p.read_text())], [])
mm_register = (PLUGINS / "mm/hooks/register.ts").read_text()
expect("#92533 mm 的 tool.call { tool: 'Skill' } 判合规",
       ("on('tool.call', { tool: 'Skill' }" in mm_register, tool_call_violations(mm_register)), (True, []))
for hostile in ["on('tool.call', { tool: 'Bash' }, async ($, e, next) => next())",
                'on("tool.call", async ($, e, next) => next())',
                "on('tool.call', { input: { command: /git/ } }, h)",
                "on('tool.call', { tool: /^Ba/ }, h)",
                "on('tool.call', { tool: ['Skill', 'Bash'] }, h)",
                "on('tool.call', { tool: TOOL }, h)",
                "on('*', h)"]:
    got = tool_call_violations(f"export default ({{ on }}) => {{\n  {hostile}\n}}\n")
    expect(f"#92533 对照判违规 [{hostile}]", len(got), 1)

print(f"\n{'全部通过' if not failures else f'{len(failures)} 条失败'}")
sys.exit(1 if failures else 0)
