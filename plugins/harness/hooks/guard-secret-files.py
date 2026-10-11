#!/usr/bin/env python3
"""PreToolUse/Bash|Read|Edit|Write|Grep: refuse tool calls that would put the contents of API-key config files
into the transcript (Read / Edit results, Grep content, shell output such as cat, jq, diff or an environment dump).

Shell is parsed as text: this guards against agent mistakes, not adversarial bypass.
"""
import fnmatch
import glob
import json
import os
import re
import shlex
import sys
import time

HOME = os.path.expanduser("~")
HOMES = {HOME, os.path.realpath(HOME)}
# Relative to HOME; `*` also crosses `/`
HOME_SECRETS = [".claude.json", ".claude.json.*", ".claude/backups/*", ".claude/settings.json", ".claude/settings.json.*",
                ".claude/settings.local.json", ".codex/config.toml", ".codex/config.toml.*", ".codex/auth.json",
                ".openviking/*", ".grok/auth.json", ".claude/file-history/*", ".codex/shell_snapshots/*"]
SECRET_NAMES = {"ovcli.conf", "ov.conf"}  # matched anywhere: the server side is reached over ssh
MENTION = re.compile(r"\.claude\.json|\.claude/settings\.json|\.claude/settings\.local\.json|\.claude/backups"
                     r"|\.claude/file-history|\.codex/shell_snapshots|\.codex/config\.toml|\.codex/auth\.json|\.openviking(?:/|(?![\w.-]))|\.grok/auth\.json"
                     r"|(?<![\w.-])(?:ovcli|ov)\.conf(?![\w.-])")
SPLIT = re.compile(r"&&|\|\||\$\(|[;&|()\n`]")
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1([^\n]*)\n(.*?)\n\s*\2\s*(?=\n|$)", re.S)
SHELL_FED = re.compile(r"(?:ba|z|da|k)?sh|python[\d.]*|node|ruby|perl|osascript")
SHELLS = re.compile(r"(?:ba|z|da|k)?sh")
MESSAGE_FLAGS = {"-m", "--message", "-t", "--title", "-b", "--body"}  # gh / git: the next word is text, not a file
WRAPPERS = {"sudo", "command", "time", "nohup"}
ASSIGN = re.compile(r"^[A-Za-z_]\w*=")
METADATA = {"ls", "stat", "test", "[", "chmod", "chown", "touch", "wc", "du", "file", "echo", "printf"}
QUIET_LONG = {"--files-with-matches", "--files-without-match", "--count", "--quiet"}
SECRET_VAR = re.compile(r"KEY|TOKEN|SECRET|PASSWORD", re.I)
REASON = ("Blocked: `{call}` would put the contents of {file} into the transcript. That file holds API keys, and whatever "
          "this call reads or prints is saved in the transcript. Ask the user to look at or change it; to check it, use "
          "metadata only (ls, stat, wc, grep -c / grep -l); to find where the file name is mentioned in other files, "
          "use grep -l or rg -l in Bash.")
ENV_REASON = ("Blocked: `{call}` would print environment variables into the transcript, and some of them hold API keys or "
              "tokens that would be saved there. Print one named variable that is not a secret instead (printenv HOME).")


def paths(path, cwd):
    """The absolute path and its realpath, with ~, $HOME and ${HOME} expanded and relative paths taken from cwd."""
    path = os.path.expanduser(re.sub(r"^\$(?:HOME|\{HOME\})(?=/|$)", lambda m: HOME, path))
    path = os.path.normpath(os.path.join(cwd, path))
    return {path, os.path.realpath(path)}


def is_secret(path):
    if os.path.basename(path) in SECRET_NAMES:
        return True
    return any(path.startswith(h + "/") and fnmatch.fnmatchcase(path[len(h) + 1:], pat) for h in HOMES for pat in HOME_SECRETS)


def holds_secret(path):
    """True when a home-anchored secret file lies under directory `path` at any depth."""
    prefix = path.rstrip("/") + "/"
    return any(os.path.dirname(os.path.join(h, pat)) + "/" == prefix or os.path.join(h, pat).startswith(prefix)
               for h in HOMES for pat in HOME_SECRETS)


def env_dump(words):
    name, args = os.path.basename(words[0]), words[1:]
    if name == "env":
        while args and (args[0] in ("-0", "--null", "-u") or ASSIGN.match(args[0])):
            args = args[2:] if args[0] == "-u" else args[1:]
        return not args
    if name in ("declare", "typeset"):
        options = [a for a in args if a[:1] in "-+"]
        # zsh `typeset NAME` and `-p NAME` print the value; `-x NAME` or an assignment NAME=V prints nothing
        names = [a for a in args if a[:1] not in "-+" and "=" not in a]
        return ((len(options) == len(args) and not any(c in a for a in options for c in "fF"))
                or ((not options or any("p" in o for o in options)) and any(SECRET_VAR.search(a) for a in names)))
    return ((name == "printenv" and (not args or any(SECRET_VAR.search(a) for a in args)))
            or (name == "export" and args in ([], ["-p"]))
            or (name == "set" and not args))


def prints_secret_var(segment, words):
    if os.path.basename(words[0]) not in ("echo", "printf"):
        return False
    # $NAME inside single quotes is not expanded; double-quoted strings are kept whole so their ' is literal
    text = re.sub(r"\"(?:\\.|[^\"\\])*\"|'[^']*'", lambda m: m.group(0) if m.group(0)[0] == '"' else "", segment)
    # \$NAME is literal, \\$NAME is not; ${NAME:+text} and ${NAME+text} print only the text
    names = re.findall(r"(?<!\\)(?:\\\\)*\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)(?!\w|:?\+))", text)
    return any(SECRET_VAR.search(a + b) for a, b in names)


def allowed(words):
    name = os.path.basename(words[0])
    if name in METADATA:
        return True
    if name in ("grep", "egrep", "rg"):
        quiet = "lcq" if name == "rg" else "lLcq"  # rg -L is --follow and still prints matching lines
        return any(a in QUIET_LONG or re.fullmatch(rf"-[A-Za-z]*[{quiet}][A-Za-z]*", a) for a in words[1:])
    return name == "git" and words[1:2] == ["commit"]


def simple_commands(command):
    """(segment, words) per simple command, past assignments and wrappers."""
    for segment in SPLIT.split(command):
        try:
            words = shlex.split(segment)
        except ValueError:
            words = segment.split()
        while words and ASSIGN.match(words[0]):
            words = words[1:]
        while words and words[0] in WRAPPERS:
            words = words[1:]
            while words and words[0].startswith("-"):
                words = words[1:]
        if words:
            yield segment, words


def drop_heredocs(command, readers=SHELL_FED):
    """The command without heredoc bodies that are only text: kept when fed to a program `readers` matches,
    or when an unquoted delimiter lets the body run $( ) or backticks."""
    def body(m):
        line = command[command.rfind("\n", 0, m.start()) + 1:m.start()] + m.group(3)
        fed = any(readers.fullmatch(os.path.basename(words[0])) for _, words in simple_commands(line))
        expands = not m.group(1) and re.search(r"\$\(|`", m.group(4))
        return m.group(0) if fed or expands else m.group(3)
    return HEREDOC.sub(body, command)


def check_bash(command, cwd):
    """(reason template, call, file) for the first refused simple command, or None."""
    # Code fed to python, node and the like is not shell: a word such as `set` there dumps nothing
    for segment, words in simple_commands(drop_heredocs(command, SHELLS)):
        if env_dump(words) or prints_secret_var(segment, words):
            return ENV_REASON, segment.strip(), None
    cwds = {cwd}
    for segment, words in simple_commands(drop_heredocs(command)):
        message = os.path.basename(words[0]) in ("gh", "git")
        if os.path.basename(words[0]) == "cd" and len(words) == 2:
            cwds |= {p for c in cwds for p in paths(words[1], c)}  # a cd inside ( ) leaves the outer cwd as it was
        text = segment
        if message:
            text = " ".join(w for i, w in enumerate(words) if not (i and words[i - 1] in MESSAGE_FLAGS)
                            and not re.match(r"--(?:message|title|body)=", w))
        mention = MENTION.search(text)
        if mention and not allowed(words):
            return REASON, segment.strip(), mention.group(0)
        # A recursive search of a directory such as ~/.codex prints lines of the secret files inside it
        if os.path.basename(words[0]) in ("grep", "egrep", "rg") and not allowed(words):
            hit = next((a for a in words[1:] if not a.startswith("-")
                        and any(holds_secret(p) for c in cwds for p in paths(a, c))), None)
            if hit:
                return REASON, segment.strip(), f"a file under {hit}"
        if not allowed(words):
            for i, a in enumerate(words[1:], 1):
                if a.startswith("-") or (message and words[i - 1] in MESSAGE_FLAGS):
                    continue
                found = {p for c in cwds for p in paths(a, c)}
                if re.search(r"[*?[]", a):
                    found |= {q for p in found for g in glob.glob(p) for q in paths(g, "/")}
                if any(is_secret(p) for p in found):
                    return REASON, segment.strip(), a
    return None


def check(tool, tool_input, cwd):
    if tool == "Bash":
        return check_bash(tool_input["command"], cwd)
    if tool in ("Read", "Edit", "Write"):
        path = tool_input["file_path"]
        if any(is_secret(p) for p in paths(path, cwd)):
            return REASON, f"{tool} {path}", path
    if tool == "Grep" and tool_input.get("output_mode") == "content":
        path = tool_input.get("path") or "."
        if any(is_secret(p) or holds_secret(p) or any(os.path.exists(os.path.join(p, n)) for n in SECRET_NAMES)
               for p in paths(path, cwd)):
            return REASON, f"Grep (output_mode content) in {path}", f"a file under {path}"
        pattern = tool_input.get("glob")
        if pattern and re.sub(r"^(?:\*\*/)+", "", pattern) in SECRET_NAMES:
            return REASON, f"Grep (output_mode content) in {path} with glob {pattern}", pattern
    return None


def log(decision, op, payload):
    """Append one line to ~/.claude/harness/guard.jsonl; a log that cannot be written is skipped."""
    entry = {"at": int(time.time() * 1000), "guard": "secret-files", "decision": decision, "op": op,
             "cwd": payload.get("cwd"), "agent_id": payload.get("agent_id")}
    path = os.path.expanduser("~/.claude/harness/guard.jsonl")
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def main():
    try:
        payload = json.load(sys.stdin)
        cwd = payload.get("cwd") or os.getcwd()
        found = check(payload["tool_name"], payload["tool_input"], cwd)
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        print(f"guard-secret-files: could not parse input ({e}); not checked", file=sys.stderr)
        sys.exit(1)
    if found:
        reason, call, file = found
        log("deny", call, payload)
        print(reason.format(call=call, file=file), file=sys.stderr)
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
