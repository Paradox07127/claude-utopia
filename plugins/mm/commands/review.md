---
description: Use to review code changes, self-check before a commit, review a PR / branch / single commit / module, or have a second model cross-check. The configured models (default codex + grok) review in parallel; the external models are read-only and the main model tracks progress at low token cost. When the scope is clear, put mmrun review options straight into args (e.g. --staged, --base main, --commit <sha>, --paths "X" --full, --focus "…") and the plugin starts the review at once, delivering the findings when it finishes; when the scope is unclear, call without args and read the instructions first. 代码审查 / 外审.
---

# /mm:review — cross-model review

Reply in the user's language.

It runs on `mmrun` (shipped with the mm plugin, on PATH while the plugin is enabled). The external models are **read-only throughout** and **cannot see each other**: codex runs under its own seatbelt +
permissions table (`-p mm`), grok under a macOS `sandbox-exec` fence; neither can read the other's output, Claude's session transcripts,
or each other's session directories, and grok's compatibility scan of `~/.claude` is off too — so their findings are independent, not copied from each other.
The default models are `${user_config.reviewModels}` (the plugin's reviewModels setting); for a Gemini view add `--models codex,grok,agy` (agy runs inside the same fence).

## Step 1: pick the review scope

**Judge the scope from what the user said first, then decide whether to ask.** Lookup table:

| What the user says | Options | What it takes |
|---|---|---|
| Nothing / "look at my changes" / "review this" | (none) | `git diff HEAD` uncommitted changes |
| "check before I commit" / "I've run add" | `--staged` | `git diff --cached` |
| "review this PR" / "review this branch" / "compare with main" | `--base main` | `git diff main...HEAD` |
| "review this commit" / gives a sha | `--commit <sha>` | `git show <sha>` |
| "review module X" / "see if auth.py has problems" | `--paths "X" --full` | the **full text** of those files, not a diff |
| "only the changes under src" | `--paths "src"` | any scope above + a path filter |

Scope modifiers stack: `--base main --paths "src/api"`.

**Two cases where you must ask the user**:
1. The current branch has many commits and the user said "review this" without saying whether they mean the working tree or the whole branch — the diff may be 3 lines vs 3000 lines
2. The directory `--full` points at is large (> 50 files) — check with `git ls-files <path> | wc -l` first, and if it is too large have the user narrow it

In every other case **pick straight from the table; do not ask back**.

## Step 2: add a focus (optional)

When the user mentions a direction, pass it along, e.g. "focus on concurrency", "this change is mostly about performance":

```bash
--focus "Concurrency safety: does the new lock cover every write path to shared state"
```

Make `--focus` **specific**; do not write empty phrases like "check code quality". Long context (design constraints,
background docs) goes in through a file with `--notes-file <path>`.

⛔ **Do not feed `mmrun review` stdin through a pipe or heredoc**; it does not read stdin.

## Step 2.5: level of detail (normal mode by default)

**Normal mode is the default**: it reports only issues that affect correctness, **at most 10**, each with a location + **code quote** + failure scenario.
With more than 10, the `Not expanded: N` line at the end of the findings is greater than 0 — **when you see it, tell the user** and let them decide whether to upgrade to exhaustive. The cap is adjustable: `--max 20`.

**Use `--exhaustive` only in these two cases**:

| Trigger | How to tell |
|---|---|
| **Before a major action** | Before merging to trunk / opening a PR / releasing or deploying / landing a large refactor / deleting important code |
| **Full review** | The user says "full review", "complete checkup", "don't miss anything", "write it up as a doc", "I want fix suggestions"; or the review covers a whole module (`--paths X --full`) |

```bash
mmrun review --exhaustive          # no cap; each finding has a quote + reason + failure scenario + fix suggestion
```

⚠️ Exhaustive mode is **slow and long**: it takes several times longer than normal mode and reports more findings, with much longer output — **do not make it the everyday default**.

**When you cannot tell, run normal mode**; the `Not expanded: N` line at the end tells you whether to run again.
When the user just casually says "review this", do not decide on your own to go exhaustive.

## Step 3: run (just start it, do **not** wait)

Start it with this one Bash command:

```bash
mmrun review [scope] [--focus "..."] --models ${user_config.reviewModels}
```

When the user named no models, you must pass `--models ${user_config.reviewModels}` (mmrun's own default does not follow this setting); when the user named models, use theirs.

It returns a RUNID immediately. Do **not** run `mmrun wait` afterwards; once the mm plugin sees the RUNID, it sends you each model's
critical/major findings together with the judge rules when the run finishes, and you can do other work in the meantime.

Fetch more detail by hand only when you need it:

```bash
mmrun result codex --top
```

The findings are structured JSON the model fills in per `${CLAUDE_PLUGIN_ROOT}/mmrun.d/review.schema.json`; `result` renders them as
`verdict / summary / findings grouped by severity (file:line + quoted source + failure scenario) / Not expanded: N`.
`--top` takes only critical + major. Drop `--top` to read everything only once you have decided to handle minor/optional,
or write it out with `mmrun report -o file.md` for the user to browse. `mmrun result grok --top` works the same way.
The raw JSON is in `<RUNID>/<model>.json`; use it for machine merging.

**Concurrency safety**: `.latest` is stored per `CLAUDE_CODE_HOST_SESSION_ID`, so several Claude sessions
running their own mmrun at once do not overwrite each other. You only need to pass a RUNID explicitly to get another session's results (look it up with `mmrun ls`).

## Step 4: judge (**filter first, then synthesize**)

Once you have both sets of findings, **do not just relay them**. Score each one and drop those `< 80`.

**Confidence rubric** (give each finding one score, no values in between):

| Score | Meaning |
|---|---|
| 100 | I read that code, I am sure it fails, and I can name the input that triggers it |
| 75 | The code really is wrong, but the trigger depends on callers I have not read |
| 50 | It looks suspicious, but I have not read enough context to decide |
| 25 | Just style/preference, or the model is restating the code |
| 0 | The quoted `file:line` does not match, or that code is not in this scope at all |

**Keep only ≥ 80.** Do not explain the dropped ones one by one; write a single line at the end: `Dropped N low-confidence findings`.

**False-positive blacklist** (a hit is dropped outright, without scoring):
1. Lines this diff did not touch
2. Things a linter / typechecker / compiler would catch anyway
3. Style preferences with no basis in CLAUDE.md
4. Suggestions to **add an abstraction layer, add a config option, or add a fallback branch** — always downgrade to Optional first;
   see the harness plugin's `ai-code-cleanup` skill for why: a reviewer asked to find problems pads its list,
   and chasing such findings feeds over-engineering
5. Generic "consider evaluating / have you considered / could be further optimized" without a concrete `file:line`
6. Old problems already on trunk, unrelated to this change

**Coming back empty-handed is fine.** With no finding at ≥80, the output is just this line; do not pad:

```
No issues. Checked: correctness defects, CLAUDE.md compliance. Dropped N low-confidence findings.
```

### Only then synthesize

- Both models report the same finding = give it 100 directly and handle it first
- Only one reports it = **read that code yourself and decide**; no voting, and do not drop it because "the other one did not report it"
- After merging and deduplicating, list by Critical / Major / Minor / Optional, each with its source model and `file:line`
- Do **not** change the code for the user unless they explicitly ask

When a record is needed, merge the two models' raw findings into one markdown file:

```bash
mmrun report -o review-report.md
```

It outputs the Run metadata + each model's full findings (**not deduplicated, not merged**; deduplication is your job).
To delegate implementation work to another model, use `/mm:run`.
Use it when the user says "write it up as a doc" or "make a report", then give the synthesized findings + the doc path in your reply.

## Token discipline (the reason this command exists)

- ✅ Read only the findings the plugin sends, the `mmrun status` table (about 30 tokens), and the final findings from `mmrun result`
- ⛔ **Do not read** `~/.claude/mmruns/<RUNID>/*.raw` — the full event stream, tens of thousands of tokens; look only at its last lines when troubleshooting
- ⛔ **Do not go** into `~/.codex/sessions/` or `~/.grok/sessions/` for status; the status is in the status table

## Troubleshooting

- A model shows `FAIL:<code>` → `tail -20 ~/.claude/mmruns/<RUNID>/<model>.raw`
- `mmrun ls` lists recent runs, `mmrun clean 7` removes those older than 7 days
- To use only one model: `--models codex` or `--models grok`

## Beyond review

For any question run across several models in parallel, use `mmrun start` (this one **does read** stdin):

```bash
mmrun start --models codex,grok --tag <name> <<'EOF'
<your question>
EOF
```

Then `wait` → `result` as usual.
