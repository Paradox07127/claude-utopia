---
name: interrogate
description: Use when auditing an existing project, taking over an unfamiliar codebase, suspecting the architecture has grown crooked, wanting to know which modules nobody dares touch, or asked to "interrogate this project". Anchors every question in git facts; each one must carry file:line + git evidence + the action to take if nobody can answer. It audits "why the whole project ended up this way", not a single change — for change review use /mm:review. 触发词:拷打这个项目、审项目。
---

# interrogate — grill the project

Reply in the user's language.

## Do not use this for

- Reviewing this diff / PR → `/mm:review`
- Finding security vulnerabilities → `/security-review`
- Deleting AI-written over-defense and thin wrappers → `/harness:ai-code-cleanup`
- A project you wrote yourself last week → you already know the answers; don't waste 20 minutes

## Three levels

| Level | Time | What it does |
|---|---|---|
| `--recon` | ~3 min | Fact tables only, **no judgments of any kind**. All reproducible numbers |
| No argument (default) | ~15 min | Fact tables + at most 10 questions |
| `--exhaustive` | ~40 min | Adds a `/mm:review`-style cross-check round: codex picks out the weak items in Claude's questions, Claude picks back. No cap on the count |

**You may only move up a level, never down.** When torn between two levels, take the heavier one. The urge to slap a lightweight label on it to skip work is itself the signal to move up.

## Step 0: health check (decides which analyses are meaningful; do not skip)

```bash
FIRST=$(git log --reverse --format='%ad' --date=short | head -1)
DAYS=$(( ( $(date +%s) - $(git log --reverse --format='%at' | head -1) ) / 86400 ))
COMMITS=$(git rev-list --count HEAD)
AUTHORS=$(git shortlog -sn --no-merges HEAD | wc -l | tr -d ' ')
echo "history ${DAYS} days (since $FIRST) · ${COMMITS} commits · ${AUTHORS} authors · $(git ls-files | wc -l | tr -d ' ') files"
```

Based on the result, **turn off analyses that have no discriminating power**, and state in the report which ones you turned off and why:

| Condition | Action |
|---|---|
| `AUTHORS == 1` | **Skip ownership analysis.** In a single-author repo 100% ownership is the norm, not a signal |
| `DAYS < 90` | **Skip code-age analysis.** A four-week-old repo can't have "long untouched" code |
| `COMMITS < 50` | **Skip co-change analysis.** The matrix is too sparse; co-changing twice says nothing |
| `COMMITS < 20` | Output only the directory tree and file sizes, and say "too few commits; git behavior analysis gives no signal" |

⚠️ **The criterion is commit count, not time span.** Hotspots and co-change need enough change samples —
a 4-week repo with 343 commits gives fully valid hotspot analysis; a 3-year repo with 20 commits does not.
Replace `--since=12.month` with a window that covers enough commits; if the history is short, drop `--since` entirely.

Better to give one table fewer than to pass off a table full of 100% as insight.

## Part 1: fact tables (pure data; the exact commands must go into the report)

**Hotspots — change count over the last 12 months**
```bash
git log --format=format: --name-only --since=12.month | grep -v '^$' \
 | grep -vE '\.(json|lock|xcstrings|pbxproj|svg|png)$' \
 | sort | uniq -c | sort -nr | head -30
```

**Line-level churn — amount changed, not count**
```bash
git log --since=12.month --numstat --format="" \
 | awk 'NF==3 {a[$3]+=$1; d[$3]+=$2} END {for (f in a) printf "%8d %8d  %s\n", a[f], d[f], f}' \
 | sort -rn | head -30
```

**Logical coupling — which two files always change together (the most effective way to catch "the abstraction boundary is drawn wrong")**
```bash
git log --since=12.month --name-only --format="%H" \
 | awk 'NF==1 && length($1)==40 {h=$1; next} NF {print h"\t"$0}' | sort -u \
 | awk -F'\t' '{a[$1]=a[$1]" "$2} END {for (h in a){n=split(a[h],f," ");
     if(n>1&&n<20) for(i=1;i<n;i++) for(j=i+1;j<=n;j++){
       k=(f[i]<f[j]?f[i]"|"f[j]:f[j]"|"f[i]); c[k]++}}}
   END{for(k in c) print c[k], k}' | sort -rn | head -30
```

**Ownership (run only when AUTHORS > 1)**
```bash
git ls-files | while read f; do
  t=$(git log --no-merges --format='%an' -- "$f" | wc -l | tr -d ' ')
  m=$(git log --no-merges --format='%an' -- "$f" | sort | uniq -c | sort -rn | head -1 | awk '{print $1}')
  [ "${t:-0}" -gt 3 ] && echo "$((100*m/t))% n=$t $f"
done | sort -rn | head -30
```

**Code age (run only when DAYS >= 90)**
```bash
git ls-files | while read f; do echo "$(git log -1 --format=%ad --date=short -- "$f") $f"; done | sort | head -40
```

To trace where a suspicious symbol came from: `git log -S"<symbol>" --oneline --all -- <path>`

**Read co-change correctly**: high co-change between extensions split from the same class usually just means the feature is cohesive, not necessarily a problem;
high co-change **across modules** is the signal (`api/user.ts` and `db/user_repo.ts` co-changed 31 times → what did this separation buy?).

## Part 2: questions (at most 10)

**Each one must carry all three; missing any one, it may not appear in the report:**

1. `file:line`
2. One piece of git evidence — the sha + message of the commit that introduced it, or "changed N times in the last year", or "co-changed with X N times"
3. The action to take if nobody can answer — delete it / merge the two layers / add a reproduction test

**Four templates (anchored in evidence):**

- **Abstraction layer**: this interface at `src/x.ts:40` has only one implementation (grep N=1); what is the second implementation it is guarding against?
- **Flag**: `FEATURE_Y` (`config.ts:12`, introduced in `a1b2c3d`, message just "wip") — who reads it now? What is its production value?
- **Fallback**: the try/except at `handler.py:88` swallows the exception; which real incident does it correspond to? Link the issue or commit.
- **Boundary**: `A` and `B` co-changed N times in the last year; what did this separation buy?

**Banned phrases (in any language) — if one appears, rewrite that item:**
"have you considered", "suggest evaluating", "could be further optimized", "suggest strengthening", "open to debate", "worth attention"

Every question must be answerable with **one fact**: "because of a customer's bug in 2023", or "nobody knows".
**"Nobody knows" is itself a conclusion**; write it down as is, then carry out action 3.

If there are more than 10, write one line `Not expanded: N` and **let the user decide whether to move up a level**; don't run the exhaustive pass on your own.

First demand an answer for why the fence is there; act only if nobody can answer — the same rule as "prove it's dead before deleting anything".

## Part 3: dead-code candidates

A repo-wide grep produces **candidates, not conclusions**. Three steps:

1. Grep the whole repo, including config, SQL, templates, persisted strings, CI scripts, docs
2. **Then grep dynamic call entry points**: `eval`, `getattr`, `Class.forName`, `NSClassFromString`,
   `#selector`, route names / job names built from strings — static tools always miss these
3. Called only by tests = candidate. **First insert a log line or probe and run one business cycle**; delete only if it never fires

Mark each with: grep hit count | called only by tests or not | needs probe verification or not

Off-the-shelf tools: `knip` for JS/TS, `vulture` for Python. (`ts-prune` is archived; don't use it.)

## Output

One md file, three parts. **No remediation plan, no time estimates, no 1-10 scores**
(CodeScene's health-score algorithm is closed source; inventing your own is false precision). **Delete nothing automatically.**

## Acceptance criteria (don't output unless all are met)

1. Every question's `file:line` is hit by `grep -n`, and the line content matches what the question describes
2. Every cited commit sha exists per `git cat-file -e`
3. No banned phrase appears in the questions
4. The exact fact-table commands are in the report, and rerunning them yields the same tables
5. For every analysis turned off in step 0, the report states why
