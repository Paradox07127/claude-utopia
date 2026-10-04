---
name: setup
description: Use when the user wants to review or change the claude-utopia plugin settings (UI language, blocked subagent models, shared-worktree git guard, idle auto-compact, mm review models, GPU hosts, dashboard toasts and chime) or finish an install. 配置 / 设置 / 改偏好.
---

# setup — review and change claude-utopia settings

Reply in the user's language. Do not edit `~/.claude/settings.json` by hand; use the `claude plugin` commands below. If a command is refused by the permission system, show the user the exact command and ask them to run it.

## 1. Find what is installed

```bash
claude plugin list
```

Note which of `dashboard`, `harness`, `mm` are installed and their full ids (`<plugin>@<marketplace>`, normally `@claude-utopia`). For each one, read the current values:

```bash
claude plugin configure <plugin>@<marketplace> --json
```

Keys in `configured` have the value shown in `inputs`. Keys in `unconfigured` use the default below, even where `inputs` shows `""`.

## 2. Ask

Show the current value of every option in one table, then ask what to change. Accept "no changes".

| Plugin | Key | Values | Default |
|---|---|---|---|
| dashboard, harness | `language` | `auto` (settings `language`, then `LC_ALL` / `LANG`, else English), `zh-CN`, `en` | `auto` |
| dashboard | `gpuHosts` | comma-separated ssh hosts (key-based login) | empty |
| dashboard | `cacheTtlMinutes` | minutes of idle before the cache warning; a fallback, used until the TTL is read from the transcript or a model switch | `60` |
| dashboard | `toastPeerAsks` | `true` / `false`: toast when another session asks a permission or its turn fails | `true` |
| dashboard | `toastPeerReplies` | `true` / `false`: toast when another session replies after a turn of two minutes or more | `true` |
| dashboard | `askSound` | `true` / `false`: chime with the toast of another session asking or failing; needs `toastPeerAsks` | `false` |
| dashboard | `toastRuns` | `true` / `false`: toast when an mmrun model returns, fails or goes stale | `true` |
| harness | `blockedSubagentModels` | comma-separated model names to refuse; empty allows all | `sonnet` |
| harness | `sharedTreeGitGuard` | `true` / `false` | `true` |
| harness | `idleCompact` | `true` / `false` | `true` |
| mm | `reviewModels` | comma-separated, from `codex`, `grok`, `agy` | `codex,grok` |

For `reviewModels`, check which CLIs exist first and only offer those (grok and agy need macOS):

```bash
for t in codex grok agy; do printf '%-6s %s\n' "$t" "$(command -v "$t" || echo missing)"; done
```

## 3. Write

Pass only the changed keys, as a JSON object whose values are all strings:

```bash
echo '{"language":"en","sharedTreeGitGuard":"false"}' | claude plugin configure harness@claude-utopia --values-stdin
```

## 4. Verify

Run `claude plugin configure <plugin>@<marketplace> --json` again for each changed plugin and confirm the changed keys are in `configured` with the new values in `inputs`. Tell the user to start a new Claude Code session for the changes to take effect.
