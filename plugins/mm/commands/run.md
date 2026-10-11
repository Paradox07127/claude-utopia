---
description: Use to hand an implementation task to another model (codex for backend logic / agy for frontend UI / grok) in its own worktree; you review the patch and merge it. Not review (use /mm:review), not consultation (use mmrun start). 派活.
---

# /mm:run — delegate implementation to another model

Reply in the user's language.

The external model works in its own git worktree opened from HEAD.
Uncommitted changes are not in the worktree; if the task depends on them, ask the user to commit first.
It cannot see this session.
It produces a patch and a self-reported JSON; the self-reported JSON is not acceptance.

## Model

| Task | Model |
|---|---|
| Backend logic, algorithms, concurrency, cross-file correctness | `codex` |
| Frontend UI (with `/impeccable` when it is installed) | `agy` |
| A second implementation to compare | `grok` |

Do not delegate what you can write yourself in 30 lines.

## Task file

Write it to your scratchpad as `task-<name>.md`, not into the repo. It contains:

1. Goal.
2. Files to change, and files not to touch.
3. Constraints, with the relevant lines of CLAUDE.md copied verbatim.
4. Acceptance commands and expected results.

Do not write your own implementation idea.

## Start

```bash
mmrun run --model codex --task <file> --dir <repo>
```

`--base <ref>` changes the starting point.
Then follow mmrun's output. When the run ends, the plugin sends the result, the patch path and the merge steps.

## Reading the result

- `not_verified` not empty → verify those claims yourself.
