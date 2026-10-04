---
description: Use to hand an implementation task to another model (codex for backend logic / agy for frontend UI / grok) to do in its own worktree, while you only review the diff and then merge it. Not review (use /mm:review for that), and not consultation (use mmrun start). 派活.
---

# /mm:run — delegate implementation to another model

Reply in the user's language.

It runs on `mmrun run` (shipped with the mm plugin, on PATH while the plugin is enabled). The external model works in its **own git worktree**, cannot write outside the worktree,
and cannot read Claude's session transcripts or other models' output. What it produces is a patch + the JSON it self-reports per the schema. **You do not watch its process; you only look at the diff.**

## Step 1: pick the model

| Task | Model | Why |
|---|---|---|
| Backend logic, algorithms, concurrency, cross-file correctness | `codex` | Strongest on deep correctness |
| Frontend UI / styling / interaction | `agy` | Gemini is strong at frontend; use it with `/impeccable` |
| A second implementation approach to compare | `grok` | Only when you explicitly want a comparison |

Do not delegate what you can write yourself in 30 lines. Delegating costs: writing the task file + waiting 5-15 minutes + reviewing the diff.

## Step 2: write the task file

Write it to your scratchpad directory (or a temp file) as `task-<name>.md` (not into the repo). **The external model cannot see your conversation; anything not written in the task does not exist.** It must contain:

1. Goal: what to change and why (one or two sentences)
2. File list: which files to touch; state explicitly which ones **must not be touched**
3. Constraints: style, forbidden practices, features not to add (**copy the relevant lines of CLAUDE.md in verbatim**; do not just cite the path)
4. Acceptance: which commands to run and what results to expect

Do not write your own implementation idea into it — it would copy your bias, and delegating would lose its point.

## Step 3: run (just start it, do **not** wait)

Start it with this one Bash command:

```bash
mmrun run --model codex --task /path/task.md --dir <repo>
```

The worktree is opened from HEAD (`--base <ref>` changes that). **Uncommitted changes are not in the worktree** — if the task depends on them, have the user commit or stash first.

It returns a RUNID immediately. Do **not** run `mmrun wait` afterwards; once the mm plugin sees the RUNID, it sends you the result, the patch path and the merge steps when the run finishes.
To look again, fetch it by hand:

```bash
mmrun result <model> <RUNID>
```

The output is `status / summary / checks_run (command → exit code · result line) / not_verified / decisions_made / questions` + the patch path and stat.

- `status: blocked` → take `questions` to the user; do not guess the answers and delegate again
- `not_verified` not empty → verify those claims yourself
- `checks_run` empty → it ran no checks; you must run them before merging

## Step 4: review the diff, then merge

**Read the patch yourself first** (`cat ~/.claude/mmruns/<RUNID>/<model>.patch`), against the task's acceptance items.
When the risk is high or the change is large, also have another model cross-review it (`--patch` reviews exactly the patch that will be applied, without touching the worktree):

```bash
mmrun review --patch <RUNID> --models codex   # work done by agy gets reviewed by codex, and vice versa
```

Judge rules as in `/mm:review`: settle each finding by reading the code yourself; no voting.

If satisfied, apply it to the original repo's working tree (no commit; the worktree is removed automatically):

```bash
mmrun apply <RUNID>
```

If not, discard it:

```bash
mmrun discard <RUNID>
```

When `apply` hits a conflict it refuses and leaves the patch path; handle it by hand with `git apply --3way`.

## Token discipline

- Read only the findings the plugin sends, the `mmrun status` table and the findings from `mmrun result`
- ⛔ Do not read `~/.claude/mmruns/<RUNID>/*.raw` (the event stream, tens of thousands of tokens)
- Look at `tail -20 <RUNID>/<model>.raw` only when troubleshooting
