#!/usr/bin/env python3
"""PreToolUse/Bash|Read|Edit|MultiEdit|Write|Grep: refuse tool calls that would put the contents of API-key config files
into the transcript (Read / Edit results, Grep content, shell output such as cat, jq, diff or an environment dump).

Shell is parsed as text: this guards against agent mistakes, not adversarial bypass.
"""
import fnmatch
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
                ".openviking/*", ".grok/auth.json"]
SECRET_NAMES = {"ovcli.conf", "ov.conf"}  # matched anywhere: the server side is reached over ssh
MENTION = re.compile(r"\.claude\.json|\.claude/settings\.json|\.claude/settings\.local\.json|\.claude/backups"
                     r"|\.codex/config\.toml|\.codex/auth\.json|\.openviking(?:/|(?![\w.-]))|\.grok/auth\.json"
                     r"|(?<![\w.-])(?:ovcli|ov)\.conf(?![\w.-])")
SPLIT = re.compile(r"&&|\|\||\$\(|[;&|()\n`]")
WRAPPERS = {"sudo", "command", "time", "nohup"}
ASSIGN = re.compile(r"^[A-Za-z_]\w*=")
METADATA = {"ls", "stat", "test", "[", "chmod", "chown", "touch", "wc", "du", "file", "echo", "printf"}
QUIET_LONG = {"--files-with-matches", "--files-without-match", "--count", "--quiet"}
SECRET_VAR = re.compile(r"KEY|TOKEN|SECRET|PASSWORD", re.I)
REASON = ("Blocked: `{call}` would put the contents of {file} into the transcript. That file holds API keys, and whatever "
          "this call reads or prints is saved in the transcript. Ask the user to look at or change it; to check it, use "
          "metadata only (ls, stat, wc, grep -c / grep -l); to find where the file name is mentioned in other files, "
          "use the Grep tool.")
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
    name, args = words[0], words[1:]
    return ((name == "env" and set(args) <= {"-0", "--null"})
            or (name == "printenv" and (not args or any(SECRET_VAR.search(a) for a in args)))
            or (name == "export" and args in ([], ["-p"]))
            or (name in ("declare", "typeset") and args == ["-x"]) or (name == "declare" and args == ["-p"])
            or (name == "set" and not args))


def allowed(words):
    name = os.path.basename(words[0])
    if name in METADATA:
        return True
    if name in ("grep", "egrep", "rg"):
        quiet = "lcq" if name == "rg" else "lLcq"  # rg -L is --follow and still prints matching lines
        return any(a in QUIET_LONG or re.fullmatch(rf"-[A-Za-z]*[{quiet}][A-Za-z]*", a) for a in words[1:])
    return name == "git" and words[1:2] == ["commit"]


def check_bash(command, cwd):
    """(reason template, call, file) for the first refused simple command, or None."""
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
        if not words:
            continue
        if env_dump(words):
            return ENV_REASON, segment.strip(), None
        mention = MENTION.search(segment)
        if mention and not allowed(words):
            return REASON, segment.strip(), mention.group(0)
        # A recursive search of a directory such as ~/.codex prints lines of the secret files inside it
        if os.path.basename(words[0]) in ("grep", "egrep", "rg") and not allowed(words):
            hit = next((a for a in words[1:] if not a.startswith("-") and any(holds_secret(p) for p in paths(a, cwd))), None)
            if hit:
                return REASON, segment.strip(), f"a file under {hit}"
    return None


def check(tool, tool_input, cwd):
    if tool == "Bash":
        return check_bash(tool_input["command"], cwd)
    if tool in ("Read", "Edit", "MultiEdit", "Write"):
        path = tool_input["file_path"]
        if any(is_secret(p) for p in paths(path, cwd)):
            return REASON, f"{tool} {path}", path
    if tool == "Grep" and tool_input.get("output_mode") == "content":
        path = tool_input.get("path") or "."
        if any(is_secret(p) or holds_secret(p) for p in paths(path, cwd)):
            return REASON, f"Grep (output_mode content) in {path}", f"a file under {path}"
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
