# progress

A per-project progress board for Claude Code, built on [mods](https://code.claude.com/docs/en/plugins/mods/overview).

The plugin registers one tool, `mcp__progress__progress`. Before its final reply in a conversation that finished or paused a piece of work, the main model records that work as 1–3 nodes: a title, a summary, a status (`todo`, `doing`, `done`, `blocked`), a kind (`feature`, `fix`, `research`, `infra`, `docs`), and links to earlier nodes (`builds_on`, `depends_on`). `list: true` answers the 30 most recent nodes.

## Where the board is kept

Chosen once per project. The first call asks, and the model puts the question to you:

- `local`: `~/.claude/progress/<project>/events/`, outside the project.
- `git`: `.notes/board/events/` in the session root, committed with the project. The plugin never runs `git add` or `git commit`.

The choice is kept in `~/.claude/progress/<project>/config.json`, where the project is the repository's main worktree, so a session in a linked worktree uses the same choice. Each session writes only its own `<session>.json`; reading folds every session's file, the latest value of each field winning.

## Canvas (optional)

`canvas/progress-web.html` is a draggable board to publish as an Artifact with `db`. Write its URL to `~/.claude/progress/canvas.json` as `{"url": "…"}`; from then on each tool result carries an ArtifactData batch for the model to submit, and the first one also mirrors the nodes recorded before.

## Options

None.

## With dashboard

The `dashboard` plugin's Progress page reads the same board and shows its tab once the project has a board.
