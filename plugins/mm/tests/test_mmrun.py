#!/usr/bin/env python3
"""mmrun 结论抽取的测试:多轮拼接/中途截断的 grok 输出能取到终稿,取不到时报错而不是静默输出空。"""
import atexit, json, os, pathlib, shutil, subprocess, tempfile, threading, time

PLUGIN = pathlib.Path(__file__).resolve().parent.parent
MMRUN = PLUGIN / "bin/mmrun"
SCHEMA = PLUGIN / "mmrun.d/review.schema.json"
FIXTURE = PLUGIN / "tests/fixtures/grok-spliced.out"
failures = []
# 所有调用 mmrun 的环境都从 os.environ 派生:wait 轮询与 __run 重试间隔压到测试尺度
os.environ.update(MMRUN_POLL="0.2", MMRUN_RETRY_SLEEP="0")
# codex 额度检查读本机真实会话:其它用例一律关掉,只在额度一节里打开
os.environ["MMRUN_NO_QUOTA_CHECK"] = "1"
# Tests that fake HOME expect codex profiles under $HOME/.codex; a CODEX_HOME from the caller would redirect them.
os.environ.pop("CODEX_HOME", None)
# Claude Code's Bash tool sets CLAUDECODE=1, which changes mmrun's NEXT/THEN lines; only the tests that check that set it.
os.environ.pop("CLAUDECODE", None)
# Nothing may land in the real ~/.claude/mmruns or ~/.codex: the sandbox sections use TEST_HOME as HOME, every subprocess gets its mmruns.
# Outside the system temp dirs on purpose: fence.sb and the codex profiles allow writes there, so the write-deny checks would pass vacuously.
TEST_HOME = pathlib.Path(os.path.realpath(tempfile.mkdtemp(prefix="mmrun-test-", dir=pathlib.Path.home() / "Library/Caches")))
atexit.register(shutil.rmtree, TEST_HOME, ignore_errors=True)
os.environ["MMRUN_HOME"] = str(TEST_HOME / ".claude/mmruns"); pathlib.Path(os.environ["MMRUN_HOME"]).mkdir(parents=True)
# Real codex reads the real base config; the mm/room/mmwt layers mmrun generates go next to this copy.
TEST_HOME.joinpath(".codex").mkdir()
if pathlib.Path.home().joinpath(".codex/config.toml").exists():
    shutil.copy(pathlib.Path.home() / ".codex/config.toml", TEST_HOME / ".codex/config.toml")

def expect(name, got, want):
    print(("ok  " if got == want else "FAIL"), name, "" if got == want else f"(得到 {got!r},应为 {want!r})")
    if got != want: failures.append(name)

# Fake codex binaries answer `mcp list --json` with no servers: mmrun checks it before every codex exec.
MCP_NONE = 'case " $* " in *" mcp list "*) echo "[]"; exit 0;; esac\n'

def make_run(root, rid, out_text, schema=SCHEMA):
    rd = pathlib.Path(root, rid); rd.mkdir(parents=True)
    rd.joinpath("run.meta").write_text(f"runid={rid}\nmode={'review' if schema else 'start'}\nschema={schema or ''}\n")
    rd.joinpath("grok.status").write_text("DONE\n")
    if out_text is not None: rd.joinpath("grok.out").write_text(out_text)
    return rd

def mmrun(root, *args):
    env = dict(os.environ, MMRUN_HOME=root, MMRUN_D=str(PLUGIN / "mmrun.d"))
    return subprocess.run([str(MMRUN), *args], capture_output=True, text=True, env=env)

def review(summary, *severities, verdict="request_changes"):
    return json.dumps({"verdict": verdict, "summary": summary, "not_checked": [], "not_expanded": 0, "findings": [
        {"severity": s, "file": "a.py", "line": 1, "quote": "x", "claim": "c", "failure_scenario": "f",
         "basis": "traced", "suggestion": None}
        for s in severities]}, ensure_ascii=False)

with tempfile.TemporaryDirectory() as root:
    # 按 grok 多轮拼接格式合成的输出:两个 approve + 一个被第四个对象从字符串中间截断的 request_changes + 完整的第四个
    make_run(root, "spliced", FIXTURE.read_text())
    r = mmrun(root, "result", "grok", "spliced", "--top")
    expect("拼接输出 --top 退出码 0", r.returncode, 0)
    expect("拼接输出取到终稿", r.stdout.startswith("verdict: request_changes\nThe cache still serves stale entries"), True)
    expect("拼接输出 --top 列出 7 条 major", (r.stdout.count("## MAJOR"), r.stdout.count("\n- **")), (1, 7))
    expect("拼接输出保留未展开条数", "Not expanded: 2" in r.stdout, True)

    # 取最高 severity 的对象;同级取最后一个
    make_run(root, "rank", review("first", "major") + review("second", "minor", "major")
             + review("third", "minor") + review("last", verdict="approve"))
    r = mmrun(root, "result", "grok", "rank")
    expect("取最高 severity、同级取最后", r.stdout.splitlines()[:2], ["verdict: request_changes", "second"])

    # 截断点在嵌套 finding 的值位置:该 finding 连同后面的真对象能解析成一个不合 schema 的 dict,不能整段跳过
    make_run(root, "nested", '{"verdict":"request_changes","summary":"cut","findings":[{"severity":"minor","quote":'
             + review("real", "major") + "}")
    r = mmrun(root, "result", "grok", "nested")
    expect("截断在嵌套值处仍取到真对象", (r.returncode, r.stdout.splitlines()[1:2]), (0, ["real"]))

    # pre_existing findings get their own section; --top and --oneline --top leave them out and say how many there are
    pre = json.loads(review("pre", "major", "critical"))
    pre["findings"][0]["claim"] = "NEW-ISSUE"; pre["findings"][0]["pre_existing"] = False
    pre["findings"][1]["claim"] = "OLD-ISSUE"; pre["findings"][1]["pre_existing"] = True
    make_run(root, "preex", json.dumps(pre))
    r = mmrun(root, "result", "grok", "preex")
    crit = r.stdout.split("## CRITICAL", 1)[1].split("## ", 1)[0] if "## CRITICAL" in r.stdout else ""
    pex = r.stdout.split("## PRE-EXISTING", 1)[1] if "## PRE-EXISTING" in r.stdout else ""
    expect("pre_existing 单列一节,不进严重度节", ("OLD-ISSUE" in pex, "[critical]" in pex, "OLD-ISSUE" in crit, "NEW-ISSUE" in r.stdout),
           (True, True, False, True))
    r = mmrun(root, "result", "grok", "preex", "--top")
    expect("--top 不含 pre_existing,写出条数", ("OLD-ISSUE" in r.stdout, "NEW-ISSUE" in r.stdout, "Pre-existing (not shown): 1" in r.stdout,
           "[critical]" in r.stdout), (False, True, True, False))
    r = mmrun(root, "result", "grok", "preex", "--top", "--oneline")
    expect("--top --oneline 不含 pre_existing", ("OLD-ISSUE" in r.stdout, "NEW-ISSUE" in r.stdout), (False, True))
    schema = json.loads(SCHEMA.read_text())["properties"]["findings"]["items"]
    expect("schema:pre_existing 是必填布尔", ("pre_existing" in schema["required"], schema["properties"].get("pre_existing", {}).get("type")),
           (True, "boolean"))

    # 模型正文裹 ```json 围栏
    make_run(root, "fenced", "```json\n" + review("fenced", "critical") + "\n```\n")
    r = mmrun(root, "result", "grok", "fenced", "--top")
    expect("围栏输出可解析", (r.returncode, "## CRITICAL" in r.stdout), (0, True))

    # 什么都解析不出来:非零退出,stderr 给出 .out 路径
    rd = make_run(root, "garbage", '{"verdict":"request_changes","summary":"截断在这')
    r = mmrun(root, "result", "grok", "garbage", "--top")
    expect("无可解析对象时非零退出", r.returncode != 0, True)
    expect("无可解析对象时 stdout 为空", r.stdout, "")
    expect("无可解析对象时报出 .out 路径", str(rd / "grok.out") in r.stderr, True)

    # 无 schema 的 start 自由文本:--top 不找 Critical 小节,原样输出全文
    rd = make_run(root, "freeform", "没有任何严重度标题的纯文本\n", schema=None)
    r = mmrun(root, "result", "grok", "freeform", "--top")
    expect("start 自由文本 --top 输出全文", (r.returncode, r.stdout), (0, "没有任何严重度标题的纯文本\n"))
    # review 自由文本:--top 没匹配到小节时报错,不静默
    rd = make_run(root, "freeform-review", "没有任何严重度标题的纯文本\n", schema=None)
    rd.joinpath("run.meta").write_text("runid=freeform-review\nmode=review\nschema=\n")
    r = mmrun(root, "result", "grok", "freeform-review", "--top")
    expect("review 自由文本 --top 无内容时非零退出", (r.returncode != 0, str(rd / "grok.out") in r.stderr), (True, True))

    # render:直接放好 .json,经 result 渲染
    TASK_SCHEMA = PLUGIN / "mmrun.d/task.schema.json"
    def render_case(rid, mode, obj):
        rd = pathlib.Path(root, rid); rd.mkdir()
        rd.joinpath("run.meta").write_text(f"runid={rid}\nmode={mode}\nschema={TASK_SCHEMA if mode == 'run' else SCHEMA}\n")
        text = json.dumps(obj, ensure_ascii=False)
        rd.joinpath("grok.out").write_text(text); rd.joinpath("grok.json").write_text(text)
        return mmrun(root, "result", "grok", rid).stdout

    out = render_case("render-run", "run", {"summary": "s", "checks_run": [{"cmd": "pytest", "exit_code": 0, "result_line": "12 passed"}],
                      "not_verified": [], "decisions_made": ["用 X 而非 Y"], "questions": [], "status": "done"})
    expect("render run:checks_run 对象", "  - pytest → exit 0 · 12 passed" in out, True)
    expect("render run:decisions_made 段", "decisions_made:\n  - 用 X 而非 Y" in out, True)
    out = render_case("render-run-old", "run", {"status": "done", "summary": "s", "files_changed": ["a.py"],
                      "checks_run": ["make test: ok"], "not_verified": [], "questions": []})
    expect("render run 旧格式:字符串原样、无 files_changed、无 decisions_made",
           ("\n  - make test: ok" in out, "files_changed" in out, "decisions_made" in out), (True, False, False))

    # run 结果:checks_run 归一化 cmd 并按 cmd 合并;续轮 patch 标签指向 .patch.full
    def run_case(rid, checks, parent=""):
        rd = pathlib.Path(root, rid); rd.mkdir()
        rd.joinpath("run.meta").write_text(f"runid={rid}\nmode=run\nschema={TASK_SCHEMA}\nworkdir=/w/repo\nwt=/w/wt\nparent={parent}\n")
        text = json.dumps({"summary": "s", "checks_run": checks, "not_verified": [], "decisions_made": [], "questions": [],
                           "status": "done"}, ensure_ascii=False)
        rd.joinpath("grok.out").write_text(text); rd.joinpath("grok.json").write_text(text)
        rd.joinpath("grok.patch").write_text("diff --git a/x b/x\n"); rd.joinpath("grok.patch.stat").write_text(" x | 1 +\n")
        return rd, mmrun(root, "result", "grok", rid).stdout
    py = "/w/repo/.venv/bin/python -m pytest -q x.py"
    rd, out = run_case("render-run-checks", [
        {"cmd": py, "exit_code": 1, "result_line": "3 failed"},
        {"cmd": "cat > /w/repo/t.sh <<'EOF'\necho hi\nEOF", "exit_code": 0, "result_line": "ok"},
        {"cmd": "make lint", "exit_code": 2, "result_line": ""},
        "manual: ok",
        {"cmd": py, "exit_code": 1, "result_line": "1 failed, 2 passed"},
        {"cmd": os.environ["HOME"] + "/bin/tool --x", "exit_code": 0, "result_line": ""},
        {"cmd": "echo " + "a" * 120, "exit_code": 0, "result_line": "long"},
        {"cmd": "make lint", "exit_code": 0, "result_line": ""},
        {"cmd": py, "exit_code": 0, "result_line": "3 passed"},
        {"cmd": "/w/wt/run.sh", "exit_code": 0, "result_line": "ok"}])
    expect("render run:checks_run 归一化并合并", out.split("checks_run:\n", 1)[-1].split("\n\n", 1)[0].splitlines(), [
        "  - python -m pytest -q x.py → exit 0 · 3 passed (×3; first: exit 1 · 3 failed)",
        "  - cat > t.sh <<'EOF' → exit 0 · ok",
        "  - make lint → exit 0 (×2; first: exit 2)",
        "  - manual: ok",
        "  - ~/bin/tool --x → exit 0",
        "  - echo " + "a" * 95 + "… → exit 0 · long",
        "  - run.sh → exit 0 · ok"])
    hd = lambda body: "python3 - <<'PY'\n" + body + "\nPY"
    _, hdout = run_case("render-run-heredoc", [{"cmd": hd("a"), "exit_code": 0, "result_line": ""},
                                             {"cmd": hd("b"), "exit_code": 1, "result_line": ""},
                                             {"cmd": hd("c"), "exit_code": 0, "result_line": ""}])
    expect("render run:首行相同的不同 heredoc 不合并", hdout.split("checks_run:\n", 1)[-1].split("\n\n", 1)[0].splitlines(), [
        "  - python3 - <<'PY' → exit 0", "  - python3 - <<'PY' → exit 1", "  - python3 - <<'PY' → exit 0"])
    _, hdout = run_case("render-run-heredoc-rerun", [{"cmd": hd("a"), "exit_code": 1, "result_line": ""},
                                                   {"cmd": hd("a"), "exit_code": 0, "result_line": ""}])
    expect("render run:同一 heredoc 重跑仍合并", hdout.split("checks_run:\n", 1)[-1].split("\n\n", 1)[0].splitlines(), [
        "  - python3 - <<'PY' → exit 0 (×2; first: exit 1)"])
    expect("render run:首行与无父 run 的 patch 标签",(out.startswith("status: done\n"), f"\npatch: {rd}/grok.patch\n" in out), (True, True))
    rd, out = run_case("render-run-cont", [], parent="render-run-checks")
    expect("render run:续轮 patch 标签",
           (f"\npatch (this round only; check and apply use grok.patch.full): {rd}/grok.patch\n" in out,
            "checks_run: none" in out), (True, True))
    rd.joinpath("grok.patch.full").write_text("diff --git a/x b/x\n")
    expect("render run:续轮但 patch 就是全量(父 tree 已回收)时用普通标签", f"\npatch: {rd}/grok.patch\n" in mmrun(root, "result", "grok", "render-run-cont").stdout, True)

    rv = json.loads(review("s", "major")); rv["findings"][0]["basis"] = "inferred"; rv["not_checked"] = ["b.py"]
    out = render_case("render-review", "review", rv)
    titles = [l for l in out.splitlines() if l.startswith("- **")]
    expect("render review:标题行带 [inferred]", titles[0].endswith(" [inferred]") if titles else None, True)
    expect("render review:未检查段在未展开之前", "Not checked:\n  - b.py\nNot expanded" in out, True)
    ri = json.loads(review("s", "major", "minor")); ri["findings"][0]["issue_identity"] = "missing-lock-on-write"
    rd = pathlib.Path(root, "render-iid"); rd.mkdir()
    rd.joinpath("run.meta").write_text(f"runid=render-iid\nmode=review\nschema={SCHEMA}\n")
    rd.joinpath("grok.out").write_text(json.dumps(ri)); rd.joinpath("grok.json").write_text(json.dumps(ri))
    rd.joinpath("grok.quotes").write_text("0\tok\n1\tok\n")
    titles = [l for l in mmrun(root, "result", "grok", "render-iid").stdout.splitlines() if l.startswith("- **")]
    expect("render review:不打印 {issue_identity},[quote ok] 不标",
           titles, ["- **a.py:1** — c [traced]", "- **a.py:1** — c [traced]"])

    # render review 精简:只给主模型它用得上的
    ASK_SCHEMA = PLUGIN / "mmrun.d/review-ask.schema.json"
    def review_run(rid, outs, quotes=None, schema=SCHEMA):
        rd = pathlib.Path(root, rid); rd.mkdir()
        rd.joinpath("run.meta").write_text(f"runid={rid}\nmode=review\nschema={schema}\nmodels={','.join(outs)}\n")
        for m, o in outs.items():
            rd.joinpath(f"{m}.out").write_text(json.dumps(o)); rd.joinpath(f"{m}.json").write_text(json.dumps(o))
        if quotes: rd.joinpath("grok.quotes").write_text(quotes)
    def fd(line, iid, claim="c", **kw):
        return dict({"severity": "major", "file": "a.py", "line": line, "quote": "x", "claim": claim, "failure_scenario": "f",
                     "basis": "traced", "suggestion": None, "issue_identity": iid}, **kw)
    def rv(*fs, **kw):
        o = json.loads(review("s")); o["findings"] = list(fs); o.update(kw); return o
    def heads(out): return [l for l in out.splitlines() if l.startswith("- ")]
    IID = "missing-lock-on-write"

    review_run("render-q", {"grok": rv(fd(1, "a-b"), fd(2, "a-b"))}, "0\tok\n1\tMISSING\n")
    for flag in ([], ["--top"]):
        expect(f"render review {flag}:quote 只在非 ok 时标出", heads(mmrun(root, "result", "grok", "render-q", *flag).stdout),
               ["- **a.py:1** — c [traced]", "- **a.py:2** — c [traced] [quote MISSING]"])

    review_run("render-also", {"codex": rv(fd(10, IID)), "grok": rv(fd(12, IID, "G1"), fd(30, IID, "G2"), fd(12, "other-thing", "G3")),
                               "agy": rv(fd(14, IID), fd(12, ""))})
    expect("render review:同 run 别的模型有同一问题时标 [also reported by …],不打印 {标签}",
           heads(mmrun(root, "result", "grok", "render-also").stdout),
           ["- **a.py:12** — G1 [traced] [also reported by codex, agy]", "- **a.py:30** — G2 [traced]", "- **a.py:12** — G3 [traced]"])

    review_run("render-top", {"grok": rv(fd(1, "x-y", "T1", suggestion="do X"), fd(2, "x-z", "T2", suggestion="do Y"),
                                         not_checked=["n1", "n2", "n3", "n4", "n5"])})
    full = mmrun(root, "result", "grok", "render-top").stdout; top = mmrun(root, "result", "grok", "render-top", "--top").stdout
    expect("render review 全量:Fix、全部 Not checked、Not expanded: 0 照旧",
           ("\n  Fix: do X\n" in full, "Not checked:\n  - n1\n  - n2\n  - n3\n  - n4\n  - n5\nNot expanded: 0\n" in full), (True, True))
    expect("render review --top:无 Fix,Not checked 截 3 条加 +N more,无 Not expanded: 0",
           ("Fix:" in top, top.split("Not checked:\n", 1)[-1]),
           (False, "  - n1\n  - n2\n  - n3\n  - (+2 more: mmrun result grok render-top)\n"))
    review_run("render-top2", {"grok": rv(fd(1, "x-y"), not_checked=["n1", "n2", "n3"], not_expanded=2)})
    expect("render review --top:正好 3 条不加 more,Not expanded: 2 保留",
           mmrun(root, "result", "grok", "render-top2", "--top").stdout.split("Not checked:\n", 1)[-1],
           "  - n1\n  - n2\n  - n3\nNot expanded: 2\n")

    def sf(claim, stance, ev=None):
        return {"severity": "major", "file": "a.py", "line": 1, "quote": "x", "claim": claim, "failure_scenario": "f",
                "basis": "traced", "stance": stance, "evidence_for_change": ev, "suggestion": None}
    review_run("render-stance", {"grok": rv(sf("S1", "maintained", "irrelevant"), sf("S2", "revised", "a.py:9 holds the lock"),
                                            sf("S3", "withdrawn", "ran: test passes"), sf("S4", "withdrawn", ""))}, schema=ASK_SCHEMA)
    full = mmrun(root, "result", "grok", "render-stance").stdout; top = mmrun(root, "result", "grok", "render-stance", "--top").stdout
    because = lambda out: [l for l in out.splitlines() if "Changed because" in l]
    expect("render review stance 全量:标题带 [stance],revised/withdrawn 有证据时给 Changed because",
           (heads(full), because(full)),
           (["- **a.py:1** — S1 [maintained] [traced]", "- **a.py:1** — S2 [revised] [traced]",
             "- **a.py:1** — S3 [withdrawn] [traced]", "- **a.py:1** — S4 [withdrawn] [traced]"],
            ["  Changed because: a.py:9 holds the lock", "  Changed because: ran: test passes"]))
    expect("render review stance --top:跳过 withdrawn",
           (heads(top), because(top)),
           (["- **a.py:1** — S1 [maintained] [traced]", "- **a.py:1** — S2 [revised] [traced]"], ["  Changed because: a.py:9 holds the lock"]))
    expect("render review stance --oneline --top", mmrun(root, "result", "grok", "render-stance", "--oneline", "--top").stdout,
           "verdict: request_changes\ns\n\n- a.py:1 [major] — S1 [maintained]\n- a.py:1 [major] — S2 [revised]\n"
           "full: mmrun result grok render-stance --top\n")

    review_run("render-one", {"codex": rv(fd(4, IID)),
                              "grok": rv(fd(3, IID, "O1", severity="minor", suggestion="fix"), fd(5, IID, "O2", severity="critical"),
                                         fd(None, "q-r", "O3"), not_checked=["n1", "n2", "n3", "n4"])},
               "0\tMISSING\n1\tok\n2\tok\n")
    expect("render review --oneline", mmrun(root, "result", "grok", "render-one", "--oneline").stdout,
           "verdict: request_changes\ns\n\n- a.py:5 [critical] — O2 [also reported by codex]\n- a.py:? [major] — O3\n"
           "- a.py:3 [minor] — O1 [also reported by codex]\nNot checked:\n  - n1\n  - n2\n  - n3\n"
           "  - (+1 more: mmrun result grok render-one)\nfull: mmrun result grok render-one\n")
    expect("render review --oneline --top", mmrun(root, "result", "grok", "render-one", "--top", "--oneline").stdout,
           "verdict: request_changes\ns\n\n- a.py:5 [critical] — O2 [also reported by codex]\n- a.py:? [major] — O3\n"
           "Not checked:\n  - n1\n  - n2\n  - n3\n  - (+1 more: mmrun result grok render-one)\nfull: mmrun result grok render-one --top\n")

    # start --top:标量在前,数组/对象在后,数组每项一行、超 200 字符截断并给 full 行;不带 --top 照旧
    START_SCHEMA = pathlib.Path(root, "start.schema.json")
    START_SCHEMA.write_text(json.dumps({"type": "object", "properties": {
        "risks": {"type": "array"}, "verdict": {"type": "string"}, "notes": {"type": "object"}, "empty": {"type": "array"},
        "count": {"type": "integer"}, "summary": {"type": "string"}}}))
    def start_run(rid, obj):
        rd = pathlib.Path(root, rid); rd.mkdir()
        rd.joinpath("run.meta").write_text(f"runid={rid}\nmode=start\nschema={START_SCHEMA}\n")
        rd.joinpath("grok.out").write_text(json.dumps(obj)); rd.joinpath("grok.json").write_text(json.dumps(obj))
    start_run("render-start", {"summary": "s", "count": 3, "empty": [], "verdict": "v", "notes": {"a": 1, "b": ["x", "y"]},
                               "risks": ["r1", {"k": "v", "n": None, "l": ["p", "q"]}, "line\nbreak", "L" * 250]})
    expect("render start 不带 --top 照旧", mmrun(root, "result", "grok", "render-start").stdout,
           "risks:\n  - r1\n  - k: v · l: p; q\n  - line\nbreak\n  - " + "L" * 250 + "\nverdict: v\nnotes: a: 1 · b: x; y\ncount: 3\nsummary: s\n")
    expect("render start --top", mmrun(root, "result", "grok", "render-start", "--top").stdout,
           "verdict: v\ncount: 3\nsummary: s\nrisks:\n  - r1\n  - k: v · l: p; q\n  - line break\n  - " + "L" * 200 + "…\n"
           "notes: a: 1 · b: x; y\nfull: mmrun result grok render-start\n")
    start_run("render-start-short", {"summary": "s", "risks": ["r1"]})
    expect("render start --top:没截断时无 full 行", mmrun(root, "result", "grok", "render-start-short", "--top").stdout,
           "summary: s\nrisks:\n  - r1\n")

    # severity 不在枚举里的 finding 单列一节,全量与 --top 都输出;四个已知值照旧分节
    CLAIMS = ("claim-Critical", "claim-high", "claim-major", "claim-minor")
    def sect(out, title):  # 该节里出现的 CLAIMS
        body = out.split(f"## {title}\n", 1)[1].split("\n## ", 1)[0] if f"## {title}\n" in out else ""
        return [c for c in CLAIMS if c in body]
    ru = json.loads(review("s", "Critical", "high", "major", "minor"))
    for f in ru["findings"]: f["claim"] = "claim-" + f["severity"]
    out = render_case("render-unknown", "review", ru)
    expect("未知 severity:全量输出 UNRECOGNIZED SEVERITY 节,已知值照旧",
           (sect(out, "UNRECOGNIZED SEVERITY"), sect(out, "MAJOR"), sect(out, "MINOR"), "[Critical]" in out),
           (["claim-Critical", "claim-high"], ["claim-major"], ["claim-minor"], True))
    out = mmrun(root, "result", "grok", "render-unknown", "--top").stdout
    expect("未知 severity:--top 也输出 UNRECOGNIZED SEVERITY 节",
           (sect(out, "UNRECOGNIZED SEVERITY"), sect(out, "MAJOR"), "## MINOR" in out), (["claim-Critical", "claim-high"], ["claim-major"], False))
    out = render_case("render-known", "review", json.loads(review("s", "critical", "major", "minor", "optional")))
    expect("四个已知 severity:没有 UNRECOGNIZED SEVERITY 节", ("UNRECOGNIZED" in out, out.count("\n- **")), (False, 4))
    with tempfile.TemporaryDirectory() as bindir:  # 不能放在 MMRUN_HOME 下:围栏禁读该目录
        payload = pathlib.Path(bindir, "grok.json"); payload.write_text(json.dumps({"structuredOutput": ru}))
        fake = pathlib.Path(bindir, "grok"); fake.write_text(f"#!/bin/sh\ncat '{payload}'\n"); fake.chmod(0o755)
        rd = make_run(root, "live-unknown", None)
        rd.joinpath("prompt.md").write_text("p\n"); rd.joinpath("grok.session").write_text("sid\n")
        subprocess.run([str(MMRUN), "__run", "grok", str(rd), bindir], capture_output=True, timeout=60,
                       env=dict(os.environ, MMRUN_HOME=root, MMRUN_D=str(PLUGIN / "mmrun.d"), GROK_BIN=str(fake)))
        expect("未知 severity:report 也带 UNRECOGNIZED SEVERITY 节",
               sect(mmrun(root, "report", "live-unknown").stdout, "UNRECOGNIZED SEVERITY"), ["claim-Critical", "claim-high"])

    # codex --output-schema 严格模式:每个 object 的 required == properties 键集合,且 additionalProperties: false
    def loose_objects(node, path="$"):
        bad = []
        if isinstance(node, dict):
            if node.get("type") == "object" and (set(node.get("required", [])) != set(node.get("properties", {}))
                                                 or node.get("additionalProperties") is not False):
                bad.append(path)
            for k, v in node.items(): bad += loose_objects(v, f"{path}.{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node): bad += loose_objects(v, f"{path}[{i}]")
        return bad
    ASK_SCHEMA = PLUGIN / "mmrun.d/review-ask.schema.json"
    for s in (SCHEMA, TASK_SCHEMA, ASK_SCHEMA):
        expect(f"schema 严格模式:{s.name}", loose_objects(json.loads(s.read_text())) if s.exists() else None, [])
    item = json.loads(SCHEMA.read_text())["properties"]["findings"]["items"]
    expect("review schema:finding 含必填 issue_identity(string)",
           (item["properties"].get("issue_identity", {}).get("type"), "issue_identity" in item["required"]), ("string", True))
    fprops = json.loads(ASK_SCHEMA.read_text())["properties"]["findings"]["items"]["properties"] if ASK_SCHEMA.exists() else {}
    expect("review-ask schema:finding 含 stance 与 evidence_for_change",
           (fprops.get("stance", {}).get("enum"), "evidence_for_change" in fprops),
           (["new", "maintained", "revised", "withdrawn"], True))

    # 阶段 schema:type 可为 ["object","null"],同样要求严格;顶层最后一个键是 verdict
    def strict_bad(node, path="$"):
        bad = []
        if isinstance(node, dict):
            t = node.get("type"); t = t if isinstance(t, list) else [t]
            if "object" in t and (set(node.get("required", [])) != set(node.get("properties", {}))
                                  or node.get("additionalProperties") is not False):
                bad.append(path)
            for k, v in node.items(): bad += strict_bad(v, f"{path}.{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node): bad += strict_bad(v, f"{path}[{i}]")
        return bad
    STAGES = PLUGIN / "mmrun.d/stages"
    for st in ("clarify", "options", "premortem", "hypotheses"):
        sf = STAGES / f"{st}.schema.json"
        try: sj = json.loads(sf.read_text())
        except (OSError, ValueError): sj = None
        expect(f"stage schema 严格且 verdict 在最后:{st}",
               (strict_bad(sj) if sj else None, list(sj["properties"])[-1] if sj else None), ([], "verdict"))

    # __run grok:优先取 grok 的 structuredOutput,而不是多轮拼接的 text
    with tempfile.TemporaryDirectory() as bindir:  # 不能放在 MMRUN_HOME 下:围栏禁读该目录
        structured = json.loads(review("from-structured-output", "major"))
        payload = pathlib.Path(bindir, "grok.json")
        payload.write_text(json.dumps({"text": FIXTURE.read_text(), "structuredOutput": structured}, ensure_ascii=False))
        fake = pathlib.Path(bindir, "grok"); fake.write_text(f"#!/bin/sh\ncat '{payload}'\n"); fake.chmod(0o755)
        rd = make_run(root, "live", None)
        rd.joinpath("prompt.md").write_text("p\n"); rd.joinpath("grok.session").write_text("sid\n")
        env = dict(os.environ, MMRUN_HOME=root, MMRUN_D=str(PLUGIN / "mmrun.d"), GROK_BIN=str(fake))
        subprocess.run([str(MMRUN), "__run", "grok", str(rd), bindir], capture_output=True, env=env, timeout=60)
        got = json.loads(rd.joinpath("grok.json").read_text()) if rd.joinpath("grok.json").exists() else None
        expect("__run 取 structuredOutput", got, structured)
        expect("__run 状态 DONE", rd.joinpath("grok.status").read_text().strip(), "DONE")

    # 派活收 patch:worktree 的 .git 指针被改到别的仓库时不能在宿主上跑那个仓库的 config(core.fsmonitor)
    def git(*a):
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *a],
                              check=True, capture_output=True, text=True).stdout.strip()

    with tempfile.TemporaryDirectory() as tmp:  # 仓库、worktree、假二进制都不能放在 MMRUN_HOME 下:围栏禁读该目录
        tmp = os.path.realpath(tmp)  # 围栏规则按真实路径匹配(/var -> /private/var)

        def run_case(rid, grok_script, gitdir_line=True, tamper=None, schema=""):
            base = pathlib.Path(tmp, rid); repo = base / "repo"; wt = base / "wt"
            git("init", "-q", str(repo)); repo.joinpath("a.txt").write_text("a\n")
            git("-C", str(repo), "add", "a.txt"); git("-C", str(repo), "commit", "-qm", "init")
            git("-C", str(repo), "worktree", "add", "--quiet", "--detach", str(wt))
            gitdir = git("-C", str(wt), "rev-parse", "--absolute-git-dir")
            base_sha = git("-C", str(repo), "rev-parse", "HEAD")
            rd = pathlib.Path(root, rid); rd.mkdir()
            rd.joinpath("run.meta").write_text(f"runid={rid}\nmode=run\nschema={schema}\nwt={wt}\nbase_sha={base_sha}\n"
                                               + (f"gitdir={gitdir}\n" if gitdir_line else ""))
            rd.joinpath("prompt.md").write_text("p\n"); rd.joinpath("grok.session").write_text("sid\n")
            fake = base / "grok"; fake.write_text("#!/bin/sh\n" + grok_script.format(wt=wt)); fake.chmod(0o755)
            if tamper: tamper(base, wt)
            env = dict(os.environ, MMRUN_HOME=root, MMRUN_D=str(PLUGIN / "mmrun.d"), GROK_BIN=str(fake))
            subprocess.run([str(MMRUN), "__run", "grok", str(rd), str(repo)], capture_output=True, env=env, timeout=60)
            patch = rd / "grok.patch"
            return (wt, rd.joinpath("grok.status").read_text().strip(),
                    patch.read_text() if patch.exists() else "")

        # A:沙箱外篡改(codex 路径)——.git 指向一个 config 带 core.fsmonitor 的恶意仓库
        marker = pathlib.Path(tmp, "pwned")
        def tamper(base, wt):
            evil = base / "evil"; git("init", "-q", str(evil))
            hook = base / "fsmon"; hook.write_text(f"#!/bin/sh\ntouch '{marker}'\n"); hook.chmod(0o755)
            git("-C", str(evil), "config", "core.fsmonitor", str(hook))
            wt.joinpath(".git").write_text(f"gitdir: {evil}/.git\n")
        _, status, patch = run_case("tamper-out", "printf '{{\"text\":\"ok\"}}'\n", tamper=tamper)
        expect("篡改 .git:fsmonitor 未在宿主执行", marker.exists(), False)
        expect("篡改 .git:状态 FAIL:tampered", status, "FAIL:tampered")
        expect("篡改 .git:不产出 patch", patch, "")

        # B:沙箱内篡改——围栏拦下对 .git 的写,正常改动照收
        wt, status, patch = run_case("tamper-in", "printf 'gitdir: /private/tmp/x\\n' 2>/dev/null > '{wt}/.git'\n"
                                     "echo b > '{wt}/a.txt'\nprintf '{{\"text\":\"ok\"}}'\n")
        expect("围栏内写 .git 被拒", wt.joinpath(".git").read_text().startswith("gitdir: /private/tmp/x"), False)
        expect("围栏内篡改未遂:状态 DONE", status, "DONE")
        expect("围栏内篡改未遂:patch 含 a.txt", "a.txt" in patch, True)

        # C:老 run 的 meta 没有 gitdir= —— 不回退到读 $wt/.git
        _, status, _ = run_case("no-gitdir", "printf '{{\"text\":\"ok\"}}'\n", gitdir_line=False)
        expect("meta 无 gitdir:状态 FAIL:tampered", status, "FAIL:tampered")

        # 收 patch 时 git 出错(worktree 的 gitdir 只读,add -A 拿不到 index.lock):FAIL:collect,不留 apply 会收的 patch
        locked = []
        def lock_gitdir(base, wt):
            locked.append(pathlib.Path(git("-C", str(wt), "rev-parse", "--absolute-git-dir"))); locked[0].chmod(0o555)
        wt, status, _ = run_case("collect-fail", "echo b > '{wt}/a.txt'\nprintf '{{\"text\":\"ok\"}}'\n", tamper=lock_gitdir)
        for p in locked: p.chmod(0o755)
        cfd = pathlib.Path(root, "collect-fail")
        expect("收 patch 失败:状态 FAIL:collect、无 .patch/.patch.full、worktree 仍在",
               (status, cfd.joinpath("grok.patch").exists(), cfd.joinpath("grok.patch.full").exists(), wt.exists()),
               ("FAIL:collect", False, False, True))

        env = dict(os.environ, MMRUN_HOME=root, MMRUN_D=str(PLUGIN / "mmrun.d"))

        # base SHA:worktree HEAD 移动过(已提交的 c.txt)也要收进 patch
        def commit_c(base, wt):
            wt.joinpath("c.txt").write_text("c\n")
            git("-C", str(wt), "add", "c.txt"); git("-C", str(wt), "commit", "-qm", "c")
        _, status, patch = run_case("base-sha", "echo b > '{wt}/a.txt'\nprintf '{{\"text\":\"ok\"}}'\n", tamper=commit_c)
        expect("base SHA:patch 含 worktree 里已提交的 c.txt", "c.txt" in patch, True)
        expect("base SHA:patch 含未提交的 a.txt", "a.txt" in patch, True)

        # 无改动:result 明说 no_changes
        task_json = pathlib.Path(tmp, "task-out.json")
        task_json.write_text(json.dumps({"structuredOutput": {"summary": "nothing", "checks_run": [], "not_verified": [],
                                         "decisions_made": [], "questions": [], "status": "done"}}))
        _, status, _ = run_case("no-change", f"cat '{task_json}'\n", schema=str(PLUGIN / "mmrun.d/task.schema.json"))
        r = mmrun(root, "result", "grok", "no-change")
        expect("无改动:result 含 no_changes", (status, "no_changes" in r.stdout), ("DONE", True))

        # mmrun run 把开工时的 base 提交写进 run.meta
        repo = pathlib.Path(tmp, "runcmd", "repo"); git("init", "-q", str(repo))
        repo.joinpath("a.txt").write_text("a\n"); git("-C", str(repo), "add", "a.txt"); git("-C", str(repo), "commit", "-qm", "init")
        fake = pathlib.Path(tmp, "runcmd", "grok"); fake.write_text("#!/bin/sh\nprintf '{\"text\":\"ok\"}'\n"); fake.chmod(0o755)
        task = pathlib.Path(tmp, "runcmd", "task.md"); task.write_text("t\n")
        r = subprocess.run([str(MMRUN), "run", "--model", "grok", "--task", str(task), "--dir", str(repo)],
                           capture_output=True, text=True, env=dict(env, GROK_BIN=str(fake)), timeout=60)
        rid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        mmrun(root, "wait", rid, "--timeout", "60")
        meta = pathlib.Path(root, rid, "run.meta")
        expect("run.meta 写 base_sha", f"base_sha={git('-C', str(repo), 'rev-parse', 'HEAD')}\n" in
               (meta.read_text() if meta.exists() else ""), True)
        expect("run 提示用 review --patch", "review --patch " + rid in r.stdout, True)

        # review --patch:审 run 目录里的 patch,不碰 worktree
        repo = pathlib.Path(tmp, "rp", "repo"); git("init", "-q", str(repo))
        repo.joinpath("a.txt").write_text("a\n"); git("-C", str(repo), "add", "a.txt"); git("-C", str(repo), "commit", "-qm", "init")
        sha = git("-C", str(repo), "rev-parse", "HEAD")
        fake = pathlib.Path(tmp, "rp", "empty"); fake.write_text("#!/bin/sh\necho '{}'\n"); fake.chmod(0o755)
        for rid, mode in (("rp-run", "run"), ("rp-review", "review")):
            rd = pathlib.Path(root, rid); rd.mkdir()
            rd.joinpath("run.meta").write_text(f"runid={rid}\nmode={mode}\nmodels=codex\nworkdir={repo}\nbase_sha={sha}\n")
            rd.joinpath("codex.patch").write_text("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+patch-marker-line\n")
        renv = dict(env, GROK_BIN=str(fake), CODEX_BIN=str(fake))
        r = subprocess.run([str(MMRUN), "review", "--patch", "rp-run", "--models", "grok"],
                           capture_output=True, text=True, env=renv, timeout=60)
        nrid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        prompt = pathlib.Path(root, nrid, "prompt.md")
        ptext = prompt.read_text() if prompt.exists() else ""
        expect("review --patch:prompt 含 patch 内容与范围说明",
               ("+patch-marker-line" in ptext, "patch from run" in ptext, sha[:12] in ptext), (True, True, True))
        if nrid != "missing": mmrun(root, "wait", nrid, "--timeout", "60")
        r = subprocess.run([str(MMRUN), "review", "--patch", "rp-review", "--models", "grok"],
                           capture_output=True, text=True, env=renv, timeout=60)
        expect("review --patch:非派活 run 拒绝", r.returncode != 0, True)
        # the model that wrote the patch does not review it
        r = subprocess.run([str(MMRUN), "review", "--patch", "rp-run", "--models", "codex"],
                           capture_output=True, text=True, env=renv, timeout=60)
        expect("review --patch:只剩写 patch 的模型时拒绝", (r.returncode != 0, "wrote this patch" in r.stderr), (True, True))
        r = subprocess.run([str(MMRUN), "review", "--patch", "rp-run", "--models", "codex,grok"],
                           capture_output=True, text=True, env=renv, timeout=60)
        nrid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        meta = pathlib.Path(root, nrid, "run.meta")
        expect("review --patch:从审查模型里去掉写 patch 的模型",
               ("models=grok\n" in (meta.read_text() if meta.exists() else ""), "codex wrote this patch" in r.stdout), (True, True))
        if nrid != "missing": mmrun(root, "wait", nrid, "--timeout", "60")

        # review 提示词:材料包在 <review_input> 里、严重度含"拿不准"、不用加粗;--full 时不说"不报改动前已存在的问题"
        repo = pathlib.Path(tmp, "pr", "repo"); git("init", "-q", str(repo))
        repo.joinpath("a.txt").write_text("a\n"); git("-C", str(repo), "add", "a.txt"); git("-C", str(repo), "commit", "-qm", "init")
        repo.joinpath("a.txt").write_text("changed\n")
        def review_prompt(*extra):
            r = subprocess.run([str(MMRUN), "review", "--models", "grok", "--dir", str(repo), *extra],
                               capture_output=True, text=True, env=renv, timeout=60)
            prid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
            if prid != "missing": mmrun(root, "wait", prid, "--timeout", "60")
            p = pathlib.Path(root, prid, "prompt.md")
            return p.read_text() if p.exists() else ""
        PRE = "set pre_existing to true"
        ptext = review_prompt()
        expect("review 提示词:review_input 包装、拿不准、无加粗、含改动前那句",
               ("<review_input>\n" in ptext, "\n</review_input>" in ptext, "If unsure" in ptext, "**" in ptext, PRE in ptext),
               (True, True, True, False, True))
        IID = "issue_identity: 2-4 lowercase English words joined by hyphens that name the mechanism of the problem (e.g. missing-lock-on-write), without file names; it is used only to match the same problem across models."
        expect("review 提示词:含 issue_identity 说明", IID in ptext, True)
        ptext = review_prompt("--full", "--paths", "a.txt")
        expect("review --full 提示词:不含改动前那句", (bool(ptext), PRE in ptext, "**" in ptext), (True, False, False))
        expect("review --full 提示词:pre_existing 一律 false", "Set pre_existing to false" in ptext, True)
        ptext = review_prompt("--exhaustive")
        expect("review --exhaustive 提示词:含改动前那句", PRE in ptext, True)
        ANGLES = ("For each removed or replaced line", "find its callers", "passes every argument", "Language pitfalls")
        expect("review --exhaustive 提示词:含检查角度", all(a in ptext for a in ANGLES), True)
        expect("review --exhaustive 提示词:同一根因只报一次、无加粗", ("Report each root cause once" in ptext, "**" in ptext), (True, False))
        expect("review --exhaustive 提示词:含 issue_identity 说明", IID in ptext, True)
        REQ = "explicitly stated requirement"
        expect("review --exhaustive 提示词:不含明示需求那句", REQ in ptext, False)
        ptext = review_prompt()
        expect("review 提示词:无 focus/notes 时不提明示需求",
               (REQ in ptext, "Report only problems that affect correctness;" in ptext), (False, True))
        expect("review 提示词:含检查角度", all(a in ptext for a in ANGLES), True)
        ptext = review_prompt("--focus", "x")
        expect("review --focus 提示词:含明示需求那句", REQ in ptext, True)
        notes = pathlib.Path(tmp, "pr", "notes.md"); notes.write_text("需求:a.txt 必须是 changed\n")
        ptext = review_prompt("--notes-file", str(notes))
        expect("review --notes-file 提示词:含明示需求那句", REQ in ptext, True)

        # rules files: root CLAUDE.md, CLAUDE.md in each ancestor of a changed file, REVIEW.md; read from the base version, not the change
        repo = pathlib.Path(tmp, "rules", "repo"); git("init", "-q", str(repo))
        for pth, txt in {"CLAUDE.md": "ROOT-RULE\n", "REVIEW.md": "REVIEW-RULE\n", "sub/CLAUDE.md": "SUB-RULE\n",
                         "other/CLAUDE.md": "OTHER-RULE\n", "sub/x.txt": "x\n"}.items():
            repo.joinpath(pth).parent.mkdir(parents=True, exist_ok=True); repo.joinpath(pth).write_text(txt)
        git("-C", str(repo), "add", "-A"); git("-C", str(repo), "commit", "-qm", "init")
        repo.joinpath("sub/x.txt").write_text("y\n"); repo.joinpath("REVIEW.md").write_text("CHANGED-RULE\n")
        r = subprocess.run([str(MMRUN), "review", "--models", "grok", "--dir", str(repo)],
                           capture_output=True, text=True, env=renv, timeout=60)
        rrid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        if rrid != "missing": mmrun(root, "wait", rrid, "--timeout", "60")
        p = pathlib.Path(root, rrid, "prompt.md"); head = (p.read_text() if p.exists() else "").split("<review_input>", 1)[0]
        expect("review 规则文件:根、祖先目录的 CLAUDE.md 和 REVIEW.md 进 prompt,无关目录的不进,取基线版本",
               ("## Repository rules" in head, "ROOT-RULE" in head, "SUB-RULE" in head, "REVIEW-RULE" in head,
                "OTHER-RULE" in head, "CHANGED-RULE" in head), (True, True, True, True, False, False))
        git("-C", str(repo), "commit", "-qam", "c2")
        r = subprocess.run([str(MMRUN), "review", "--models", "grok", "--dir", str(repo), "--commit", "HEAD"],
                           capture_output=True, text=True, env=renv, timeout=60)
        rrid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        if rrid != "missing": mmrun(root, "wait", rrid, "--timeout", "60")
        p = pathlib.Path(root, rrid, "prompt.md"); head = (p.read_text() if p.exists() else "").split("<review_input>", 1)[0]
        expect("review --commit 规则文件:取父提交的版本", ("REVIEW-RULE" in head, "CHANGED-RULE" in head), (True, False))

        # apply 闸门:敏感路径拒绝,--allow-sensitive 放行;HEAD 离开 base 时提示
        def apply_case(rid, files, edits):
            repo = pathlib.Path(tmp, rid, "repo"); git("init", "-q", str(repo))
            for p, c in files.items():
                repo.joinpath(p).parent.mkdir(parents=True, exist_ok=True); repo.joinpath(p).write_text(c)
            git("-C", str(repo), "add", "-A"); git("-C", str(repo), "commit", "-qm", "init")
            for p, c in edits.items():
                f = repo.joinpath(p)
                if c is None: f.unlink()
                else: f.parent.mkdir(parents=True, exist_ok=True); f.write_text(c)
            git("-C", str(repo), "add", "-A")
            patch = git("-C", str(repo), "diff", "--cached", "--binary", "-M") + "\n"
            git("-C", str(repo), "reset", "-q", "--hard")
            rd = pathlib.Path(root, rid); rd.mkdir()
            rd.joinpath("run.meta").write_text(f"runid={rid}\nmode=run\nmodels=grok\nworkdir={repo}\nwt=\n"
                                               f"base_sha={git('-C', str(repo), 'rev-parse', 'HEAD')}\n")
            rd.joinpath("grok.patch").write_text(patch); rd.joinpath("grok.status").write_text("DONE\n")
            return repo

        repo = apply_case("ap-claude", {".claude/settings.json": "{}\n"}, {".claude/settings.json": '{"x":1}\n'})
        r = mmrun(root, "apply", "ap-claude", "--keep")
        expect("apply 敏感路径:拒绝且文件未变",
               (r.returncode != 0, repo.joinpath(".claude/settings.json").read_text(),
                ".claude/settings.json" in r.stderr,
                "show them to the user and apply with --allow-sensitive only after they agree:" in r.stderr), (True, "{}\n", True, True))
        r = mmrun(root, "apply", "ap-claude", "--keep", "--allow-sensitive")
        expect("apply --allow-sensitive 放行", (r.returncode, repo.joinpath(".claude/settings.json").read_text()), (0, '{"x":1}\n'))

        repo = apply_case("ap-space", {"x.txt": "x\n"}, {"sub dir/.vscode/a b.json": "{}\n"})
        r = mmrun(root, "apply", "ap-space", "--keep")
        expect("apply 敏感路径:深层带空格路径被拒", (r.returncode != 0, "sub dir/.vscode/a b.json" in r.stderr,
               repo.joinpath("sub dir").exists()), (True, True, False))

        repo = apply_case("ap-rename", {"ci.yml": "on: push\n" * 5}, {"ci.yml": None, ".github/workflows/ci.yml": "on: push\n" * 5})
        r = mmrun(root, "apply", "ap-rename", "--keep")
        expect("apply 敏感路径:重命名的新路径被拒", (r.returncode != 0, ".github/workflows/ci.yml" in r.stderr,
               repo.joinpath("ci.yml").exists()), (True, True, True))

        # macOS 默认文件系统不区分大小写:.Claude/Settings.json 写到的就是 .claude/settings.json
        repo = apply_case("ap-case", {"x.txt": "x\n"}, {".Claude/Settings.json": "{}\n", ".VSCode/t.json": "{}\n"})
        r = mmrun(root, "apply", "ap-case", "--keep")
        expect("apply 敏感路径:大小写变体被拒", (r.returncode != 0, ".Claude/Settings.json" in r.stderr,
               ".VSCode/t.json" in r.stderr), (True, True, True))

        # numstat -z 对重命名只给新路径:把受保护文件改名移走也要拦
        repo = apply_case("ap-rename-src", {".githooks/pre": "#!/bin/sh\n" * 5}, {".githooks/pre": None, "ordinary": "#!/bin/sh\n" * 5})
        r = mmrun(root, "apply", "ap-rename-src", "--keep")
        expect("apply 敏感路径:重命名的旧路径被拒", (r.returncode != 0, ".githooks/pre" in r.stderr,
               repo.joinpath("ordinary").exists()), (True, True, False))
        for rid, p in (("ap-codex", ".codex/config.toml"), ("ap-skills", ".claude/skills/s/SKILL.md"), ("ap-agents-file", ".claude/agents")):
            repo = apply_case(rid, {"x.txt": "x\n"}, {p: "x\n"})
            r = mmrun(root, "apply", rid, "--keep")
            expect(f"apply 敏感路径:{p} 被拒", (r.returncode != 0, p in r.stderr, repo.joinpath(p).exists()), (True, True, False))
        repo = apply_case("ap-link", {"x.txt": "x\n"}, {})
        pathlib.Path(root, "ap-link", "grok.patch").write_text(
            "diff --git a/.vscode b/.vscode\nnew file mode 120000\n--- /dev/null\n+++ b/.vscode\n@@ -0,0 +1 @@\n+evil\n\\ No newline at end of file\n")
        r = mmrun(root, "apply", "ap-link", "--keep")
        expect("apply 敏感路径:.vscode 换成符号链接被拒", (r.returncode != 0, ".vscode" in r.stderr, os.path.lexists(repo / ".vscode")),
               (True, True, False))
        repo = apply_case("ap-corrupt", {"x.txt": "x\n"}, {"x.txt": "y\n"})
        pathlib.Path(root, "ap-corrupt", "grok.patch").write_text("diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-x\n")
        r = mmrun(root, "apply", "ap-corrupt", "--keep")
        expect("apply:numstat 失败时报错退出,不当作无敏感路径", (r.returncode != 0, "numstat" in r.stderr, repo.joinpath("x.txt").read_text()),
               (True, True, "x\n"))

        r = subprocess.run([str(MMRUN), "review", "--patch", "rp-run", "--paths", "a.txt", "--models", "grok"],
                           capture_output=True, text=True, env=renv, timeout=60)
        expect("review --patch 与 --paths 互斥", r.returncode != 0, True)

        repo = apply_case("ap-head",{"x.txt": "x\n"}, {"x.txt": "y\n"})
        repo.joinpath("z.txt").write_text("z\n"); git("-C", str(repo), "add", "z.txt"); git("-C", str(repo), "commit", "-qm", "z")
        r = mmrun(root, "apply", "ap-head", "--keep")
        expect("apply HEAD 离开 base:成功并提示", (r.returncode, repo.joinpath("x.txt").read_text(), "HEAD has moved from" in r.stderr),
               (0, "y\n", True))

        repo = apply_case("ap-conflict", {"x.txt": "x\n"}, {"x.txt": "y\n"})
        repo.joinpath("x.txt").write_text("local\n")
        r = mmrun(root, "apply", "ap-conflict", "--keep")
        expect("apply 冲突:非零、叫停问用户、点明 --3way 写 index、给出 patch 路径",
               (r.returncode != 0, r.stderr.splitlines()[-1:], repo.joinpath("x.txt").read_text()),
               (True, ["mmrun: patch conflicts with the current working tree; stop and ask the user. Do not use git apply --3way: "
                       f"it writes the index. Patch at {pathlib.Path(root, 'ap-conflict', 'grok.patch')}"], "local\n"))

        # apply 本身失败(--check 已过、目标目录只读):非零、报出 patch 路径、不删 worktree
        repo = apply_case("ap-fail", {"x.txt": "x\n", "ro/keep.txt": "k\n"}, {"ro/new.txt": "n\n"})
        fwt = pathlib.Path(tmp, "ap-fail", "wt")
        git("-C", str(repo), "worktree", "add", "--quiet", "--detach", str(fwt))
        rmeta = pathlib.Path(root, "ap-fail", "run.meta"); rmeta.write_text(rmeta.read_text().replace("wt=\n", f"wt={fwt}\n"))
        repo.joinpath("ro").chmod(0o555)
        r = mmrun(root, "apply", "ap-fail")
        repo.joinpath("ro").chmod(0o755)
        expect("apply 失败:非零、不是冲突、报出 patch 路径、worktree 保留",
               (r.returncode != 0, "conflicts" in r.stderr, str(pathlib.Path(root, "ap-fail", "grok.patch")) in r.stderr, fwt.exists()),
               (True, False, True, True))

        # 从子目录发起的 run:patch 相对仓库根,apply 要在仓库根执行,根目录的文件也得改到
        repo = apply_case("ap-sub", {"root.txt": "r\n", "sub/s.txt": "s\n"}, {"root.txt": "R\n", "sub/s.txt": "S\n"})
        rmeta = pathlib.Path(root, "ap-sub", "run.meta")
        rmeta.write_text(rmeta.read_text().replace(f"workdir={repo}\n", f"workdir={repo / 'sub'}\n"))
        r = mmrun(root, "apply", "ap-sub", "--keep")
        expect("apply 子目录 run:根目录与子目录的文件都改到",
               (r.returncode, repo.joinpath("root.txt").read_text(), repo.joinpath("sub/s.txt").read_text()), (0, "R\n", "S\n"))

        # check:从 base 新开干净 worktree 应用 patch 再跑命令,模型 worktree 里的未跟踪文件不能带进来
        repo = apply_case("ck", {"a.txt": "a\n"}, {"a.txt": "new\n"})
        mwt = pathlib.Path(tmp, "ck", ".mm-wt", "repo-ck")
        git("-C", str(repo), "worktree", "add", "--quiet", "--detach", str(mwt))
        mwt.joinpath("leftover.txt").write_text("x\n")
        rd = pathlib.Path(root, "ck"); rmeta = rd / "run.meta"
        rmeta.write_text(rmeta.read_text().replace("wt=\n", f"wt={mwt}\n"))
        ck = rd / "grok.check"
        r = mmrun(root, "check", "ck", "--", "sh", "-c", "cat a.txt; test ! -e leftover.txt")
        cktext = ck.read_text() if ck.exists() else ""
        expect("check PASS:退出 0、首行 exit=0、含 new", (r.returncode, cktext.split("\n")[0], "new" in cktext), (0, "exit=0", True))
        expect("check PASS:输出带命令输出的最后一个非空行", r.stdout, f"check: PASS\nnew\n{ck}\n")
        expect("check PASS:status 含 check:PASS", "check:PASS" in mmrun(root, "status", "ck").stdout, True)
        expect("check 后 check worktree 已移除", "-check" in git("-C", str(repo), "worktree", "list"), False)
        r = mmrun(root, "check", "ck", "--", "sh", "-c", "exit 3")
        cktext = ck.read_text() if ck.exists() else ""
        expect("check FAIL:退出 3、首行 exit=3", (r.returncode, cktext.split("\n")[0]), (3, "exit=3"))
        expect("check FAIL:status 含 check:FAIL", "check:FAIL" in mmrun(root, "status", "ck").stdout, True)
        r = mmrun(root, "check", "ck", "--", "sh", "-c", "seq 1 30; exit 4")
        expect("check FAIL:输出带命令输出的最后 20 行", (r.returncode, r.stdout),
               (4, "check: FAIL (exit 4)\n" + "".join(f"{i}\n" for i in range(11, 31)) + f"{ck}\n"))
        r = mmrun(root, "check", "ck", "--", "sh", "-c", "echo hi", "--help")
        expect("check -- 之后的 --help 属于命令,不打印帮助", r.stdout, f"check: PASS\nhi\n{ck}\n")

        # cancel:杀掉整个进程组,status 写 CANCELLED
        rd = pathlib.Path(root, "cancel"); rd.mkdir()
        rd.joinpath("run.meta").write_text("runid=cancel\nmode=review\nmodels=grok\n")
        p = subprocess.Popen(["perl", "-MPOSIX", "-e", "POSIX::setsid(); exec @ARGV", "--", "sleep", "100"])
        reaper = threading.Thread(target=p.wait); reaper.start()  # 及时收尸:僵尸进程会让 kill -0 一直成功
        time.sleep(0.5)  # 等 setsid 生效,否则进程组号还不存在
        rd.joinpath("grok.pid").write_text(f"{p.pid}\n"); rd.joinpath("grok.status").write_text("RUNNING\n")
        r = mmrun(root, "cancel", "cancel")
        reaper.join(timeout=10)
        exited = p.returncode is not None
        if not exited: p.kill(); reaper.join()
        expect("cancel:进程已退出、status CANCELLED", (exited, rd.joinpath("grok.status").read_text().strip()), (True, "CANCELLED"))
        expect("cancel:写 grok.reason", rd.joinpath("grok.reason").read_text() if rd.joinpath("grok.reason").exists() else None,
               "cancelled by mmrun cancel\n")

        # status:已结束且没有 .meta 的模型,秒数取 .status 的修改时间而不是现在;非 DONE 的行以 .reason 结尾;worker 不在了写 STALE 与原因
        rd = pathlib.Path(root, "ended"); rd.mkdir()
        rd.joinpath("run.meta").write_text("runid=ended\nmode=review\nmodels=grok,codex\n")
        now = int(time.time())
        rd.joinpath("grok.started").write_text(f"{now - 10000}\n"); rd.joinpath("grok.status").write_text("FAIL:1\n")
        os.utime(rd / "grok.status", (now - 9000, now - 9000)); rd.joinpath("grok.reason").write_text("exit 1: boom\n")
        dead = subprocess.Popen(["true"]); dead.wait()
        rd.joinpath("codex.started").write_text(f"{now - 50}\n"); rd.joinpath("codex.status").write_text("RUNNING\n")
        rd.joinpath("codex.pid").write_text(f"{dead.pid}\n")
        lines = {l.split()[0]: l for l in mmrun(root, "status", "ended").stdout.splitlines()[1:]}
        expect("status 已结束无 .meta:秒数按 .status 修改时间算、行尾是原因",
               (lines.get("grok", "").split()[2], lines.get("grok", "").endswith(" exit 1: boom")), ("1000s", True))
        expect("status worker 已退出:STALE、写 codex.reason、行尾是原因",
               (lines.get("codex", "").split()[1:2], rd.joinpath("codex.reason").exists(),
                lines.get("codex", "").endswith(" " + (rd.joinpath("codex.reason").read_text().strip() if rd.joinpath("codex.reason").exists() else "-"))),
               (["STALE"], True, True))

        # status:RUNNING 时显示 raw 多久没更新
        rd = pathlib.Path(root, "quiet"); rd.mkdir()
        rd.joinpath("run.meta").write_text("runid=quiet\nmode=review\nmodels=grok\n")
        rd.joinpath("grok.status").write_text("RUNNING\n"); rd.joinpath("grok.pid").write_text(f"{os.getpid()}\n")
        raw = rd / "grok.raw"; raw.write_text(""); t = time.time() - 100; os.utime(raw, (t, t))
        expect("status RUNNING 显示静默时长", " quiet:" in mmrun(root, "status", "quiet").stdout, True)

        # 单个模型 RUNNING 满 90 分钟:status / wait 结束它的进程组,写 FAIL:timeout;同 run 的其他模型不动
        def timeout_case(rid, age):
            rd = pathlib.Path(root, rid); rd.mkdir()
            rd.joinpath("run.meta").write_text(f"runid={rid}\nmode=review\nmodels=grok,codex\n")
            p = subprocess.Popen(["perl", "-MPOSIX", "-e", "POSIX::setsid(); exec @ARGV", "--", "sleep", "100"])
            reaper = threading.Thread(target=p.wait); reaper.start()
            time.sleep(0.5)
            rd.joinpath("grok.pid").write_text(f"{p.pid}\n"); rd.joinpath("grok.status").write_text("RUNNING\n")
            rd.joinpath("grok.started").write_text(f"{int(time.time()) - age}\n")
            rd.joinpath("codex.status").write_text("DONE\n"); rd.joinpath("codex.started").write_text(f"{int(time.time()) - age}\n")
            return rd, p, reaper
        def finish(p, reaper):
            reaper.join(timeout=10)
            exited = p.returncode is not None
            if not exited: p.kill(); reaper.join()
            return exited
        rd, p, reaper = timeout_case("tmo", 5401)
        r = mmrun(root, "status", "tmo")
        gline = next((l for l in r.stdout.splitlines() if l.startswith("grok")), "")
        greason = rd.joinpath("grok.reason").read_text() if rd.joinpath("grok.reason").exists() else ""
        expect("status 满 90 分钟:进程已退出、FAIL:timeout、grok.reason 与行尾是 timeout after <N> s、codex 仍 DONE",
               (finish(p, reaper), rd.joinpath("grok.status").read_text().strip(),
                greason in ("timeout after 5401 s\n", "timeout after 5402 s\n"), gline.endswith(" " + greason.strip()),
                rd.joinpath("codex.status").read_text().strip()), (True, "FAIL:timeout", True, True, "DONE"))
        rd, p, reaper = timeout_case("tmo-young", 100)
        mmrun(root, "status", "tmo-young")
        alive = p.poll() is None
        p.kill(); reaper.join()
        expect("status 未满 90 分钟:仍 RUNNING、进程还在", (rd.joinpath("grok.status").read_text().strip(), alive), ("RUNNING", True))
        rd, p, reaper = timeout_case("tmo-wait", 5401)
        r = subprocess.run([str(MMRUN), "wait", "tmo-wait", "--timeout", "5"], capture_output=True, text=True, timeout=30,
                           env=dict(os.environ, MMRUN_HOME=root, MMRUN_D=str(PLUGIN / "mmrun.d")))
        expect("wait 满 90 分钟:结束进程并返回 0、FAIL:timeout、输出含 timeout after",
               (finish(p, reaper), r.returncode, rd.joinpath("grok.status").read_text().strip(), " timeout after " in r.stdout),
               (True, 0, "FAIL:timeout", True))

        # ask --from:在父 run 的外部模型会话上续聊;thread 显示续聊链
        askd = pathlib.Path(tmp, "ask"); work = askd / "work"; work.mkdir(parents=True)  # 记录文件不能放在 work 下:围栏禁写被审目录
        recs = {m: askd / f"{m}.rec" for m in ("codex", "grok", "agy")}
        prms = {m: askd / f"{m}.prm" for m in ("codex", "grok", "agy")}  # 每次调用收到的 prompt,以 ===== 分隔
        record = 'for a in "$@"; do printf "%s\\n" "$a" >> \'{rec}\'; done\necho --- >> \'{rec}\'\n'
        save_arg = 'prev=""\nfor a in "$@"; do [ "$prev" = {flag} ] && {save}; prev="$a"; done\necho ===== >> \'{{prm}}\'\n'
        bodies = {
            "codex": 'out=""; prev=""\nfor a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done\n'
                     'cat >> \'{prm}\'\necho ===== >> \'{prm}\'\necho ok > "$out"\necho \'{{"type":"thread.started","thread_id":"t-1"}}\'\n',
            "grok": save_arg.format(flag="--prompt-file", save="cat \"$a\" >> '{prm}'")
                    + "printf '{{\"text\":\"ok\"}}'\n",
            "agy": save_arg.format(flag="-p", save="printf '%s\\n' \"$a\" >> '{prm}'")
                   + "printf '{{\"response\":\"ok\",\"conversation_id\":\"c-1\"}}'\n",
        }
        aenv = dict(env, HOME=str(TEST_HOME))  # codex's mm profile is generated under TEST_HOME, not checked against the real one
        for m, body in bodies.items():
            fake = askd / f"fake-{m}"; fake.write_text("#!/bin/sh\n" + MCP_NONE + (record + body).format(rec=recs[m], prm=prms[m])); fake.chmod(0o755)
            aenv[f"{m.upper()}_BIN"] = str(fake)
        def ask_cmd(*args, prompt="q\n"):
            r = subprocess.run([str(MMRUN), *args], input=prompt, capture_output=True, text=True, env=aenv, timeout=60)
            rid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
            if rid != "missing": mmrun(root, "wait", rid, "--timeout", "60")
            return r, rid
        def calls(m):
            return [c.splitlines() for c in recs[m].read_text().split("---\n")[:-1]] if recs[m].exists() else []
        def run_meta(rid):
            p = pathlib.Path(root, rid, "run.meta")
            return p.read_text() if p.exists() else ""
        _, prid = ask_cmd("start", "--models", "codex,grok,agy", "--dir", str(work), prompt="first\n")
        uuid = pathlib.Path(root, prid, "grok.session").read_text().strip() if prid != "missing" else "missing"
        r, crid = ask_cmd("ask", "--from", prid, prompt="second\n")
        expect("ask:退出 0", (r.returncode, r.stderr), (0, ""))
        c2 = (calls("codex") + [[], []])[1]
        expect("ask codex:resume t-1 在 -o 之后、prompt 走 stdin",
               ("resume" in c2, "t-1" in c2, "-o" in c2 and "resume" in c2 and c2.index("-o") < c2.index("resume"), c2[-1:]),
               (True, True, True, ["-"]))
        g2 = (calls("grok") + [[], []])[1]
        expect("ask grok:-r 父 uuid,不带 -s", ("-r" in g2, uuid in g2, "-s" in g2), (True, True, False))
        a2 = (calls("agy") + [[], []])[1]
        expect("ask agy:--conversation c-1", ("--conversation" in a2, "c-1" in a2), (True, True))
        expect("ask 子 run:parent/root/mode/tag", (f"\nparent={prid}\n" in run_meta(crid), f"\nroot={prid}\n" in run_meta(crid),
               "\nmode=start\n" in run_meta(crid), "\ntag=ask:\n" in run_meta(crid)), (True, True, True, True))
        expect("start 父 run:parent/root 为空", ("\nparent=\n" in run_meta(prid), "\nroot=\n" in run_meta(prid)), (True, True))
        r, grid = ask_cmd("ask", "--from", crid, prompt="third\n")
        expect("ask 孙 run:root 为最初的父", (r.returncode, f"\nparent={crid}\n" in run_meta(grid), f"\nroot={prid}\n" in run_meta(grid)),
               (0, True, True))
        g3 = (calls("grok") + [[], [], []])[2]
        expect("ask 孙 run grok:仍续父 uuid", ("-r" in g3, uuid in g3), (True, True))

        r = mmrun(root, "thread", grid)
        expect("thread:父→子→孙,每 run 三行", [l.split()[0] for l in r.stdout.splitlines() if l.strip()], [prid] * 3 + [crid] * 3 + [grid] * 3)
        first = (r.stdout.splitlines() + [""])[0].split("  ")
        expect("thread:行格式", (first[:5], first[5:6] != [] and first[5].endswith("s"), first[6:]),
               ([prid, "codex", "DONE", "-", "-"], True, ["-"]))

        # 拒绝:父 run 仍在运行
        pst = pathlib.Path(root, prid, "codex.status"); ppid_f = pathlib.Path(root, prid, "codex.pid")
        old_pid = ppid_f.read_text() if ppid_f.exists() else ""
        pst.write_text("RUNNING\n"); ppid_f.write_text(f"{os.getpid()}\n")
        r, rid = ask_cmd("ask", "--from", prid)
        expect("ask 拒绝:父 run 有模型 RUNNING", (r.returncode != 0, rid), (True, "missing"))
        pst.write_text("DONE\n"); ppid_f.write_text(old_pid)
        # 拒绝:另一个 RUNNING 的 run 正在续同一会话
        busy = pathlib.Path(root, "ask-busy"); busy.mkdir()
        busy.joinpath("run.meta").write_text(f"runid=ask-busy\nmode=start\nmodels=codex\nparent={prid}\n")
        busy.joinpath("codex.status").write_text("RUNNING\n"); busy.joinpath("codex.pid").write_text(f"{os.getpid()}\n")
        r, rid = ask_cmd("ask", "--from", prid, "--models", "codex")
        expect("ask 拒绝:同一 sid 在别的 run 里 RUNNING", (r.returncode != 0, "ask-busy" in r.stderr, rid), (True, True, "missing"))
        busy.joinpath("codex.status").write_text("DONE\n")
        # 拒绝:--models 含父 run 没有 sid 的模型
        nos = pathlib.Path(root, "ask-nosid"); nos.mkdir()
        nos.joinpath("run.meta").write_text(f"runid=ask-nosid\nmode=review\nmodels=codex,grok\nworkdir={work}\n")
        for m, s in (("codex", "t-9"), ("grok", "")):
            nos.joinpath(f"{m}.sid").write_text(s + "\n"); nos.joinpath(f"{m}.status").write_text("DONE\n")
        r, rid = ask_cmd("ask", "--from", "ask-nosid", "--models", "codex,grok")
        expect("ask 拒绝:--models 含无 sid 的模型", (r.returncode != 0, "grok" in r.stderr, rid), (True, True, "missing"))
        # 拒绝:派活 run 的 worktree 不存在
        arun = pathlib.Path(root, "ask-run"); arun.mkdir()
        arun.joinpath("run.meta").write_text(f"runid=ask-run\nmode=run\nmodels=grok\nworkdir={work}\n")
        arun.joinpath("grok.sid").write_text("s\n"); arun.joinpath("grok.status").write_text("DONE\n")
        r, rid = ask_cmd("ask", "--from", "ask-run")
        expect("ask 拒绝:派活 run 无 worktree", (r.returncode != 0, "worktree" in r.stderr, rid), (True, True, "missing"))

        # 续聊继承父 run 的模型名
        _, mrid = ask_cmd("start", "--models", "grok", "--dir", str(work), "--grok-model", "gx", prompt="m\n")
        r, _ = ask_cmd("ask", "--from", mrid)
        g = (calls("grok") or [[]])[-1]
        expect("ask 继承模型名:grok 带 -m gx", (r.returncode, "-m" in g and g[g.index("-m") + 1] == "gx"), (0, True))

        # --with / --cross:手工造父 run(三个模型都 DONE,各有 review.schema 格式的 json)
        aenv["MMRUN_SEED"] = "1"
        def prompts(m):
            return prms[m].read_text().split("=====\n")[:-1] if prms[m].exists() else []
        def last_prompts():
            return [(prompts(m) or [""])[-1] for m in ("codex", "grok", "agy")]
        def rv(claim):
            o = json.loads(review("s", "major")); o["findings"][0]["claim"] = claim
            return json.dumps(o, ensure_ascii=False)
        def mkparent(rid, outs, mode="review"):
            rd = pathlib.Path(root, rid); rd.mkdir()
            rd.joinpath("run.meta").write_text(f"runid={rid}\nmode={mode}\nmodels=codex,grok,agy\nworkdir={work}\n"
                                               f"schema={SCHEMA if mode == 'review' else ''}\nparent=\nroot=\n")
            for i, (m, out) in enumerate(outs.items()):
                rd.joinpath(f"{m}.sid").write_text(f"s-{i}\n"); rd.joinpath(f"{m}.status").write_text("DONE\n")
                rd.joinpath(f"{m}.out").write_text(out)
                if out.startswith("{"): rd.joinpath(f"{m}.json").write_text(out)
            return rd
        three = {"codex": rv("CLAIM-1"), "grok": rv("CLAIM-2"), "agy": rv("CLAIM-3")}
        mkparent("x-par", three)
        r, xrid = ask_cmd("ask", "--from", "x-par", "--cross")
        cp, gp, ap = last_prompts()
        expect("ask --cross:退出 0", (r.returncode, r.stderr), (0, ""))
        expect("ask --cross:各模型收到另两位的论点、不含自己的",
               [tuple(f"CLAIM-{i}" in p for i in (1, 2, 3)) for p in (cp, gp, ap)],
               [(False, True, True), (True, False, True), (True, True, False)])
        expect("ask --cross:codex prompt 含追问、with.md、匿名标题,MMRUN_SEED 下按原顺序",
               (cp.startswith("q\n"), "is not evidence" in cp, "### Another reviewer (anonymous A)" in cp, "### Another reviewer (anonymous B)" in cp,
                0 <= cp.find("CLAIM-2") < cp.find("CLAIM-3")), (True,) * 5)
        expect("ask --cross:prompt 不含模型名", [n in cp for n in ("codex", "grok", "agy")], [False] * 3)
        STANCE = "Mark each of your findings with a stance"
        expect("ask --cross review 父 run:prompt 含 stance 与 evidence_for_change 两行",
               (STANCE in cp, "evidence_for_change" in cp), (True, True))
        expect("ask --cross:子 run 用 review-ask schema、cross=1",
               (f"\nschema={ASK_SCHEMA}\n" in run_meta(xrid), "\ncross=1\n" in run_meta(xrid)), (True, True))

        r, wrid = ask_cmd("ask", "--from", "x-par", "--with", "x-par:grok")
        expect("ask --with P:grok:每个模型只收到 grok 的论点",
               (r.returncode, [tuple(f"CLAIM-{i}" in p for i in (1, 2, 3)) for p in last_prompts()]),
               (0, [(False, True, False)] * 3))
        expect("ask --with:run.meta 记 with/cross", ("\nwith=x-par:grok\n" in run_meta(wrid), "\ncross=0\n" in run_meta(wrid)),
               (True, True))

        mkparent("x-spar", three, mode="start")
        r, _ = ask_cmd("ask", "--from", "x-spar", "--cross")
        expect("ask --cross start 父 run:prompt 不含 stance 与 evidence_for_change,通用几行仍在",
               (r.returncode, [(STANCE in p, "evidence_for_change" in p, "is not evidence" in p, "Report as new" in p)
                               for p in last_prompts()]), (0, [(False, False, True, True)] * 3))

        mkparent("x-big", dict(three, grok="x" * 13000))
        r, rid = ask_cmd("ask", "--from", "x-big", "--cross")
        expect("ask --cross 拒绝:单份论点超 12KB", (r.returncode != 0, "12KB" in r.stderr, rid), (True, True, "missing"))

        mkparent("x-lim", three)
        for i in (1, 2):
            pathlib.Path(root, f"x-lim-c{i}").mkdir()
            pathlib.Path(root, f"x-lim-c{i}", "run.meta").write_text(f"runid=x-lim-c{i}\nmode=review\nparent=x-lim\nroot=x-lim\ncross=1\n")
        r, rid = ask_cmd("ask", "--from", "x-lim", "--cross")
        expect("ask --cross 拒绝:同一 root 已有 2 轮", (r.returncode != 0, "--force" in r.stderr, rid), (True, True, "missing"))
        r, rid = ask_cmd("ask", "--from", "x-lim", "--cross", "--force")
        expect("ask --cross --force 放行", (r.returncode, rid != "missing"), (0, True))

        pathlib.Path(mkparent("x-fail", three), "grok.status").write_text("FAIL:1\n")
        r, rid = ask_cmd("ask", "--from", "x-par", "--with", "x-fail:grok")
        expect("ask --with 拒绝:模型 status 不是 DONE", (r.returncode != 0, rid), (True, "missing"))

        # 从 review run 续聊:子 run 继承被审版本,quote 校验按同一版本核对
        SHA0 = "0123456789abcdef0123456789abcdef01234567"
        rvp = pathlib.Path(root, "ask-rv"); rvp.mkdir()
        rvp.joinpath("run.meta").write_text(f"runid=ask-rv\nmode=review\nmodels=codex\nworkdir={work}\nschema={SCHEMA}\nreviewed={SHA0}\n")
        rvp.joinpath("codex.sid").write_text("t-rv\n"); rvp.joinpath("codex.status").write_text("DONE\n")
        r, rid = ask_cmd("ask", "--from", "ask-rv")
        expect("ask 继承被审版本:子 run 的 reviewed= 同父", (r.returncode, f"\nreviewed={SHA0}\n" in run_meta(rid)), (0, True))

        o = json.loads(rv("CLAIM-9")); f = o["findings"][0]
        o["findings"] = [dict(f, stance="new", evidence_for_change=None), dict(f, stance="withdrawn", evidence_for_change="a.py:1")]
        if xrid != "missing": pathlib.Path(root, xrid, "codex.json").write_text(json.dumps(o, ensure_ascii=False))
        line = next((l for l in mmrun(root, "thread", xrid).stdout.splitlines() if l.startswith(f"{xrid}  codex  ")), "")
        expect("thread:findings 带 stance 时显示 n/m/r/w", "  n1/m0/r0/w1  " in line, True)

        # start --stage:role → hard_constraints → context(材料)→ question → 收尾句;--brief 只给指定模型
        def ftext(p):
            return p.read_text() if p.exists() else ""
        cons = askd / "cons.md"; cons.write_text("CONS-RULE\n")
        brief = askd / "brief.md"; brief.write_text("BRIEF-ONLY-GROK\n")
        r, srid = ask_cmd("start", "--stage", "premortem", "--question", "Q-TEXT", "--constraints", str(cons),
                          "--dir", str(work), prompt="MATERIAL-X\n")
        sp = ftext(pathlib.Path(root, srid, "prompt.md"))
        pos = [sp.find(s) for s in ("<role>", "<hard_constraints>", "<context", "MATERIAL-X", "<question>",
                                    "Based on the material above, answer: Q-TEXT")]
        expect("start --stage:prompt 各段依次出现", (r.returncode, min(pos) >= 0, pos == sorted(pos)), (0, True, True))
        expect("start --stage:meta 记 stage 与 schema",
               ("\nstage=premortem\n" in run_meta(srid), f"\nschema={STAGES / 'premortem.schema.json'}\n" in run_meta(srid)),
               (True, True))
        r, srid = ask_cmd("start", "--stage", "premortem", "--question", "Q", "--dir", str(work), prompt="M\n")
        sp = ftext(pathlib.Path(root, srid, "prompt.md"))
        expect("start --stage 无 --constraints:没有 hard_constraints", (r.returncode, "<question>" in sp, "<hard_constraints>" in sp),
               (0, True, False))
        r, srid = ask_cmd("start", "--stage", "options", "--question", "Q", "--brief", f"grok={brief}", "--dir", str(work), prompt="M\n")
        gp = ftext(pathlib.Path(root, srid, "prompt.grok.md"))
        expect("start --brief grok:prompt.grok.md 的分工在 question 之前",
               (r.returncode, 0 <= gp.find("<your_assignment>") < gp.find("BRIEF-ONLY-GROK") < gp.find("<question>")), (0, True))
        expect("start --brief grok:grok 收到分工,codex 没收到",
               ("BRIEF-ONLY-GROK" in (prompts("grok") or [""])[-1], "BRIEF-ONLY-GROK" in (prompts("codex") or ["BRIEF-ONLY-GROK"])[-1]),
               (True, False))
        def start_err(*a):
            return subprocess.run([str(MMRUN), "start", *a, "--dir", str(work)], input="M\n", capture_output=True,
                                  text=True, env=aenv, timeout=60)
        r = start_err("--stage", "premortem", "--question", "Q", "--brief", f"agy={brief}")
        expect("start --brief 模型不在 --models:非零", r.returncode != 0, True)
        r = start_err("--stage", "bogus", "--question", "Q")
        expect("start --stage bogus:非零并列出四个阶段",
               (r.returncode != 0, all(s in r.stderr for s in ("clarify", "options", "premortem", "hypotheses"))), (True, True))
        expect("start --stage 无 --question:非零", start_err("--stage", "premortem").returncode != 0, True)
        expect("start --stage 与 --schema 互斥:非零",
               start_err("--stage", "premortem", "--question", "Q", "--schema", str(SCHEMA)).returncode != 0, True)

        # 通用渲染:按 schema 键序(grok 输出键序打乱),空数组与 null 不输出,对象数组一行用 · 连接
        pm = {"verdict": "revise", "unknowns": [], "summary": "S-SUM", "caller_challenge": None, "not_checked": ["N1"],
              "questions_for_user": [{"recommended": "yes", "q": "UQ"}],
              "failures": [{"id": "F1", "basis": "traced", "failure": "lost write", "construction": "two runs race",
                            "evidence": "a.sh:3", "one_way": True, "undo_cost": "restore backup"}],
              "would_change_my_mind": [{"need": "N", "why": "W"}],
              "assumptions": [{"id": "A1", "claim": "CL", "how_to_verify": "H", "basis": "inferred"}]}
        pmj = askd / "pm.json"; pmj.write_text(json.dumps({"structuredOutput": pm}))
        pmf = askd / "fake-pm"; pmf.write_text(f"#!/bin/sh\ncat '{pmj}'\n"); pmf.chmod(0o755)
        r = subprocess.run([str(MMRUN), "start", "--stage", "premortem", "--question", "Q", "--models", "grok", "--dir", str(work)],
                           input="M\n", capture_output=True, text=True, env=dict(aenv, GROK_BIN=str(pmf)), timeout=60)
        prid2 = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        if prid2 != "missing": mmrun(root, "wait", prid2, "--timeout", "60")
        out = mmrun(root, "result", "grok", prid2).stdout
        expect("render stage:按 schema 键序、空数组与 null 不出现",
               [l.split(":")[0] for l in out.splitlines() if l and not l.startswith(" ")],
               ["failures", "assumptions", "not_checked", "would_change_my_mind", "questions_for_user", "summary", "verdict"])
        expect("render stage:对象数组一行用 · 连接", any(l.startswith("  - ") and " · " in l for l in out.splitlines()), True)

        # 派活续做:同一 worktree、同一会话接着改;子 run 的 patch 只含本轮增量
        def mm(*args, e, prompt=None):
            r = subprocess.run([str(MMRUN), *args], input=prompt, capture_output=True, text=True, env=e, timeout=60)
            rid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
            if rid != "missing": mmrun(root, "wait", rid, "--timeout", "60")
            return r, rid
        def read(p):
            return p.read_text() if p.exists() else ""
        cont = pathlib.Path(tmp, "cont"); repo = cont / "repo"; git("init", "-q", str(repo))
        repo.joinpath("x.txt").write_text("x\n"); git("-C", str(repo), "add", "x.txt"); git("-C", str(repo), "commit", "-qm", "init")
        fake = cont / "grok"
        fake.write_text('#!/bin/sh\ncwd=""; prev=""; r=0\n'
                        'for a in "$@"; do [ "$prev" = --cwd ] && cwd="$a"; [ "$a" = -r ] && r=1; prev="$a"; done\n'
                        'if [ $r = 1 ]; then echo 2 > "$cwd/a.txt"; echo b > "$cwd/b.txt"; else echo 1 > "$cwd/a.txt"; fi\n'
                        "printf '{\"text\":\"ok\"}'\n")
        fake.chmod(0o755)
        task = cont / "task.md"; task.write_text("t\n")
        genv = dict(env, GROK_BIN=str(fake))
        _, prid = mm("run", "--model", "grok", "--task", str(task), "--dir", str(repo), e=genv)
        pd = pathlib.Path(root, prid)
        cwt = pathlib.Path(next((l[3:] for l in read(pd / "run.meta").splitlines() if l.startswith("wt=")), "/nonexistent"))
        gitf = cwt / ".git"; orig = read(gitf)
        if gitf.exists(): gitf.write_text("gitdir: /private/tmp/elsewhere\n")
        r, rid = mm("ask", "--from", prid, e=genv, prompt="more\n")
        expect("续做拒绝:.git 指针被改", (r.returncode != 0, rid), (True, "missing"))
        if gitf.exists(): gitf.write_text(orig)
        r, crid = mm("ask", "--from", prid, e=genv, prompt="more\n")
        cd = pathlib.Path(root, crid)
        expect("续做:退出 0、子 run DONE", (r.returncode, r.stderr, read(cd / "grok.status").strip()), (0, "", "DONE"))
        cpatch, cfull = read(cd / "grok.patch"), read(cd / "grok.patch.full")
        expect("续做 patch 只含增量:a.txt 1→2、新增 b.txt,无新增 a.txt",
               ("\n-1\n+2\n" in cpatch, "b/b.txt" in cpatch, cpatch.count("new file mode")), (True, True, 1))
        expect("续做 patch.full 相对 base:a.txt=2 与 b.txt 都是新增",
               ("\n+2\n" in cfull, "\n-1\n" in cfull, "b/b.txt" in cfull, cfull.count("new file mode")), (True, False, True, 2))
        expect("续做:父 run 有 grok.tree", (pd / "grok.tree").exists(), True)
        expect("续做:子 run 的 wt 与父相同", f"\nwt={cwt}\n" in read(cd / "run.meta"), True)
        r, rid = mm("ask", "--from", prid, e=genv, prompt="again\n")
        expect("续做拒绝:父 run 已有子 run,提示链尾", (r.returncode != 0, crid in r.stderr, rid), (True, True, "missing"))
        r = mmrun(root, "apply", prid, "--keep")
        expect("apply 拒绝:有后代的派活 run", (r.returncode != 0, crid in r.stderr, repo.joinpath("a.txt").exists()), (True, True, False))
        cst = cd / "grok.status"; cpid = cd / "grok.pid"; old_pid = read(cpid)
        if cd.is_dir(): cst.write_text("RUNNING\n"); cpid.write_text(f"{os.getpid()}\n")
        r = mmrun(root, "discard", prid)
        expect("discard 拒绝:链上有 RUNNING,worktree 仍在", (r.returncode != 0, crid in r.stderr, cwt.exists()), (True, True, True))
        if cd.is_dir(): cst.write_text("DONE\n"); cpid.write_text(old_pid)
        r = mmrun(root, "apply", crid, "--keep")
        expect("apply 链尾:原仓库 a.txt=2、b.txt 新增",
               (r.returncode, read(repo / "a.txt"), read(repo / "b.txt")), (0, "2\n", "b\n"))
        # 父 run 的 tree 已不在对象库:子 run 的 .patch 退回全量并在 stat 首行注明
        if cd.is_dir(): (cd / "grok.tree").write_text("0123456789abcdef0123456789abcdef01234567\n")
        r, lrid = mm("ask", "--from", crid, e=genv, prompt="lost\n")
        ld = pathlib.Path(root, lrid)
        expect("父 tree 丢失:patch 等于 patch.full、stat 首行注意",
               (r.returncode, bool(read(ld / "grok.patch.full")), read(ld / "grok.patch") == read(ld / "grok.patch.full"),
                (read(ld / "grok.patch.stat").splitlines() or [""])[0]),
               (0, True, True, "Note: the parent run's tree is no longer in the object store; this patch is the full diff against base"))

        # codex 续做:为子 run 生成指向同一 worktree 的 profile,运行时存在、结束后删除
        xhome = pathlib.Path(tmp, "cx-home"); xhome.joinpath(".codex").mkdir(parents=True)
        xrepo = pathlib.Path(tmp, "cx", "repo"); git("init", "-q", str(xrepo))
        xrepo.joinpath("x.txt").write_text("x\n"); git("-C", str(xrepo), "add", "x.txt"); git("-C", str(xrepo), "commit", "-qm", "init")
        xrec = pathlib.Path(tmp, "cx", "codex.rec")
        xfake = pathlib.Path(tmp, "cx", "codex")
        xfake.write_text(f'#!/bin/sh\n{MCP_NONE}for a in "$@"; do printf "%s\\n" "$a" >> \'{xrec}\'; done\n'
                         'out=""; p=""; prev=""\n'
                         'for a in "$@"; do [ "$prev" = -o ] && out="$a"; [ "$prev" = -p ] && p="$a"; prev="$a"; done\n'
                         f'test -f "$HOME/.codex/$p.config.toml" && echo "profile-present:$p" >> \'{xrec}\'\n'
                         f"echo --- >> '{xrec}'\ncat > /dev/null\necho ok > \"$out\"\n"
                         "echo '{\"type\":\"thread.started\",\"thread_id\":\"t-wt\"}'\n")
        xfake.chmod(0o755)
        xenv = dict(env, HOME=str(xhome), CODEX_BIN=str(xfake))
        _, xp = mm("run", "--model", "codex", "--task", str(task), "--dir", str(xrepo), e=xenv)
        r, xc = mm("ask", "--from", xp, e=xenv, prompt="more\n")
        last = ([c.splitlines() for c in read(xrec).split("---\n")[:-1]] or [[]])[-1]
        expect("codex 续做:-p mmwt-<子rid>、resume、运行时 profile 存在",
               (r.returncode, "-p" in last and last[last.index("-p") + 1] == f"mmwt-{xc}", "resume" in last,
                f"profile-present:mmwt-{xc}" in last), (0, True, True, True))
        first = ([c.splitlines() for c in read(xrec).split("---\n")[:-1]] or [[]])[0]
        expect("codex run 与续做:不带 skills.include_instructions", ["skills.include_instructions=false" in a for a in (first, last)], [False, False])
        expect("codex 续做:结束后 profile 已删除", xhome.joinpath(".codex", f"mmwt-{xc}.config.toml").exists(), False)
        expect("codex 续做:子 run 的 wt 与父相同",
               next((l for l in read(pathlib.Path(root, xp, "run.meta")).splitlines() if l.startswith("wt=")), "x")
               in read(pathlib.Path(root, xc, "run.meta")).splitlines(), True)

        # review 记录被审版本(run.meta reviewed=)
        qd = pathlib.Path(tmp, "qv"); repo = qd / "repo"; git("init", "-q", str(repo))
        A = [f"value_{i:02d} = compute_thing({i})" for i in range(1, 31)]
        repo.joinpath("a.py").write_text("\n".join(A) + "\n")
        repo.joinpath("b.py").write_text("other_module_marker = True\n")
        git("-C", str(repo), "add", "-A"); git("-C", str(repo), "commit", "-qm", "init")
        repo.joinpath("a.py").write_text("\n".join(A) + "\nappended_line = 1\n")
        git("-C", str(repo), "commit", "-qam", "second")
        qpay = qd / "payload.json"
        def qfinding(file, line, quote):
            return {"severity": "major", "file": file, "line": line, "quote": quote, "claim": "c", "failure_scenario": "f",
                    "basis": "traced", "suggestion": None}
        def set_payload(*fs):
            o = json.loads(review("s")); o["findings"] = list(fs)
            qpay.write_text(json.dumps({"structuredOutput": o}))
        set_payload()
        qfake = qd / "grok"; qfake.write_text(f"#!/bin/sh\ncat '{qpay}'\n"); qfake.chmod(0o755)
        qenv = dict(env, GROK_BIN=str(qfake))
        def qreview(rdir, *extra, e=qenv, models="grok"):
            r = subprocess.run([str(MMRUN), "review", "--models", models, "--dir", str(rdir), *extra],
                               capture_output=True, text=True, env=e, timeout=60)
            rid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
            if rid != "missing": mmrun(root, "wait", rid, "--timeout", "60")
            return rid
        def reviewed(rid):
            return next((l[9:] for l in run_meta(rid).splitlines() if l.startswith("reviewed=")), None)
        expect("reviewed --commit:该提交 SHA", reviewed(qreview(repo, "--commit", "HEAD~1")), git("-C", str(repo), "rev-parse", "HEAD~1"))
        expect("reviewed --base:当时的 HEAD", reviewed(qreview(repo, "--base", "HEAD~1")), git("-C", str(repo), "rev-parse", "HEAD"))
        repo.joinpath("b.py").write_text("other_module_marker = False\n"); git("-C", str(repo), "add", "b.py")
        expect("reviewed --staged:write-tree", reviewed(qreview(repo, "--staged")), git("-C", str(repo), "write-tree"))
        git("-C", str(repo), "reset", "-q", "--hard")
        repo.joinpath("a.py").write_text("\n".join(A) + "\nappended_line = 2\n")
        set_payload(qfinding("a.py", 5, A[4]), qfinding("a.py", 5, A[14]), qfinding("a.py", 1, "other_module_marker = True"),
                    qfinding("a.py", 1, "this_line_does_not_exist_anywhere()"), qfinding("a.py", 2, "x = 1\ny = 2"),
                    qfinding("a.py", 7, "+" + A[6]))
        wrid = qreview(repo)
        wobj = reviewed(wrid) or "missing"
        wtype = subprocess.run(["git", "-C", str(repo), "cat-file", "-t", wobj], capture_output=True, text=True).stdout.strip()
        wa = subprocess.run(["git", "-C", str(repo), "show", f"{wobj}:a.py"], capture_output=True, text=True).stdout
        expect("reviewed 工作树:一个 tree,含未提交改动", (wtype, "appended_line = 2" in wa), ("tree", True))
        expect("reviewed --full:prompt", reviewed(qreview(repo, "--full", "--paths", "a.py")), "prompt")

        # quote 机械校验:按记录的版本核对,标记写 .quotes 并出现在 result 里
        expect("quote 校验:.quotes 内容", read(pathlib.Path(root, wrid, "grok.quotes")),
               "0\tok\n1\tmoved:15\n2\tother_file:b.py\n3\tMISSING\n4\tunchecked\n5\tok\n")
        out = mmrun(root, "result", "grok", wrid).stdout
        expect("quote 校验:result 标题带非 ok 的 [quote …]",
               [l.rsplit("[quote ", 1)[-1].rstrip("]") if "[quote " in l else None for l in out.splitlines() if l.startswith("- **")],
               [None, "moved:15", "other_file:b.py", "MISSING", "unchecked", None])
        expect("quote 校验:标记跟在 [basis] 之后", "— c [traced] [quote MISSING]" in out, True)

        # 审查期间工作树被改(假 codex 在返回前改文件):仍按记录的对象判 ok
        mrepo = pathlib.Path(tmp, "qm", "repo"); git("init", "-q", str(mrepo))
        mrepo.joinpath("a.py").write_text("\n".join(A) + "\n"); git("-C", str(mrepo), "add", "-A"); git("-C", str(mrepo), "commit", "-qm", "i")
        mrepo.joinpath("a.py").write_text("\n".join(A[:2] + ["changed_line_content = 42"] + A[3:]) + "\n")
        mo = json.loads(review("s")); mo["findings"] = [qfinding("a.py", 3, "changed_line_content = 42")]
        mpay = pathlib.Path(tmp, "qm", "out.json"); mpay.write_text(json.dumps(mo))
        mfake = pathlib.Path(tmp, "qm", "codex")
        mfake.write_text('#!/bin/sh\n' + MCP_NONE + 'out=""; prev=""\nfor a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done\n'
                         f"cat > /dev/null\nprintf 'rewritten\\n' > '{mrepo}/a.py'\ncat '{mpay}' > \"$out\"\n"
                         "echo '{\"type\":\"thread.started\",\"thread_id\":\"t-q\"}'\n")
        mfake.chmod(0o755)
        mrid = qreview(mrepo, e=dict(env, HOME=str(TEST_HOME), CODEX_BIN=str(mfake)), models="codex")
        expect("quote 校验:审查期间文件被改仍按记录版本判 ok",
               (read(mrepo / "a.py"), read(pathlib.Path(root, mrid, "codex.quotes"))), ("rewritten\n", "0\tok\n"))

        # 默认工作树审查带上未跟踪文件、不带被忽略的;走临时 index,真 index 与 status 不变
        urepo = pathlib.Path(tmp, "qu", "repo"); git("init", "-q", str(urepo))
        urepo.joinpath(".gitignore").write_text("ignored.txt\n"); urepo.joinpath("a.py").write_text("\n".join(A) + "\n")
        git("-C", str(urepo), "add", "-A"); git("-C", str(urepo), "commit", "-qm", "i")
        urepo.joinpath("a.py").write_text("\n".join(A) + "\ntracked_change_marker = 1\n")
        U = [f"untracked_value_{i} = new_helper({i})" for i in range(1, 6)]
        urepo.joinpath("new.py").write_text("\n".join(U) + "\n")
        urepo.joinpath("ignored.txt").write_text("ignored_file_marker\n")
        ustatus = git("-C", str(urepo), "status", "--porcelain")
        uo = json.loads(review("s")); uo["findings"] = [qfinding("new.py", 3, U[2])]
        upay = pathlib.Path(tmp, "qu", "out.json"); upay.write_text(json.dumps(uo))
        ufake = pathlib.Path(tmp, "qu", "codex")
        ufake.write_text('#!/bin/sh\n' + MCP_NONE + 'out=""; prev=""\nfor a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done\n'
                         f"cat > /dev/null\ncat '{upay}' > \"$out\"\n")
        ufake.chmod(0o755)
        urid = qreview(urepo, e=dict(env, HOME=str(TEST_HOME), CODEX_BIN=str(ufake)), models="codex")
        uprompt = read(pathlib.Path(root, urid, "prompt.md"))
        expect("工作树审查:材料含已跟踪改动与未跟踪文件、不含被忽略文件",
               ("tracked_change_marker" in uprompt, U[0] in uprompt, "ignored_file_marker" in uprompt), (True, True, False))
        expect("工作树审查:真 index 未被改、status 前后一致",
               (subprocess.run(["git", "-C", str(urepo), "diff", "--cached", "--quiet"]).returncode,
                git("-C", str(urepo), "status", "--porcelain")), (0, ustatus))
        expect("工作树审查:引用未跟踪文件的 finding 引文校验 ok", read(pathlib.Path(root, urid, "codex.quotes")), "0\tok\n")

        # --full:按 prompt.md 的 ===== 路径 ===== 分段核对
        set_payload(qfinding("a.py", 12, A[11]))
        frid = qreview(repo, "--full", "--paths", "a.py")
        expect("quote 校验 --full:按 prompt 分段判 ok", read(pathlib.Path(root, frid, "grok.quotes")), "0\tok\n")
        # 从子目录发起 --full:分段名是仓库根相对路径,与模型报的 file 一致
        X = [f"sub_value_{i:02d} = compute_sub({i})" for i in range(1, 9)]
        repo.joinpath("sub").mkdir(); repo.joinpath("sub", "x.py").write_text("\n".join(X) + "\n"); git("-C", str(repo), "add", "sub/x.py")
        set_payload(qfinding("sub/x.py", 4, X[3]))
        srid = qreview(repo / "sub", "--full", "--paths", "x.py")
        expect("--full 从子目录发起:分段名 sub/x.py、quote 判 ok",
               ("\n===== sub/x.py =====\n" in read(pathlib.Path(root, srid, "prompt.md")), read(pathlib.Path(root, srid, "grok.quotes"))),
               (True, "0\tok\n"))
        # --full 只取已跟踪文件:被忽略的生成文件与未跟踪文件不进 prompt
        repo.joinpath("sub", "gen").mkdir(); repo.joinpath("sub", "gen", "big.txt").write_text("ignored_generated_marker\n")
        repo.joinpath("sub", ".gitignore").write_text("gen/\n"); repo.joinpath("sub", "new.py").write_text("untracked_file_marker\n")
        fp = read(pathlib.Path(root, qreview(repo, "--full", "--paths", "sub"), "prompt.md"))
        expect("--full 只取已跟踪文件:含 sub/x.py,不含被忽略与未跟踪文件",
               ("\n===== sub/x.py =====\n" in fp, "ignored_generated_marker" in fp, "untracked_file_marker" in fp), (True, False, False))

        # report:写明 M 个模型里 N 个返回,未返回的列出状态
        rd = pathlib.Path(root, "rep3"); rd.mkdir()
        rd.joinpath("run.meta").write_text("runid=rep3\nmode=review\nmodels=codex,grok,agy\ntag=review:worktree:brief\n")
        for m, st in (("codex", "DONE"), ("grok", "DONE"), ("agy", "FAIL:1")):
            rd.joinpath(f"{m}.status").write_text(st + "\n")
            if st == "DONE": rd.joinpath(f"{m}.out").write_text("verdict: approve\n")
        out = mmrun(root, "report", "rep3").stdout
        expect("report:参与者行与未返回模型", ("| Returned | 2 of 3 models |" in out, "\n- agy:FAIL:1\n" in out), (True, True))

        # report 分组:同 file + 都有 line 且 |Δline|≤5 + 同 issue_identity 才并成一组
        def gf(file, line, iid, sev="major", claim="c"):
            return {"severity": sev, "file": file, "line": line, "quote": "q", "claim": claim, "failure_scenario": "f",
                    "basis": "traced", "suggestion": None, "issue_identity": iid}
        def group_report(rid, outs):
            rd = pathlib.Path(root, rid); rd.mkdir()
            rd.joinpath("run.meta").write_text(f"runid={rid}\nmode=review\nmodels=codex,grok,agy\ntag=review:worktree:brief\n")
            for m in ("codex", "grok", "agy"):
                rd.joinpath(f"{m}.status").write_text("DONE\n"); rd.joinpath(f"{m}.out").write_text("verdict: request_changes\n")
                if m in outs:
                    o = json.loads(review("s")); o["findings"] = outs[m]
                    rd.joinpath(f"{m}.json").write_text(json.dumps(o, ensure_ascii=False))
            return mmrun(root, "report", rid)
        L = "missing-lock-on-write"
        r = group_report("grp", {"codex": [gf("a.py", 10, L, "minor", "CX-CLAIM"), gf("a.py", None, L)],
                                 "grok": [gf("a.py", 13, L, "major", "GK-CLAIM"), gf("a.py", 11, "stale-cache-read")],
                                 "agy": [gf("a.py", 30, L)]})
        expect("report 分组:一组 codex+grok,最高 severity、第一个模型的 claim",
               (r.stderr, "\n## Reported by several models (groups: 1)\n" in r.stdout, f"\n- [codex+grok] **a.py:10** — {L} · major · CX-CLAIM\n" in r.stdout,
                r.stdout.count("\n- [")), ("", True, True, 1))
        expect("report 分组:该节在表头之后、各模型原文之前",
               r.stdout.find("| Returned |") < r.stdout.find("## Reported by several models") < r.stdout.find("\n## codex"), True)
        r = group_report("grp-none", {"codex": [gf("a.py", 10, L)], "grok": [gf("b.py", 10, L)]})
        expect("report 分组:无重合写 无、缺 .json 的模型不报错", (r.stderr, "\n## Reported by several models: none\n" in r.stdout), ("", True))
        expect("report 不带 -o:退出 0", r.returncode, 0)
        make_run(root, "rep-start", "free text\n", schema=None)
        r = mmrun(root, "report", "rep-start")
        expect("report 非审查 run:没有 多家都报 一节", (r.returncode, "Reported by several models" in r.stdout), (0, False))

        # clean:默认只列出,--force 才删;覆盖旧 run(含 worktree)、孤儿 worktree、孤儿 codex 配置,跳过 RUNNING
        chome = pathlib.Path(tmp, "clean-home"); croot = chome / "mmruns"; croot.mkdir(parents=True)
        chome.joinpath(".codex").mkdir()
        repo = pathlib.Path(tmp, "cl", "repo"); git("init", "-q", str(repo))
        repo.joinpath("a.txt").write_text("a\n"); git("-C", str(repo), "add", "a.txt"); git("-C", str(repo), "commit", "-qm", "init")
        mmwt = pathlib.Path(tmp, "cl", ".mm-wt")
        old_rid, live_rid, dead_rid = "20000101-000000-0001", "20000101-000000-0002", "20990101-000000-dead"
        wts = {r_: mmwt / f"repo-{r_}" for r_ in (old_rid, live_rid, dead_rid)}
        for w in wts.values(): git("-C", str(repo), "worktree", "add", "--quiet", "--detach", str(w))
        ten_days = time.time() - 10 * 86400
        for r_, st in ((old_rid, "DONE"), (live_rid, "RUNNING")):
            rd = croot / r_; rd.mkdir()
            rd.joinpath("run.meta").write_text(f"runid={r_}\nmode=run\nmodels=grok\nworkdir={repo}\nwt={wts[r_]}\n")
            rd.joinpath("grok.status").write_text(st + "\n")
            os.utime(rd, (ten_days, ten_days))
        cfg = chome / ".codex" / "mmwt-20990101-000000-beef.config.toml"; cfg.write_text("x\n")
        # 续做链:父 run 已过期、子 run 是新的,共用一个 worktree → 整条链都保留
        chain_par, chain_child = "20000101-000000-0003", "20000101-000000-0004"
        chain_wt = mmwt / f"repo-{chain_par}"; git("-C", str(repo), "worktree", "add", "--quiet", "--detach", str(chain_wt))
        for r_, par in ((chain_par, ""), (chain_child, chain_par)):
            rd = croot / r_; rd.mkdir()
            rd.joinpath("run.meta").write_text(f"runid={r_}\nmode=run\nmodels=grok\nworkdir={repo}\nwt={chain_wt}\nparent={par}\n")
            rd.joinpath("grok.status").write_text("DONE\n")
        os.utime(croot / chain_par, (ten_days, ten_days))
        cenv = dict(os.environ, HOME=str(chome), MMRUN_HOME=str(croot), MMRUN_D=str(PLUGIN / "mmrun.d"))
        def present():
            return ((croot / old_rid).exists(), wts[old_rid].exists(), wts[dead_rid].exists(), cfg.exists(),
                    (croot / live_rid).exists(), wts[live_rid].exists())
        r = subprocess.run([str(MMRUN), "clean", "7"], capture_output=True, text=True, env=cenv, timeout=60)
        expect("clean 默认:全都还在", present(), (True,) * 6)
        expect("clean 默认:输出列出各项并提示 --force",
               (old_rid in r.stdout, dead_rid in r.stdout, "beef" in r.stdout, live_rid in r.stdout, "--force" in r.stdout),
               (True,) * 5)
        r = subprocess.run([str(MMRUN), "clean", "7", "--force"], capture_output=True, text=True, env=cenv, timeout=60)
        expect("clean --force:旧 run/孤儿已删,RUNNING 的保留", present(), (False, False, False, False, True, True))
        expect("clean --force:续做链有未过期的 run,父 run 与 worktree 都保留",
               ((croot / chain_par).exists(), chain_wt.exists()), (True, True))
        expect("clean --force:git 不再登记已删 worktree",
               (old_rid in git("-C", str(repo), "worktree", "list"), dead_rid in git("-C", str(repo), "worktree", "list")),
               (False, False))

# ---------- room:mmroom 协议、room 目录、按参与者的沙箱规则、mmrun room 汇总 ----------
MMROOM = PLUGIN / "mmrun.d/mmroom"
def room_env(room, me=None):
    e = {k: v for k, v in os.environ.items() if k != "MMROOM_SELF"}
    e.update(MMROOM_DIR=str(room), MMROOM_POLL="0.1")
    if me: e["MMROOM_SELF"] = str(pathlib.Path(room, me + ".jsonl"))
    return e
def mmroom(room, me, *args):
    return subprocess.run([str(MMROOM), *args], capture_output=True, text=True, env=room_env(room, me), timeout=30)
def claim(cid, **kw):
    return dict({"type": "claim", "claim_id": cid, "stance": "new", "claim": f"C-{cid}", "evidence": "a.py:3", "basis": "traced"}, **kw)
def post(room, me, rnd, entry):
    return mmroom(room, me, "post", "--round", str(rnd), "--json", json.dumps(entry, ensure_ascii=False))
def jlines(s):
    return [json.loads(l) for l in s.splitlines() if l.strip()]
def jline(e, rnd=1):
    return json.dumps(dict(e, round=rnd), ensure_ascii=False) + "\n"
def mkroom(base, *names):
    room = pathlib.Path(base, "room"); room.mkdir(parents=True)
    for n in (*names, "host", "control"): room.joinpath(n + ".jsonl").write_text("")
    return room

with tempfile.TemporaryDirectory() as tmp:
    room = mkroom(pathlib.Path(tmp, "u"), "P1", "P2", "P3")
    r = post(room, "P1", 1, claim("c1"))
    expect("mmroom post 合格论点:退出 0", (r.returncode, r.stderr), (0, ""))
    got = jlines(mmroom(room, "P2", "read").stdout)
    expect("mmroom read:看到 P1 的论点,带 from 与 round", [(e["from"], e["claim_id"], e["round"]) for e in got], [("P1", "c1", 1)])
    expect("mmroom read:不打印自己的", mmroom(room, "P1", "read").stdout, "")
    nobasis = claim("c2"); del nobasis["basis"]
    r1 = post(room, "P1", 1, nobasis); r2 = post(room, "P1", 1, claim("c3", stance="agree"))
    expect("mmroom post 不合格(缺字段、stance 非法):非零并说明原因",
           (r1.returncode != 0, "format" in r1.stderr, r2.returncode != 0, "format" in r2.stderr), (True,) * 4)
    expect("mmroom post 不合格:未写入", len(room.joinpath("P1.jsonl").read_text().splitlines()), 1)
    with open(room / "P2.jsonl", "a") as f:  # 绕过 post 直接写:读取侧照样丢弃
        f.write(jline(claim("r-noev", stance="revise", evidence="想了想还是不对")))
        f.write(jline(claim("r-cmd", stance="revise", evidence="$ grep -n x a.py\n3:x")))
        f.write(jline(claim("big", claim="x" * 2100)))
        for i in range(1, 5): f.write(jline(claim(f"k{i}")))
        f.write("not json\n")
    got = jlines(mmroom(room, "P3", "read", "--round", "1").stdout)
    expect("mmroom read 校验:丢弃 revise 无证据、超 2KB、同轮第 4 条起",
           [(e["from"], e["claim_id"]) for e in got], [("P1", "c1"), ("P2", "r-cmd"), ("P2", "k1"), ("P2", "k2")])
    for n in ("k5", "k6"): room.joinpath("P1.jsonl").open("a").write(jline(claim(n)))
    expect("mmroom post:同轮第 4 条非零", "more than 3 claims" in post(room, "P1", 1, claim("k7")).stderr, True)
    expect("mmroom read --round 2:没有第 1 轮的条目", mmroom(room, "P3", "read", "--round", "2").stdout, "")

    room = mkroom(pathlib.Path(tmp, "w"), "P1", "P2")
    post(room, "P1", 1, claim("a"))
    r = mmroom(room, "P1", "wait", "--round", "1", "--timeout", "1")
    expect("mmroom wait:P2 未发时超时退出 2", r.returncode, 2)
    post(room, "P2", 1, claim("b")); post(room, "P2", 1, {"type": "ask_host", "text": "Q?"})
    room.joinpath("host.jsonl").write_text(jline({"type": "reply", "text": "H-1"}))
    r = mmroom(room, "P1", "wait", "--round", "1", "--timeout", "5")
    expect("mmroom wait:P2 发后返回 0,打印 P2 的论点、提问与 host 回复",
           (r.returncode, [(e["from"], e.get("claim_id") or e.get("text")) for e in jlines(r.stdout)]),
           (0, [("P2", "b"), ("P2", "Q?"), ("host", "H-1")]))
    room = mkroom(pathlib.Path(tmp, "l"), "P1", "P2", "P3")
    post(room, "P3", 1, claim("c"))
    expect("mmroom wait:P2 未发、未离场时超时", mmroom(room, "P1", "wait", "--round", "1", "--timeout", "1").returncode, 2)
    room.joinpath("control.jsonl").write_text('{"type":"leave","who":"P2"}\n')
    expect("mmroom wait:P2 离场后不再等它", mmroom(room, "P1", "wait", "--round", "1", "--timeout", "5").returncode, 0)
    r = mmroom(room, "P1", "wait", "--round", "3")
    expect("mmroom wait --round 3:退出 3", (r.returncode, r.stdout.strip()), (3, "round limit reached"))

    # mmrun room:两轮、一条被丢弃、一条离场、一条 ask_host
    hroot = pathlib.Path(tmp, "runs"); room = mkroom(hroot / "rr", "P1", "P2")
    room.joinpath("P1.jsonl").write_text(jline(claim("a1")) + jline(claim("a2", stance="maintain", claim="长" * 100), 2)
                                         + jline({"type": "ask_host", "text": "Q?"}))
    room.joinpath("P2.jsonl").write_text(jline(claim("b1")) + jline(claim("b2", stance="revise", evidence="无")))
    room.joinpath("control.jsonl").write_text('{"type":"leave","who":"P2"}\n')
    r = mmrun(str(hroot), "room", "rr")
    expect("mmrun room:按轮每条一行、离场单列、末尾计丢弃", (r.returncode, r.stdout.splitlines()),
           (0, ["R1 P1 new a1 C-a1", "R1 P1 ask_host Q?", "R1 P2 new b1 C-b1", "R2 P1 maintain a2 " + "长" * 80,
                "left P2", "dropped 1 (reasons: revise without evidence×1)"]))
    expect("mmrun room:没有 room 的 run 非零", mmrun(str(hroot), "room", "nope").returncode != 0, True)

# 沙箱集成:room 必须在 HOME=TEST_HOME 的 mmruns 下 —— 系统临时目录 /private/var/folders 的写被
# fence.sb 与 codex profile 放开,"写别人的文件被拒"在那里不成立;mm profile 按 TEST_HOME 生成,才会 deny 这里
import shlex
test_runs = TEST_HOME / ".claude/mmruns"
zz = pathlib.Path(os.path.realpath(tempfile.mkdtemp(prefix="zz-test-", dir=test_runs)))
rid = "20991231-000000-r00m"
rd = zz / rid; room = rd / "room"
rbin = pathlib.Path(os.path.realpath(tempfile.mkdtemp(prefix="mmroom-bin-")))  # 假 CLI 与记录:不能放在 mmruns 下(围栏禁读)
try:
    renv = dict(os.environ, HOME=str(TEST_HOME), MMRUN_HOME=str(zz), MMRUN_D=str(PLUGIN / "mmrun.d"))
    def mmz(*a, e=renv):
        return subprocess.run([str(MMRUN), *a], capture_output=True, text=True, env=e, timeout=60)
    rd.mkdir(); sib = zz / "20991231-000000-s1b"; sib.mkdir(); sib.joinpath("secret.txt").write_text("S\n")
    r = mmz("__room_init", str(rd), "codex,grok,agy")
    expect("room_init:文件、映射、目录 555",
           (r.returncode, sorted(os.listdir(room)) if room.exists() else None, rd.joinpath("room.map").read_text() if rd.joinpath("room.map").exists() else "",
            oct(room.stat().st_mode & 0o777) if room.exists() else None),
           (0, ["P1.jsonl", "P2.jsonl", "P3.jsonl", "control.jsonl", "host.jsonl"], "P1=codex\nP2=grok\nP3=agy\n", "0o555"))
    ROOM_POST = (f"MMROOM_DIR={shlex.quote(str(room))} MMROOM_SELF={shlex.quote(str(room / 'P1.jsonl'))} "
                 f"{shlex.quote(str(MMROOM))} post --round 1 --json " + shlex.quote(json.dumps(claim("in-box"))))
    CHECKS = [  # (名, 脚本, 应成功)
        ("读 P2.jsonl", f"cat {room}/P2.jsonl", True),
        ("追加 P1.jsonl", f"echo x >> {room}/P1.jsonl", True),
        ("追加 P2.jsonl", f"echo x >> {room}/P2.jsonl", False),
        ("追加 host.jsonl", f"echo x >> {room}/host.jsonl", False),
        ("追加 control.jsonl", f"echo x >> {room}/control.jsonl", False),
        ("删 P1.jsonl", f"rm -f {room}/P1.jsonl && test ! -e {room}/P1.jsonl", False),
        ("在 room 新建文件", f"echo x > {room}/new.jsonl", False),
        ("读兄弟 run", f"cat {sib}/secret.txt", False),
        ("列 run 根目录", f"ls {zz}", False),
        ("沙箱内 mmroom post", ROOM_POST, True),
    ]
    def run_checks(label, runner):
        for name, script, want in CHECKS:
            expect(f"{label}:{name}{'成功' if want else '被拒'}", runner(script).returncode == 0, want)
        expect(f"{label}:mmroom post 写进了 P1", "in-box" in room.joinpath("P1.jsonl").read_text(), True)
        expect(f"{label}:P2/host/control 未被改", [room.joinpath(f"{n}.jsonl").read_text() for n in ("P2", "host", "control")], ["", "", ""])
        expect(f"{label}:room 里没有多出文件", sorted(os.listdir(room)), ["P1.jsonl", "P2.jsonl", "P3.jsonl", "control.jsonl", "host.jsonl"])
        room.joinpath("P1.jsonl").write_text("")

    def fenced(script, with_room=True):
        e = dict(renv, FENCE_ROOM_RUN=str(rd), FENCE_ROOM_AS="P1") if with_room else renv
        return subprocess.run([str(MMRUN), "__fence", "/nonexistent", "/nonexistent", "/nonexistent", "/nonexistent",
                               "/bin/sh", "-c", script], capture_output=True, text=True, env=e, timeout=60)
    expect("fence 不带 room:读不到 room", fenced(f"cat {room}/P2.jsonl", with_room=False).returncode != 0, True)
    run_checks("fence+room", fenced)

    if shutil.which("codex"):
        prof = TEST_HOME / ".codex" / f"mmroom-{rid}-P1.config.toml"
        try:
            r = mmz("__room_profile", rid, str(rd), "P1")
            ptext = prof.read_text() if prof.exists() else ""
            mm_ro = [l for l in (TEST_HOME / ".codex/mm.config.toml").read_text().splitlines() if l.endswith('= "deny"')]
            expect("write_room_profile:打印 profile 名、含 mm_ro 全部 deny、room 读、P1 写",
                   (r.stdout.strip(), bool(mm_ro) and all(l in ptext.splitlines() for l in mm_ro),
                    f'"{room}" = "read"' in ptext, f'"{room}/P1.jsonl" = "write"' in ptext),
                   (f"mmroom-{rid}-P1", True, True, True))
            # Same config resolution as `codex exec -p`: no -P; codex sandbox's -C requires -P, so use the process cwd.
            with tempfile.TemporaryDirectory() as cwd:
                run_checks("codex sandbox", lambda script: subprocess.run(
                    ["codex", "sandbox", "-p", f"mmroom-{rid}-P1", "--", "/bin/sh", "-c", script],
                    cwd=cwd, capture_output=True, text=True, env=renv, timeout=60))
        finally:
            prof.unlink(missing_ok=True)
    else:
        print("SKIP codex 集成:找不到 codex")

    r = mmz("__room_leave", str(rd), "P2")
    expect("room_leave:control 追加离场、目录仍 555",
           (r.returncode, room.joinpath("control.jsonl").read_text(), oct(room.stat().st_mode & 0o777)),
           (0, '{"type":"leave","who":"P2"}\n', "0o555"))
    room.chmod(0o755); room.joinpath("control.jsonl").unlink(); room.chmod(0o555)
    r = mmz("__room_leave", str(rd), "P3")
    expect("room_leave:control 不在时建好再追加、目录改回 555",
           (r.returncode, room.joinpath("control.jsonl").read_text() if room.joinpath("control.jsonl").exists() else "",
            oct(room.stat().st_mode & 0o777)), (0, '{"type":"leave","who":"P3"}\n', "0o555"))

    # ---------- ask --room:三方在各自沙箱里经 mmroom 交流两轮 ----------
    def txt(p):
        return p.read_text() if p.exists() else ""
    MS = ("codex", "grok", "agy")
    work = rbin / "work"; work.mkdir()
    ans_schema = rbin / "ans.schema.json"
    ans_schema.write_text(json.dumps({"type": "object", "required": ["answer"], "properties": {"answer": {"type": "string"}}}))
    FAKE = r'''#!/bin/sh
case " $* " in *" mcp list "*) echo "[]"; exit 0;; esac
R=@R@; M=@M@; ME=@ME@
for a in "$@"; do printf '%s\n' "$a" >> "$R.argv"; done
echo --- >> "$R.argv"
echo "self=$MMROOM_SELF dir=$MMROOM_DIR" >> "$R.log"
out=""; prev=""
for a in "$@"; do [ "$prev" = -o ] && out="$a"; [ "$prev" = -p ] && p="$a"; prev="$a"; done
if [ "$ME" = codex ]; then cat > /dev/null; test -f "$HOME/.codex/$p.config.toml" && echo "profile-present:$p" >> "$R.log"; fi
[ "$ROOMTEST" = silent ] && [ "$ME" = agy ] && exit 0
forge=-
if [ "$ME" = grok ]; then if echo x 2>/dev/null >> "$MMROOM_DIR/P1.jsonl"; then forge=ok; else forge=denied; fi; fi
claim() { printf '{"type":"claim","claim_id":"%s1","stance":"%s","claim":"%s-r%s","evidence":"a.py:1","basis":"traced"}' "$ME" "$2" "$ME" "$1"; }
"$M" post --round 1 --json "$(claim 1 new)"; p1=$?
if [ "$ROOMTEST" = host ] && [ "$ME" = grok ]; then
  "$M" post --round 1 --json '{"type":"ask_host","text":"Q-from-grok"}'
  i=0; while [ $i -lt 100 ] && ! "$M" read | grep -q '答复'; do sleep 0.1; i=$((i+1)); done
fi
"$M" wait --round 1 --timeout 5 > "$R.w1"; w1=$?
"$M" post --round 2 --json "$(claim 2 maintain)"; p2=$?
"$M" wait --round 2 --timeout 5 > "$R.w2"; w2=$?
ans="p1=$p1 w1=$w1 p2=$p2 w2=$w2 forge=$forge"
case "$ME" in
  codex) printf '{"answer":"%s"}' "$ans" > "$out"; echo '{"type":"thread.started","thread_id":"t-room"}';;
  grok)  printf '{"structuredOutput":{"answer":"%s"}}' "$ans";;
  agy)   printf '{"structured_output":{"answer":"%s"},"conversation_id":"c-room"}' "$ans";;
esac
'''
    aenv = dict(renv, MMROOM_POLL="0.1")
    for m in MS:
        f = rbin / f"fake-{m}"
        f.write_text(FAKE.replace("@R@", shlex.quote(str(rbin / m))).replace("@M@", shlex.quote(str(MMROOM))).replace("@ME@", m))
        f.chmod(0o755); aenv[f"{m.upper()}_BIN"] = str(f)
    def mkpar(name, mode="start", statuses=("DONE",) * 3):
        d = zz / name; d.mkdir()
        d.joinpath("run.meta").write_text(f"runid={name}\nmode={mode}\nmodels=codex,grok,agy\nworkdir={work}\nschema={ans_schema}\nparent=\nroot=\n")
        for m, s in zip(MS, statuses):
            d.joinpath(f"{m}.sid").write_text(f"sid-{m}\n"); d.joinpath(f"{m}.status").write_text(s + "\n")
        return name
    par = mkpar("20991231-000001-pa01")
    def room_ask(*extra, frm=par, scen="", wait=True, **env):
        r = subprocess.run([str(MMRUN), "ask", "--from", frm, *extra], input="Discuss.\n", capture_output=True, text=True,
                           env=dict(aenv, ROOMTEST=scen, **env), timeout=60)
        crid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        if wait and crid != "missing": mmz("wait", crid, "--timeout", "50")
        return r, crid
    def last_argv(m):
        return ([b.splitlines() for b in txt(rbin / f"{m}.argv").split("---\n") if b.strip()] or [[]])[-1]
    def after(argv, flag):
        return argv[argv.index(flag) + 1] if flag in argv[:-1] else None
    def answer(crid, m):
        try: return json.loads(txt(zz / crid / f"{m}.json")).get("answer")
        except ValueError: return None

    r, _ = room_ask("--room", frm=mkpar("20991231-000002-rv01", mode="review"))
    expect("ask --room 拒绝:父 run 不是 start", (r.returncode != 0, "start" in r.stderr), (True, True))
    r, _ = room_ask("--room", frm=mkpar("20991231-000003-nd01", statuses=("DONE", "FAIL:1", "DONE")))
    expect("ask --room 拒绝:父 run 有模型不是 DONE", (r.returncode != 0, "DONE" in r.stderr), (True, True))
    r, _ = room_ask("--room", "--cross")
    expect("ask --room 拒绝:与 --cross 同用", (r.returncode != 0, "mutually exclusive" in r.stderr), (True, True))
    r = mmz("room", "wait", par, "--as", "P1", "--timeout", "1")
    expect("room wait --as P1:非零", (r.returncode != 0, "host" in r.stderr), (True, True))

    r, c3 = room_ask("--room")
    cd = zz / c3
    expect("ask --room:退出 0、子 run 三家 DONE", (r.returncode, r.stderr, [txt(cd / f"{m}.status").strip() for m in MS]),
           (0, "", ["DONE"] * 3))
    expect("ask --room:各自 wait/post 都成功、grok 改不了 P1.jsonl", [answer(c3, m) for m in MS],
           ["p1=0 w1=0 p2=0 w2=0 forge=-", "p1=0 w1=0 p2=0 w2=0 forge=denied", "p1=0 w1=0 p2=0 w2=0 forge=-"])
    expect("ask --room:MMROOM_SELF/MMROOM_DIR 按化名",
           [txt(rbin / f"{m}.log").splitlines()[-1:] for m in ("grok", "agy")],
           [[f"self={cd}/room/P2.jsonl dir={cd}/room"], [f"self={cd}/room/P3.jsonl dir={cd}/room"]])
    summ = mmz("room", c3).stdout.splitlines()
    expect("ask --room:mmrun room 汇总里三人两轮都在",
           sorted(" ".join(l.split()[:2]) for l in summ if l.startswith("R")), sorted(f"R{n} P{i}" for n in (1, 2) for i in (1, 2, 3)))
    expect("ask --room:control.jsonl 三条离场",
           sorted(json.loads(l).get("who") for l in txt(cd / "room/control.jsonl").splitlines() if l.strip()), ["P1", "P2", "P3"])
    cx, gx, ax = (last_argv(m) for m in MS)
    expect("ask --room codex:-p mmroom-<子rid>-P1、resume、运行中 profile 存在、结束后删除",
           (after(cx, "-p"), "resume" in cx, f"profile-present:mmroom-{c3}-P1" in txt(rbin / "codex.log"),
            (TEST_HOME / ".codex" / f"mmroom-{c3}-P1.config.toml").exists()),
           (f"mmroom-{c3}-P1", True, True, False))
    expect("ask --room grok:dontAsk、--allow mmroom 绝对路径、带 run_terminal_command",
           (after(gx, "--permission-mode"), after(gx, "--allow"), after(gx, "--tools")),
           ("dontAsk", f"Bash({MMROOM} *)", "read_file,grep,list_dir,run_terminal_command"))
    expect("ask --room agy:--dangerously-skip-permissions", "--dangerously-skip-permissions" in ax, True)
    cmeta = txt(cd / "run.meta")
    expect("ask --room:子 run meta room=1 host=0", ("\nroom=1\n" in cmeta, "\nhost=0\n" in cmeta), (True, True))
    gp = txt(cd / "prompt.grok.md")
    expect("ask --room:grok 的提示词含化名 P2、其他人 P1/P3、mmroom 绝对路径,不带 --host 时没有 ask_host",
           (gp.startswith("Discuss.\n"), "P2" in gp, "P1, P3" in gp, f"{MMROOM} wait --round 1" in gp, "ask_host" in gp),
           (True, True, True, True, False))

    r, cs = room_ask("--room", scen="silent")
    expect("离场:agy 不发言退出,其余两人第 1 轮 wait 返回 0", [(answer(cs, m) or "")[:9] for m in ("codex", "grok")],
           ["p1=0 w1=0"] * 2)
    expect("离场:agy 失败、control 记了 P3 离场",
           (txt(zz / cs / "agy.status").startswith("FAIL"), '"who":"P3"' in txt(zz / cs / "room/control.jsonl")), (True, True))

    r, ch = room_ask("--room", "--host", scen="host", wait=False, CLAUDECODE="1")
    expect("CLAUDECODE=1 ask --room --host:NEXT 教 room wait/post,结果由插件送达",
           [l for l in r.stdout.splitlines() if l.startswith(("NEXT ", "THEN "))],
           [f'NEXT  run in the background: mmrun room wait {ch} --as host --timeout 3600; answer with: mmrun room post {ch} --as host --text "…"; '
            "the mm plugin sends the final result when the run ends"])
    hw = subprocess.Popen([str(MMRUN), "room", "wait", ch, "--as", "host", "--timeout", "10"],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=renv)
    hout, _ = hw.communicate(timeout=30)
    expect("host:room wait --as host 拿到 P2 的提问", (hw.returncode, [(e.get("from"), e.get("text")) for e in jlines(hout)]),
           (0, [("P2", "Q-from-grok")]))
    r = mmz("room", "post", ch, "--as", "host", "--text", "答复")
    expect("host:room post --as host 退出 0、目录仍 555",
           (r.returncode, oct((zz / ch / "room").stat().st_mode & 0o777) if (zz / ch / "room").exists() else None), (0, "0o555"))
    if ch != "missing": mmz("wait", ch, "--timeout", "50")
    expect("host:grok 之后的 wait 输出里有答复", "答复" in txt(rbin / "grok.w1"), True)
    expect("host:子 run meta host=1、grok 提示词有 ask_host", ("\nhost=1\n" in txt(zz / ch / "run.meta"), "ask_host" in txt(zz / ch / "prompt.grok.md")),
           (True, True))
    r = mmz("room", "wait", ch, "--as", "host", "--timeout", "10")
    expect("host:全部离场后 room wait --as host 退出 3", (r.returncode, r.stdout.strip()), (3, "all left"))

    # write_room_profile 不依赖 tomllib:PATH 上的 python3 是 /usr/bin/python3(3.9)
    with tempfile.TemporaryDirectory() as fh:
        fh = pathlib.Path(fh); fh.joinpath(".codex").mkdir(); shim = fh / "shim"; shim.mkdir()
        shim.joinpath("python3").symlink_to("/usr/bin/python3")
        # A stale mm profile stops the run, so the parser input goes in through the template it is generated from
        mmd = fh / "mmrun.d"; mmd.mkdir(); cfg = mmd / "codex-mm.config.toml"
        cfg.write_text('sandbox_mode = "read-only"\n"/top" = "deny"\n[permissions.mm_ro.filesystem]\n":root" = "read"\n'
                       '"/a/runs" = "deny"\n# c\n"/a/b c" = "deny"\n"/a/p" = "deny"\n\n[permissions.other.filesystem]\n"/z" = "deny"\n')
        pe = dict(renv, HOME=str(fh), PATH=f"{shim}:{os.environ['PATH']}", MMRUN_D=str(mmd))
        r = mmz("__room_profile", "rid9", str(rd), "P1", e=pe)
        pt = txt(fh / ".codex/mmroom-rid9-P1.config.toml")
        expect("write_room_profile 用 python3.9:成功、只取 mm_ro 段的全部 deny",
               (r.returncode, r.stderr, [l for l in pt.splitlines() if l.endswith('= "deny"')]),
               (0, "", ['"/a/runs" = "deny"', '"/a/b c" = "deny"', '"/a/p" = "deny"']))
        cfg.write_text('[permissions.mm_ro.filesystem]\n":root" = "read"\n[permissions.x.filesystem]\n"/z" = "deny"\n')
        fh.joinpath(".codex/mm.config.toml").unlink()
        r = mmz("__room_profile", "rid8", str(rd), "P1", e=pe)
        expect("write_room_profile:mm_ro 无 deny 时非零、不留半成品",
               (r.returncode != 0, fh.joinpath(".codex/mmroom-rid8-P1.config.toml").exists()), (True, False))

    # 设了 CODEX_HOME:mm profile 与 room profile 都写进 $CODEX_HOME,不碰 $HOME/.codex
    with tempfile.TemporaryDirectory() as fh:
        fh = pathlib.Path(fh); chome = fh / "cxhome"; xhome = fh / "home"; xhome.mkdir()
        r = mmz("__room_profile", "rid7", str(rd), "P1", e=dict(renv, HOME=str(xhome), CODEX_HOME=str(chome)))
        expect("CODEX_HOME:write_room_profile 成功、profile 在 $CODEX_HOME、$HOME/.codex 不存在",
               (r.returncode, chome.joinpath("mm.config.toml").exists(), chome.joinpath("mmroom-rid7-P1.config.toml").exists(),
                xhome.joinpath(".codex").exists()), (0, True, True, False))

    # clean:过期的 room run(room 目录 555)整个删掉
    croot = zz / "cleanroot"; croot.mkdir(); old = croot / "20990101-000000-c1ea"; old.mkdir()
    old.joinpath("run.meta").write_text(f"runid={old.name}\nmode=start\nmodels=grok,agy\n")
    old.joinpath("grok.status").write_text("DONE\n")
    mmz("__room_init", str(old), "grok,agy")
    t = time.time() - 3 * 86400; os.utime(old, (t, t))
    with tempfile.TemporaryDirectory() as fh:
        r = mmz("clean", "0", "--force", e=dict(renv, MMRUN_HOME=str(croot), HOME=fh))
    expect("clean --force:过期 room run 整个删除", (r.returncode, old.exists()), (0, False))
finally:
    for p in zz.rglob("room"): p.chmod(0o755)
    shutil.rmtree(zz, ignore_errors=True); shutil.rmtree(rbin, ignore_errors=True)

# ---------- 外部模型读写不到 Claude 临时目录(scratchpad、任务输出) ----------
claude_tmp = pathlib.Path(f"/private/tmp/claude-{os.getuid()}"); claude_tmp.mkdir(exist_ok=True)
ctp = pathlib.Path(tempfile.mkdtemp(prefix="mmrun-probe-", dir=claude_tmp)); ctp.joinpath("x").write_text("p\n")
ctd = pathlib.Path(os.path.realpath(tempfile.mkdtemp(prefix="mmrun-ct-")))
try:
    ctd.joinpath("ctl").write_text("c\n")
    cenv = dict(os.environ, HOME=str(TEST_HOME), MMRUN_D=str(PLUGIN / "mmrun.d"))
    def ct_fence(wt, ro, script):
        return subprocess.run([str(MMRUN), "__fence", wt, "/nonexistent", "/nonexistent", ro, "/bin/sh", "-c", script],
                              capture_output=True, text=True, env=cenv, cwd=ctd, timeout=60)
    for label, wt, ro in (("委派", str(ctd), "/nonexistent"), ("审查", "/nonexistent", str(ctd))):
        expect(f"fence {label}模式:读 Claude 临时目录被拒", ct_fence(wt, ro, f"cat {ctp}/x").returncode != 0, True)
        expect(f"fence {label}模式:写 Claude 临时目录被拒", ct_fence(wt, ro, f"echo w >> {ctp}/x").returncode != 0, True)
        expect(f"fence {label}模式:读工作目录成功(对照)", ct_fence(wt, ro, "cat ./ctl").returncode, 0)
    expect("fence:Claude 临时目录探针未被改", ctp.joinpath("x").read_text(), "p\n")

    # 每个模型读不到其他模型的状态目录,自己的照常读写
    sdirs = {n: TEST_HOME / n for n in (".grok", ".gemini")}
    csess = TEST_HOME / ".codex/sessions"
    for d in (*sdirs.values(), csess): d.mkdir(exist_ok=True); d.joinpath("x").write_text("s\n")
    senv = dict(cenv, CODEX_HOME=str(TEST_HOME / ".codex"))
    def st_fence(state, script):
        return subprocess.run([str(MMRUN), "__fence", "/nonexistent", str(state), "/nonexistent", "/nonexistent", "/bin/sh", "-c", script],
                              capture_output=True, text=True, env=senv, cwd=ctd, timeout=60)
    for own, other in ((".grok", ".gemini"), (".gemini", ".grok")):
        expect(f"fence STATE=~/{own}:读 ~/{other} 被拒", st_fence(sdirs[own], f"cat {sdirs[other]}/x").returncode != 0, True)
        expect(f"fence STATE=~/{own}:读 ~/.codex/sessions 被拒", st_fence(sdirs[own], f"cat {csess}/x").returncode != 0, True)
        expect(f"fence STATE=~/{own}:读写自己的状态目录成功",
               st_fence(sdirs[own], f"cat {sdirs[own]}/x && echo w >> {sdirs[own]}/x").returncode, 0)

    # 写边界:只有 WT、STATE、临时目录与 /dev 可写;HOME 之外的用户可写目录同样被拒
    fwt = TEST_HOME / "fence-wt"; fwt.mkdir()
    def wr_fence(script):
        return subprocess.run([str(MMRUN), "__fence", str(fwt), str(sdirs[".grok"]), "/nonexistent", "/nonexistent", "/bin/sh", "-c", script],
                              capture_output=True, text=True, env=senv, cwd=ctd, timeout=60)
    for name, script in (("/dev/null", "echo w > /dev/null"), ("WT", f"echo w > {fwt}/x"), ("STATE", f"echo w > {sdirs['.grok']}/w")):
        expect(f"fence 写边界:写 {name} 成功", wr_fence(script).returncode, 0)
    expect("fence 写边界:写 HOME 下 WT/STATE 之外被拒", wr_fence(f"echo w > {TEST_HOME}/outside").returncode != 0, True)
    shared = pathlib.Path("/Users/Shared")
    if shared.is_dir() and os.access(shared, os.W_OK):
        sprobe = pathlib.Path(tempfile.mkdtemp(prefix="mmrun-fence-", dir=shared))
        try:
            expect("fence 写边界:写 HOME 与临时目录之外的用户可写目录被拒",
                   (wr_fence(f"echo w > {sprobe}/x").returncode != 0, sprobe.joinpath("x").exists()), (True, False))
        finally:
            shutil.rmtree(sprobe, ignore_errors=True)
    else:
        print("SKIP fence 写边界:/Users/Shared 不存在或不可写,找不到 HOME 与临时目录之外的用户可写目录")

    # 从 Claude 的 Bash 沙箱里调起时 TMPDIR 在 Claude 临时目录下:外部模型改用用户临时目录
    trd = make_run(str(ctd / "runs"), "tmpdir", None, schema=None)
    trd.joinpath("prompt.md").write_text("p\n"); trd.joinpath("grok.session").write_text("sid\n")
    tfake = ctd / "grok"; tfake.write_text("#!/bin/sh\nprintf '{\"text\":\"%s\"}' \"$TMPDIR\"\n"); tfake.chmod(0o755)
    subprocess.run([str(MMRUN), "__run", "grok", str(trd), str(ctd)], capture_output=True, timeout=60,
                   env=dict(cenv, MMRUN_HOME=str(ctd / "runs"), GROK_BIN=str(tfake), TMPDIR=str(ctp)))
    utmp = subprocess.run(["getconf", "DARWIN_USER_TEMP_DIR"], capture_output=True, text=True).stdout.strip()
    tout = trd / "grok.out"
    expect("TMPDIR 在 Claude 临时目录下:外部模型拿到 DARWIN_USER_TEMP_DIR",
           tout.read_text().strip() if tout.exists() else None, utmp)

    # mm 模板生成的 profile 与从它复制 deny 的 room 层都带上 Claude 临时目录;临时 CODEX_HOME,不碰本机 profile
    chome = ctd / "codex-home"
    ctxt = lambda p: p.read_text() if p.exists() else ""
    r = subprocess.run([str(MMRUN), "__room_profile", "ctprobe", str(ctd), "P1"], capture_output=True, text=True,
                       env=dict(cenv, CODEX_HOME=str(chome)), timeout=60)
    cdeny = f'"{claude_tmp}" = "deny"'
    expect("mm 模板与 room 层都 deny Claude 临时目录",
           (r.returncode, cdeny in ctxt(chome / "mm.config.toml").splitlines(),
            cdeny in ctxt(chome / "mmroom-ctprobe-P1.config.toml").splitlines()), (0, True, True))
    # 权限层只用 default_permissions:同时出现 sandbox_mode 时 codex 文档说改用旧沙箱
    subprocess.run([str(MMRUN), "__mmwt_profile", "ctprobe", str(ctd)], capture_output=True, env=dict(cenv, CODEX_HOME=str(chome)), timeout=60)
    layers = ("mm.config.toml", "mmwt-ctprobe.config.toml", "mmroom-ctprobe-P1.config.toml")
    expect("mm 模板、mmwt 层、room 层:都生成了,且没有 sandbox_mode 行",
           [(chome / n).exists() and not any(l.startswith("sandbox_mode") for l in ctxt(chome / n).splitlines()) for n in layers],
           [True, True, True])
    sdeny = [f'"{TEST_HOME}/{n}" = "deny"' for n in (".grok", ".gemini")]
    expect("mm 模板、mmwt 层、room 层:都 deny ~/.grok 与 ~/.gemini",
           [all(l in ctxt(chome / n).splitlines() for l in sdeny) for n in layers], [True, True, True])
    if shutil.which("codex"):
        def codex_sh(profile, cwd, script, e=None):
            # Same config resolution as `codex exec -p <profile>`: no -P, no -s; the process cwd instead of -C.
            return subprocess.run(["codex", "sandbox", "-p", profile, "--", "/bin/sh", "-c", script], cwd=cwd,
                                  capture_output=True, text=True, env=e, timeout=60)
        cxe = dict(os.environ, CODEX_HOME=str(chome))
        expect("codex mm 层:读 Claude 临时目录被拒", codex_sh("mm", ctd, f"cat {ctp}/x", cxe).returncode != 0, True)
        expect("codex mm 层:读工作目录成功(对照)", codex_sh("mm", ctd, "cat ./ctl", cxe).returncode, 0)
        for n, d in sdirs.items():
            expect(f"codex mm 层:读 ~/{n} 被拒", codex_sh("mm", ctd, f"cat {d}/x", cxe).returncode != 0, True)
        # mm 与 mm_wt 层走生产路径(不带 -P);mm_wt 层生成在 TEST_HOME/.codex,基础配置是本机 config.toml 的副本
        mprobe = pathlib.Path(tempfile.mkdtemp(prefix=".probe-", dir=test_runs)); mprobe.joinpath("x").write_text("p\n")
        wtp = f"probe{os.getpid()}"; wtprof = TEST_HOME / ".codex" / f"mmwt-{wtp}.config.toml"
        outside = TEST_HOME / ".codex" / f"mmwt-{wtp}-outside"
        try:
            expect("codex mm 层:读不到 mmruns 探针", codex_sh("mm", ctd, f"cat {mprobe}/x", cxe).returncode != 0, True)
            expect("codex mm 层:不能写工作目录", codex_sh("mm", ctd, "touch ./w", cxe).returncode != 0, True)
            wt = ctd / "wt"; wt.mkdir(); wt.joinpath(".git").write_text("gitdir: /nonexistent\n")
            r = subprocess.run([str(MMRUN), "__mmwt_profile", wtp, str(wt)], capture_output=True, env=cenv, timeout=60)
            expect("__mmwt_profile:生成 mmwt 层", (r.returncode, wtprof.exists()), (0, True))
            for name, script, want in (("能写工作树", "touch ./x", True), ("不能写 .git", "echo x >> ./.git", False),
                                       ("不能写工作树外", f"touch {outside}", False), ("读不到 mmruns 探针", f"cat {mprobe}/x", False),
                                       ("读不到 Claude 临时目录", f"cat {ctp}/x", False),
                                       ("读不到 ~/.grok", f"cat {sdirs['.grok']}/x", False),
                                       ("读不到 ~/.gemini", f"cat {sdirs['.gemini']}/x", False),
                                       ("不能写 Claude 临时目录", f"echo w >> {ctp}/x", False)):
                expect(f"codex mm_wt 层:{name}", codex_sh(f"mmwt-{wtp}", wt, script, cenv).returncode == 0, want)
        finally:
            shutil.rmtree(mprobe, ignore_errors=True); wtprof.unlink(missing_ok=True); outside.unlink(missing_ok=True)
    else:
        print("SKIP codex 集成:找不到 codex")
finally:
    shutil.rmtree(ctp, ignore_errors=True); shutil.rmtree(ctd, ignore_errors=True)

# ---------- codex 额度:用尽时不发起 codex;跑到一半撞额度不重试 ----------
with tempfile.TemporaryDirectory() as qroot, tempfile.TemporaryDirectory() as qtmp:  # 假二进制、会话目录不能放在 MMRUN_HOME 下
    qtmp = pathlib.Path(os.path.realpath(qtmp)); work = qtmp / "work"; work.mkdir()
    chome, crec, cfake, gfake = qtmp / "codex-home", qtmp / "codex.rec", qtmp / "codex", qtmp / "grok"
    def fake_codex(tail):
        cfake.write_text(f"#!/bin/sh\n{MCP_NONE}echo call >> '{crec}'\ncat > /dev/null\n" + tail); cfake.chmod(0o755)
    fake_codex('out=""; prev=""\nfor a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done\necho ok > "$out"\n')
    gfake.write_text("#!/bin/sh\nprintf '{\"text\":\"ok\"}'\n"); gfake.chmod(0o755)
    qenv = {k: v for k, v in os.environ.items() if k != "MMRUN_NO_QUOTA_CHECK"}
    qenv.update(MMRUN_HOME=qroot, MMRUN_D=str(PLUGIN / "mmrun.d"), CODEX_HOME=str(chome), CODEX_BIN=str(cfake), GROK_BIN=str(gfake))
    def session(rl):  # 今天的 rollout 文件,最后一条 token_count 带 rl;rl=None 时没有会话目录
        shutil.rmtree(chome, ignore_errors=True)
        if rl is None: return
        d = chome / "sessions" / time.strftime("%Y/%m/%d"); d.mkdir(parents=True)
        ev = lambda r: json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": None, "rate_limits": r}})
        d.joinpath("rollout-old.jsonl").write_text(ev(None) + "\n")
        os.utime(d / "rollout-old.jsonl", (time.time() - 600, time.time() - 600))
        d.joinpath("rollout-new.jsonl").write_text(ev(dict(rl, primary=None, rate_limit_reached_type=None)) + "\n" + ev(rl) + "\n")
    def limits(pct, resets, reached=None):
        return {"limit_id": "codex", "limit_name": None, "secondary": None, "individual_limit": None,
                "primary": {"used_percent": pct, "window_minutes": 10080, "resets_at": int(resets)},
                "credits": {"has_credits": True, "unlimited": False, "balance": "100"}, "spend_control_reached": None,
                "plan_type": "pro", "rate_limit_reached_type": reached}
    def qstart(models, e=qenv):
        if crec.exists(): crec.unlink()
        r = subprocess.run([str(MMRUN), "start", "--models", models, "--dir", str(work)], input="q\n",
                           capture_output=True, text=True, env=e, timeout=60)
        rid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        w = mmrun(qroot, "wait", rid, "--timeout", "60") if rid != "missing" else None
        st = {m: (pathlib.Path(qroot, rid, f"{m}.status").read_text().strip()
                  if pathlib.Path(qroot, rid, f"{m}.status").exists() else None) for m in models.split(",")}
        calls = len(crec.read_text().splitlines()) if crec.exists() else 0
        return r, rid, st, calls, w

    session(limits(100.0, time.time() + 3 * 86400))
    r, rid, st, calls, w = qstart("codex,grok")
    expect("额度用尽:codex SKIP:quota、grok DONE、假 codex 未被调用", (st, calls), ({"codex": "SKIP:quota", "grok": "DONE"}, 0))
    expect("额度用尽:打印 SKIP codex 与周额度原因", ("SKIP codex: weekly quota 100%" in r.stdout, r.returncode), (True, 0))
    skipf = pathlib.Path(qroot, rid, "codex.skip")
    expect("额度用尽:原因写进 codex.skip", "weekly quota 100%" in (skipf.read_text() if skipf.exists() else ""), True)
    reasonf = pathlib.Path(qroot, rid, "codex.reason")
    expect("额度用尽:codex.reason 与 codex.skip 同文", reasonf.exists() and reasonf.read_text() == skipf.read_text(), True)
    evf = pathlib.Path(qroot, rid, "codex.events.jsonl")
    qevs = [json.loads(l) for l in evf.read_text().splitlines()] if evf.exists() else []
    expect("额度用尽:codex.events.jsonl 是 task_started 加 stopped 的 task_notification,summary 是跳过原因",
           ([e["type"] for e in qevs], qevs[-1].get("status") if qevs else None, qevs[-1].get("summary") if qevs else None),
           (["task_started", "task_notification"], "stopped", skipf.read_text().strip() if skipf.exists() else ""))
    expect("额度用尽:wait 把 SKIP 当已结束", (w.returncode if w else None, "TIMEOUT" in (w.stdout if w else "")), (0, False))
    sl = [l for l in mmrun(qroot, "status", rid).stdout.splitlines() if l.startswith("codex")]
    expect("status:SKIP:quota 行带原因", bool(sl) and "SKIP:quota" in sl[0] and "weekly quota 100%" in sl[0], True)
    r = mmrun(qroot, "report", rid)
    expect("report 遇 SKIP 不报错、列出 codex 状态", (r.returncode, r.stderr, "\n- codex:SKIP:quota\n" in r.stdout), (0, "", True))
    r = mmrun(qroot, "thread", rid)
    expect("thread 遇 SKIP 不报错", (r.returncode, r.stderr, "codex  SKIP:quota" in r.stdout), (0, "", True))

    session(limits(100.0, time.time() - 3600))
    _, _, st, calls, _ = qstart("codex,grok")
    expect("重置时间已过:不跳过 codex", (st["codex"], calls), ("DONE", 1))

    session(limits(10.0, time.time() + 3600, reached="rate_limit_reached"))
    _, _, st, calls, _ = qstart("codex,grok")
    expect("rate_limit_reached_type 非 null:跳过 codex", (st["codex"], calls), ("SKIP:quota", 0))

    session(limits(100.0, time.time() + 3 * 86400))
    _, _, st, calls, _ = qstart("codex,grok", e=dict(qenv, MMRUN_NO_QUOTA_CHECK="1"))
    expect("MMRUN_NO_QUOTA_CHECK=1:不跳过 codex", (st["codex"], calls), ("DONE", 1))

    before = sorted(os.listdir(qroot))
    r, rid, _, calls, _ = qstart("codex")
    expect("只有 codex:非零退出、stderr 有原因、不留 run 目录、未调用",
           (r.returncode != 0, "weekly quota 100%" in r.stderr, sorted(os.listdir(qroot)) == before, calls), (True, True, True, 0))
    expect("只有 codex:报错说强行发起要花额度、先问用户",
           "(MMRUN_NO_QUOTA_CHECK=1 starts it anyway and spends credits: ask the user first)" in r.stderr, True)
    qrepo = qtmp / "qrepo" / "repo"; git("init", "-q", str(qrepo))
    qrepo.joinpath("a.txt").write_text("a\n"); git("-C", str(qrepo), "add", "a.txt"); git("-C", str(qrepo), "commit", "-qm", "init")
    qtask = qtmp / "task.md"; qtask.write_text("t\n")
    r = subprocess.run([str(MMRUN), "run", "--model", "codex", "--task", str(qtask), "--dir", str(qrepo)],
                       capture_output=True, text=True, env=qenv, timeout=60)
    expect("run --model codex 额度用尽:非零、有原因、不开 worktree、不留 run 目录",
           (r.returncode != 0, "weekly quota 100%" in r.stderr, qrepo.parent.joinpath(".mm-wt").exists(), sorted(os.listdir(qroot)) == before),
           (True, True, False, True))

    session(None)
    _, _, st, calls, _ = qstart("codex,grok")
    expect("没有会话目录:不跳过 codex", (st["codex"], calls), ("DONE", 1))

    lim = qtmp / "limit.jsonl"
    lim.write_text('{"type":"thread.started","thread_id":"t-q"}\n{"type":"error","message":"You\'ve hit your usage limit. Try again later."}\n'
                   'not json\n{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}\n')
    fake_codex(f"cat '{lim}'\nexit 1\n")
    _, rid, st, calls, _ = qstart("codex")
    expect("跑到一半撞额度:FAIL:quota、只调用一次", (st["codex"], calls), ("FAIL:quota", 1))
    reason = lambda rid: pathlib.Path(qroot, rid, "codex.reason").read_text() if pathlib.Path(qroot, rid, "codex.reason").exists() else None
    expect("跑到一半撞额度:codex.reason", reason(rid), "codex hit the quota mid-run: You've hit your usage limit.\n")
    lim.write_text('{"type":"error","message":"stream disconnected"}\n')
    _, _, st, calls, _ = qstart("codex")
    expect("其它失败照常重试一次:FAIL:1、调用两次", (st["codex"], calls), ("FAIL:1", 2))
    # FAIL:<n> 的原因:最后一次尝试里最后一条 JSON 错误消息,没有就取最后一个非空的非 JSON 行;单行、至多 200 字符
    lim.write_text('{"type":"thread.started","thread_id":"t-r"}\nReading prompt from stdin...\n'
                   '{"type":"error","message":"stream disconnected before completion"}\n'
                   '{"type":"turn.failed","error":{"message":"stream disconnected:\\nretry limit reached"}}\n'
                   '{"type":"item.completed","item":{"type":"agent_message","text":"x"}}\n')
    _, rid, st, _, _ = qstart("codex")
    expect("codex JSONL 失败:reason 取最后一条错误消息、换行并成空格", (st["codex"], reason(rid)),
           ("FAIL:1", "exit 1: stream disconnected: retry limit reached\n"))
    fake_codex(f'if [ "$(wc -l < \'{crec}\')" -lt 2 ]; then echo \'{{"type":"error","message":"first attempt"}}\'; exit 1; fi\n'
               'printf "Traceback (most recent call last):\\nValueError: bad config\\n\\n"\nexit 2\n')
    _, rid, st, _, _ = qstart("codex")
    expect("纯文本失败:reason 只看最后一次尝试、取最后一个非空行", (st["codex"], reason(rid)), ("FAIL:2", "exit 2: ValueError: bad config\n"))
    fake_codex('printf \'{"type":"error","message":"%0300d"}\\n\' 0\nexit 1\n')
    _, rid, st, _, _ = qstart("codex")
    expect("超长错误消息:reason 截到 200 字符", (st["codex"], reason(rid)), ("FAIL:1", "exit 1: " + "0" * 192 + "\n"))

    # grok:402 余额用尽算撞额度不重试;其它失败重试时换新 session id
    grec, g402 = qtmp / "grok.rec", qtmp / "grok402.raw"
    g402.write_text('{"type":"error","message":"Internal error: {\\n  \\"message\\": \\"API error (status 402 Payment Required): Grok Build usage balance exhausted\\",\\n  \\"http_status\\": 402\\n}"}\n'
                    'Error: Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n'
                    '  "http_status": 402\n}\n')
    def fake_grok(tail):
        if grec.exists(): grec.unlink()
        gfake.write_text('#!/bin/sh\nsid=""; prev=""\nfor a in "$@"; do [ "$prev" = -s ] && sid="$a"; prev="$a"; done\n'
                         f"echo \"$sid\" >> '{grec}'\n" + tail); gfake.chmod(0o755)
    gcalls = lambda: grec.read_text().splitlines() if grec.exists() else []
    greason = lambda rid: pathlib.Path(qroot, rid, "grok.reason").read_text() if pathlib.Path(qroot, rid, "grok.reason").exists() else ""
    fake_grok(f"cat '{g402}'\nexit 1\n")
    _, rid, st, _, _ = qstart("grok")
    expect("grok 402:FAIL:quota、只调用一次、reason", (st["grok"], len(gcalls()), greason(rid).startswith("grok hit the quota mid-run:")),
           ("FAIL:quota", 1, True))
    fake_grok(f'if [ "$(wc -l < \'{grec}\')" -lt 2 ]; then echo \'{{"type":"error","message":"stream disconnected"}}\'; exit 1; fi\n'
              "printf '{\"text\":\"ok\"}'\n")
    _, rid, st, _, _ = qstart("grok")
    ids = gcalls()
    expect("grok 重试换新 session id、最终 DONE", (st["grok"], len(ids), len(set(ids)), all(ids)), ("DONE", 2, 2, True))

# ---------- codex mm profile:不存在时按 mmrun.d 模板生成,已存在时不覆盖 ----------
with tempfile.TemporaryDirectory() as proot, tempfile.TemporaryDirectory() as ptmp:
    ptmp = pathlib.Path(os.path.realpath(ptmp)); phome = ptmp / "home"; phome.mkdir()
    prepo = ptmp / "repo"; git("init", "-q", str(prepo))
    for n in ("1", "2"):
        prepo.joinpath("a.txt").write_text(n + "\n"); git("-C", str(prepo), "add", "a.txt"); git("-C", str(prepo), "commit", "-qm", n)
    pfake = ptmp / "codex"
    pfake.write_text('#!/bin/sh\n' + MCP_NONE + 'out=""; prev=""\nfor a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done\n'
                     f"cat > /dev/null\necho '{review('s', verdict='approve')}' > \"$out\"\n")
    pfake.chmod(0o755)
    penv = {k: v for k, v in os.environ.items() if k != "CODEX_HOME"}
    penv.update(HOME=str(phome), MMRUN_HOME=proot, MMRUN_D=str(PLUGIN / "mmrun.d"), CODEX_BIN=str(pfake))
    prof = phome / ".codex" / "mm.config.toml"
    def preview(stderr=False):
        r = subprocess.run([str(MMRUN), "review", "--models", "codex", "--commit", "HEAD", "--dir", str(prepo)],
                           capture_output=True, text=True, env=penv, timeout=60)
        rid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        if rid != "missing": mmrun(proot, "wait", rid, "--timeout", "60")
        if stderr: return r.stderr
        st = pathlib.Path(proot, rid, "codex.status")
        return r.returncode, st.read_text().strip() if st.exists() else None
    rc_st = preview()
    ptext = prof.read_text() if prof.exists() else ""
    expect("mm profile 不存在:review 跑通、生成、无 @HOME@、deny 指向临时 HOME",
           (rc_st, prof.exists(), "@HOME@" in ptext, f'"{phome}/.claude/mmruns" = "deny"' in ptext),
           ((0, "DONE"), True, False, True))
    # 已有 profile 与模板(替换后)不同:新加的 deny 不会生效,review 拒跑并说明删掉会重新生成,文件不动、不发起
    prof.write_text("# 用户自己的 mm profile\n")
    before = sorted(os.listdir(proot))
    r = subprocess.run([str(MMRUN), "review", "--models", "codex", "--commit", "HEAD", "--dir", str(prepo)],
                       capture_output=True, text=True, env=penv, timeout=60)
    expect("mm profile 与模板不同:非零、stderr 点出文件并说明删掉、文件未被改、不发起",
           (r.returncode != 0, str(prof) in r.stderr and "differs" in r.stderr and "delete" in r.stderr, prof.read_text(),
            "RUN " in r.stdout, sorted(os.listdir(proot)) == before), (True, True, "# 用户自己的 mm profile\n", False, True))
    prof.unlink(); preview()
    perr = preview(stderr=True)
    expect("mm profile 与模板(替换后)一致:没有报错、照跑", ("differs" in perr, preview()), (False, (0, "DONE")))

    # 受信项目的 .codex/config.toml 高于 -p 层:设了沙箱、权限、MCP、插件的拒跑,只设 model 的照跑
    orepo = ptmp / "orepo"; git("init", "-q", str(orepo)); orepo.joinpath("sub").mkdir()
    orepo.joinpath("a.txt").write_text("1\n"); git("-C", str(orepo), "add", "a.txt"); git("-C", str(orepo), "commit", "-qm", "1")
    orepo.joinpath(".codex").mkdir(); ocfg = orepo / ".codex/config.toml"
    def oreview():
        r = subprocess.run([str(MMRUN), "review", "--models", "codex", "--commit", "HEAD", "--dir", str(orepo / "sub")],
                           capture_output=True, text=True, env=penv, timeout=60)
        rid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        if rid != "missing": mmrun(proot, "wait", rid, "--timeout", "60")
        st = pathlib.Path(proot, rid, "codex.status")
        return r, st.read_text().strip() if st.exists() else None
    ocfg.write_text('sandbox_mode = "danger-full-access"\n')
    r, st = oreview()
    expect("项目层设 sandbox_mode:review 拒跑、报出文件与原因、不发起",
           (r.returncode != 0, str(ocfg) in r.stderr, "sandbox_mode" in r.stderr, st), (True, True, True, None))
    ocfg.write_text('model = "x"\n')
    r, st = oreview()
    expect("项目层只设 model:review 照跑", (r.returncode, st), (0, "DONE"))
    ocfg.write_text('[mcp_servers.x]\ncommand = "y"\n'); git("-C", str(orepo), "add", "-A"); git("-C", str(orepo), "commit", "-qm", "2")
    otask = ptmp / "otask.md"; otask.write_text("t\n")
    r = subprocess.run([str(MMRUN), "run", "--model", "codex", "--task", str(otask), "--dir", str(orepo)],
                       capture_output=True, text=True, env=penv, timeout=60)
    expect("工作树的项目层有 [mcp_servers:run 拒跑、报出原因、不留工作树",
           (r.returncode != 0, "mcp_servers" in r.stderr, "RUN " in r.stdout,
            git("-C", str(orepo), "worktree", "list", "--porcelain").count("worktree ")), (True, True, False, 1))

# ---------- codex 运行关掉 MCP server、插件与自动审批;关不掉就不启动 ----------
with tempfile.TemporaryDirectory() as mroot, tempfile.TemporaryDirectory() as mtmp:
    mtmp = pathlib.Path(os.path.realpath(mtmp)); mwork = mtmp / "work"; mwork.mkdir()
    margv, mprm, mfake = mtmp / "exec.argv", mtmp / "exec.prm", mtmp / "codex"
    # mcp list:FAKEMCP=two 两个启用的 server 按 -c 关掉;stuck 时 srv-a 关不掉;fail 时命令失败。输出带假密钥,不能外泄
    mfake.write_text(r'''#!/bin/sh
case " $* " in *" mcp list "*)
  [ "$FAKEMCP" = fail ] && exit 1
  a=true; b=true
  for x in "$@"; do
    [ "$x" = mcp_servers.srv-a.enabled=false ] && [ "$FAKEMCP" != stuck ] && a=false
    [ "$x" = mcp_servers.srv_b.enabled=false ] && b=false
  done
  printf '[{"name":"srv-a","enabled":%s,"transport":{"env":{"TOKEN":"SECRET-TOKEN-1"}}},{"name":"srv_b","enabled":%s},{"name":"off","enabled":false}]\n' "$a" "$b"
  exit 0;;
esac
for x in "$@"; do printf '%s\n' "$x" >> @ARGV@; done; echo --- >> @ARGV@
cat >> @PRM@; echo ===== >> @PRM@
out=""; prev=""; for x in "$@"; do [ "$prev" = -o ] && out="$x"; prev="$x"; done
echo ok > "$out"; echo '{"type":"thread.started","thread_id":"t-mcp"}'
'''.replace("@ARGV@", shlex.quote(str(margv))).replace("@PRM@", shlex.quote(str(mprm))))
    mfake.chmod(0o755)
    menv = dict(os.environ, MMRUN_HOME=mroot, MMRUN_D=str(PLUGIN / "mmrun.d"), CODEX_BIN=str(mfake), CODEX_HOME=str(mtmp / "codex-home"))
    def mrun(*args, scen="two", prompt="q\n"):
        for f in (margv, mprm): f.unlink(missing_ok=True)
        r = subprocess.run([str(MMRUN), *args], input=prompt, capture_output=True, text=True, env=dict(menv, FAKEMCP=scen), timeout=60)
        rid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        if rid != "missing": mmrun(mroot, "wait", rid, "--timeout", "60")
        st = pathlib.Path(mroot, rid, "codex.status")
        calls = [b.splitlines() for b in margv.read_text().split("---\n")[:-1]] if margv.exists() else []
        return r, rid, st.read_text().strip() if st.exists() else None, calls
    def cvals(argv):
        return sorted(argv[i + 1] for i, x in enumerate(argv[:-1]) if x == "-c")
    LOCK = sorted(['approval_policy="never"', 'approvals_reviewer="user"', "features.plugins=false",
                   "mcp_servers.srv-a.enabled=false", "mcp_servers.srv_b.enabled=false",
                   "skills.include_instructions=false"])

    r, mrid, st, calls = mrun("start", "--models", "codex", "--dir", str(mwork))
    expect("关 MCP:exec 带上两个启用 server 的 -c、插件、审批与 skills 目录覆盖,已停用的不带",
           (st, len(calls), cvals((calls or [[]])[0])), ("DONE", 1, LOCK))
    p0 = (mprm.read_text().split("=====\n") if mprm.exists() else [""])[0]
    expect("关 MCP:codex 的 prompt 开头一句说明没有 MCP 工具,原文在后",
           (p0.startswith("This run has no MCP tools") and "AGENTS.md" in p0.splitlines()[0], p0.endswith("\nq\n")), (True, True))
    leaked = [p.name for p in pathlib.Path(mroot).rglob("*") if p.is_file() and "SECRET-TOKEN-1" in p.read_text(errors="replace")]
    expect("关 MCP:mcp list 的原始输出不进 stdout/stderr 和 run 目录", ("SECRET-TOKEN-1" in r.stdout + r.stderr, leaked), (False, []))
    r, _, st, calls = mrun("ask", "--from", mrid, prompt="more\n")
    c = (calls or [[]])[0]
    expect("关 MCP:resume 时同样带上", (st, "resume" in c, cvals(c)), ("DONE", True, LOCK))

    r, _, st, calls = mrun("start", "--models", "codex", "--dir", str(mwork), scen="stuck")
    expect("带了参数仍有启用的 server:不启动、FAIL:mcp、stderr 一行只有名字",
           (st, calls, r.stderr.splitlines()),
           ("FAIL:mcp", [], ["mmrun: codex not started: MCP servers still enabled under mmrun's overrides: srv-a"]))
    r, frid, st, calls = mrun("start", "--models", "codex", "--dir", str(mwork), scen="fail")
    expect("mcp list 失败:不启动、FAIL:mcp、stderr 一行", (st, calls, len(r.stderr.splitlines())), ("FAIL:mcp", [], 1))
    fev = pathlib.Path(mroot, frid, "codex.events.jsonl")
    fevs = [json.loads(l) for l in fev.read_text().splitlines()] if fev.exists() else []
    expect("mcp list 失败:events 是 task_started 加 failed 的 task_notification",
           [(e["type"], e.get("status")) for e in fevs], [("task_started", None), ("task_notification", "failed")])

    for name, item, want in (("含", "mcp_tool_call", True), ("不含", "command_execution", False)):
        wd = pathlib.Path(mroot, f"mcpwarn-{int(want)}"); wd.mkdir()
        wd.joinpath("run.meta").write_text(f"runid={wd.name}\nmode=review\nschema={SCHEMA}\n")
        wd.joinpath("codex.status").write_text("DONE\n")
        wd.joinpath("codex.raw").write_text(json.dumps({"type": "item.completed", "item": {"id": "i1", "type": item}}) + "\n")
        for f in ("codex.json", "codex.out"): wd.joinpath(f).write_text(review("s"))
        out = mmrun(mroot, "result", "codex", wd.name).stdout
        expect(f"codex.raw {name} mcp_tool_call:render {'有' if want else '没有'}警告", out.startswith("WARNING: codex made MCP tool calls"), want)

    if shutil.which("codex"):
        r = subprocess.run([str(MMRUN), "__codex_lockdown", str(mwork)], capture_output=True, text=True,
                           env={k: v for k, v in os.environ.items() if k != "CODEX_BIN"}, timeout=120)
        largs = r.stdout.splitlines()
        lst = subprocess.Popen(["codex", *largs, "mcp", "list", "--json"], cwd=mwork, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        n = subprocess.run(["jq", "[.[] | select(.enabled != false)] | length"], stdin=lst.stdout, capture_output=True, text=True).stdout.strip()
        lst.wait()
        expect("真 codex:带生成的参数后 mcp list 启用数为 0", (r.returncode, "features.plugins=false" in largs, lst.returncode, n), (0, True, 0, "0"))
    else:
        print("SKIP codex 集成:找不到 codex")

# ---------- 下一步写在输出里:CLAUDECODE=1 时的 NEXT 行、review 拒收 stdin、review 默认模型取插件配置 ----------
with tempfile.TemporaryDirectory() as nroot, tempfile.TemporaryDirectory() as ntmp:  # 假二进制、仓库不能放在 MMRUN_HOME 下
    ntmp = pathlib.Path(os.path.realpath(ntmp)); nhome = ntmp / "home"; nhome.mkdir()
    nrepo = ntmp / "repo"; git("init", "-q", str(nrepo))
    nrepo.joinpath("a.txt").write_text("a\n"); git("-C", str(nrepo), "add", "a.txt"); git("-C", str(nrepo), "commit", "-qm", "init")
    nrepo.joinpath("a.txt").write_text("changed\n")
    ngrok = ntmp / "grok"; ngrok.write_text("#!/bin/sh\nprintf '{\"text\":\"ok\"}'\n"); ngrok.chmod(0o755)
    ncodex = ntmp / "codex"
    ncodex.write_text('#!/bin/sh\n' + MCP_NONE + 'out=""; prev=""\nfor a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done\n'
                      'cat > /dev/null\necho ok > "$out"\n')
    ncodex.chmod(0o755)
    ntask = ntmp / "task.md"; ntask.write_text("t\n")
    # 临时 HOME:默认模型读 $HOME/.claude/settings.json,codex 的 mm profile 也生成在这里
    nenv = dict(os.environ, HOME=str(nhome), MMRUN_HOME=nroot, MMRUN_D=str(PLUGIN / "mmrun.d"), GROK_BIN=str(ngrok), CODEX_BIN=str(ncodex))
    cc = dict(nenv, CLAUDECODE="1")
    def nrun(*args, e=nenv, **kw):
        if "input" not in kw: kw.setdefault("stdin", subprocess.DEVNULL)
        r = subprocess.run([str(MMRUN), *args], capture_output=True, text=True, env=e, timeout=60, **kw)
        rid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        if rid != "missing": mmrun(nroot, "wait", rid, "--timeout", "60")
        return r, rid
    def nexts(out):  # mod 用 ^(NEXT|THEN)  过滤的行
        return [l for l in out.splitlines() if l.startswith(("NEXT ", "THEN "))]
    def cc_next(rid):
        return ["NEXT  nothing to run: the mm plugin sends the result to the main session when the run ends"]
    def nmodels(rid):
        p = pathlib.Path(nroot, rid, "run.meta")
        return next((l[7:] for l in (p.read_text() if p.exists() else "").splitlines() if l.startswith("models=")), None)

    r, srid = nrun("start", "--models", "grok", "--dir", str(nrepo), input="q\n", e=cc)
    expect("CLAUDECODE=1 start:只有一行 NEXT,说明结果由插件送达", (r.returncode, nexts(r.stdout)), (0, cc_next(srid)))
    r, rid = nrun("ask", "--from", srid, input="more\n", e=cc)
    expect("CLAUDECODE=1 ask:只有一行 NEXT", (r.returncode, nexts(r.stdout)), (0, cc_next(rid)))
    r, rid = nrun("review", "--models", "grok", "--dir", str(nrepo), e=cc)
    expect("CLAUDECODE=1 review:只有一行 NEXT", (r.returncode, nexts(r.stdout)), (0, cc_next(rid)))
    r, rid = nrun("run", "--model", "grok", "--task", str(ntask), "--dir", str(nrepo), e=cc)
    expect("CLAUDECODE=1 run:只有一行 NEXT,没有 THEN", (r.returncode, nexts(r.stdout)), (0, cc_next(rid)))
    r, rid = nrun("start", "--models", "grok", "--dir", str(nrepo), input="q\n")
    expect("无 CLAUDECODE start:NEXT wait 与 THEN result 照旧", nexts(r.stdout),
           [f"NEXT  mmrun wait {rid} --timeout 3600   # run in the background, it wakes you when done", f"THEN  mmrun result <model> {rid}"])
    r, rid = nrun("run", "--model", "grok", "--task", str(ntask), "--dir", str(nrepo))
    expect("无 CLAUDECODE run:NEXT/THEN 共四行,含 review --patch 与 apply", nexts(r.stdout)[1:],
           [f"THEN  mmrun result <model> {rid}",
            f"THEN  mmrun review --patch {rid} --models <another model>   # optional: have another model review this patch",
            f"THEN  mmrun apply {rid} | mmrun discard {rid}"])

    STDIN_ERR = 'mmrun: review does not read stdin; pass the text with --focus "…" or --notes-file <path>\n'
    r, rid = nrun("review", "--models", "grok", "--dir", str(nrepo), input="please focus on locking\n")
    expect("review 管道有数据:报错指向 --focus/--notes-file、不发起", (r.returncode != 0, r.stderr, rid), (True, STDIN_ERR, "missing"))
    nnotes = ntmp / "notes.txt"; nnotes.write_text("notes\n")
    with open(nnotes) as f:
        r, rid = nrun("review", "--models", "grok", "--dir", str(nrepo), stdin=f)
    expect("review stdin 是非空文件:报错、不发起", (r.returncode != 0, r.stderr, rid), (True, STDIN_ERR, "missing"))
    r, rid = nrun("review", "--models", "grok", "--dir", str(nrepo))
    expect("review stdin=/dev/null:照常发起", (r.returncode, r.stderr, rid != "missing"), (0, "", True))
    r, rid = nrun("review", "--models", "grok", "--dir", str(nrepo), input="")
    expect("review 空管道:照常发起", (r.returncode, rid != "missing"), (0, True))
    ntag = lambda rid: next((l[4:] for l in pathlib.Path(nroot, rid, "run.meta").read_text().splitlines() if l.startswith("tag=")), None)
    expect("review tag:普通模式 brief", ntag(rid), "review:worktree:brief")
    r, rid = nrun("review", "--exhaustive", "--models", "grok", "--dir", str(nrepo))
    expect("review tag:--exhaustive 是 exhaustive 而不是 full", (r.returncode, ntag(rid)), (0, "review:worktree:exhaustive"))

    r, rid = nrun("review", "--dir", str(nrepo))
    expect("review 无 settings.json:默认 codex,grok", (r.returncode, nmodels(rid)), (0, "codex,grok"))
    nhome.joinpath(".claude").mkdir()
    nset = nhome / ".claude/settings.json"
    nset.write_text(json.dumps({"env": {"API_KEY": "SECRET-KEY-1"}, "pluginConfigs": {
        "other@m": {"options": {"reviewModels": "agy"}}, "mm@empty": {"options": {"reviewModels": ""}},
        "mm@m": {"options": {"reviewModels": "grok", "token": "SECRET-KEY-2"}}, "mm@later": {"options": {"reviewModels": "codex"}}}}))
    r, rid = nrun("review", "--dir", str(nrepo))
    expect("review 有 mm@ 配置:用第一个非空 reviewModels、不外泄文件其他内容",
           (r.returncode, nmodels(rid), "SECRET-KEY" in r.stdout + r.stderr), (0, "grok", False))
    r, rid = nrun("review", "--models", "codex", "--dir", str(nrepo))
    expect("review 传了 --models:不看配置", (r.returncode, nmodels(rid)), (0, "codex"))
    nset.write_text(json.dumps({"pluginConfigs": {"mm@m": {"options": {}}}}))
    r, rid = nrun("review", "--dir", str(nrepo))
    expect("review 配置里没有 reviewModels:默认 codex,grok", (r.returncode, nmodels(rid)), (0, "codex,grok"))
    nset.write_text('{"pluginConfigs": {"mm@m": ')
    r, rid = nrun("review", "--dir", str(nrepo))
    expect("review settings.json 解析失败:默认 codex,grok", (r.returncode, nmodels(rid)), (0, "codex,grok"))
    nset.write_text(json.dumps({"pluginConfigs": {"mm@m": {"options": {"reviewModels": "grok"}}}}))
    r, rid = nrun("start", "--dir", str(nrepo), input="q\n")
    expect("start 不读 reviewModels:仍默认 codex,grok", (r.returncode, nmodels(rid)), (0, "codex,grok"))

    rd = make_run(nroot, "20991231-000009-nout", None); rd.joinpath("grok.status").write_text("FAIL:1\n")
    r = mmrun(nroot, "result", "grok", rd.name)
    expect("result 没有输出:报错给出 tail -n 20 的排障命令",
           (r.returncode != 0, r.stderr.strip().endswith(f"diagnose with: tail -n 20 {rd}/grok.raw")), (True, True))

    usage = subprocess.run([str(MMRUN)], capture_output=True, text=True, env=nenv).stdout
    expect("usage 列出 --codex-model/--grok-model/--agy-model/--model-name",
           [o for o in ("--codex-model", "--grok-model", "--agy-model", "--model-name") if o not in usage], [])
    expect("usage 流程:主会话由 mm 插件送回结果,subagent/终端用 wait → result",
           ("the mm plugin sends the result" in usage, "wait → result" in usage, "Token-saving flow: review → wait → result" in usage), (True, True, False))
    notc = next((l for l in usage.splitlines() if l.startswith("Not covered:")), "")
    expect("usage 隔离:写明各模型读不到其他模型的状态目录,未覆盖一行不再列它们",
           ("~/.grok, ~/.gemini" in usage, "~/.grok" in notc or "~/.gemini" in notc, "each other's sessions" in usage),
           (True, False, False))
    for args in (["help"], ["--help"]):
        r = subprocess.run([str(MMRUN), *args], capture_output=True, text=True, env=nenv)
        expect(f"mmrun {' '.join(args)}:整份 usage", (r.returncode, r.stdout), (0, usage))
    def sub_help(*args):
        r = subprocess.run([str(MMRUN), *args], capture_output=True, text=True, env=nenv)
        return r.returncode, [l.split()[1:3] for l in r.stdout.splitlines() if l.startswith("  mmrun ")], r.stdout
    code, heads, out = sub_help("review", "--help")
    expect("review --help:只有 review 一块、含其缩进行、退出 0", (code, heads, "--exhaustive" in out, "Isolation:" in out),
           (0, [["review", "[scope]"]], True, False))
    code, heads, out = sub_help("status", "X", "-h")
    expect("status -h:status 一块,含 SKIP:quota 说明行", (code, heads, "SKIP:quota" in out), (0, [["status", "[RUNID]"]], True))
    code, heads, _ = sub_help("room", "--help")
    expect("room --help:三个 room 块,不含中间的 thread", (code, heads), (0, [["room", "wait"], ["room", "post"], ["room", "[RUNID]"]]))
    code, heads, out = sub_help("clean", "--help")
    expect("clean --help:续行也带上", (code, heads, "start/review/run run" in out), (0, [["clean", "[DAYS]"]], True))

# ---------- 自动清理:默认 mmruns 下,start/review/run 每天顺带跑一次 clean --force ----------
with tempfile.TemporaryDirectory() as ahome:
    aroot = pathlib.Path(ahome, ".claude/mmruns"); aroot.mkdir(parents=True)
    def old_run(rid):
        rd = make_run(aroot, rid, "x\n"); t = time.time() - 10 * 86400; os.utime(rd, (t, t)); return rd
    aenv = {k: v for k, v in os.environ.items() if k != "MMRUN_HOME"}
    aenv.update(HOME=ahome, MMRUN_D=str(PLUGIN / "mmrun.d"))
    a1 = old_run("20000101-000000-a001")
    subprocess.run([str(MMRUN), "status"], capture_output=True, text=True, env=aenv)
    expect("自动清理:status 不触发", a1.exists(), True)
    subprocess.run([str(MMRUN), "review", "--dir", str(pathlib.Path(ahome, "nope"))], capture_output=True, text=True, env=aenv)
    expect("自动清理:review 删掉过期 run", a1.exists(), False)
    a2 = old_run("20000101-000000-a002")
    subprocess.run([str(MMRUN), "review", "--dir", str(pathlib.Path(ahome, "nope"))], capture_output=True, text=True, env=aenv)
    expect("自动清理:一天内只跑一次", a2.exists(), True)
    a3 = old_run("20000101-000000-a003"); aroot.joinpath(".last-clean").unlink(missing_ok=True)
    subprocess.run([str(MMRUN), "review", "--dir", str(pathlib.Path(ahome, "nope"))], capture_output=True, text=True,
                   env=dict(aenv, MMRUN_HOME=str(aroot)))
    expect("自动清理:设了 MMRUN_HOME 不触发", a3.exists(), True)

# ---------- <model>.events.jsonl:哪个 Claude 会话发起、codex 跑到哪、怎么结束 ----------
with tempfile.TemporaryDirectory() as eroot, tempfile.TemporaryDirectory() as etmp:  # 假二进制不能放在 MMRUN_HOME 下:围栏禁读该目录
    etmp = pathlib.Path(os.path.realpath(etmp)); ework = etmp / "work"; ework.mkdir()
    ecodex, egrok, efail, eslow = etmp / "codex", etmp / "grok", etmp / "grok-fail", etmp / "grok-slow"
    cmd = "/bin/zsh -lc \"git status --short\""
    elines = [{"type": "thread.started", "thread_id": "t-ev"},
              {"type": "item.started", "item": {"id": "item_1", "type": "command_execution", "command": cmd}},
              {"type": "item.completed", "item": {"id": "item_1", "type": "command_execution", "command": cmd, "exit_code": 0}},
              {"type": "item.completed", "item": {"id": "item_2", "type": "agent_message", "text": "Looks fine.\nsecond line"}},
              {"type": "item.started", "item": {"id": "item_3", "type": "command_execution", "command": "/bin/bash -lc 'ls -la'"}},
              {"type": "item.completed", "item": {"id": "item_3", "type": "command_execution", "command": "/bin/bash -lc 'ls -la'"}}]
    erollout = etmp / "codex-home/sessions/2026/10/15/rollout-x-t-ev.jsonl"
    def etok(out, total):
        return {"timestamp": "2026-10-15T00:00:00Z", "type": "event_msg", "payload": {"type": "token_count", "info": None if out is None else {
            "total_token_usage": {"input_tokens": total - out, "cached_input_tokens": 0, "output_tokens": out, "reasoning_output_tokens": 0, "total_tokens": total},
            "last_token_usage": {"output_tokens": 1}}}}
    rwrites = {0: etok(11, 1000), 3: etok(45, 2400), 4: etok(None, 0)}  # 在第 i 条 codex 行之后写进 rollout;info 为 null 的行不算
    ecodex.write_text("#!/bin/sh\n" + MCP_NONE + 'cat > /dev/null\nout=""; prev=""\nfor a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done\n'
                      + f'mkdir -p {shlex.quote(str(erollout.parent))}\n'
                      + "".join(f"printf '%s\\n' {shlex.quote(json.dumps(l))}\n"
                                + (f"printf '%s\\n' {shlex.quote(json.dumps(rwrites[i]))} >> {shlex.quote(str(erollout))}\n" if i in rwrites else "")
                                + "sleep 1.2\n" for i, l in enumerate(elines))
                      + 'echo ok > "$out"\n'
                      + f"printf '%s\\n' {shlex.quote(json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 100, 'cached_input_tokens': 20, 'output_tokens': 7}}))}\n")
    egrok.write_text("#!/bin/sh\nprintf '{\"text\":\"ok\",\"usage\":{\"input_tokens\":5,\"output_tokens\":3}}'\n")
    efail.write_text("#!/bin/sh\necho '{\"type\":\"error\",\"message\":\"boom happened\"}'\nexit 1\n")
    eslow.write_text("#!/bin/sh\nsleep 30\n")
    ehome = etmp / "home"; ehome.joinpath(".grok").mkdir(parents=True)
    elive, enosess = etmp / "grok-live", etmp / "grok-nosess"
    def gout(**kw): return f"printf '%s\\n' {shlex.quote(json.dumps(kw))}\n"
    def gchat(**kw): return f"printf '%s\\n' {shlex.quote(json.dumps(kw))} >> \"$d/chat_history.jsonl\"\n"
    elive.write_text('#!/bin/sh\nsid=""; prev=""\nfor a in "$@"; do [ "$prev" = -s ] && sid="$a"; prev="$a"; done\n'
                     'd="$HOME/.grok/sessions/%2Fx/$sid"; mkdir -p "$d"\n'
                     + gchat(type="system", content="sys") + gchat(type="user", content="q")
                     + gout(type="tool_call", toolCallId="c1", toolName="grep") + "sleep 1.2\n" + gout(type="tool_call_update", toolCallId="c1", status="completed")
                     + gchat(type="reasoning", summary=[{"type": "summary_text", "text": "Thinking first.\nx"}]) + "sleep 2.2\n"
                     + gchat(type="assistant", content="Looking at mmrun.\nmore", tool_calls=[{"id": "c1"}])
                     + gout(type="tool_call", toolCallId="c2", toolName="read_file") + "sleep 1.2\n" + gout(type="tool_call_update", toolCallId="c2", status="completed")
                     + gchat(type="tool_result", content="file body") + gchat(type="assistant", content="") + "sleep 2.5\n"
                     + gout(type="text", data="ok") + gout(type="end", stopReason="end_turn", usage={"input_tokens": 5, "output_tokens": 3}))
    enosess.write_text("#!/bin/sh\nsleep 2.5\nprintf '{\"text\":\"ok\"}'\n")
    for f in (ecodex, egrok, efail, eslow, elive, enosess): f.chmod(0o755)
    eenv = dict(os.environ, MMRUN_HOME=eroot, MMRUN_D=str(PLUGIN / "mmrun.d"), CODEX_HOME=str(etmp / "codex-home"),
                CODEX_BIN=str(ecodex), GROK_BIN=str(egrok), MMRUN_PROGRESS_SECS="1", CLAUDE_CODE_SESSION_ID="test-session")
    def estart(models, tag, e=eenv, wait=True):
        r = subprocess.run([str(MMRUN), "start", "--models", models, "--dir", str(ework), "--tag", tag], input="q\n",
                           capture_output=True, text=True, env=e, timeout=60)
        rid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        if wait and rid != "missing": mmrun(eroot, "wait", rid, "--timeout", "60")
        return rid
    def events(rid, m, until="task_notification"):  # wait 只看 status:末行可能稍后才写,等到末行是 until
        f = pathlib.Path(eroot, rid, f"{m}.events.jsonl")
        evs = []
        for _ in range(50):
            evs = [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []
            if evs and evs[-1]["type"] == until: break
            time.sleep(0.2)
        return evs

    rid = estart("codex", "evt-codex")
    evs = events(rid, "codex"); first = evs[0] if evs else {}; last = evs[-1] if evs else {}
    expect("events codex:首行 task_started,带 task_id、provider、mode、tag、claude_session",
           tuple(first.get(k) for k in ("type", "task_id", "provider", "mode", "description", "claude_session")),
           ("task_started", f"{rid}/codex", "codex", "start", "evt-codex", "test-session"))
    prog = [e for e in evs if e["type"] == "task_progress"]
    expect("events codex:有 task_progress 的 tool_uses ≥ 1、last_tool_name 以 command_execution: 开头",
           any(e["usage"]["tool_uses"] >= 1 and e["last_tool_name"].startswith("command_execution: ") for e in prog), True)
    expect("events codex:last_tool_name 去掉 /bin/zsh -lc、/bin/bash -lc 与引号",
           {"command_execution: git status --short", "command_execution: ls -la"} <= {e["last_tool_name"] for e in prog}, True)
    expect("events codex:summary 取最后一条 agent_message 的首行", "Looks fine." in {e["summary"] for e in prog}, True)
    expect("events codex:相邻 task_progress 不重复",
           all(a != b for a, b in zip([{k: v for k, v in e.items() if k != "ts"} for e in prog],
                                      [{k: v for k, v in e.items() if k != "ts"} for e in prog][1:])), True)
    expect("events codex:task_progress 带 rollout 里最后一条非空 token_count 的 output/total_tokens 与 transcript_path",
           any((e["usage"].get("output_tokens"), e["usage"].get("total_tokens"), e.get("transcript_path")) == (45, 2400, str(erollout))
               for e in prog), True)
    expect("events codex:task_notification 的 transcript_path 是 rollout 文件", last.get("transcript_path"), str(erollout))
    expect("events codex:末行 task_notification completed,usage 带 total/output_tokens 与 duration_ms、只有一条",
           (last.get("type"), last.get("status"), last.get("summary"), (last.get("usage") or {}).get("total_tokens"),
            (last.get("usage") or {}).get("output_tokens"), isinstance((last.get("usage") or {}).get("duration_ms"), int),
            sum(e["type"] == "task_notification" for e in evs)),
           ("task_notification", "completed", "", 107, 7, True, 1))
    evf = pathlib.Path(eroot, rid, "codex.events.jsonl"); size = evf.stat().st_size if evf.exists() else -1
    time.sleep(2)
    expect("events codex:结束后 watcher 不再写", evf.stat().st_size if evf.exists() else -1, size)

    rid = estart("grok", "evt-grok", e={k: v for k, v in eenv.items() if k != "CLAUDE_CODE_SESSION_ID"})
    evs = events(rid, "grok")
    expect("events grok:只有 task_started 与 completed 的 task_notification", ([e["type"] for e in evs], evs[-1].get("status") if evs else None),
           (["task_started", "task_notification"], "completed"))
    expect("events:没有 CLAUDE_CODE_SESSION_ID 时 claude_session 是空串", evs[0].get("claude_session") if evs else None, "")

    # grok --output-format streaming-json:每行一个 ACP 事件,末行 end 带 usage、cost,有 --json-schema 时带 structuredOutput;json 格式只在结束时打一个对象
    estream = etmp / "grok-stream"
    turn_usage = {"type": "usage", "usage": {"input_tokens": 1, "output_tokens": 1}}
    end = {"type": "end", "stopReason": "end_turn", "usage": {"input_tokens": 50, "output_tokens": 9}, "total_cost_usd": 0.01}
    slines = [[{"type": "available_commands", "tools": ["read_file", "grep"]}, turn_usage,
               {"type": "tool_call", "toolCallId": "c1", "toolName": "read_file", "status": "pending", "rawInput": {"target_file": "a"}},
               {"type": "tool_call_update", "toolCallId": "c1", "status": None},
               {"type": "tool_call_update", "toolCallId": "c1", "status": "completed"}],
              [{"type": "tool_call", "toolCallId": "c2", "toolName": "grep", "status": "pending"},
               {"type": "tool_call_update", "toolCallId": "c2", "status": "failed"}],
              [{"type": "text", "data": "Done."}, {"type": "text", "data": "\nAll good"}, turn_usage]]
    pl = lambda l: f"printf '%s\\n' {shlex.quote(json.dumps(l))}\n"
    jend = {k: v for k, v in end.items() if k != "type"} | {"text": "Done.\nAll good"}
    estream.write_text('#!/bin/sh\nfmt=""; schema=""; prev=""\nfor a in "$@"; do [ "$prev" = --output-format ] && fmt="$a"; '
                       '[ "$prev" = --json-schema ] && schema=1; prev="$a"; done\n'
                       + 'if [ "$fmt" != streaming-json ]; then\n'
                       + f'  if [ -n "$schema" ]; then {pl(dict(jend, structuredOutput={"answer": "yes"}))}  else {pl(jend)}  fi; exit 0\nfi\n'
                       + "sleep 1.2\n".join("".join(pl(l) for l in g) for g in slines) + "sleep 1.2\n"
                       + f'if [ -n "$schema" ]; then {pl(dict(end, structuredOutput={"answer": "yes"}))}else {pl(end)}fi\n')
    estream.chmod(0o755)
    senv = {**eenv, "GROK_BIN": str(estream)}
    rid = estart("grok", "evt-stream", e=senv)
    evs = events(rid, "grok"); prog = [e for e in evs if e["type"] == "task_progress"]
    expect("events grok:task_progress 依次报 read_file 1 次、grep 2 次(completed 与 failed 都算)",
           [(e["usage"]["tool_uses"], e["last_tool_name"]) for e in prog], [(1, "read_file"), (2, "grep")])
    expect("events grok:末行 task_notification 取 end 行的 usage", (evs[-1].get("usage") or {}).get("total_tokens") if evs else None, 59)
    gout = pathlib.Path(eroot, rid, "grok.out")
    expect("grok streaming:无 schema 时 .out 是各段 text 拼接", gout.read_text() if gout.exists() else None, "Done.\nAll good\n")
    sch = etmp / "answer.schema.json"; sch.write_text(json.dumps({"type": "object", "required": ["answer"]}))
    r = subprocess.run([str(MMRUN), "start", "--models", "grok", "--dir", str(ework), "--tag", "evt-schema", "--schema", str(sch)],
                       input="q\n", capture_output=True, text=True, env=senv, timeout=60)
    rid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
    mmrun(eroot, "wait", rid, "--timeout", "60")
    gj, gc = pathlib.Path(eroot, rid, "grok.json"), pathlib.Path(eroot, rid, "grok.cost")
    expect("grok streaming:有 schema 时 .json 取 end 行的 structuredOutput、cost 取 end 行",
           (json.loads(gj.read_text()) if gj.exists() else None, gc.read_text().strip() if gc.exists() else None), ({"answer": "yes"}, "0.01"))

    rid = estart("grok", "evt-grok-live", e=dict(eenv, HOME=str(ehome), GROK_BIN=str(elive)))
    evs = events(rid, "grok"); prog = [e for e in evs if e["type"] == "task_progress"]
    gsid = pathlib.Path(eroot, rid, "grok.session").read_text().strip() if pathlib.Path(eroot, rid, "grok.session").exists() else "missing"
    gchatf = str(ehome / ".grok/sessions/%2Fx" / gsid / "chat_history.jsonl")
    expect("events grok:task_progress 带 tool_uses 2、最后的工具名、最后一条非空 assistant 的首行、chat_history 路径",
           any((e["usage"], e.get("last_tool_name"), e.get("summary"), e.get("transcript_path"))
               == ({"tool_uses": 2}, "read_file", "Looking at mmrun.", gchatf) for e in prog), True)
    expect("events grok:assistant 之前 summary 取最后一条 reasoning 的首行",
           any(e.get("summary") == "Thinking first." and e.get("transcript_path", "").endswith("/chat_history.jsonl") for e in prog), True)
    expect("events grok:相邻 task_progress 不重复",
           all(a != b for a, b in zip([{k: v for k, v in e.items() if k != "ts"} for e in prog],
                                      [{k: v for k, v in e.items() if k != "ts"} for e in prog][1:])), True)
    expect("events grok:task_notification completed,transcript_path 同上",
           (evs[-1].get("type"), evs[-1].get("status"), evs[-1].get("transcript_path")) if evs else None, ("task_notification", "completed", gchatf))

    rid = estart("grok", "evt-grok-nosess", e=dict(eenv, HOME=str(ehome), GROK_BIN=str(enosess)))
    evs = events(rid, "grok")
    expect("events grok:会话目录始终不出现时没有 task_progress,task_notification 没有 transcript_path",
           ([e["type"] for e in evs], "transcript_path" in evs[-1] if evs else None), (["task_started", "task_notification"], False))

    rid = estart("grok", "evt-fail", e=dict(eenv, GROK_BIN=str(efail)))
    evs = events(rid, "grok"); rf = pathlib.Path(eroot, rid, "grok.reason")
    rline = rf.read_text().splitlines()[0] if rf.exists() else None
    expect("events 失败:末行 task_notification failed,summary 是 grok.reason 首行",
           ((evs[-1].get("type"), evs[-1].get("status"), evs[-1].get("summary")) if evs else None, bool(rline)),
           (("task_notification", "failed", rline), True))

    rid = estart("grok", "evt-cancel", e=dict(eenv, GROK_BIN=str(eslow)), wait=False)
    events(rid, "grok", until="task_started")
    mmrun(eroot, "cancel", rid)
    evs = events(rid, "grok")
    expect("events cancel:末行 task_notification stopped、summary 说明、没有 usage",
           ((evs[-1].get("type"), evs[-1].get("status"), evs[-1].get("summary"), "usage" in evs[-1]) if evs else None),
           ("task_notification", "stopped", "cancelled by mmrun cancel", False))

# ---------- review material: noise files left out, a large change split into parts by files ----------
with tempfile.TemporaryDirectory() as sroot, tempfile.TemporaryDirectory() as stmp:
    stmp = pathlib.Path(os.path.realpath(stmp))
    sgrok = stmp / "grok"; sgrok.write_text("#!/bin/sh\nprintf '{\"text\":\"ok\"}'\n"); sgrok.chmod(0o755)
    senv = dict(os.environ, MMRUN_HOME=sroot, MMRUN_D=str(PLUGIN / "mmrun.d"), GROK_BIN=str(sgrok))
    def srepo(name, files):
        repo = stmp / name; git("init", "-q", str(repo))
        repo.joinpath("seed.txt").write_text("s\n"); git("-C", str(repo), "add", "seed.txt"); git("-C", str(repo), "commit", "-qm", "init")
        for p, text in files.items():
            repo.joinpath(p).parent.mkdir(parents=True, exist_ok=True); repo.joinpath(p).write_text(text)
        return repo
    def sreview(repo, *extra):
        r = subprocess.run([str(MMRUN), "review", "--models", "grok", "--dir", str(repo), *extra],
                           capture_output=True, text=True, env=senv, stdin=subprocess.DEVNULL, timeout=120)
        rids = [l.split()[1] for l in r.stdout.splitlines() if l.startswith("RUN ")]
        for rid in rids: mmrun(sroot, "wait", rid, "--timeout", "60")
        return r, [pathlib.Path(sroot, rid, "prompt.md").read_text() for rid in rids], rids
    def smeta(rid, key):
        return next((l.split("=", 1)[1] for l in pathlib.Path(sroot, rid, "run.meta").read_text().splitlines() if l.startswith(key + "=")), None)
    def material(prompt):
        return prompt.split("<review_input>", 1)[-1]
    def big(tag, kb):  # about kb KB of distinct lines, each carrying tag
        return "".join(f"{tag} line {k:06d} {'x' * 80}\n" for k in range(kb * 1024 // 100))

    noise = {"package-lock.json": "LOCK-MARK\n", "conf.json": '{"JSON-MARK": 1}\n', "tests/fixtures/f.txt": "FIXTURE-MARK\n",
             "web/app.min.js": "MINIFIED-MARK\n", "src/a.py.orig": "ORIG-MARK\n", ".notes/n.md": "NOTES-MARK\n", "yarn.lock": "YARN-MARK\n"}
    repo = srepo("noise", {"src/a.py": "SRC-MARK\n", "tests/test_a.py": "TEST-MARK\n", **noise})
    r, ps, rids = sreview(repo)
    m = material(ps[0]) if ps else ""
    expect("review 噪声文件:一个 run,源码和小测试在材料里", (r.returncode, len(ps), "SRC-MARK" in m, "TEST-MARK" in m), (0, 1, True, True))
    expect("review 噪声文件:锁文件、JSON、测试数据、压缩产物、过渡文件不在材料里",
           [k for k in ("LOCK-MARK", "JSON-MARK", "FIXTURE-MARK", "MINIFIED-MARK", "ORIG-MARK", "NOTES-MARK", "YARN-MARK") if k in m], [])
    head = ps[0].split("<review_input>", 1)[0] if ps else ""
    expect("review 噪声文件:prompt 列出被略去的文件和读法",
           ("## Files left out of the material" in head, all(p in head for p in noise), "git diff HEAD --" in head), (True, True, True))
    expect("review 噪声文件:stdout 有 LEFT OUT 行,没有 PART 行",
           (any(l.startswith("LEFT OUT") for l in r.stdout.splitlines()), "PART " in r.stdout), (True, False))

    expect("review 一段:run.meta 没有 group", smeta(rids[0], "group") if rids else None, "")

    repo = srepo("attrs", {".gitattributes": "gen/** linguist-generated\nthird/** linguist-vendored\n", "src/b.py": "ATTR-SRC\n",
                           "gen/api.py": "GEN-MARK\n", "third/lib.py": "VENDORED-MARK\n"})
    git("-C", str(repo), "add", ".gitattributes"); git("-C", str(repo), "commit", "-qm", "attrs")
    r, ps, rids = sreview(repo)
    m = material(ps[0]) if ps else ""
    expect("review .gitattributes:linguist-generated / linguist-vendored 的文件列为 generated",
           ("ATTR-SRC" in m, "GEN-MARK" in m, "VENDORED-MARK" in m, "gen/api.py — generated" in ps[0] if ps else None), (True, False, False, True))

    fn = "def f(x):\n    y = 1\n" + "".join(f"    y += {k}\n" for k in range(30)) + "    return y  # FAR-MARK\n"
    for name, extra in (("ctx-small", {}), ("ctx-big", {"z/other.py": big("OTHER", 60)})):
        repo = srepo(name, {"m.py": fn, **extra})
        git("-C", str(repo), "add", "-A"); git("-C", str(repo), "commit", "-qm", "f")
        repo.joinpath("m.py").write_text(fn.replace("    y += 1\n", "    y += 100\n"))
        if extra: repo.joinpath("z/other.py").write_text(big("OTHER2", 60))
        r, ps, rids = sreview(repo)
        want = name == "ctx-small"
        expect(f"review {'小改动带整个函数' if want else '大改动只带 3 行上下文'}", "FAR-MARK" in "".join(material(p) for p in ps), want)

    repo = srepo("quoted", {"a.json": '{"Q-JSON": 1}\n', "src/中文.py": "CJK-NAME-MARK\n"})
    r, ps, rids = sreview(repo)
    m = material(ps[0]) if ps else ""
    expect("review 中文文件名:不被并进前一个文件的段,照样进材料", ("CJK-NAME-MARK" in m, "Q-JSON" in m, "src/中文.py" in m), (True, False, True))

    repo = srepo("json-only",{"conf.json": '{"ONLY-JSON": 1}\n'})
    r, ps, rids = sreview(repo)
    expect("review 只改了 JSON:照样审它", (r.returncode, len(ps), "ONLY-JSON" in material(ps[0]) if ps else None), (0, 1, True))

    repo = srepo("split", {"a/one.py": big("ONE", 100), "b/two.py": big("TWO", 100), "c/three.py": big("THREE", 100),
                           "c/tests/test_three.py": "SMALLTEST-MARK\n", "d/tests/test_huge.py": big("HUGETEST", 120),
                           "e/huge.py": big("HUGE", 450)})
    r, ps, rids = sreview(repo)
    ms = [material(p) for p in ps]
    expect("review 大改动:按文件分成 3 段,各起一个 run,各段只含自己的文件",
           (r.returncode, len(ps), [[t for t in ("ONE line", "TWO line", "THREE line") if t in x] for x in ms]),
           (0, 3, [["ONE line"], ["TWO line"], ["THREE line"]]))
    expect("review 大改动:每段材料不超过 150 KB", [len(x.encode()) <= 150_000 for x in ms], [True] * 3)
    expect("review 大改动:小测试跟着同目录的源码段", ["SMALLTEST-MARK" in x for x in ms], [False, False, True])
    expect("review 大改动:装不下的测试和单个超大文件不进材料,列为略去",
           (any("HUGETEST line" in x or "HUGE line" in x for x in ms),
            all("d/tests/test_huge.py" in p.split("<review_input>")[0] and "e/huge.py" in p.split("<review_input>")[0] for p in ps)),
           (False, True))
    expect("review 大改动:prompt 写明第几段、列出其它段的文件",
           ("part 1 of 3" in ps[0] and "b/two.py" in ps[0].split("<review_input>")[0], "part 3 of 3" in ps[2] if len(ps) > 2 else None),
           (True, True))
    expect("review 大改动:stdout 有 PART 行,源码没审时有 NOTE 行",
           ([l.split()[1] for l in r.stdout.splitlines() if l.startswith("PART ")],
            any(l.startswith("NOTE") and "e/huge.py" in l for l in r.stdout.splitlines())),
           (["1/3", "2/3", "3/3"], True))

    expect("review 大改动:各段 run.meta 的 group 按顺序列出全部段", [smeta(x, "group") for x in rids], [",".join(rids)] * 3)
    rep = mmrun(sroot, "report", rids[-1]).stdout if rids else ""
    expect("review 大改动:report 一次给出全部段", (rep.count("# Multi-model review report"), all(f"Part {k} of 3" in rep for k in (1, 2, 3)),
           all(x in rep for x in rids)), (1, True, True))

    repo = srepo("oversize", {"a/one.py": big("ONE", 20), "b/big.py": big("BIG", 200)})
    r, ps, rids = sreview(repo)
    expect("review 单个文件超过 150 KB、不到 400 KB:自成一段",
           (r.returncode, [[t for t in ("ONE line", "BIG line") if t in material(p)] for p in ps]), (0, [["ONE line"], ["BIG line"]]))

    repo = srepo("overflow", {**{f"d{k}/f.py": big(f"F{k}", 100) for k in range(6)}, **{f"j/c{k:02d}.json": "{}\n" for k in range(55)}})
    r, ps, rids = sreview(repo)
    expect("review 超过 4 段:只起 4 个 run,其余源码列进 NOTE",
           (r.returncode, len(ps), any(l.startswith("NOTE") and "d5/f.py" in l for l in r.stdout.splitlines())), (0, 4, True))
    head = ps[0].split("<review_input>", 1)[0] if ps else ""
    expect("review 略去列表过长:没审的源码排在最前,截断处写明还有几个", ("d5/f.py" in head, "more not listed" in head), (True, True))

    repo = srepo("firstfit", {**{f"d{k}/f.py": big(f"F{k}", 100) for k in range(4)}, **{f"e{k}/g.py": big(f"G{k}", 40) for k in range(3)}})
    r, ps, rids = sreview(repo)
    expect("review 4 段满后:放得进前面段的源码照样进材料,不报超限",
           (len(ps), sum(f"G{k} line" in material(p) for p in ps for k in range(3)), "NOTE" in r.stdout), (4, 3, False))

    repo = srepo("toolarge", {"a/huge.py": big("ALONE", 450), "a/tests/test_a.py": "T\n"})
    r, ps, rids = sreview(repo)
    expect("review 没有源码装得下:报错指向 NOTE 行,不说每个文件都超限",
           (r.returncode != 0, "NOTE" in r.stdout, "no source diff fits" in r.stderr), (True, True, True))

    repo = srepo("cjk-ctx", {"m.py": "def f(x):\n    y = 1\n" + "".join(f"    y += {k}\n" for k in range(30)) + "    return y  # FAR-MARK\n",
                             "z/doc.md": "中" * 15000 + "\n"})
    git("-C", str(repo), "add", "-A"); git("-C", str(repo), "commit", "-qm", "f")
    repo.joinpath("m.py").write_text(repo.joinpath("m.py").read_text().replace("    y += 1\n", "    y += 100\n"))
    repo.joinpath("z/doc.md").write_text("文" * 15000 + "\n")
    r, ps, rids = sreview(repo)
    expect("review 中文改动按字节算:超过 50 KB 不带整个函数", "FAR-MARK" in "".join(material(p) for p in ps), False)

    repo = srepo("relative", {"sub/.gitattributes": "gen.py linguist-generated\n", "sub/a.py": "REL-SRC\n"})
    git("-C", str(repo), "add", "-A"); git("-C", str(repo), "commit", "-qm", "attrs"); git("-C", str(repo), "config", "diff.relative", "true")
    repo.joinpath("sub/gen.py").write_text("REL-GEN\n"); repo.joinpath("sub/a.py").write_text("REL-SRC2\n")
    r, ps, rids = sreview(repo / "sub")
    m = material(ps[0]) if ps else ""
    expect("review diff.relative=true:路径仍从仓库根算,.gitattributes 照样生效", ("REL-SRC2" in m, "REL-GEN" in m, "sub/a.py" in m), (True, False, True))

    repo = srepo("merge", {"src.py": "base\n", "conf.json": '{"v": 0}\n'})
    git("-C", str(repo), "add", "-A"); git("-C", str(repo), "commit", "-qm", "base")
    git("-C", str(repo), "checkout", "-qb", "side")
    repo.joinpath("src.py").write_text("side\n"); repo.joinpath("conf.json").write_text('{"v": 1}\n')
    git("-C", str(repo), "commit", "-qam", "side"); git("-C", str(repo), "checkout", "-q", "-")
    repo.joinpath("src.py").write_text("main\n"); repo.joinpath("conf.json").write_text('{"v": 2}\n')
    git("-C", str(repo), "commit", "-qam", "main")
    subprocess.run(["git", "-C", str(repo), "merge", "-q", "side"], capture_output=True)
    repo.joinpath("src.py").write_text("MERGED-SRC\n"); repo.joinpath("conf.json").write_text('{"MERGED-JSON": 3}\n')
    git("-C", str(repo), "commit", "-qam", "merge")
    r, ps, rids = sreview(repo, "--commit", "HEAD")
    m = material(ps[0]) if ps else ""
    expect("review 合并提交 (diff --cc):按文件切,JSON 照样略去", ("MERGED-SRC" in m, "MERGED-JSON" in m), (True, False))

    prun = pathlib.Path(sroot, "pr-run"); prun.mkdir()
    repo = srepo("patchscope", {})
    prun.joinpath("run.meta").write_text(f"runid=pr-run\nmode=run\nmodels=codex\nworkdir={repo}\nbase_sha=\n")
    prun.joinpath("codex.patch").write_text("diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -0,0 +1 @@\n+P\n"
                                           "diff --git a/c.json b/c.json\n--- a/c.json\n+++ b/c.json\n@@ -0,0 +1 @@\n+{}\n")
    r, ps, rids = sreview(repo, "--patch", "pr-run")
    head = ps[0].split("<review_input>", 1)[0] if ps else ""
    expect("review --patch 略去文件:写明仓库里的文件是打补丁前的版本", "before the patch" in head, True)
    repo = srepo("stagedscope", {"a.py": "S\n", "c.json": "{}\n"})
    git("-C", str(repo), "add", "-A")
    r, ps, rids = sreview(repo, "--staged")
    head = ps[0].split("<review_input>", 1)[0] if ps else ""
    expect("review --staged 略去文件:写明没有 git 时工作区文件可能不是被审的版本", "may differ" in head, True)

    repo = srepo("full", {"m/a.py": "FULL-SRC\n", "m/fixtures/x.txt": "FULL-FIXTURE\n", "m/conf.json": '{"FULL-JSON": 1}\n'})
    git("-C", str(repo), "add", "-A"); git("-C", str(repo), "commit", "-qm", "m")
    r, ps, rids = sreview(repo, "--paths", "m", "--full")
    m = material(ps[0]) if ps else ""
    expect("review --full:源码在材料里,测试数据和 JSON 不在", (r.returncode, "FULL-SRC" in m, "FULL-FIXTURE" in m, "FULL-JSON" in m),
           (0, True, False, False))

def vfinding(severity, claim, pre=False):
    return {"severity": severity, "file": "a.py", "line": 1, "quote": "q", "claim": claim, "failure_scenario": "f",
            "basis": "traced", "suggestion": None, "issue_identity": "some-thing", "pre_existing": pre}

def vreview(*findings):
    return {"verdict": "request_changes", "summary": "s", "not_checked": [], "not_expanded": 0, "findings": list(findings)}

with tempfile.TemporaryDirectory() as vroot:
    # render: grok's findings checked by codex, verify.json written by hand
    rd = make_run(vroot, "vr", json.dumps(vreview(vfinding("major", "REFUTED-CLAIM"), vfinding("minor", "UPGRADED-CLAIM"),
                                                  vfinding("major", "DOWNGRADED-CLAIM"), vfinding("major", "UNVERIFIED-CLAIM"),
                                                  vfinding("major", "CONFIRMED-LOW-CLAIM"))))
    rd.joinpath("verify.json").write_text(json.dumps([
        {"model": "grok", "index": 0, "verifier": "codex", "verdict": "refuted", "severity": "major", "evidence": "a.py:1 GUARD-EVIDENCE"},
        {"model": "grok", "index": 1, "verifier": "codex", "verdict": "confirmed", "severity": "major", "evidence": "e"},
        {"model": "grok", "index": 2, "verifier": "codex", "verdict": "plausible", "severity": "minor", "evidence": "e"},
        {"model": "grok", "index": 4, "verifier": "codex", "verdict": "confirmed", "severity": "minor", "evidence": "e"}]))
    def vline(text, claim):
        return next((l for l in text.splitlines() if claim in l), "")
    top = mmrun(vroot, "result", "grok", "vr", "--top").stdout
    expect("verify render --top:refuted 不出现,写出条数",
           ("REFUTED-CLAIM" in top, "Refuted by the verifier (not shown): 1" in top), (False, True))
    expect("verify render --top:原 minor、核对者 major 的进 MAJOR,带核对标签",
           ("UPGRADED-CLAIM" in top.split("## MAJOR", 1)[-1], "[confirmed by codex] [codex: major]" in vline(top, "UPGRADED-CLAIM")), (True, True))
    expect("verify render --top:原 major、核对者 minor 的不出现,写出条数",
           ("DOWNGRADED-CLAIM" in top, "Downgraded by the verifier (not shown): 1" in top), (False, True))
    expect("verify render --top:confirmed 取原严重度与核对者严重度中较高的",
           ("CONFIRMED-LOW-CLAIM" in top.split("## MAJOR", 1)[-1], "[confirmed by codex] [codex: minor]" in vline(top, "CONFIRMED-LOW-CLAIM")),
           (True, True))
    expect("verify render --top:没验证结果的照旧按原严重度,不带标签",
           ("UNVERIFIED-CLAIM" in top, "codex" in vline(top, "UNVERIFIED-CLAIM")), (True, False))
    full = mmrun(vroot, "result", "grok", "vr").stdout
    fmajor, fminor = full.split("## MAJOR", 1)[-1].split("## MINOR", 1)
    expect("verify render 不带 --top:按原严重度分节,refuted 也列出并写原因",
           (all(c in fmajor for c in ("REFUTED-CLAIM", "DOWNGRADED-CLAIM", "UNVERIFIED-CLAIM")), "UPGRADED-CLAIM" in fminor,
            "[refuted by codex]" in vline(full, "REFUTED-CLAIM"), "[plausible per codex] [codex: minor]" in vline(full, "DOWNGRADED-CLAIM"),
            "Refuted because: a.py:1 GUARD-EVIDENCE" in fmajor), (True, True, True, True, True))
    one = mmrun(vroot, "result", "grok", "vr", "--top", "--oneline").stdout
    expect("verify render --oneline:行上带核对标签", "[confirmed by codex] [codex: major]" in vline(one, "UPGRADED-CLAIM"), True)

    # result verify: prints verify.out; without it, status and reason
    rd.joinpath("verify.out").write_text("verification: VERIFY-OUT-MARK\n")
    r = mmrun(vroot, "result", "verify", "vr", "--top")
    expect("result verify:打印 verify.out", (r.returncode, r.stdout), (0, "verification: VERIFY-OUT-MARK\n"))
    rd2 = make_run(vroot, "vs", json.dumps(vreview()))
    rd2.joinpath("verify.status").write_text("SKIP\n"); rd2.joinpath("verify.reason").write_text("fewer than 2 models finished\n")
    r = mmrun(vroot, "result", "verify", "vs")
    expect("result verify:没有 verify.out 时打印状态和原因", (r.returncode, "SKIP" in r.stdout, "fewer than 2 models finished" in r.stdout), (0, True, True))
    rd2.joinpath("verify.status").write_text("RUNNING\n")
    r = mmrun(vroot, "verify", "vs")
    expect("mmrun verify:verify RUNNING 时拒绝", (r.returncode != 0, rd2.joinpath("verify.status").read_text()), (True, "RUNNING\n"))

with tempfile.TemporaryDirectory() as vroot, tempfile.TemporaryDirectory() as vtmp:  # 假二进制、仓库不能放在 MMRUN_HOME 下
    vtmp = pathlib.Path(os.path.realpath(vtmp)); vhome = vtmp / "home"; vhome.mkdir()
    vrepo = vtmp / "repo"; git("init", "-q", str(vrepo))
    vrepo.joinpath("a.py").write_text("a\n"); git("-C", str(vrepo), "add", "a.py"); git("-C", str(vrepo), "commit", "-qm", "init")
    vrepo.joinpath("a.py").write_text("changed\n")
    data = {"grok-review": {"structuredOutput": vreview(vfinding("major", "G0-CLAIM"), vfinding("minor", "G1-CLAIM"), vfinding("major", "G2-PRE", pre=True))},
            "grok-verdicts": {"structuredOutput": {"summary": "s", "verdicts": [
                {"id": "F1", "verdict": "confirmed", "severity": "major", "evidence": "e"}]}},
            "codex-review": vreview(vfinding("critical", "C0-CLAIM")),
            "codex-verdicts": {"summary": "s", "verdicts": [{"id": "F1", "verdict": "refuted", "severity": "minor", "evidence": "e"},
                                                            {"id": "F2", "verdict": "plausible", "severity": "minor", "evidence": "e"}]}}
    for k, v in data.items(): vtmp.joinpath(k + ".json").write_text(json.dumps(v) + "\n")
    vgrok = vtmp / "grok"
    vgrok.write_text('#!/bin/sh\npf=""; prev=""\nfor a in "$@"; do [ "$prev" = --prompt-file ] && pf="$a"; prev="$a"; done\n'
                     f'if grep -qx F1 "$pf"; then [ -n "$SLOWV" ] && sleep 30; cat "{vtmp}/grok-verdicts.json"; else cat "{vtmp}/grok-review.json"; fi\n')
    vcodex = vtmp / "codex"
    vcodex.write_text('#!/bin/sh\n' + MCP_NONE + 'out=""; prev=""\nfor a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done\n'
                      f'if cat | grep -qx F1; then [ -n "$SLOWV" ] && sleep 30; cat "{vtmp}/codex-verdicts.json" > "$out"; else cat "{vtmp}/codex-review.json" > "$out"; fi\n')
    for f in (vgrok, vcodex): f.chmod(0o755)
    venv = dict(os.environ, HOME=str(vhome), MMRUN_HOME=vroot, MMRUN_D=str(PLUGIN / "mmrun.d"), GROK_BIN=str(vgrok), CODEX_BIN=str(vcodex),
                MMRUN_SESSION="vsess")
    def vrun(*args):
        r = subprocess.run([str(MMRUN), *args], capture_output=True, text=True, env=venv, stdin=subprocess.DEVNULL, timeout=120)
        rid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        if rid != "missing": mmrun(vroot, "wait", rid, "--timeout", "60")
        return r, rid
    def vread(rid, name):
        p = pathlib.Path(vroot, rid, name)
        return p.read_text() if p.exists() else None
    def vmeta(rid, key):
        return next((l.split("=", 1)[1] for l in (vread(rid, "run.meta") or "").splitlines() if l.startswith(key + "=")), "")
    def vtuples(rid):
        return sorted((e["model"], e["index"], e["verifier"], e["verdict"]) for e in json.loads(vread(rid, "verify.json") or "[]"))
    WANT = [("codex", 0, "grok", "confirmed"), ("grok", 0, "codex", "refuted"), ("grok", 1, "codex", "plausible")]

    r, rid = vrun("review", "--models", "codex,grok", "--dir", str(vrepo))
    expect("verify 两家:wait 返回时 verify.status 为 DONE", (r.returncode, vread(rid, "verify.status")), (0, "DONE\n"))
    expect("verify 两家:verify.json 的 (model, index, verifier) 对", vtuples(rid), WANT)
    kids = [k for k in vmeta(rid, "verify_runs").split(",") if k]
    prompts = {vmeta(k, "models"): vread(k, "prompt.md") or "" for k in kids}
    claims = {m: p.split("## Claims to check", 1)[-1] for m, p in prompts.items()}
    expect("verify 两家:两个子 run,各一家核对", (len(kids), sorted(prompts)), (2, ["codex", "grok"]))
    expect("verify 两家:grok 只核对 codex 的声明,codex 只核对 grok 的",
           ("C0-CLAIM" in claims.get("grok", ""), "G0-CLAIM" in claims.get("grok", ""),
            all(c in claims.get("codex", "") for c in ("G0-CLAIM", "G1-CLAIM")), "C0-CLAIM" in claims.get("codex", "")), (True, False, True, False))
    expect("verify 两家:pre_existing 的不进核对 prompt", any("G2-PRE" in p for p in prompts.values()), False)
    expect("verify 两家:声明里没有原严重度和报告模型",
           [w for c in claims.values() for w in ("severity", "critical", "major", "minor", "codex", "grok") if w in c], [])
    expect("verify 两家:prompt 带 review_input 和审查范围",
           [("<review_input>" in p, "## Review scope" in p) for p in prompts.values()], [(True, True)] * 2)
    expect("verify 两家:子 run 不成为本会话的 latest", (pathlib.Path(vroot, ".latest-vsess").read_text().strip()), rid)
    r = mmrun(vroot, "result", "verify", rid)
    expect("verify 两家:result verify 打印汇总",
           r.stdout, "verification: 3 findings sent to the other model; 1 confirmed, 1 plausible, 1 refuted, 0 not verified\n")
    r = subprocess.run([str(MMRUN), "verify", rid], capture_output=True, text=True, env=venv, timeout=60)
    mmrun(vroot, "wait", rid, "--timeout", "60")
    again = [k for k in vmeta(rid, "verify_runs").split(",") if k]
    expect("mmrun verify:已结束的 run 重做验证",
           (r.returncode, r.stdout.splitlines()[0] if r.stdout else "", vread(rid, "verify.status"), vtuples(rid), len(again), set(again) & set(kids)),
           (0, f"VERIFY {rid}", "DONE\n", WANT, 2, set()))

    r, rid = vrun("review", "--models", "grok", "--dir", str(vrepo))
    expect("verify 一家:SKIP,原因写明", (vread(rid, "verify.status"), vread(rid, "verify.reason")), ("SKIP\n", "fewer than 2 models finished\n"))
    r, rid = vrun("review", "--models", "codex,grok", "--dir", str(vrepo), "--no-verify")
    expect("verify --no-verify:没有 verify.status", (rid != "missing", vread(rid, "verify.status")), (True, None))

    # the check runs render their own verdicts: .out is not the raw JSON, and result reads it
    expect("verify 子 run:.out 是渲染过的,result 能读",
           [(vread(k, vmeta(k, "models") + ".out") or "").startswith("verdicts:") and mmrun(vroot, "result", vmeta(k, "models"), k).returncode == 0
            for k in kids], [True, True])
    r, rid = vrun("review", "--models", "codex,grok", "--dir", str(vrepo), "--codex-model", "CX-M", "--grok-model", "GK-M")
    kids2 = [k for k in vmeta(rid, "verify_runs").split(",") if k]
    expect("verify 子 run:沿用 review 的 --codex-model/--grok-model",
           sorted((vmeta(k, "models"), vmeta(k, "model_" + vmeta(k, "models"))) for k in kids2), [("codex", "CX-M"), ("grok", "GK-M")])

    # cancel during verification: the check runs stop too
    r = subprocess.run([str(MMRUN), "review", "--models", "codex,grok", "--dir", str(vrepo)], capture_output=True, text=True,
                       env=dict(venv, SLOWV="1"), stdin=subprocess.DEVNULL, timeout=60)
    rid = r.stdout.split("RUN ", 1)[1].split()[0]
    deadline = time.time() + 30
    while time.time() < deadline:
        kids3 = [k for k in vmeta(rid, "verify_runs").split(",") if k]
        if len(kids3) == 2 and all(vread(k, vmeta(k, "models") + ".pid") for k in kids3): break
        time.sleep(0.2)
    kpids = [int(vread(k, vmeta(k, "models") + ".pid")) for k in kids3]
    r = mmrun(vroot, "cancel", rid)
    def alive(pid):
        try: os.kill(pid, 0); return True
        except OSError: return False
    expect("cancel:verify 跑着时连核对子 run 一起停",
           (r.returncode, vread(rid, "verify.status"), [vread(k, vmeta(k, "models") + ".status") for k in kids3], [alive(p) for p in kpids]),
           (0, "CANCELLED\n", ["CANCELLED\n"] * 2, [False, False]))

    # ask --from waits only for the review models, not for verification
    ad = pathlib.Path(vroot, "askv"); ad.mkdir()
    ad.joinpath("run.meta").write_text(f"runid=askv\nmode=review\nmodels=grok\nworkdir={vrepo}\n")
    ad.joinpath("grok.status").write_text("DONE\n"); ad.joinpath("grok.sid").write_text("sid-askv\n")
    sleeper = subprocess.Popen(["sleep", "30"])
    ad.joinpath("verify.status").write_text("RUNNING\n"); ad.joinpath("verify.pid").write_text(f"{sleeper.pid}\n")
    ad.joinpath("verify.started").write_text(f"{int(time.time())}\n")
    r = mmrun(vroot, "ask", "--from", "askv", "--models", "grok", "--with", "nosuch:grok")
    sleeper.kill()
    expect("ask --from:verify 跑着时不拒绝", ("unknown run nosuch" in r.stderr, "still running" in r.stderr), (True, False))

# ---------- deepseek(dsh headless):事件流取结果与用量、续聊、schema 附在 prompt 末尾、额度、围栏 ----------
with tempfile.TemporaryDirectory() as dtmp:  # 假二进制、记录、被审仓库都不能放在 MMRUN_HOME 下:围栏禁读该目录
    dtmp = pathlib.Path(os.path.realpath(dtmp))
    drepo = dtmp / "repo"; git("init", "-q", str(drepo))
    drepo.joinpath("a.txt").write_text("a\n"); git("-C", str(drepo), "add", "a.txt"); git("-C", str(drepo), "commit", "-qm", "init")
    drepo.joinpath("a.txt").write_text("changed\n")
    droot, dfake, drec, din = str(test_runs), dtmp / "dsh", dtmp / "dsh.rec", dtmp / "dsh.stdin"
    def dstep(i, o):
        return json.dumps({"type": "status", "phase": "step_end",
                           "usage": {"inputTokens": i, "outputTokens": o, "cacheReadTokens": 1, "cacheWriteTokens": 0, "totalTokens": i + o}})
    def devents(final, sid="session-d1"):
        return "\n".join([json.dumps({"type": "session", "sessionId": sid, "cwd": "/x"}), dstep(10, 3),
                          json.dumps({"type": "text", "text": "partial"}), dstep(20, 4),
                          json.dumps({"type": "final", "text": final})]) + "\n"
    def fake_dsh(tail):  # 每次调用记 argv、DSH_PERMISSION_MODE、MMRUN_DSH_MODEL,stdin 存进 din
        if drec.exists(): drec.unlink()
        dfake.write_text("#!/bin/sh\n{ for a in \"$@\"; do printf '%s\\n' \"$a\"; done\n"
                         f"  echo \"PERM=$DSH_PERMISSION_MODE\"; echo \"MODEL=$MMRUN_DSH_MODEL\"; echo ---; }} >> '{drec}'\n"
                         f"cat > '{din}'\n" + tail); dfake.chmod(0o755)
    def dcalls():
        return [c.splitlines() for c in drec.read_text().split("---\n")[:-1]] if drec.exists() else []
    def dfile(name, text):
        p = dtmp / name; p.write_text(text); return p
    def dout(name, text):  # like node in dsh, macOS cat fails when its stdout is a file in the fence's read-denied mmruns
        return f"cat '{dfile(name, text)}'\n"
    denv = dict(os.environ, HOME=str(TEST_HOME), MMRUN_HOME=droot, MMRUN_D=str(PLUGIN / "mmrun.d"), DSH_BIN=str(dfake))
    def dcmd(*args, prompt="q\n"):
        r = subprocess.run([str(MMRUN), *args], input=prompt, capture_output=True, text=True, env=denv, timeout=60,
                           **({} if prompt is not None else {"stdin": subprocess.DEVNULL}))
        rid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        if rid != "missing": mmrun(droot, "wait", rid, "--timeout", "60")
        return r, rid
    def dread(rid, name):
        p = pathlib.Path(droot, rid, name)
        return p.read_text() if p.exists() else None
    DPATCH = str(PLUGIN / "mmrun.d/dsh-mm.patch.yml")

    # e. 额度:turn_end 的错误码 QUOTA / stderr 的 ACCOUNT_QUOTA 算撞额度不重试;其它失败重试一次
    qend = json.dumps({"type": "turn_end", "reason": {"kind": "error", "error": {"message": "quota exhausted", "code": "QUOTA"}}})
    fake_dsh(dout("q.ndjson", json.dumps({"type": "session", "sessionId": "session-q"}) + "\n" + qend + "\n")
             + "echo '{\"type\":\"final\",\"text\":\"\"}'\necho 'dsh: QUOTA: quota exhausted' >&2\nexit 1\n")
    _, rid = dcmd("start", "--models", "deepseek", "--dir", str(drepo))
    expect("deepseek 额度 QUOTA:FAIL:quota、只调用一次、reason",
           (dread(rid, "deepseek.status"), len(dcalls()), (dread(rid, "deepseek.reason") or "").startswith("deepseek hit the quota mid-run:")),
           ("FAIL:quota\n", 1, True))
    fake_dsh("echo 'dsh: ACCOUNT_QUOTA: account balance is empty' >&2\nexit 1\n")
    _, rid = dcmd("start", "--models", "deepseek", "--dir", str(drepo))
    expect("deepseek 额度 ACCOUNT_QUOTA(只在 stderr):FAIL:quota、只调用一次", (dread(rid, "deepseek.status"), len(dcalls())), ("FAIL:quota\n", 1))
    fake_dsh("echo 'dsh: NETWORK: connection reset' >&2\nexit 1\n")
    _, rid = dcmd("start", "--models", "deepseek", "--dir", str(drepo))
    expect("deepseek 其它失败:重试一次、FAIL:1", (dread(rid, "deepseek.status"), len(dcalls())), ("FAIL:1\n", 2))

    # f. 围栏:别家读不到 ~/.dsh,deepseek 读不到别家的状态目录;codex 各层也 deny ~/.dsh
    dsdirs = {n: TEST_HOME / n for n in (".grok", ".dsh")}
    for d in dsdirs.values(): d.mkdir(exist_ok=True); d.joinpath("x").write_text("s\n")
    def ds_fence(state, script):
        return subprocess.run([str(MMRUN), "__fence", "/nonexistent", str(state), "/nonexistent", "/nonexistent", "/bin/sh", "-c", script],
                              capture_output=True, text=True, env=denv, cwd=dtmp, timeout=60)
    expect("fence STATE=~/.grok:读 ~/.dsh 被拒", ds_fence(dsdirs[".grok"], f"cat {dsdirs['.dsh']}/x").returncode != 0, True)
    expect("fence STATE=~/.dsh:读 ~/.grok 被拒", ds_fence(dsdirs[".dsh"], f"cat {dsdirs['.grok']}/x").returncode != 0, True)
    expect("fence STATE=~/.dsh:读写自己的状态目录成功",
           ds_fence(dsdirs[".dsh"], f"cat {dsdirs['.dsh']}/x && echo w >> {dsdirs['.dsh']}/x").returncode, 0)
    dch = dtmp / "codex-home"
    subprocess.run([str(MMRUN), "__room_profile", "dsprobe", str(dtmp), "P1"], capture_output=True, env=dict(denv, CODEX_HOME=str(dch)), timeout=60)
    subprocess.run([str(MMRUN), "__mmwt_profile", "dsprobe", str(dtmp)], capture_output=True, env=dict(denv, CODEX_HOME=str(dch)), timeout=60)
    ddeny = f'"{TEST_HOME}/.dsh" = "deny"'
    expect("mm 模板、mmwt 层、room 层:都 deny ~/.dsh",
           [ddeny in ((dch / n).read_text().splitlines() if (dch / n).exists() else [])
            for n in ("mm.config.toml", "mmwt-dsprobe.config.toml", "mmroom-dsprobe-P1.config.toml")], [True, True, True])
    # review 形态:写不进被审仓库、读不到 mmruns
    dprobe = pathlib.Path(tempfile.mkdtemp(prefix=".dsprobe-", dir=test_runs)); dprobe.joinpath("x").write_text("p\n")
    dfr = dtmp / "fence.rec"
    try:
        fake_dsh(f"if cat '{dprobe}/x' >/dev/null 2>&1; then echo READ >> '{dfr}'; else echo NOREAD >> '{dfr}'; fi\n"
                 f"echo pwned 2>/dev/null > '{drepo}/a.txt'; touch '{drepo}/new' 2>/dev/null\n"
                 + dout("fr.ndjson", devents(review("s", "major"))))
        _, rid = dcmd("review", "--models", "deepseek", "--dir", str(drepo), "--no-verify", prompt=None)
        expect("deepseek review 形态:读不到 mmruns、写不进被审仓库",
               (dfr.read_text() if dfr.exists() else None, drepo.joinpath("a.txt").read_text(), drepo.joinpath("new").exists()),
               ("NOREAD\n", "changed\n", False))
    finally:
        shutil.rmtree(dprobe, ignore_errors=True)

    # a. start:结果是 final 文本,sid 是 session 事件的 id,meta 的 usage 是各 step_end 之和
    fake_dsh(dout("a.ndjson", devents("hello from dsh")))
    r, arid = dcmd("start", "--models", "deepseek", "--dir", str(drepo))
    expect("deepseek start:DONE、result 是 final 文本、sid 取 session 事件",
           (dread(arid, "deepseek.status"), mmrun(droot, "result", "deepseek", arid).stdout.strip(), dread(arid, "deepseek.sid")),
           ("DONE\n", "hello from dsh", "session-d1\n"))
    expect("deepseek start:meta 的 usage 是两个 step_end 之和,input_tokens 含缓存读",
           "usage=" + json.dumps({"input_tokens": 32, "cached_input_tokens": 2, "output_tokens": 7}, separators=(",", ":")) in (dread(arid, "deepseek.meta") or "").splitlines(), True)
    # b. argv、权限模式、模型名
    expect("deepseek argv:headless --patch <mmrun.d>/dsh-mm.patch.yml --json -、danger-full-access、默认模型名为空",
           (dcalls() or [None])[0], ["headless", "--patch", DPATCH, "--json", "-", "PERM=danger-full-access", "MODEL="])
    expect("deepseek 无 schema:stdin 就是 prompt", din.read_text() if din.exists() else None, "q\n")
    fake_dsh(dout("a.ndjson", devents("hello from dsh")))
    dcmd("start", "--models", "deepseek", "--dir", str(drepo), "--deepseek-model", "deepseek-v4-pro")
    expect("deepseek --deepseek-model:MMRUN_DSH_MODEL 为它", ((dcalls() or [[]])[0])[-1:], ["MODEL=deepseek-v4-pro"])
    # d. ask --from:续聊带 --session-id
    fake_dsh(dout("d.ndjson", devents("again")))
    r, drid = dcmd("ask", "--from", arid, prompt="second\n")
    expect("deepseek ask --from:argv 含 --session-id <sid>、DONE",
           ((dcalls() or [None])[0], dread(drid, "deepseek.status")),
           (["headless", "--patch", DPATCH, "--json", "--session-id", "session-d1", "-", "PERM=danger-full-access", "MODEL="], "DONE\n"))
    # c. review 带 schema:schema 附在 stdin 末尾,合 schema 的回答能渲染
    fake_dsh(dout("c.ndjson", devents(review("ds-review", "major"))))
    r, crid = dcmd("review", "--models", "deepseek", "--dir", str(drepo), "--no-verify", prompt=None)
    dstdin = din.read_text() if din.exists() else ""
    expect("deepseek review:stdin 末尾是 schema 指令和 schema 内容",
           ("\n\nReply with only one JSON object that conforms to this JSON Schema, and no other text:\n" in dstdin,
            dstdin.endswith(SCHEMA.read_text())), (True, True))
    out = mmrun(droot, "result", "deepseek", crid).stdout
    expect("deepseek review:result 渲染出 finding", (dread(crid, "deepseek.status"), "ds-review" in out, "## MAJOR" in out), ("DONE\n", True, True))
    # run 形态:能写 worktree,patch 收进来
    drun = dtmp / "runrepo" / "repo"; git("init", "-q", str(drun))
    drun.joinpath("a.txt").write_text("a\n"); git("-C", str(drun), "add", "a.txt"); git("-C", str(drun), "commit", "-qm", "init")
    fake_dsh("echo b > a.txt\n" + dout("r.ndjson", devents("done")))
    r = subprocess.run([str(MMRUN), "run", "--model", "deepseek", "--task", str(dfile("task.md", "t\n")), "--dir", str(drun),
                        "--model-name", "deepseek-v4-pro"], capture_output=True, text=True, env=denv, timeout=60)
    rrid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
    if rrid != "missing": mmrun(droot, "wait", rrid, "--timeout", "60")
    expect("deepseek run:DONE、patch 含 a.txt、--model-name 传成 MMRUN_DSH_MODEL",
           (dread(rrid, "deepseek.status"), "a.txt" in (dread(rrid, "deepseek.patch") or ""), ((dcalls() or [[]])[0])[-1:]),
           ("DONE\n", True, ["MODEL=deepseek-v4-pro"]))
    if rrid != "missing": mmrun(droot, "discard", rrid)
    usage = subprocess.run([str(MMRUN)], capture_output=True, text=True, env=denv).stdout
    expect("usage 列出 --deepseek-model 与 ~/.dsh", ("--deepseek-model NAME" in usage, "~/.dsh" in usage), (True, True))

print(f"\n{len(failures)} failed" if failures else "\nall passed")
raise SystemExit(1 if failures else 0)
