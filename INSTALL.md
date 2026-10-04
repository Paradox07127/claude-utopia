# Installing claude-utopia (instructions for Claude)

You are installing the claude-utopia plugins for the user. Follow these steps in order. Talk to the user in their language. Do not edit `~/.claude/settings.json` by hand; use the `claude plugin` commands below. If a command is refused by the permission system, show the user the exact command and ask them to run it, then continue.

## 1. Check the environment

```bash
claude --version
```

The version must be 2.1.287 or later. If it is older, tell the user to update Claude Code first and stop.

```bash
for t in git jq python3 ssh codex grok agy; do printf '%-8s %s\n' "$t" "$(command -v "$t" || echo missing)"; done; uname -s
```

- `harness` needs `python3` (its git guard runs before every Bash call, even when switched off).
- `mm` needs `git`, `jq`, `python3` and at least one of `codex`, `grok`, `agy`. The grok and agy read-only fence needs macOS (`Darwin`); on other systems only `codex` can be used.
- `progress` needs nothing extra.
- `dashboard` needs nothing extra, except for GPU hosts: `ssh` that logs in without a prompt (key-based), and `nvidia-smi` or `tegrastats` on the host.

If `git`, `jq` or `python3` is missing, tell the user which plugin needs it and ask them to install it. If none of the usable model CLIs is installed, tell the user `mm` will not work until one is, and ask whether to install the `mm` plugin anyway.

## 2. Ask the user

Ask these in one message, with the defaults shown, and accept "defaults" as an answer:

1. Which plugins to install: `dashboard`, `harness`, `mm`, `progress` (default: all four). `progress` is a per-project board on which the main model records each conversation's work; it has no options.
2. UI language for `dashboard` and `harness`: `auto` (follow Claude Code's language setting and the system locale), `zh-CN` or `en` (default `auto`).
3. `harness`: model names to refuse for subagents, comma-separated (default `sonnet`; empty allows all); whether to guard the shared main worktree against git commands that discard uncommitted work (default yes); whether to run `/compact` automatically when the main thread idles until just before the prompt cache expires (1h cache: 10 minutes before, at 100k tokens or more; 5m cache: 1 minute before, at 200k or more; the TTL is read from the transcript) (default yes).
4. `mm`: models `/mm:review` uses by default, from the usable CLIs found in step 1 (suggest `codex,grok`, minus any that are missing or unusable).
5. `dashboard`: ssh host names with GPUs to watch, comma-separated (default none); the fallback prompt cache TTL in minutes, after which the band warns that the next message rewrites the prompt cache, used only until the real TTL is known (default `60`); whether to toast when another Claude Code session asks a permission or its turn fails (default yes), when another session replies after a turn of two minutes or more (default yes), and when an mmrun model returns, fails or goes stale (default yes); whether to play a short chime with the toast of another session asking or failing (default no; needs that toast on).
6. Whether to install the `worker` and `researcher` agent templates into `~/.claude/agents/` (default no). Mention that with them installed, `harness` hides the built-in `general-purpose` agent.

## 3. Install

```bash
claude plugin marketplace add Paradox07127/claude-utopia
```

Then, for each chosen plugin:

```bash
claude plugin install <plugin>@claude-utopia
```

Each install prints that some userConfig options are not set yet; step 4 handles that, and unset options use their defaults.

## 4. Configure

The defaults are: `language` `auto`; `blockedSubagentModels` `sonnet`; `sharedTreeGitGuard` `true`; `idleCompact` `true`; `reviewModels` `codex,grok`; `gpuHosts` empty; `cacheTtlMinutes` `60`; `toastPeerAsks` `true`; `toastPeerReplies` `true`; `toastRuns` `true`; `askSound` `false`. Write every value that differs from these defaults (so if the user's `reviewModels` is not exactly `codex,grok`, write it). Values are passed as a JSON object whose values are all strings, including booleans and numbers. Examples:

```bash
echo '{"language":"zh-CN","blockedSubagentModels":"","sharedTreeGitGuard":"false"}' | claude plugin configure harness@claude-utopia --values-stdin
```

```bash
echo '{"language":"zh-CN","gpuHosts":"gpu-box,gpu-box-2","askSound":"true"}' | claude plugin configure dashboard@claude-utopia --values-stdin
```

```bash
echo '{"reviewModels":"codex"}' | claude plugin configure mm@claude-utopia --values-stdin
```

## 5. Agent templates (only if the user said yes)

```bash
loc="$(claude plugin marketplace list --json | python3 -c 'import json,sys; print(next(m["installLocation"] for m in json.load(sys.stdin) if m["name"] == "claude-utopia"))')"
```

```bash
mkdir -p ~/.claude/agents && cp -n "$loc/agents/worker.md" "$loc/agents/researcher.md" ~/.claude/agents/
```

`cp -n` does not overwrite. If a file with the same name already existed, show the user the difference from the template and ask before replacing it.

## 6. Verify

```bash
claude plugin list
```

Each chosen plugin must show `enabled` under `@claude-utopia`.

```bash
claude plugin configure harness@claude-utopia --json
```

Repeat for each installed plugin. Keys listed in `configured` must have the values you wrote, as shown in `inputs`. Keys listed in `unconfigured` use the defaults from step 4, even where `inputs` shows `""`.

Then tell the user to start a new Claude Code session so the plugins and options take effect, and to check there:

- `dashboard`: `/dashboard` opens the workbench.
- `harness`: `/harness:setup` is listed in the `/` menu.
- `mm`: `mmrun` with no arguments prints its usage from the Bash tool.
- `progress`: asked to call the `progress` tool with `list: true`, Claude gets an answer; in a project with no board yet, it is the question of where to keep the board.

## Changing settings later

With `harness` installed, run its `setup` skill (`/harness:setup`). It shows the current options, asks what to change, writes the changes and verifies them (steps 2.2–2.5, 4 and 6). To add or remove plugins or the agent templates, follow steps 3 and 5 again.
