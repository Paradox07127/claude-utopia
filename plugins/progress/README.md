# progress

A per-project progress board for Claude Code, built on [mods](https://code.claude.com/docs/en/plugins/mods/overview).

The plugin records the work itself; it registers no tool. After each main-thread turn you started by typing a prompt, and in which a file was edited (by the main model or a subagent) or a new commit was made, it sends the turn's facts to Sonnet through a completion: the head of your prompt and of the final answer, the edited paths, the new commits, and the board's recent nodes. Sonnet answers with 0–3 nodes, each a title, a summary, a status (`todo`, `doing`, `done`, `blocked`), a kind (`feature`, `fix`, `research`, `infra`, `docs`), and links to earlier nodes (`builds_on`, `depends_on`), or an update of an existing node. The plugin checks them and writes them; a reply it cannot use writes nothing. Questions, interrupted turns, notifications and turns that changed nothing are not recorded. Each recording is one Sonnet completion, billed to your session.

## Where the board is kept

Chosen once per project. The first recording asks you; if you dismiss the question (or in a `-p` run), nothing is recorded and the session does not ask again:

- `local`: `~/.claude/progress/<project>/events/`, outside the project.
- `git`: `.notes/board/events/` in the session root, committed with the project. The plugin never runs `git add` or `git commit`.

The choice is kept in `~/.claude/progress/<project>/config.json`, where the project is the repository's main worktree, so a session in a linked worktree uses the same choice. Each session writes only its own `<session>.json`; reading folds every session's file, the latest value of each field winning.

## Canvas (optional)

`canvas/progress-web.html` is a draggable board to publish as an Artifact with `db`. Write its URL to `~/.claude/progress/canvas.json` as `{"url": "…"}`; from then on the plugin submits an ArtifactData batch after each recording, and until one batch has gone through, each also mirrors the nodes recorded before.

## Options

None.

## With dashboard

The `dashboard` plugin's Progress page reads the same board and shows its tab once the project has a board.
