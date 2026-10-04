---
name: ai-code-cleanup
description: >
  Use when the user wants to cut AI over-defense, thin wrappers (1–2 statement
  forwards), multi-layer shells, backward-compat residue (legacy aliases,
  un-deleted old paths, unshipped-version migrations), lint suppressions, or
  demand-free fallbacks — in any language or framework — or says legacy alias,
  deslop, anti-slop, "cut dead code", or /harness:ai-code-cleanup. Deletes them safely.
  Not for new features, architecture replacement, or domain-semantics rewrites
  (rendering, protocol, business rules). 触发词: 清理 AI 代码, 过度防御, 薄封装,
  套壳, 死码, 兼容残留, 无需求兜底.
---

# AI-generated code cleanup (any language / any framework)

Reply in the user's language.

Delete AI bloat without changing product semantics. Core: **ask "should this exist" before "how could it be written better"**. Cleanup = less code, not new abstractions.

Counterparts: use a code review to find problems; an architecture replacement is a separate, planned change. This skill does only **subtraction** inside the existing architecture.

## 0. When to use / when not to

**Use**: the user wants to cut over-defense, thin wrappers, shells, compat residue, lint suppressions, demand-free fallbacks, deslop / anti-slop.

**Don't use**: new features, architecture changes, domain semantics (rendering/protocol/business rules), switching a security policy to fail-open, formatting only.

## Overall criteria (two rulers, ahead of any pattern list)

1. **Dialect consistency**: slop is relative, anchored in the file's existing style. The criterion is "this part looks transplanted from elsewhere, not native to this file" — compare comment density, defense density, and abstraction depth with the surrounding code, not with an ideal.
2. **Trust model**: whether a defensive check should exist depends on **whether the caller has already validated**. Validation at system boundaries (user input, network, files, IPC) is KEEP; redundant defense on internal already-validated paths is deleted. This holds both ways: when deleting internal defense, you may not trim boundary validation along the way.

## 1. Iron rules (scar: written only after real breakage)

1. **TODO / Adopt or retire / never wired / unconsumed = feature backlog, KEEP by default.** Not dead code.
2. **Deleting a public symbol: rg production + all tests + package tests together.** Scanning only production leads to deleting test surface by mistake.
3. **Compat layers are judged by named contract** (see §2 classes 5/6), not by the words "for compatibility" in a comment — the comment was written by AI and is not evidence.
4. **Intentional security is KEEP** (authz, CSP, path safety, trust, lease). Only catch/`??`/fail-open with no requirement behind it gets deleted.
5. **Dynamic entry points are KEEP** (reflection, selector, delegate, route strings, serialization key names, FFI exports).
6. **Ask first in forbidden zones**: build project files, entitlements/manifest permissions, secrets, conditional-compilation variants changed only halfway.
7. **One comment per line of code, long essays on special cases, comments that restate the code** → delete or compress to ≤2 lines of why. A 1–2 line responsibility note at the top may stay.
8. **Don't change the same file in parallel.** Multiple agents must have mutually exclusive files.

## 2. Local smells: nine classes to cut (by ROI)

| # | Class | Criterion | Action |
|---|----|------|------|
| 1 | **Thin wrapper (the biggest share)** | Body is essentially 1–2 statements, only calls another API / returns it unchanged, no semantic-rename value | Inline, then delete |
| 2 | **Multi-layer pointless shells** | A→B→C, middle layer has zero policy | Callers go straight to the bottom layer; delete the middle |
| 3 | **Over-defense + its tests** | Trust model mismatch: caller already validated but it validates again; null check after the type already guarantees non-null; guards on impossible paths; "error handling that handles nothing" | Delete guard + tests; leave boundary validation alone |
| 4 | **Overly broad exception handling + its tests** | Empty catch, log-only and continue, catch then rethrow unchanged, catch-log-rethrow at every layer duplicating logs, tests for "the catch that is never reached" | Delete, or let the error bubble up; keep logging only at the layer that actually handles the error |
| 5 | **API-level compat residue** | Old-name alias / deprecated forward left after a rename, old path not deleted after migration, legacy parameters, compat layers in a greenfield project | No named contract (see below) → change all callers + delete the old name, in one go |
| 6 | **Persisted-data compat (unshipped)** | retired / still read once / pre-release, **no evidence of real user data** | Delete migration + tests |
| 7 | **Lint suppressions and type escapes** | disable / `@ts-ignore` / `as any` / force cast / `nolint` with no reason | Change the code to remove the suppression; if you can't, write down why |
| 8 | **Demand-free fallbacks** | `?? default` with no product requirement, fallback chains (A fails, try B, try C), mock/fake data standing in for a real failure, failures smoothed into "looks like success" | Delete the fallback; failures should be visible |
| 9 | **Debug leftovers and file copies** | Leftover print/console.log tracing; whole-file copies and parallel implementations like `_old`/`_backup`/`enhanced_x` | Delete directly (lowest risk, can go first) |

**Named-contract whitelist for compat layers** (any one → KEEP): public API/CLI/config/data-format contracts; tagged, shipped upgrade paths; security boundaries; observed production state. **The criterion is "is there a real external caller / real user data", not a blanket rule in one direction** — overshooting the other way (breaking a contract in use, or blowing up existing tests, to delete compat) is just as much an incident.

Detailed patterns and the KEEP table are in [`references/criteria.md`](references/criteria.md); **for Swift/Xcode projects also read** [`references/swift.md`](references/swift.md) (concurrency escapes, weak self, redundant #available, SwiftUI shells, dynamic entry point list).

## 2b. Structural entropy: four classes (cross-file, highest ROI per item)

The nine classes above can be caught with a single rg pattern; these four **cannot** — the criterion is "how many copies of the truth, how many contracts, how many states does this system have to maintain", which only an ownership map reveals. The approach differs too: touch **one ownership boundary** at a time, and don't batch these with the nine classes.

| # | Class | Criterion | Action |
|---|----|------|------|
| 10 | **Mirrored fact** | Two or more places (cache/snapshot/derived field/parallel event/adapter) record the same fact and must be kept in sync to avoid conflict | Collapse to the load-bearing copy; compute the rest. **Don't "connect" the two truths with a sync wrapper — that adds entropy** |
| 11 | **Lifecycle duplication** | One transition (ready / started / suspended / stopped / settled / disposed) is expressed separately by several flags, sentinels, continuations, queues | Draw the table first: each flag → which owner, which transition. Merge those with the same owner and same transition; **never merge same-named states of different owners** |
| 12 | **Hand-rolled existing infrastructure** | Locally implemented parsing / retry backoff / glob / diff / framing / data structures already covered by the standard library or a library **already depended on** | Switch to the standard facility. **Adding a dependency for this doesn't count**: if glue + dedicated tests aren't smaller than the original implementation, KEEP |
| 13 | **Added-then-abandoned residue** | The implementation is gone, but flags, schema, docs, tests, compat branches, decision notes still describe it | Follow the "descriptions" and delete them all; use `git log --diff-filter=D` to find which commit deleted the implementation, as evidence |

**These four need one more piece of evidence than the nine: you must read git history / decision records** to answer "does the problem that created this surface still exist". If you can't find why it exists → `DEFER`, don't delete.

The KEEP table and detection techniques are in [`references/criteria.md`](references/criteria.md) §M.

## 3. Process (must follow in order)

### E0 Define scope and success criteria

Write down: which trees to scan, forbidden zones, how to prove you're done (which tests / which build). If you can't define them, ask first.

### E1 Scan + classify (list first, then change)

Mark each candidate: `DELETE_OK` / `COLLAPSE` / `TEST_ONLY_API` / `DEFER` / `KEEP`.

`COLLAPSE` is **§2b only**: the action is merging two truths / two mechanisms; line count may barely change, what shrinks is **the number of states and illegal states**. Don't force it into `DELETE_OK` (it isn't a deletion) or `DEFER` (its conclusion is clear).

Minimum evidence standard (all of):

1. Repo-wide rg (production + tests + resources/strings/config)
2. Not a dynamic entry point, not a TODO feature, not intentional security, doesn't meet a named contract
3. Still dead under all build variants (flavor / `#if` / feature flag / multiple targets)
4. **Extra for the §2b four classes**: git log / decision records can explain why it originally existed, and that reason no longer holds

**Escape hatch when history has been flattened** (squashed repos, initial public release, migrated repos): `git log -S` can only land on the root commit, so the previous item means "DELETE_OK is always 0". **Revised rule**: code-internal invariants may stand in for git evidence, provided all of these hold — (a) the mechanism's invariant or unreachability can be derived from the code itself (an always-true flag, a one-way irreversible terminal state, an illegal state in a Cartesian product); (b) zero test references repo-wide, or tests only pin the mechanism itself, not behavior; (c) write the sentence "invariant used in place of history", for re-review. **First run `git rev-list --count HEAD` and check the root commit to confirm the history really is flattened before using this hatch** — it is not allowed in a normal repo.

Heuristics (language-agnostic):

- Function body of 1–2 lines that is `return other(...)` or a single `other(...)` call → thin-wrapper candidate. **Before inlining, check which directory `other` is defined in**: a one-line forward across layers/modules is often a **boundary convergence point**, not a shell (see criteria.md §A)
- rg `legacy|deprecated|for backward|for compatibility|_v2|_old|Enhanced|Improved` → compat-residue / naming-bloat candidates
- Flags that are always `true`/`false` + dead branches; interfaces/abstract base classes with only one implementation
- `catch {}` / `except: pass` / `try?` with no policy; null checks after the type already guarantees
- Comments with hedging ("should work", "hopefully"), leftover Option 1/Option 2 alternatives, step numbering
- No why next to a lint disable / type escape
- rg `print(|console.log|_old|_backup| copy` → debug-leftover / file-copy candidates
- Near-identical bodies with the same signature (90%+ identical) → near-duplicate candidates, handled under the criteria.md G3 merge discipline

The §2b four classes don't rely on a single rg pattern; they rely on these actions:

- **Count states**: in one type, `is*` / `has*` / `did*` booleans + continuations + queues + timers totaling ≥3 → lifecycle-duplication candidate; fill in the two columns "owner / transition" for each
- **Find sync points**: write sites for rg `sync|mirror|keep.*in sync|refresh|invalidate`; for each cache ask "who is the truth" — if you can't name exactly one, it's a mirrored fact
- **Check against the standard library**: hand-written retry/backoff, glob, diff, date parsing, ring buffers → check the standard library and dependencies **already in the manifest**
- **Check deletion history**: `git log --diff-filter=D --name-only` gives deleted type/file names; rg back for flags, schema, docs, tests still describing them

**Don't** treat `TODO: never wired` as DELETE_OK. **Fake-done empty shells** (stubs returning constants, empty pipelines pretending to be wired up) and **sleep masking races** → mark `DEFER` and report as bugs; don't delete silently.

### E2 Execute in small steps

Order: **debug leftovers/file copies → dead cases / dead APIs → thin-wrapper inlining → shell collapsing → API compat residue → dead data-compat branches → demand-free fallbacks → overly broad catch → lint suppressions/type escapes → tests that only test over-defense.**

**The §2b four classes come after this chain, in their own batches**: added-then-abandoned residue → hand-rolled existing infrastructure → mirrored fact → lifecycle duplication (increasing risk). One batch touches only one ownership boundary; verify before starting the next batch.

- One smell class at a time; don't mix in architecture refactoring
- When deleting a symbol, change/delete the tests that only test it; when deleting an old name, change **all** callers
- Don't "improve" the surroundings along the way

### E3 Verify

After changes you must have: related tests green + every build variant compiles. The report pastes **the test-count line**; writing just "passed" is not allowed.

If the project has its own build/test gate rules (project CLAUDE.md / rules files), follow them — e.g. suite-level `-only-testing` for Xcode projects, and the ban on false-green switches that strip signing.

## 4. Multiple agents

Partition files so they are mutually exclusive. The main process merges the lists, spot-checks, runs the gates. After an agent reports "done", the main process must run `git diff` / grep itself and not trust the verbal report.

## 5. Output

1. Code diff (only the deletions/inlinings on the list)
2. Short ledger: what was cut / why / what was KEPT / what was reported (fake-done)
3. Gate evidence (N tests / BUILD line)

## 6. Red flags (stop immediately) — including brakes on the cleaner itself

- You are **adding** abstractions instead of deleting
- You deleted TODO feature scaffolding as dead code
- You deleted a public symbol after scanning only production
- You cut a compat layer that meets a named contract (shipped data, public API, callers in use)
- You deleted system-boundary input validation as over-defense; you weakened a security path
- **Over-compression**: sacrificing readability for line count, deleting abstractions that really organize the code — "less code" is a means, not a KPI
- Two writers on the same file
- You are **adding a sync wrapper** to two truths instead of collapsing one
- You **added a dependency** to delete a hand-rolled implementation, and glue + dedicated tests are not smaller than the original
- You merged same-named states of **different owners** (render ready ≠ session ready) into one flag
- You deleted something from §2b but can't say why it was originally built

## 7. Relation to existing tools

This skill is **decision and execution discipline**; it does not replace static analysis:

- JS/TS: knip + unused scans that include tests
- Python: sloppylint (AST lint for AI patterns; slop score can be a CI gate), AI-SLOP-Detector (fake-done detection)
- General rule lists: aislop (`thin-wrapper`/`swallowed-exception`/`hidden-fallback`), slopbuster (79 code slop patterns)
- Dead code: Periphery / knip / compiler unused — **must include test targets** (`exclude_tests:true` produces false deaths)

When a tool reports "dead", it still has to pass the three gates of §E1 before deletion.
