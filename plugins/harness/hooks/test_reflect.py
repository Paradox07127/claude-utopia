#!/usr/bin/env python3
"""reflect.py 的测试:造一份事件账本和会话记录,查各项计数、≥2 次才进候选、证据片段与落点。

跑法:python3 plugins/harness/hooks/test_reflect.py
"""
import datetime, json, os, pathlib, subprocess, sys, tempfile

HOOKS = pathlib.Path(__file__).resolve().parent
REFLECT = HOOKS / "reflect.py"
failures = []


def expect(name, got, want):
    print(("ok  " if got == want else "FAIL"), name, "" if got == want else f"(得到 {got},应为 {want})")
    if got != want: failures.append(name)


now = datetime.datetime.now(datetime.timezone.utc)
at = lambda minutes: (now - datetime.timedelta(minutes=600 - minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
today = datetime.date.today().isoformat()
old = (datetime.date.today() - datetime.timedelta(days=10)).isoformat()


class Transcript:
    """一个会话记录文件的行:prompt、带文字的回复、工具调用与结果。"""
    def __init__(self, session):
        self.session, self.rows, self.n = session, [], 0

    def prompt(self, t, text):
        self.rows.append({"type": "user", "timestamp": at(t), "sessionId": self.session, "message": {"role": "user", "content": text}})

    def reply(self, t, text):
        self.n += 1
        self.rows.append({"type": "assistant", "timestamp": at(t), "sessionId": self.session,
                          "message": {"id": f"m{self.n}", "content": [{"type": "text", "text": text}]}})

    def call(self, t, name, tool_input, error=None):
        self.n += 1
        tid = f"toolu_{self.session}_{self.n}"
        self.rows.append({"type": "assistant", "timestamp": at(t), "sessionId": self.session,
                          "message": {"id": f"m{self.n}", "content": [{"type": "tool_use", "id": tid, "name": name, "input": tool_input}]}})
        self.rows.append({"type": "user", "timestamp": at(t), "sessionId": self.session, "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tid, "is_error": error is not None, "content": error or "ok"}]}})

    def write(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in self.rows))


def blocked(rule_text, in_process=False):
    # 进程内守卫(guard-secret.ts)的拒绝只带理由文本,没有脚本路径
    if in_process: return f"Blocked: {rule_text}"
    return f'PreToolUse:Bash hook error: [python3 "/x/hooks/guard-secret-files.py"]: Blocked: {rule_text}'


def event(t, session, rule, target, day=None):
    return {"timestamp": at(t), "event_name": "guard.block", "severity_text": "WARN",
            "attributes": {"session.id": session, "rule.id": rule, "rule.name": "guard-secret-files", "tool": "Bash", "target": target}}


ENGLISH = "I updated the configuration loader and reran the whole suite; everything passes now and nothing else changed."

with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    projects, events = root / "projects/-p", root / "events/-p"

    s1 = Transcript("s1")
    s1.prompt(0, "帮我看看配置加载为什么慢")
    s1.call(1, "Bash", {"command": "python3 -c 'print(set())'"}, blocked("`set` would print environment variables"))
    s1.call(2, "Bash", {"command": "python3 -c 'print(set([1]))'"})
    s1.reply(3, ENGLISH)
    s1.prompt(10, "不要改 agents/worker.md:20 那行")
    s1.call(11, "Bash", {"command": "grep -n 'export' notes.md"},
            blocked("`export` would print environment variables into the transcript, and some of them hold API keys", in_process=True))
    s1.call(12, "Bash", {"command": "grep -n export notes.md"})
    s1.reply(13, "好的，那一行保持原样，只改了 loader 的缓存。")
    s1.prompt(20, "别再催我提交了")
    s1.call(21, "Bash", {"command": "cat ~/.codex/config.toml"}, blocked("`cat` would put the contents"))
    s1.call(22, "Bash", {"command": "ls -la ~/.codex"})
    s1.reply(23, ENGLISH + " " + ENGLISH)
    s1.prompt(30, "不错")
    s1.reply(31, "```python\nprint('a long block of code that is not prose at all and has many letters in it')\n```\n改好了。")
    s1.prompt(40, "<task-notification>agent finished</task-notification>")
    s1.reply(41, "The worker finished its task and all the acceptance commands passed without any failures.")
    s1.write(projects / "s1.jsonl")

    def subagent(name, agent_type, turns, description="survey"):
        sub = Transcript("s1")
        for i in range(turns): sub.reply(50 + i // 10, f"step {i}")
        sub.write(projects / f"s1/subagents/agent-{name}.jsonl")
        (projects / f"s1/subagents/agent-{name}.meta.json").write_text(json.dumps({"agentType": agent_type, "description": description}))
    subagent("a1", "researcher", 81)
    subagent("a2", "researcher", 85)
    subagent("a3", "worker", 81)
    subagent("a4", "researcher", 80)

    s2 = Transcript("s2")
    s2.prompt(0, "stop polling with sleep")
    s2.reply(1, ENGLISH)
    s2.prompt(5, "No, use the other file")
    s2.reply(6, ENGLISH)
    s2.write(projects / "s2.jsonl")

    # worktree 里开的会话记录在 <项目编码>--claude-worktrees-<名>/ 下;只是前缀相同的别的项目不算
    s3 = Transcript("s3")
    s3.prompt(0, "别在主树里提交")
    s3.write(root / "projects/-p--claude-worktrees-agent-x/s3.jsonl")
    s4 = Transcript("s4")
    s4.prompt(0, "别动这个项目")
    s4.write(root / "projects/-p-other/s4.jsonl")

    unnamed = event(11, "s1", "env-dump", "grep -n 'export' notes.md")
    del unnamed["attributes"]["session.id"]
    # 一个会话的行分在各写入方的文件里;没有 session.id 的行按文件名第一个 . 之前归会话
    lines = {f"{today}/s1.jsonl": [event(21, "s1", "secret-file", "cat ~/.codex/config.toml")],
             f"{today}/s1.guard.jsonl": [event(1, "s1", "env-dump", "python3 -c 'print(set())'"), unnamed],
             f"{old}/s1.jsonl": [event(0, "s1", "secret-file", "cat ~/.claude.json")]}
    for rel, rows in lines.items():
        (events / rel).parent.mkdir(parents=True, exist_ok=True)
        (events / rel).write_text("".join(json.dumps(r) + "\n" for r in rows))

    env = dict(os.environ, EVENTS_ROOT=str(root / "events"), PROJECTS_ROOT=str(root / "projects"))
    run = lambda *args: subprocess.run([sys.executable, str(REFLECT), "--project", "-p", *args], capture_output=True, text=True, env=env)
    p = run("--json")
    expect("--json 退出 0", (p.returncode, p.stderr), (0, ""))
    out = json.loads(p.stdout or "{}")
    counts = out.get("counts", {})
    expect("guard.block 按规则计数,10 天前的不算", counts.get("guard_block"), {"env-dump": 2, "secret-file": 1})
    expect("被拦后 2 次调用内换写法跑通算疑似误报,改去 ls 不算,进程内守卫的拒绝也认", counts.get("guard_false_positive"), {"env-dump": 2})
    expect("超过 80 轮的子 agent 按类型计数,80 轮不算", counts.get("subagent_over_turns"), {"researcher": 2, "worker": 1})
    expect("否定式纠正:别/不要/stop/No, 开头,'不错' 不算,worktree 会话也算", counts.get("correction"), 5)
    expect("写过中文的会话里英文回复算违规,代码块不算,纯英文会话不算", counts.get("language"), 3)
    got = sorted((c["kind"], c["key"], c["count"]) for c in out.get("candidates", []))
    expect("≥2 次才进候选", got, [("guard.block", "env-dump", 2), ("guard.false-positive", "env-dump", 2),
                                  ("reply.language", "", 3), ("subagent.over-turns", "researcher", 2), ("user.correction", "", 5)])
    by = {(c["kind"], c["key"]): c for c in out.get("candidates", [])}
    line = next(i for i, l in enumerate((HOOKS / "guard-secret.ts").read_text().splitlines(), 1) if l.startswith("function envDump("))
    expect("守卫规则的落点指向 guard-secret.ts", by.get(("guard.block", "env-dump"), {}).get("target"),
           f"plugins/harness/hooks/guard-secret.ts:{line}")
    expect("证据里点名的 file:line 当落点", by.get(("user.correction", ""), {}).get("target"), "agents/worker.md:20")
    expect("没点名就没有落点", by.get(("reply.language", ""), {}).get("target"), None)
    ev = by.get(("guard.false-positive", "env-dump"), {}).get("evidence", [])
    expect("证据带会话、时间、片段", [sorted(e) for e in ev], [["excerpt", "session", "time"]] * 2)
    expect("片段不超过 160 字", max([len(e["excerpt"]) for c in out.get("candidates", []) for e in c["evidence"]], default=0) <= 160, True)
    expect("证据最多 5 条", max([len(c["evidence"]) for c in out.get("candidates", [])], default=0) <= 5, True)
    p = run("--since", (datetime.date.today() + datetime.timedelta(days=1)).isoformat(), "--json")
    expect("--since 之后什么都没有就没有候选", json.loads(p.stdout or "{}").get("candidates"), [])
    p = run()
    expect("不加 --json 打印摘要", (p.returncode, "candidates: 5" in p.stdout), (0, True))

print(f"\n{'全部通过' if not failures else f'{len(failures)} 条失败'}")
sys.exit(1 if failures else 0)
