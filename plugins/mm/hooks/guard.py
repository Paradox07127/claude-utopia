#!/usr/bin/env python3
"""PreToolUse(Bash|Read): denies reading mmrun's *.raw; moves a foreground `mmrun wait` to the background."""
import json
import os
import re
import shlex
import sys
import time

RAW_DENY = ("mm: *.raw is the full event stream (tens of thousands of tokens); do not read it. "
            "Use `mmrun status <RUNID>` for status and `mmrun result <model> <RUNID>` for findings.")

RAW_PATH = re.compile(r"/\.claude/mmruns/[^/]+/[^/]+\.raw$")
# The whole command is one `tail -N|-n N <file>.raw`: the troubleshooting step the mm docs recommend.
BOUNDED_TAIL = re.compile(r"\s*tail\s+(?:-(\d+)|-n\s+(\d+))\s+[^\s;&|<>()$`'\"\\*?]+\.raw\s*")
ASSIGN = re.compile(r"^[A-Za-z_]\w*=")
HOME_VAR = re.compile(r"\$(?:HOME\b|\{HOME\})")
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1([^\n]*)\n.*?\n\s*\2\s*(?=\n|$)", re.S)
SHELL_FED = re.compile(r"(?:ba|z|da|k)?sh|python[\d.]*|node|ruby|perl")


def commands(command):
    """The command's simple commands as word lists, split at ; & | ( ) and newlines outside quotes."""
    lex = shlex.shlex(command, posix=True, punctuation_chars=";&|()\n")
    lex.whitespace, lex.whitespace_split, lex.commenters = " \t\r", True, ""
    try:
        tokens = list(lex)
    except ValueError:
        tokens = command.split()
    out, cur = [], []
    for t in tokens:
        if set(t) <= set(";&|()\n"):
            out.append(cur)
            cur = []
        else:
            cur.append(t)
    return [words for words in out + [cur] if words]


def drop_heredocs(command):
    """The command without heredoc bodies, except those on a line that runs a shell or interpreter."""
    def body(m):
        line = command[command.rfind("\n", 0, m.start()) + 1:m.start()] + m.group(3)
        fed = any(run and SHELL_FED.fullmatch(os.path.basename(run[0])) for run in map(executable, commands(line)))
        return m.group(0) if fed else m.group(3)
    return HEREDOC.sub(body, command)


def executable(words):
    """The words of the command actually run, past assignments, keywords and the env / timeout / nice / command / exec launchers."""
    while words:
        w = os.path.basename(words[0])
        if ASSIGN.match(words[0]) or w in ("!", "{", "then", "do", "else", "time", "nohup"):
            words = words[1:]
        elif w == "env":
            words = words[1:]
            while words and (words[0].startswith("-") or ASSIGN.match(words[0])):
                words = words[2:] if words[0] in ("-u", "--unset", "-C", "--chdir", "-S", "--split-string") else words[1:]
        elif w == "timeout":
            words = words[1:]
            while words and words[0].startswith("-"):
                words = words[2:] if words[0] in ("-s", "--signal", "-k", "--kill-after") else words[1:]
            words = words[1:]  # the duration
        elif w in ("nice", "command", "exec"):
            words = words[1:]
            while words and words[0].startswith("-"):
                words = words[2:] if words[0] in ("-n", "-a") else words[1:]
        else:
            return words
    return words


def resolve(word, dirs):
    """Absolute paths the word may name: ~ and $HOME expanded, relative to each possible directory; none if unresolvable."""
    word = os.path.expanduser(HOME_VAR.sub(os.path.expanduser("~").replace("\\", "\\\\"), word))
    if "$" in word or "`" in word:
        return []
    if os.path.isabs(word):
        return [os.path.normpath(word)]
    return [os.path.normpath(os.path.join(d, word)) for d in dirs]


def names_raw(command, cwd):
    """True when a *.raw operand resolves, against the cwd and any cd, into an mmruns run directory."""
    dirs = [cwd] if cwd else []
    for words in commands(command):
        if words[0] == "cd" and len(words) > 1 and words[1] != "-":
            dirs += resolve(words[1], dirs)
            continue
        for word in words:
            for part in re.split(r"[=<>]", word):
                if part.endswith(".raw") and any(RAW_PATH.search(p) for p in resolve(part, dirs)):
                    return True
    return False


def deny():
    entry = {"at": int(time.time() * 1000), "guard": "mm-raw", "decision": "deny", "op": "read *.raw",
             "cwd": event.get("cwd"), "agent_id": event.get("agent_id")}
    path = os.path.expanduser("~/.claude/harness/guard.jsonl")
    try:  # a log that cannot be written is skipped
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass
    print(RAW_DENY, file=sys.stderr)
    sys.exit(2)


try:
    event = json.load(sys.stdin)
    tool, ti = event["tool_name"], event["tool_input"]
except (ValueError, KeyError, TypeError):
    sys.exit(0)

if tool == "Read":
    if RAW_PATH.search(str(ti.get("file_path", ""))):
        deny()
    sys.exit(0)

if tool != "Bash":
    sys.exit(0)
command = str(ti.get("command", ""))
text = drop_heredocs(command)
# Best effort: a word naming the mmruns tree and a *.raw, or a *.raw operand that resolves into a run directory.
# A word with whitespace is quoted prose unless it holds a command substitution.
if any("mmruns" in w and re.search(r"\.raw\b", w) and (not re.search(r"\s", w) or "$(" in w or "`" in w)
       for words in commands(text) for w in words) or names_raw(text, event.get("cwd")):
    tail = BOUNDED_TAIL.fullmatch(command)
    if not tail or int(tail.group(1) or tail.group(2)) > 50:
        deny()
if not any(len(run) > 1 and os.path.basename(run[0]) == "mmrun" and run[1] == "wait"
           for run in map(executable, commands(text))):
    sys.exit(0)

new = {**ti, "run_in_background": True}
# Background Bash is stopped at its `timeout` (default 30 min, max 2 h): cover mmrun's own --timeout plus a minute.
m = re.search(r"--timeout\s+(\d+)", command)
if m:
    need = min((int(m.group(1)) + 60) * 1000, 7_200_000)
    if ti.get("timeout", 1_800_000) < need:
        new["timeout"] = need
if new != ti:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": new}}, ensure_ascii=False))
