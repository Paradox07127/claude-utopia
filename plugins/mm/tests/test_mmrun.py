#!/usr/bin/env python3
"""mmrun 结论抽取的测试:多轮拼接/中途截断的 grok 输出能取到终稿,取不到时报错而不是静默输出空。"""
import json, os, pathlib, subprocess, tempfile, threading, time

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

def expect(name, got, want):
    print(("ok  " if got == want else "FAIL"), name, "" if got == want else f"(得到 {got!r},应为 {want!r})")
    if got != want: failures.append(name)

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

    # 无 schema 的自由文本 run:--top 没匹配到小节时报错,不静默
    rd = make_run(root, "freeform", "没有任何严重度标题的纯文本\n", schema=None)
    r = mmrun(root, "result", "grok", "freeform", "--top")
    expect("自由文本 --top 无内容时非零退出", (r.returncode != 0, str(rd / "grok.out") in r.stderr), (True, True))

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
    expect("render review:有 issue_identity 时 [quote …] 后跟 {标签},没有不加",
           [t.rsplit("]", 1)[-1] for t in titles], [" {missing-lock-on-write}", ""])

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
            rd.joinpath("run.meta").write_text(f"runid={rid}\nmode={mode}\nmodels=grok\nworkdir={repo}\nbase_sha={sha}\n")
            rd.joinpath("grok.patch").write_text("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+patch-marker-line\n")
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
        PRE = "Do not report problems that existed before this change."
        ptext = review_prompt()
        expect("review 提示词:review_input 包装、拿不准、无加粗、含改动前那句",
               ("<review_input>\n" in ptext, "\n</review_input>" in ptext, "If unsure" in ptext, "**" in ptext, PRE in ptext),
               (True, True, True, False, True))
        IID = "issue_identity: 2-4 lowercase English words joined by hyphens that name the mechanism of the problem (e.g. missing-lock-on-write), without file names; it is used only to match the same problem across models."
        expect("review 提示词:含 issue_identity 说明", IID in ptext, True)
        ptext = review_prompt("--full", "--paths", "a.txt")
        expect("review --full 提示词:不含改动前那句", (bool(ptext), PRE in ptext, "**" in ptext), (True, False, False))
        ptext = review_prompt("--exhaustive")
        expect("review --exhaustive 提示词:同一根因只报一次、无加粗", ("Report each root cause once" in ptext, "**" in ptext), (True, False))
        expect("review --exhaustive 提示词:含 issue_identity 说明", IID in ptext, True)

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
                ".claude/settings.json" in r.stderr, "--allow-sensitive" in r.stderr), (True, "{}\n", True, True))
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

        r = subprocess.run([str(MMRUN), "review", "--patch", "rp-run", "--paths", "a.txt", "--models", "grok"],
                           capture_output=True, text=True, env=renv, timeout=60)
        expect("review --patch 与 --paths 互斥", r.returncode != 0, True)

        repo = apply_case("ap-head",{"x.txt": "x\n"}, {"x.txt": "y\n"})
        repo.joinpath("z.txt").write_text("z\n"); git("-C", str(repo), "add", "z.txt"); git("-C", str(repo), "commit", "-qm", "z")
        r = mmrun(root, "apply", "ap-head", "--keep")
        expect("apply HEAD 离开 base:成功并提示", (r.returncode, repo.joinpath("x.txt").read_text(), "HEAD has moved from" in r.stderr),
               (0, "y\n", True))

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
        expect("check PASS:status 含 check:PASS", "check:PASS" in mmrun(root, "status", "ck").stdout, True)
        expect("check 后 check worktree 已移除", "-check" in git("-C", str(repo), "worktree", "list"), False)
        r = mmrun(root, "check", "ck", "--", "sh", "-c", "exit 3")
        cktext = ck.read_text() if ck.exists() else ""
        expect("check FAIL:退出 3、首行 exit=3", (r.returncode, cktext.split("\n")[0]), (3, "exit=3"))
        expect("check FAIL:status 含 check:FAIL", "check:FAIL" in mmrun(root, "status", "ck").stdout, True)

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

        # status:RUNNING 时显示 raw 多久没更新
        rd = pathlib.Path(root, "quiet"); rd.mkdir()
        rd.joinpath("run.meta").write_text("runid=quiet\nmode=review\nmodels=grok\n")
        rd.joinpath("grok.status").write_text("RUNNING\n"); rd.joinpath("grok.pid").write_text(f"{os.getpid()}\n")
        raw = rd / "grok.raw"; raw.write_text(""); t = time.time() - 100; os.utime(raw, (t, t))
        expect("status RUNNING 显示静默时长", " quiet:" in mmrun(root, "status", "quiet").stdout, True)

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
        aenv = dict(env)
        for m, body in bodies.items():
            fake = askd / f"fake-{m}"; fake.write_text("#!/bin/sh\n" + (record + body).format(rec=recs[m], prm=prms[m])); fake.chmod(0o755)
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
        def mkparent(rid, outs):
            rd = pathlib.Path(root, rid); rd.mkdir()
            rd.joinpath("run.meta").write_text(f"runid={rid}\nmode=review\nmodels=codex,grok,agy\nworkdir={work}\n"
                                               f"schema={SCHEMA}\nparent=\nroot=\n")
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
        expect("ask --cross:子 run 用 review-ask schema、cross=1",
               (f"\nschema={ASK_SCHEMA}\n" in run_meta(xrid), "\ncross=1\n" in run_meta(xrid)), (True, True))

        r, wrid = ask_cmd("ask", "--from", "x-par", "--with", "x-par:grok")
        expect("ask --with P:grok:每个模型只收到 grok 的论点",
               (r.returncode, [tuple(f"CLAIM-{i}" in p for i in (1, 2, 3)) for p in last_prompts()]),
               (0, [(False, True, False)] * 3))
        expect("ask --with:run.meta 记 with/cross", ("\nwith=x-par:grok\n" in run_meta(wrid), "\ncross=0\n" in run_meta(wrid)),
               (True, True))

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
        xfake.write_text(f'#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a" >> \'{xrec}\'; done\n'
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
        expect("reviewed 工作树:一个提交,其 tree 含未提交改动", (wtype, "appended_line = 2" in wa), ("commit", True))
        expect("reviewed --full:prompt", reviewed(qreview(repo, "--full", "--paths", "a.py")), "prompt")

        # quote 机械校验:按记录的版本核对,标记写 .quotes 并出现在 result 里
        expect("quote 校验:.quotes 内容", read(pathlib.Path(root, wrid, "grok.quotes")),
               "0\tok\n1\tmoved:15\n2\tother_file:b.py\n3\tMISSING\n4\tunchecked\n5\tok\n")
        out = mmrun(root, "result", "grok", wrid).stdout
        expect("quote 校验:result 标题带 [quote …]",
               [l.rsplit("[quote ", 1)[-1].rstrip("]") if "[quote " in l else None for l in out.splitlines() if l.startswith("- **")],
               ["ok", "moved:15", "other_file:b.py", "MISSING", "unchecked", "ok"])
        expect("quote 校验:标记跟在 [basis] 之后", "— c [traced] [quote ok]" in out, True)

        # 审查期间工作树被改(假 codex 在返回前改文件):仍按记录的对象判 ok
        mrepo = pathlib.Path(tmp, "qm", "repo"); git("init", "-q", str(mrepo))
        mrepo.joinpath("a.py").write_text("\n".join(A) + "\n"); git("-C", str(mrepo), "add", "-A"); git("-C", str(mrepo), "commit", "-qm", "i")
        mrepo.joinpath("a.py").write_text("\n".join(A[:2] + ["changed_line_content = 42"] + A[3:]) + "\n")
        mo = json.loads(review("s")); mo["findings"] = [qfinding("a.py", 3, "changed_line_content = 42")]
        mpay = pathlib.Path(tmp, "qm", "out.json"); mpay.write_text(json.dumps(mo))
        mfake = pathlib.Path(tmp, "qm", "codex")
        mfake.write_text('#!/bin/sh\nout=""; prev=""\nfor a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done\n'
                         f"cat > /dev/null\nprintf 'rewritten\\n' > '{mrepo}/a.py'\ncat '{mpay}' > \"$out\"\n"
                         "echo '{\"type\":\"thread.started\",\"thread_id\":\"t-q\"}'\n")
        mfake.chmod(0o755)
        mrid = qreview(mrepo, e=dict(env, CODEX_BIN=str(mfake)), models="codex")
        expect("quote 校验:审查期间文件被改仍按记录版本判 ok",
               (read(mrepo / "a.py"), read(pathlib.Path(root, mrid, "codex.quotes"))), ("rewritten\n", "0\tok\n"))

        # --full:按 prompt.md 的 ===== 路径 ===== 分段核对
        set_payload(qfinding("a.py", 12, A[11]))
        frid = qreview(repo, "--full", "--paths", "a.py")
        expect("quote 校验 --full:按 prompt 分段判 ok", read(pathlib.Path(root, frid, "grok.quotes")), "0\tok\n")
        # 从子目录发起 --full:分段名是仓库根相对路径,与模型报的 file 一致
        X = [f"sub_value_{i:02d} = compute_sub({i})" for i in range(1, 9)]
        repo.joinpath("sub").mkdir(); repo.joinpath("sub", "x.py").write_text("\n".join(X) + "\n")
        set_payload(qfinding("sub/x.py", 4, X[3]))
        srid = qreview(repo / "sub", "--full", "--paths", "x.py")
        expect("--full 从子目录发起:分段名 sub/x.py、quote 判 ok",
               ("\n===== sub/x.py =====\n" in read(pathlib.Path(root, srid, "prompt.md")), read(pathlib.Path(root, srid, "grok.quotes"))),
               (True, "0\tok\n"))

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

# 沙箱集成:room 必须在真实 ~/.claude/mmruns 下 —— 测试用的临时目录在 /private/var/folders,
# fence.sb 与 codex profile 都放开了那里的写,"写别人的文件被拒"在那里不成立
import shutil, shlex
real_runs = pathlib.Path.home() / ".claude/mmruns"
zz = pathlib.Path(os.path.realpath(tempfile.mkdtemp(prefix="zz-test-", dir=real_runs)))
rid = "20991231-000000-r00m"
rd = zz / rid; room = rd / "room"
rbin = pathlib.Path(os.path.realpath(tempfile.mkdtemp(prefix="mmroom-bin-")))  # 假 CLI 与记录:不能放在 mmruns 下(围栏禁读)
try:
    renv = dict(os.environ, MMRUN_HOME=str(zz), MMRUN_D=str(PLUGIN / "mmrun.d"))
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
        prof = pathlib.Path.home() / ".codex" / f"mmroom-{rid}-P1.config.toml"
        try:
            r = mmz("__room_profile", rid, str(rd), "P1")
            ptext = prof.read_text() if prof.exists() else ""
            mm_ro = [l for l in (pathlib.Path.home() / ".codex/mm.config.toml").read_text().splitlines() if l.endswith('= "deny"')]
            expect("write_room_profile:打印 profile 名、含 mm_ro 全部 deny、room 读、P1 写",
                   (r.stdout.strip(), bool(mm_ro) and all(l in ptext.splitlines() for l in mm_ro),
                    f'"{room}" = "read"' in ptext, f'"{room}/P1.jsonl" = "write"' in ptext),
                   (f"mmroom-{rid}-P1", True, True, True))
            with tempfile.TemporaryDirectory() as cwd:
                run_checks("codex sandbox", lambda script: subprocess.run(
                    ["codex", "sandbox", "-P", "mm_room", "-p", f"mmroom-{rid}-P1", "-C", cwd, "--", "/bin/sh", "-c", script],
                    capture_output=True, text=True, timeout=60))
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
    def room_ask(*extra, frm=par, scen="", wait=True):
        r = subprocess.run([str(MMRUN), "ask", "--from", frm, *extra], input="Discuss.\n", capture_output=True, text=True,
                           env=dict(aenv, ROOMTEST=scen), timeout=60)
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
            (pathlib.Path.home() / ".codex" / f"mmroom-{c3}-P1.config.toml").exists()),
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

    r, ch = room_ask("--room", "--host", scen="host", wait=False)
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
        cfg = fh / ".codex/mm.config.toml"
        cfg.write_text('sandbox_mode = "read-only"\n"/top" = "deny"\n[permissions.mm_ro.filesystem]\n":root" = "read"\n'
                       '"/a/runs" = "deny"\n# c\n"/a/b c" = "deny"\n"/a/p" = "deny"\n\n[permissions.other.filesystem]\n"/z" = "deny"\n')
        pe = dict(renv, HOME=str(fh), PATH=f"{shim}:{os.environ['PATH']}")
        r = mmz("__room_profile", "rid9", str(rd), "P1", e=pe)
        pt = txt(fh / ".codex/mmroom-rid9-P1.config.toml")
        expect("write_room_profile 用 python3.9:成功、只取 mm_ro 段的全部 deny",
               (r.returncode, r.stderr, [l for l in pt.splitlines() if l.endswith('= "deny"')]),
               (0, "", ['"/a/runs" = "deny"', '"/a/b c" = "deny"', '"/a/p" = "deny"']))
        cfg.write_text('[permissions.mm_ro.filesystem]\n":root" = "read"\n[permissions.x.filesystem]\n"/z" = "deny"\n')
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
    for d in zz.iterdir():
        for f in (pathlib.Path.home() / ".codex").glob(f"mmroom-{d.name}-*.config.toml"): f.unlink()
    shutil.rmtree(zz, ignore_errors=True); shutil.rmtree(rbin, ignore_errors=True)

# ---------- codex 额度:用尽时不发起 codex;跑到一半撞额度不重试 ----------
with tempfile.TemporaryDirectory() as qroot, tempfile.TemporaryDirectory() as qtmp:  # 假二进制、会话目录不能放在 MMRUN_HOME 下
    qtmp = pathlib.Path(os.path.realpath(qtmp)); work = qtmp / "work"; work.mkdir()
    chome, crec, cfake, gfake = qtmp / "codex-home", qtmp / "codex.rec", qtmp / "codex", qtmp / "grok"
    def fake_codex(tail):
        cfake.write_text(f"#!/bin/sh\necho call >> '{crec}'\ncat > /dev/null\n" + tail); cfake.chmod(0o755)
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
    _, _, st, calls, _ = qstart("codex")
    expect("跑到一半撞额度:FAIL:quota、只调用一次", (st["codex"], calls), ("FAIL:quota", 1))
    lim.write_text('{"type":"error","message":"stream disconnected"}\n')
    _, _, st, calls, _ = qstart("codex")
    expect("其它失败照常重试一次:FAIL:1、调用两次", (st["codex"], calls), ("FAIL:1", 2))

# ---------- codex mm profile:不存在时按 mmrun.d 模板生成,已存在时不覆盖 ----------
with tempfile.TemporaryDirectory() as proot, tempfile.TemporaryDirectory() as ptmp:
    ptmp = pathlib.Path(os.path.realpath(ptmp)); phome = ptmp / "home"; phome.mkdir()
    prepo = ptmp / "repo"; git("init", "-q", str(prepo))
    for n in ("1", "2"):
        prepo.joinpath("a.txt").write_text(n + "\n"); git("-C", str(prepo), "add", "a.txt"); git("-C", str(prepo), "commit", "-qm", n)
    pfake = ptmp / "codex"
    pfake.write_text('#!/bin/sh\nout=""; prev=""\nfor a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done\n'
                     f"cat > /dev/null\necho '{review('s', verdict='approve')}' > \"$out\"\n")
    pfake.chmod(0o755)
    penv = {k: v for k, v in os.environ.items() if k != "CODEX_HOME"}
    penv.update(HOME=str(phome), MMRUN_HOME=proot, MMRUN_D=str(PLUGIN / "mmrun.d"), CODEX_BIN=str(pfake))
    prof = phome / ".codex" / "mm.config.toml"
    def preview():
        r = subprocess.run([str(MMRUN), "review", "--models", "codex", "--commit", "HEAD", "--dir", str(prepo)],
                           capture_output=True, text=True, env=penv, timeout=60)
        rid = r.stdout.split("RUN ", 1)[1].split()[0] if "RUN " in r.stdout else "missing"
        if rid != "missing": mmrun(proot, "wait", rid, "--timeout", "60")
        st = pathlib.Path(proot, rid, "codex.status")
        return r.returncode, st.read_text().strip() if st.exists() else None
    rc_st = preview()
    ptext = prof.read_text() if prof.exists() else ""
    expect("mm profile 不存在:review 跑通、生成、无 @HOME@、deny 指向临时 HOME",
           (rc_st, prof.exists(), "@HOME@" in ptext, f'"{phome}/.claude/mmruns" = "deny"' in ptext),
           ((0, "DONE"), True, False, True))
    prof.write_text("# 用户自己的 mm profile\n")
    rc_st = preview()
    expect("mm profile 已存在:不覆盖", (rc_st, prof.read_text()), ((0, "DONE"), "# 用户自己的 mm profile\n"))

print(f"\n{len(failures)} failed" if failures else "\nall passed")
raise SystemExit(1 if failures else 0)
