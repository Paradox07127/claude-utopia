#!/usr/bin/env python3
"""mm guard.py 的行为测试:前台 mmrun wait 转后台、*.raw 被拒,对照组原样放行。

跑法:python3 plugins/mm/hooks/test_guard.py
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

GUARD = pathlib.Path(__file__).resolve().parent / "guard.py"
RUN = "/h/.claude/mmruns/20260101-000000-abcd"
SCRATCH = tempfile.TemporaryDirectory()  # guard 的拦截日志写这里,不碰真实 ~/.claude
failures = []


def run(stdin, home=None):
    p = subprocess.run([sys.executable, str(GUARD)], input=stdin, capture_output=True, text=True, timeout=10,
                       env=dict(os.environ, HOME=home or f"{SCRATCH.name}/home"))
    return p.returncode, p.stdout, p.stderr


def expect(name, got, want):
    print(("ok  " if got == want else "FAIL"), name, "" if got == want else f"(得到 {got},应为 {want})")
    if got != want:
        failures.append(name)


def bash(command, **extra):
    """跑一次 Bash 调用,返回 (exit code, 实际生效的 tool_input);没输出 updatedInput 就是原输入。"""
    tool_input = {"command": command, "description": "d", **extra}
    code, out, _ = run(json.dumps({"tool_name": "Bash", "tool_input": tool_input}))
    if code == 0 and out.strip():
        try:
            spec = json.loads(out)["hookSpecificOutput"]
        except (ValueError, KeyError, TypeError):
            return code, "stdout 不是合法的 hookSpecificOutput"
        if spec.get("hookEventName") != "PreToolUse" or "permissionDecision" in spec:
            return code, f"hookSpecificOutput 字段不对:{spec}"
        return code, spec["updatedInput"]
    return code, tool_input


def denied(payload):
    code, _, err = run(json.dumps(payload))
    return code, err.startswith("mm: *.raw is the full event stream") and "`mmrun status <RUNID>`" in err


# 前台 wait 转后台,原字段保留
for cmd in ["mmrun wait 20260101-000000-abcd --timeout 3600", "cd /tmp && mmrun wait",
            "mmrun status; mmrun wait X", "true || ~/.local/bin/mmrun wait X"]:
    code, ti = bash(cmd)
    expect(f"转后台 [{cmd}]", (code, ti.get("run_in_background"), ti.get("command"), ti.get("description")),
           (0, True, cmd, "d"))

# 后台超时覆盖 mmrun 的 --timeout 再加一分钟,上限 2 小时,不缩短已有的
for name, cmd, extra, want in [
    ("前台 --timeout 3600", "mmrun wait X --timeout 3600", {}, 3_660_000),
    ("已后台 --timeout 3600", "mmrun wait X --timeout 3600", {"run_in_background": True}, 3_660_000),
    ("--timeout 9000 封顶", "mmrun wait X --timeout 9000", {"run_in_background": True, "timeout": 60_000}, 7_200_000),
    ("已有更长 timeout 不改", "mmrun wait X --timeout 60", {"run_in_background": True, "timeout": 600_000}, 600_000),
    ("无 --timeout 不设", "mmrun wait X", {}, None),
]:
    code, ti = bash(cmd, **extra)
    expect(f"timeout {name}", (code, ti.get("run_in_background"), ti.get("timeout")), (0, True, want))

# 对照组:已后台且无需改、或 mmrun wait 不在命令位置 → 不输出 updatedInput
for cmd, extra in [("mmrun wait X", {"run_in_background": True}), ("echo mmrun wait", {}),
                   ("mmrun status X", {}), ('grep "mmrun wait" notes.md', {})]:
    code, out, err = run(json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd, **extra}}))
    expect(f"不改 [{cmd}]", (code, out, err), (0, "", ""))

# *.raw 被拒,.out 放行
expect("Read .raw 拒绝", denied({"tool_name": "Read", "tool_input": {"file_path": f"{RUN}/codex.raw"}}), (2, True))
code, out, err = run(json.dumps({"tool_name": "Read", "tool_input": {"file_path": f"{RUN}/codex.out"}}))
expect("Read .out 放行", (code, out, err), (0, "", ""))
for cmd in [f"head -50 {RUN}/codex.raw", 'jq . "$HOME/.claude/mmruns/$RID/grok.raw"',
            "cd ~/.claude/mmruns/20260101-000000-abcd && wc -l *.raw"]:
    expect(f"Bash .raw 拒绝 [{cmd}]", denied({"tool_name": "Bash", "tool_input": {"command": cmd}}), (2, True))
code, out, err = run(json.dumps({"tool_name": "Bash", "tool_input": {"command": f"cat {RUN}/codex.out"}}))
expect("Bash .out 放行", (code, out, err), (0, "", ""))

# 文档推荐的排障命令:整条只是 N ≤ 50 的 tail 才放行
for cmd in ["tail -20 ~/.claude/mmruns/R/codex.raw", f"tail -n 30 {RUN}/codex.raw"]:
    code, out, err = run(json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}}))
    expect(f"有界 tail 放行 [{cmd}]", (code, out, err), (0, "", ""))
for cmd in [f"tail -200 {RUN}/codex.raw", f"tail -n 51 {RUN}/codex.raw", f"tail -20 {RUN}/codex.raw | cat",
            f"cat {RUN}/codex.raw", f"tail -20 {RUN}/codex.raw; cat {RUN}/codex.raw",
            f"tail -20 {RUN}/codex.raw && cat {RUN}/codex.raw", f"tail -20 {RUN}/codex.raw $(cat {RUN}/codex.raw)"]:
    expect(f"非有界 tail 拒绝 [{cmd}]", denied({"tool_name": "Bash", "tool_input": {"command": cmd}}), (2, True))

# 相对路径按 Bash 的 cwd 和 cd 解析:人在 run 目录里也拦,有界 tail 照样放行
for cmd, cwd in [("cat codex.raw", RUN), ("cat ../20261001-000000-aaaa/grok.raw", RUN),
                 ("cat 20260101-000000-abcd/codex.raw", "/h/.claude/mmruns"), ("cd ../.. && cat R/codex.raw", f"{RUN}/x"),
                 ("tail -n 51 codex.raw", RUN), ("wc -l < codex.raw", RUN)]:
    expect(f"cwd 下 .raw 拒绝 [{cmd}]", denied({"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": cwd}), (2, True))
for cmd, cwd in [("tail -n 20 codex.raw", RUN), ("tail -20 codex.raw", RUN), ("cat codex.raw", "/w/project"),
                 ("cat codex.out", RUN)]:
    code, out, err = run(json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": cwd}))
    expect(f"cwd 下放行 [{cmd} @ {cwd}]", (code, out, err), (0, "", ""))

# mmrun wait 只认真正的命令位置:引号里的不算,常见启动器剥掉再认
for cmd in ["env mmrun wait R", "timeout 600 mmrun wait R", "nice -n 5 mmrun wait R", "command mmrun wait R",
            "exec mmrun wait R", "FOO=1 mmrun wait R", "env -u X timeout -s INT 600 mmrun wait R"]:
    code, ti = bash(cmd)
    expect(f"启动器后转后台 [{cmd}]", (code, ti.get("run_in_background"), ti.get("command")), (0, True, cmd))
for cmd in ['echo "example; mmrun wait R"', "echo 'x | mmrun wait R'", "timeout 600 echo mmrun wait R"]:
    code, out, err = run(json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}}))
    expect(f"引号里/非命令位置不改 [{cmd}]", (code, out, err), (0, "", ""))

# 引号里的说明文字、写进文件的 heredoc 正文不是要跑的命令;喂给 shell 的 heredoc 正文照查
for cmd in ['git commit -m "mm guard: deny reading ~/.claude/mmruns/<rid>/<model>.raw"',
            "cat > notes.md <<'EOF'\nmmrun wait 20261003-120000-abcd\nEOF"]:
    code, out, _ = run(json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}}))
    expect(f"不拦不改 [{cmd!r}]", (code, out), (0, ""))
for cmd in ["bash <<'EOF'\ntail ~/.claude/mmruns/x/codex.raw\nEOF", "cat ~/.claude/mmruns/x/codex.raw"]:
    expect(f"跑的命令里 .raw 拒绝 [{cmd!r}]", denied({"tool_name": "Bash", "tool_input": {"command": cmd}}), (2, True))

# 坏输入不阻断
expect("非法 JSON 放行", run("{bad"), (0, "", ""))

# 拦截日志:拒绝追加一行 deny,放行和 mmrun wait 转后台不写;日志写不了不改结果
home = f"{SCRATCH.name}/log-home"
log = pathlib.Path(home, ".claude/harness/guard.jsonl")
entries = lambda: [json.loads(l) for l in log.read_text().splitlines()] if log.exists() else []
fields = lambda e: ({k: e.get(k) for k in ("guard", "decision", "op", "cwd", "agent_id")}, type(e.get("at")))
read_raw = json.dumps({"tool_name": "Read", "tool_input": {"file_path": f"{RUN}/codex.raw"}, "cwd": "/w", "agent_id": "a1"})
got = run(read_raw, home)
expect("日志 Read .raw 写一行 deny", (got[0], [fields(e) for e in entries()]),
       (2, [({"guard": "mm-raw", "decision": "deny", "op": "read *.raw", "cwd": "/w", "agent_id": "a1"}, int)]))
run(json.dumps({"tool_name": "Bash", "tool_input": {"command": f"cat {RUN}/codex.raw"}}), home)
expect("日志 Bash .raw 缺 cwd/agent_id 记 null", fields(entries()[-1]) if len(entries()) == 2 else len(entries()),
       ({"guard": "mm-raw", "decision": "deny", "op": "read *.raw", "cwd": None, "agent_id": None}, int))
for payload in [{"tool_name": "Read", "tool_input": {"file_path": f"{RUN}/codex.out"}},
                {"tool_name": "Bash", "tool_input": {"command": "mmrun wait X"}}]:
    run(json.dumps(payload), home)
expect("日志 放行和转后台不写", len(entries()), 2)
readonly = f"{SCRATCH.name}/home-ro"
os.makedirs(readonly)
open(f"{readonly}/.claude", "w").close()
expect("日志写不了 拒绝结果不变", run(read_raw, readonly), got)

# register.ts 的 tool.call 只能带 { tool: … } 匹配器且不匹配 Bash(claude-code#92533)
SOURCE = (GUARD.parent / "register.ts").read_text()
expect("register.ts 有 tool.call(Skill)", "on('tool.call', { tool: 'Skill' }" in SOURCE, True)
expect("register.ts 无不带匹配器的 tool.call", re.search(r"""on\(\s*['"]tool\.call['"]\s*,(?!\s*\{\s*tool:)""", SOURCE), None)
expect("register.ts 无 tool: 'Bash'", re.search(r"""tool:\s*['"]Bash['"]""", SOURCE), None)

print(f"\n{'全部通过' if not failures else f'{len(failures)} 条失败'}")
sys.exit(1 if failures else 0)
