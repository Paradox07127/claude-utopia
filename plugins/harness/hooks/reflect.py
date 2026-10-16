#!/usr/bin/env python3
"""反思的确定性部分:读事件账本和会话记录,统计一个项目近 7 天的摩擦,同一模式出现 ≥2 次才进候选。
统计:guard.block 按规则、疑似守卫误报、超过 80 轮的子 agent、用户的否定式纠正、违反"用简体中文回复"的回复。
每个候选带证据(会话 id、时间、≤160 字片段),证据点名了 file:line 或来自守卫规则时猜一个落点。不调模型。
用法: reflect.py --project <项目键> [--since YYYY-MM-DD] [--json]
项目键 = 主树根目录把 / 换成 -;EVENTS_ROOT 覆盖 ~/.claude/harness/events,PROJECTS_ROOT 覆盖 ~/.claude/projects"""
import argparse, collections, datetime, glob, json, os, pathlib, re, sys

HOOKS = pathlib.Path(__file__).resolve().parent
MAX_TURNS = 80
MIN_SEEN = 2
EVIDENCE_KEPT = 5
EXCERPT_CHARS = 160
# 账本里的 rule.name → 守卫源文件;规则 id → 文件里判定它的函数
GUARD_FILES = {"guard-secret-files": "guard-secret.ts"}
RULE_ANCHORS = {"env-dump": "function envDump(", "secret-file": "export async function secretFiles("}
# 进程内守卫的拒绝只带理由文本,没有脚本路径:按理由里的固定句子认
GUARD_DENIALS = {"guard-secret-files": ("That file holds API keys", "would print environment variables into the transcript")}
CORRECTION = re.compile(r"^(?:别|不要|不是|我说过|no[,，]|don'?t\b|stop\b)", re.I)
FILE_LINE = re.compile(r"[\w./-]+\.\w+:\d+")
CJK = re.compile(r"[㐀-䶿一-鿿豈-﫿]")
LATIN = re.compile(r"[A-Za-z]")
# 与 rule-check.ts 同一套剥离:代码块、行内代码、URL、路径,再去掉带 _、数字、内部 . 或驼峰的标识符
FENCE = re.compile(r"```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)")
INLINE = re.compile(r"`[^`\n]*`")
URL = re.compile(r"\b[A-Za-z][A-Za-z0-9+.-]*://\S+")
PATH = re.compile(r"\S*/\S*")
WORD = re.compile(r"[A-Za-z0-9_.]+")
IDENT = re.compile(r"[_0-9]|[a-z][A-Z]|[A-Za-z0-9]\.[A-Za-z0-9]")


def is_language_violation(text):
    """剥掉代码与标识符后,中文字符在字母里占比低于 0.3 且字母不少于 40 个。"""
    for rx in (FENCE, INLINE, URL, PATH): text = rx.sub(" ", text)
    text = WORD.sub(lambda m: " " if IDENT.search(m.group(0)) else m.group(0), text)
    cjk, latin = len(CJK.findall(text)), len(LATIN.findall(text))
    return cjk + latin >= 40 and cjk / (cjk + latin) < 0.3


def excerpt(text):
    return " ".join(str(text).split())[:EXCERPT_CHARS]


def rows(path):
    for l in open(path, errors="ignore"):
        try: r = json.loads(l)
        except ValueError: continue
        if isinstance(r, dict): yield r


def blocks(r):
    c = (r.get("message") or {}).get("content")
    return [b for b in c if isinstance(b, dict)] if isinstance(c, list) else []


def result_text(b):
    c = b.get("content")
    return c if isinstance(c, str) else " ".join(x.get("text", "") for x in c if isinstance(x, dict)) if isinstance(c, list) else ""


def prompt_text(r):
    """主线程上开启一轮的 user 行的文字(人打的 prompt 或通知);工具结果、meta 行返回 None。"""
    if r.get("type") != "user" or r.get("isMeta") or r.get("isSidechain"): return None
    c = (r.get("message") or {}).get("content")
    if isinstance(c, str): return c
    if not isinstance(c, list) or any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c): return None
    return " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text") or None


def calls(path, since):
    """一个记录文件里按顺序的工具调用:{ts, name, input, ok, error}。"""
    out, by_id = [], {}
    for r in rows(path):
        if r.get("timestamp", "") < since: continue
        for b in blocks(r):
            if b.get("type") == "tool_use" and b.get("id") not in by_id:
                by_id[b.get("id")] = c = {"ts": r.get("timestamp", ""), "name": b.get("name"), "input": b.get("input") or {}, "ok": None, "error": ""}
                out.append(c)
            elif b.get("type") == "tool_result" and b.get("tool_use_id") in by_id:
                c = by_id[b["tool_use_id"]]
                c["ok"], c["error"], c["done"] = not b.get("is_error"), result_text(b) if b.get("is_error") else "", r.get("timestamp", "")
    return out


def same_intent(a, b):
    # 同一意图:同一个工具,且 Bash 命令按空白切词的 Jaccard ≥ 0.5,其他工具的 file_path / path 相同
    if a["name"] != b["name"]: return False
    if a["name"] == "Bash":
        x, y = set(str(a["input"].get("command", "")).split()), set(str(b["input"].get("command", "")).split())
        return bool(x | y) and len(x & y) / len(x | y) >= 0.5
    key = lambda c: c["input"].get("file_path") or c["input"].get("path")
    return key(a) is not None and key(a) == key(b)


def guard_target(rule_name, rule):
    name, anchor = GUARD_FILES.get(rule_name), RULE_ANCHORS.get(rule)
    if not name or not anchor or not (HOOKS / name).is_file(): return None
    script = HOOKS / name
    for n, l in enumerate(script.read_text(errors="ignore").splitlines(), 1):
        if l.startswith(anchor): return f"plugins/harness/hooks/{script.name}:{n}"
    return None


def scan(project, since):
    events_root = os.path.join(os.environ.get("EVENTS_ROOT") or os.path.expanduser("~/.claude/harness/events"), project)
    projects = os.path.join(os.environ.get("PROJECTS_ROOT") or os.path.expanduser("~/.claude/projects"), re.sub(r"[^A-Za-z0-9]", "-", project))
    found = collections.defaultdict(list)  # (kind, key) → 证据
    targets = {}

    events = []
    for path in sorted(glob.glob(f"{glob.escape(events_root)}/*/*.jsonl")):
        if os.path.basename(os.path.dirname(path)) < since: continue
        # 一个会话的行分在各写入方的文件里;没有 session.id 就按文件名第一个 . 之前
        events += [(e, os.path.basename(path).split(".")[0]) for e in rows(path) if e.get("event_name") == "guard.block"]

    sessions = collections.defaultdict(list)  # 会话 id → 主记录与子 agent 记录的路径
    # worktree 里开的会话,记录在 <项目编码>--claude-worktrees-<名>/ 下
    for path in sorted(glob.glob(f"{glob.escape(projects)}/*.jsonl") + glob.glob(f"{glob.escape(projects)}--claude-worktrees-*/*.jsonl")):
        sid = os.path.basename(path)[:-6]
        subs = sorted(glob.glob(f"{glob.escape(path[:-6])}/subagents/*.jsonl"))
        ids, cjk_seen, turn = {sid}, False, None
        def close(turn):
            if turn and turn["cjk"] and turn["reply"] and is_language_violation(turn["reply"]):
                found[("reply.language", "")].append({"session": sid, "time": turn["ts"][:19], "excerpt": excerpt(turn["reply"])})
        for r in rows(path):
            if r.get("sessionId"): ids.add(r["sessionId"])
            if r.get("timestamp", "") < since: continue
            text = prompt_text(r)
            if text is not None:
                close(turn)
                typed = not text.lstrip().startswith("<")
                cjk_seen = cjk_seen or (typed and bool(CJK.search(text)))
                # 用户写过中文的会话才按中文规则判:通知开启的一轮也算
                turn = {"cjk": cjk_seen, "reply": "", "id": None, "ts": r.get("timestamp", "")}
                if typed and CORRECTION.match(text.lstrip()):
                    found[("user.correction", "")].append({"session": sid, "time": r["timestamp"][:19], "excerpt": excerpt(text)})
            elif r.get("type") == "assistant" and not r.get("isSidechain") and turn is not None:
                said = "".join(b.get("text", "") for b in blocks(r) if b.get("type") == "text")
                if said:
                    mid = (r.get("message") or {}).get("id")
                    turn["reply"], turn["id"] = (turn["reply"] + said if mid == turn["id"] else said), mid
                    turn["ts"] = r.get("timestamp", "")
        close(turn)
        for i in ids: sessions[i] += [path, *subs]
        for sub in subs:
            try: meta = json.load(open(sub[:-6] + ".meta.json"))
            except (OSError, ValueError): meta = {}
            recs = [r for r in rows(sub) if r.get("type") == "assistant" and r.get("timestamp", "") >= since]
            turns = len({(r.get("message") or {}).get("id") for r in recs})
            if turns > MAX_TURNS:
                kind = meta.get("agentType", "unknown")
                found[("subagent.over-turns", kind)].append(
                    {"session": sid, "time": recs[0]["timestamp"][:19], "excerpt": excerpt(f"{kind} {turns} turns: {meta.get('description', '')}")})

    seqs = {}
    for e, named in sorted(events, key=lambda pair: str(pair[0].get("timestamp", ""))):
        at = e.get("attributes") if isinstance(e.get("attributes"), dict) else {}
        rule, name, sid, ts = str(at.get("rule.id")), str(at.get("rule.name", "")), str(at.get("session.id", named)), str(e.get("timestamp", ""))
        ev = {"session": sid, "time": ts[:19], "excerpt": excerpt(at.get("target", ""))}
        found[("guard.block", rule)].append(ev)
        targets[("guard.block", rule)] = targets[("guard.false-positive", rule)] = guard_target(name, rule)
        # 记录里被这条守卫拦下、结果时间离事件最近的那次调用
        best = None
        for path in sessions.get(sid, []):
            if path not in seqs: seqs[path] = calls(path, since)
            seq = seqs[path]
            for i, c in enumerate(seq):
                if c["ok"] is False and c["name"] == at.get("tool", c["name"]) and any(m in c["error"] for m in (name, *GUARD_DENIALS.get(name, ()))):
                    gap = abs(_seconds(c.get("done", c["ts"])) - _seconds(ts))
                    if gap <= 120 and (best is None or gap < best[0]): best = (gap, seq, i)
        if best and any(c["ok"] and same_intent(best[1][best[2]], c) for c in best[1][best[2] + 1:best[2] + 3]):
            found[("guard.false-positive", rule)].append(ev)

    counts = {"guard_block": {}, "guard_false_positive": {}, "subagent_over_turns": {}, "correction": 0, "language": 0}
    for (kind, key), evs in found.items():
        if kind == "user.correction": counts["correction"] = len(evs)
        elif kind == "reply.language": counts["language"] = len(evs)
        else: counts[{"guard.block": "guard_block", "guard.false-positive": "guard_false_positive", "subagent.over-turns": "subagent_over_turns"}[kind]][key] = len(evs)
    candidates = []
    for (kind, key), evs in sorted(found.items()):
        if len(evs) < MIN_SEEN: continue
        named = next((m.group(0) for ev in evs for m in [FILE_LINE.search(ev["excerpt"])] if m), None)
        candidates.append({"kind": kind, "key": key, "count": len(evs), "target": targets.get((kind, key)) or named, "evidence": evs[:EVIDENCE_KEPT]})
    return {"project": project, "since": since, "counts": counts, "candidates": candidates}


def _seconds(ts):
    try: return datetime.datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except ValueError: return 0.0


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--project", required=True); ap.add_argument("--since"); ap.add_argument("--json", action="store_true")
    if "--project" in argv[:-1]:  # 项目键以 - 开头,argparse 会把它当成选项
        i = argv.index("--project"); argv[i:i + 2] = [f"--project={argv[i + 1]}"]
    a = ap.parse_args(argv)
    since = a.since or (datetime.date.today() - datetime.timedelta(days=6)).isoformat()  # 今天算第 1 天
    out = scan(a.project, since)
    if a.json:
        json.dump(out, sys.stdout, ensure_ascii=False); print(); return
    print(f"{a.project}  since={since}")
    for k, v in out["counts"].items(): print(f"  {k}: {v}")
    print("candidates:", len(out["candidates"]))
    for c in out["candidates"]: print(f"  {c['count']:4d}  {c['kind']} {c['key']}  {c['target'] or ''}")


if __name__ == "__main__":
    main(sys.argv[1:])
