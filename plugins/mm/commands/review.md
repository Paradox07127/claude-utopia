---
description: Use to review code changes, self-check before a commit, review a PR / branch / single commit / module, or have a second model cross-check. When the scope is clear, put mmrun review options straight into args (e.g. --staged, --base main, --commit <sha>, --paths "X" --full, --focus "…"); otherwise call without args. 代码审查 / 外审.
---

# /mm:review — cross-model review

Reply in the user's language.

The external models cannot see this session.

## Scope

| What the user says | Options |
|---|---|
| Nothing / "look at my changes" | (none) |
| "check before I commit" | `--staged` |
| A PR / a branch / "compare with main" | `--base main` |
| One commit | `--commit <sha>` |
| A module / the full text of files | `--paths "X" --full` |
| Only changes under one directory | add `--paths "src"` |

Options stack: `--base main --paths "src/api"`.

Ask the user first only in two cases:
1. The branch has many commits and "review this" could mean the working tree or the whole branch.
2. The `--full` directory has more than 50 files (`find <path> -type f | wc -l`).

Otherwise pick from the table.

## Options

- `--focus "<specific direction>"`, e.g. `--focus "does the new lock cover every write path to shared state"`.
- Long context goes in with `--notes-file <path>`.
- Normal mode is the default (at most 10 findings).
- Use `--exhaustive` only:
  - before merging to trunk, opening a PR, releasing, landing a large refactor or deleting important code;
  - when the user says "full review", "don't miss anything" or "write it up as a doc";
  - when reviewing a whole module (`--paths X --full`).
- When unsure, use normal mode.
- For a Gemini view: `--models codex,grok,agy`.

## Start

```bash
mmrun review [scope] [options]
```

Then follow mmrun's output. When the run ends, the plugin sends each model's critical/major findings and the judge rules.

mmrun keeps the material small:
- Lockfiles, JSON, test data, generated files (also `linguist-generated`, `linguist-vendored` and `-diff` in `.gitattributes`) and scratch files (`.orig`, `.bak`, `.notes/`) are left out; the models see them listed (`LEFT OUT` line).
- Tests go in only while the part has room.
- A change under 50 KB goes in with the whole function around each hunk, unless that no longer fits one part.
- A change over 150 KB is split by files into up to 4 parts, one run each (`PART i/n` lines). The plugin sends one message once every part has ended; `mmrun report` covers every part. One file over 150 KB gets a part of its own.
- A `NOTE` line names source files that no part holds: files past the 4-part limit (review them with `--paths "<files>"`), and single diffs over 400 KB (tell the user).

For a written report, `mmrun report -o <file>.md`; for other subcommands (start, ask, room, thread, cancel, clean), run `mmrun` without arguments to see usage.
