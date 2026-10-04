---
name: verify-change
description: Use before committing, or after a round of changes lands, when you want to see which modules this diff touched and whether docs and tests kept up. Runs a script that reports file categories, affected modules, and doc-sync and test-coverage warnings. Not a code review (use /mm:review for that). 触发词:改动检查、文档同步。
allowed-tools: Bash, Read, Grep
argument-hint: [--mode working|staged|committed] [--json]
---

# verify-change

Reply in the user's language.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/change_analyzer.js" $ARGUMENTS
```

By default it analyzes uncommitted changes in the working tree; `--mode staged` looks at the index, `--mode committed` looks at HEAD~1..HEAD, `-v` is verbose, `--json` is machine-readable.

Once you have the report, do only two things:
1. Relay each ⚠️ to the user, one by one (code changed >50 lines but DESIGN.md untouched, >30 lines but no tests, new files but README not updated, config changed but not documented).
2. If the affected-modules field lists modules you never touched, check their callers with `codegraph_impact` or grep before drawing a conclusion.

Do not write docs or tests for the user unless they ask.
