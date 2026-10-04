#!/usr/bin/env python3
"""PreToolUse/Bash: in a repo's main worktree, refuse git commands that discard uncommitted changes or rewrite HEAD.

The main tree often has several writers (Claude sessions, foreground codex/grok); these commands take their changes away.
Linked worktrees (worker's .claude/worktrees/*, mmrun's .mm-wt/*) are allowed.
Shell is parsed as text: this guards against agent mistakes, not adversarial bypass. When the directory cannot be
determined, or git cannot tell whether it is the main tree, dangerous operations are treated as being on the main tree.
"""
import json
import os
import re
import shlex
import subprocess
import sys
import time

UNKNOWN = object()  # directory could not be determined
unchecked = []  # dangerous ops refused because git could not tell whether the tree is the main one
QUOTED_HEREDOC = re.compile(r"<<-?\s*(['\"])(\w+)\1[^\n]*\n.*?\n\s*\2\s*(?=\n|$)", re.S)
ANY_HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?\n\s*\2\s*(?=\n|$)", re.S)
GLOB = re.compile(r"[*?\[]")
VAR = re.compile(r"\$\{(\w+)(?::?-([^}]*))?\}|\$(\w+)")
SEPARATORS = set(";&|()\n")
KEYWORDS = {"if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time", "exec", "nohup"}
ASSIGN = re.compile(r"^([A-Za-z_]\w*)=(.*)$", re.S)
REASON = ("Blocked on the shared main worktree: `{op}` would take away uncommitted changes from other sessions or the user. "
          "Undo your own edit with a reverse Edit; for a clean baseline open a temporary worktree. Linked worktrees are exempt.")
UNVERIFIED = ("Blocked: `{op}` would take away uncommitted changes if this is the shared main worktree, and git could not tell "
              "(git missing, timed out or failed). Make sure `git rev-parse --git-common-dir` works in that directory, "
              "or run the command in a linked worktree.")
REPO_VARS = ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE")
# Short options that take a value, and long ones that may take it as the next word, per subcommand
VALUED = {"checkout": ("bB", ("--orphan", "--conflict")), "restore": ("s", ("--source",)),
          "clean": ("e", ("--exclude",)), "switch": ("cC", ("--create", "--force-create", "--orphan", "--conflict"))}
# Git ignores an alias named like a builtin, so these are never looked up as aliases
BUILTINS = {"add", "am", "apply", "archive", "bisect", "blame", "branch", "cat-file", "checkout", "cherry-pick", "clean",
            "clone", "commit", "config", "describe", "diff", "fetch", "for-each-ref", "format-patch", "gc", "grep",
            "help", "init", "log", "ls-files", "ls-remote", "ls-tree", "merge", "merge-base", "mv", "notes", "pull",
            "push", "range-diff", "rebase", "reflog", "remote", "reset", "restore", "rev-list", "rev-parse", "revert",
            "rm", "shortlog", "show", "show-ref", "stash", "status", "submodule", "switch", "symbolic-ref", "tag",
            "version", "worktree"}
ALIAS_DEPTH = 5


def git(target, *args, env=None):
    """Run git in target; the repository is found from target alone unless `env` sets GIT_DIR / GIT_WORK_TREE."""
    clean = {k: v for k, v in os.environ.items() if k not in REPO_VARS}
    clean.update(env or {}, LC_ALL="C")
    try:
        return subprocess.run(["git", "-C", target, *args], capture_output=True, text=True, timeout=5, env=clean)
    except (OSError, subprocess.TimeoutExpired):
        return None


def is_main_tree(path):
    """True / False, or None when git could not answer (missing, timed out, failed)."""
    out = git(path, "rev-parse", "--absolute-git-dir", "--git-common-dir")
    if out is None:
        return None
    if out.returncode != 0:
        return False if "not a git repository" in out.stderr else None
    lines = out.stdout.split("\n")
    if len(lines) < 2 or not lines[0] or not lines[1]:
        return None
    return os.path.realpath(lines[0]) == os.path.realpath(os.path.join(path, lines[1]))


def short_flags(args, sub=""):
    """Letters of short option clusters before `--`; a letter that takes a value ends its cluster (or takes the next word)."""
    short, long = VALUED.get(sub, ("", ()))
    flags, skip = set(), False
    for a in args:
        if skip:
            skip = False
        elif a == "--":
            break
        elif a in long:
            skip = True
        elif a.startswith("-") and not a.startswith("--"):
            for k, c in enumerate(a[1:], 2):
                flags.add(c)
                if c in short:
                    skip = k == len(a)
                    break
    return flags


def checkout_op(rest, target, probe):
    flags = short_flags(rest, "checkout")
    if "--force" in rest or "f" in flags:
        return "git checkout --force"
    if "--" in rest or set(rest) & {"--ours", "--theirs", "--patch", "-p"} or any(
            a.startswith("--pathspec-from-file") for a in rest):
        return "git checkout <path>"
    if flags & {"b", "B"} or "--orphan" in rest:
        return None
    positional, skip = [], False
    for a in rest:
        if skip:
            skip = False
        elif a in ("--conflict", "--track"):
            skip = True
        elif not a.startswith("-"):
            positional.append(a)
    if len(positional) >= 2 or "." in positional or (positional and GLOB.search(positional[0])):
        return "git checkout <path>"
    if positional and target is UNKNOWN:
        # Directory unknown: refs are shared by a repo's worktrees, so a ref that resolves in probe is a branch switch, else a file restore
        ref = None if probe is UNKNOWN else git(probe, "rev-parse", "--verify", "--quiet", positional[0] + "^{commit}")
        return None if ref and ref.returncode == 0 else "git checkout <path>"
    if positional:
        ref = git(target, "rev-parse", "--verify", "--quiet", positional[0] + "^{commit}")
        if not ref or ref.returncode != 0:
            # Not a commit: a path on disk or a deleted tracked file, both mean a file restore
            tracked = git(target, "ls-files", "--error-unmatch", "--", positional[0])
            if os.path.exists(os.path.join(target, positional[0])) or (tracked and tracked.returncode == 0):
                return "git checkout <path>"
    return None


def dangerous(sub, rest, target, probe):
    if "-h" in rest or "--help" in rest:
        return None
    flags = short_flags(rest, sub)
    if sub == "checkout":
        return checkout_op(rest, target, probe)
    if sub == "restore":
        staged = "--staged" in rest or "S" in flags
        worktree = "--worktree" in rest or "W" in flags
        return None if staged and not worktree else "git restore"
    if sub == "stash" and not (rest and rest[0] in ("list", "show", "create")):
        return "git stash"
    if sub == "clean" and not ("--dry-run" in rest or "n" in flags):
        return "git clean"
    if sub == "switch" and ("--discard-changes" in rest or "--force" in rest or "f" in flags):
        return "git switch --discard-changes"
    if sub == "reset" and "--hard" in rest:
        return "git reset --hard"
    if sub == "commit" and "--amend" in rest:
        return "git commit --amend"
    return None


def expand(word, env, cwd):
    if "`" in word or "$(" in word:
        return UNKNOWN
    def value(m):
        name, default = m.group(1) or m.group(3), m.group(2)
        val = env.get(name)
        return default if default is not None and not val else "$?" if val is None else val
    word = VAR.sub(value, word)  # handles $X, ${X}, ${X:-default}, ${X-default}; other ${...} forms leave a $ and count as unknown
    word = os.path.expanduser(word)
    if "$" in word:
        return UNKNOWN
    if os.path.isabs(word):
        return os.path.normpath(word)
    return UNKNOWN if cwd is UNKNOWN else os.path.normpath(os.path.join(cwd, word))


def substitutions(text):
    """Contents of $(...) and `...` outside single quotes (single-quoted text is literal; the shell does not run it)."""
    out, i, quote = [], 0, ""
    while i < len(text):
        c = text[i]
        if c == "\\" and quote != "'":
            i += 2
            continue
        if c == "'" and quote != '"':
            quote = "" if quote == "'" else "'"
        elif c == '"' and quote != "'":
            quote = "" if quote == '"' else '"'
        elif quote != "'" and text.startswith("$(", i):
            depth, j = 1, i + 2
            while j < len(text) and depth:
                depth += {"(": 1, ")": -1}.get(text[j], 0)
                j += 1
            out.append(text[i + 2:j - 1])
            i = j
            continue
        elif quote != "'" and c == "`":
            j = text.find("`", i + 1)
            j = len(text) if j < 0 else j
            out.append(text[i + 1:j])
            i = j + 1
            continue
        i += 1
    return out


def strip_comments(text):
    """Strip from a word-initial # outside quotes to end of line (the newline stays: it separates commands)."""
    out, quote, i = [], "", 0
    while i < len(text):
        c = text[i]
        if c == "\\" and quote != "'":
            out.append(text[i:i + 2])
            i += 2
            continue
        if c in "'\"" and quote in ("", c):
            quote = "" if quote else c
        elif c == "#" and not quote and (i == 0 or text[i - 1] in " \t\n;&|("):
            j = text.find("\n", i)
            i = len(text) if j < 0 else j
            continue
        out.append(c)
        i += 1
    return "".join(out)


def commands(command):
    """Split command text into [(preceding separator, words)] plus the $(...) contents to check separately.
    A quoted heredoc body is literal; an unquoted body is not run, but $(...) inside it is expanded."""
    text = strip_comments(QUOTED_HEREDOC.sub("", command))
    extra = substitutions(text)
    text = ANY_HEREDOC.sub("", text).replace("\\\n", " ")
    lex = shlex.shlex(text, posix=True, punctuation_chars=";&|()\n")
    lex.whitespace, lex.whitespace_split, lex.commenters = " \t\r", True, ""
    try:
        tokens = list(lex)
    except ValueError:
        tokens = text.split()
    out, cur, sep = [], [], ""
    for t in tokens:
        if set(t) <= SEPARATORS:
            if cur:
                out.append((sep, cur))
            cur, sep = [], t
        else:
            cur.append(t)
    if cur:
        out.append((sep, cur))
    return out, extra


def strip_wrappers(words, env):
    """Return (the words of the command actually run, the directory from env -C or None)."""
    chdir = None
    while words:
        w = os.path.basename(words[0])
        if w in KEYWORDS:
            words = words[1:]
        elif w in ("sudo", "command", "nice"):
            takes_arg = {"sudo": ("-u", "-g", "-p", "-C", "-D", "-h", "-U", "-r", "-t"), "nice": ("-n",)}.get(w, ())
            words = words[1:]
            while words and words[0].startswith("-"):
                words = words[2:] if words[0] in takes_arg else words[1:]
        elif w == "env":
            words = words[1:]
            while words and (words[0].startswith("-") or ASSIGN.match(words[0])):
                if ASSIGN.match(words[0]):
                    env.update([ASSIGN.match(words[0]).groups()])
                elif words[0] in ("-u", "--unset") and len(words) > 1:
                    env.pop(words[1], None)
                    words = words[1:]
                elif words[0] in ("-C", "--chdir") and len(words) > 1:
                    chdir = words[1]
                    words = words[1:]
                elif words[0].startswith("--chdir="):
                    chdir = words[0].split("=", 1)[1]
                words = words[1:]
        else:
            return words, chdir
    return words, chdir


def git_op(args, local, base, probe, depth):
    """The dangerous op that `git <args>` run from base would do on the main tree, or None. Aliases are expanded first."""
    rundir, worktree, gitdir, aliases = base, None, None, {}
    for _ in range(ALIAS_DEPTH):
        # git runs in the -C directory, but an explicit work tree (--work-tree / GIT_WORK_TREE) takes precedence
        while args and args[0].startswith("-"):
            opt = args[0]
            if opt in ("-C", "-c", "--git-dir", "--work-tree", "--namespace") and len(args) >= 2:
                if opt == "-C":
                    rundir = expand(args[1], local, rundir)
                elif opt == "-c" and args[1].lower().startswith("alias.") and "=" in args[1]:
                    key, value = args[1].split("=", 1)
                    aliases[key[len("alias."):].lower()] = value
                elif opt == "--work-tree":
                    worktree = args[1]
                elif opt == "--git-dir":
                    gitdir = args[1]
                    worktree = worktree or UNKNOWN
                args = args[2:]
            else:
                if opt.startswith("-C") and len(opt) > 2:
                    rundir = expand(opt[2:], local, rundir)
                elif opt.startswith("--work-tree="):
                    worktree = opt.split("=", 1)[1]
                elif opt.startswith("--git-dir="):
                    gitdir = opt.split("=", 1)[1]
                    worktree = worktree or UNKNOWN
                args = args[1:]
        tree = worktree
        if tree is None and "GIT_WORK_TREE" in local:
            tree = local["GIT_WORK_TREE"]
        elif tree is None and "GIT_DIR" in local:
            tree = UNKNOWN
        target = rundir if tree is None else tree if tree is UNKNOWN else expand(tree, local, rundir)
        if not args:
            return None
        alias = None if args[0] in BUILTINS else aliases.get(args[0].lower())
        if alias is None and args[0] not in BUILTINS:
            repo = {k: local[k] for k in ("GIT_DIR", "GIT_WORK_TREE") if k in local}
            if gitdir is not None:
                repo["GIT_DIR"] = gitdir
            if isinstance(worktree, str):
                repo["GIT_WORK_TREE"] = worktree
            got = git("/" if rundir is UNKNOWN else rundir, "config", "--get", f"alias.{args[0]}", env=repo)
            alias = got.stdout.strip() if got and got.returncode == 0 else None
        if alias is None:
            break
        if alias.startswith("!"):
            # A shell alias runs from the top of the work tree with the remaining words appended
            return check(f"{alias[1:]} {shlex.join(args[1:])}", target, depth + 1) if depth < 3 else None
        try:
            args = shlex.split(alias) + args[1:]
        except ValueError:
            return None
    else:
        return None
    op = dangerous(args[0], args[1:], target, probe)
    if op and target is not UNKNOWN:
        on_main = is_main_tree(target)
        if on_main is None:
            unchecked.append(op)
        elif not on_main:
            return None
    return op


def check(command, cwd, depth=0):
    # heres: where the next command may run if it continues the && chain; maybe: where it may run once the chain breaks
    env, heres, maybe, prev, outer, visited = dict(os.environ), [cwd], None, [UNKNOWN], [], [cwd]
    cmds, extra = commands(command)
    for i, (sep, words) in enumerate(cmds):
        if maybe is not None and sep != "&&":
            heres, maybe = maybe, None
        for c in sep:  # parentheses are a subshell: a cd inside stops applying after the closing paren
            if c == "(":
                outer.append(heres)
            elif c == ")" and outer:
                heres = outer.pop()
        local = dict(env)
        while words and ASSIGN.match(words[0]):
            local.update([ASSIGN.match(words[0]).groups()])
            words = words[1:]
        if not words:
            env = local
            continue
        words, chdir = strip_wrappers(words, local)
        bases = list(dict.fromkeys(here if chdir is None else expand(chdir, local, here) for here in heres))
        if not words:
            continue
        next_sep = cmds[i + 1][0] if i + 1 < len(cmds) else ""
        if words[0] == "export":
            env.update(ASSIGN.match(w).groups() for w in words[1:] if ASSIGN.match(w))
            continue
        if words[0] == "unset":
            for w in words[1:]:
                env.pop(w, None)
            continue
        if words[0] == "cd":
            args = [a for a in words[1:] if a not in ("-L", "-P", "--")]
            dests = prev if args == ["-"] else [expand(args[0], local, h) for h in heres] if args else [os.path.expanduser("~")]
            if "|" in (sep + next_sep) and "||" not in (sep + next_sep):
                continue  # a cd in a pipeline runs in a subshell and does not affect later commands
            dests = list(dict.fromkeys(d for d in dests if d is UNKNOWN or os.path.isdir(d)))
            if dests:
                # A cd after && or || may not run: after ||, or once a following && chain breaks, the old directory stays possible
                if "||" in sep:
                    heres, prev = list(dict.fromkeys((maybe or []) + heres + dests)), heres
                    maybe = None
                elif "&&" in sep:
                    maybe, heres, prev = list(dict.fromkeys((maybe or heres) + dests)), dests, heres
                else:
                    heres, prev = dests, heres
                visited.extend(heres + (maybe or []))
            continue
        # Commands that launch others: the bash -c string is checked on its own; xargs / find -exec yield the command after them
        name = os.path.basename(words[0])
        cflag = next((k for k, a in enumerate(words[1:-1], 1) if re.fullmatch(r"-[a-zA-Z]*c[a-zA-Z]*", a)), None)
        if name in ("bash", "sh", "zsh") and cflag:
            for base in bases:
                op = check(words[cflag + 1], base, depth + 1) if depth < 3 else None
                if op:
                    return op
            continue
        if name == "xargs":
            words = words[1:]
            while words and words[0].startswith("-"):
                words = words[2:] if words[0] in ("-I", "-n", "-P", "-L", "-s", "-d", "-E") else words[1:]
        elif name == "find":
            starts = [k for k, a in enumerate(words) if a in ("-exec", "-execdir", "-ok", "-okdir")]
            words = words[starts[0] + 1:] if starts else []
        if not words or os.path.basename(words[0]) != "git":
            continue
        for base in bases:
            op = git_op(words[1:], local, base, cwd, depth)
            if op:
                return op
    if depth < 3:
        # Which command a substitution sits in is not tracked, so check it in every directory the command visited
        for inner in extra:
            for d in dict.fromkeys(visited):
                op = check(inner, d, depth + 1)
                if op:
                    return op
    return None


def log(decision, op, payload):
    """Append one line to ~/.claude/harness/guard.jsonl; a log that cannot be written is skipped."""
    entry = {"at": int(time.time() * 1000), "guard": "shared-tree-git", "decision": decision, "op": op,
             "cwd": payload.get("cwd"), "agent_id": payload.get("agent_id")}
    path = os.path.expanduser("~/.claude/harness/guard.jsonl")
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def main():
    if os.environ.get("CLAUDE_PLUGIN_OPTION_SHAREDTREEGITGUARD", "").lower() in ("false", "0"):
        sys.exit(0)
    try:
        payload = json.load(sys.stdin)
        command = payload["tool_input"]["command"]
        cwd = payload.get("cwd") or os.getcwd()
    except (ValueError, KeyError, TypeError) as e:
        print(f"guard-shared-tree-git: could not parse input ({e}); not checked", file=sys.stderr)
        sys.exit(1)
    op = check(command, cwd)
    if op:
        log("deny", op, payload)
        print((UNVERIFIED if unchecked else REASON).format(op=op), file=sys.stderr)
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
