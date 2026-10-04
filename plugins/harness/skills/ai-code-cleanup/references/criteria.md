# Cleanup criteria in detail (any language)

Used with `../SKILL.md`. This page is a pattern dictionary, not a second process. Items marked **[scar]** flag failure modes that are easy to hit in practice; the criteria themselves are general. For Swift/Xcode projects also read [`swift.md`](swift.md).

## A. Thin wrappers / shells

**Cut**

- `f(...) { return g(...) }` with no policy (doesn't change arguments, doesn't validate, no logging contract)
- A only calls B, B only calls C, B has zero policy
- Two names, one body (`isFoo` ≡ `isBar`, and tests pin only one of them)
- The five-piece set of pure forwards from a Coordinator/Manager to the service below
- Preemptively extracted single-use helpers (`isNotEmpty(arr)` ≡ `arr.length > 0`)

**Keep**

- Semantic renames with production callers on both sides (documenting is enough)
- Thin implementations required by a protocol/interface/override
- Module façades: across a module boundary, multiple callers, hiding internal types
- "Two-liners" that include cleanup/traversal/permission/generation checks — that is policy, not a shell
- **[scar] Convergence points at layer boundaries**: this one-line function in layer A is A's **only** entry into layer B; inlining it into N call sites = creating N new cross-layer references. Criterion: **is the forwarded-to symbol in the same layer as the caller**. Repos with architecture ratchet tests (layer-boundary baselines, import whitelists) go red immediately — **repos without a ratchet are more dangerous, degrading silently**. Before inlining, check which directory the callee is defined in

aislop `thin-wrapper`: flags only when it forwards its own parameters without transforming them; transforming parameters doesn't count.

## B. Over-defense and overly broad exception handling

**Principle (trust model)**: whether a defense belongs depends on whether the caller has already validated — "Defensive checks or try/catch blocks that don't match the trust model of the surrounding code" (prathamdby deslop). Put validation at system boundaries; let errors propagate internally.

**Cut**

- Second checks after the type system already guarantees non-null / has narrowed
- The same value validated repeatedly along the call chain
- Dead branches of always-true/always-false flags; interfaces/abstract base classes with only one implementation
- `catch {}` / `except: pass` / log without the error and continue
- Catch then rethrow unchanged, no context; **catch-log-rethrow at every layer** (the same error logged once per layer — keep logging only at the boundary layer that actually handles the error)
- Failures smoothed into 0 / empty array / success (hidden fallback)
- "Error handling that handles nothing": a handler that exists only to make the code look robust
- Tests that only test "the decoder ignores unknown keys" or "the catch that is never reached"

**Keep**

- Cooperative cancellation (the catch-return idiom for cancellation)
- Failure paths + visible errors for **system-boundary input** (user files, network, IPC, env, CLI arguments) — when deleting internal defense, don't trim this layer along the way; criticism in the security literature points the opposite way (LLM code **lacks** defense at boundaries)
- Fail-open with a product requirement — the user must name it
- Paths where security failures should close (trust / path / CSP)
- Files/layers that are densely defensive by nature (legacy system edges, driver glue) — dialect consistency takes priority over the list

## C. Compat residue (two subtypes, different criteria)

### C1. API level (a frequent AI habit: rename without deleting the old, migrate without deleting the old path)

**Cut**

- Old-name aliases / re-exports / deprecated forwards kept after a rename, with comments saying "legacy" or "for backwards compatibility" — the comment is not evidence; rg for callers is
- Old implementation paths not deleted after migration is complete, "code contortions" that bend the new code to stay compatible with the old path
- Legacy parameters on new functions, dual-signature overloads (one old, one new)
- Any compat layer on a greenfield / internal private API (by definition there are no external callers)

**Keep (named-contract whitelist, any one)**

- External contracts of a public API / CLI / config format / data format
- Tagged, shipped upgrade paths
- Security boundaries
- Observed production state (monitoring/logs confirm the old path is still hit)

**Reverse brake**: the model swings between the two extremes of "keep everything" and "delete everything and blow up the tests". The criterion is "is there a real external caller", not a direction. Deleting an old name = change **all** callers + delete, in one go; a half-delete (old name still there but half broken) is worse than not deleting.

### C2. Persisted-data level

**Cut**: retired / still read once / pre-release / internal experimental formats; mentioned only by test fixtures, never written by production.

**Keep**: defaults for keys missing from a shipped schema; migrations of real blobs on users' disks. [scar] An enum case that exists only to deserialize an old persisted `rawValue` → KEEP + comment "migration compat, do not delete".

## D. Lint suppressions and type escapes

**Cut**: disable / `@ts-ignore` / `#pragma warning disable` / `swiftlint:disable` / `nolint` / `periphery:ignore` with no reason; `as any` / force cast / assertion bypass that circumvent type checking.

**Keep**: third-party JSON keys that can't be renamed, generated code, known false positives with a one-line why. Prefer changing the code to remove the suppression.

## E. Demand-free fallbacks

**Cut**

- Defaults, silent degradation, fake success that the product never asked for
- Fallback chains: A fails, try B, try C, with no requirement basis at any layer (including import fallbacks: `try: import A / except: import B` with no basis in declared dependencies — weak evidence for AI attribution, but the same family of criterion)
- **Mock/fake data standing in for a real failure** ("generate a value if no match" instead of raising an error) — the signature product of AI uncertainty
- A process that fails but exits with a success code

**Keep**: degradation documented for users; explicit security/availability fail-open locked by tests.

## F. Comments and AI writing-style residue (can be done along the way during cleanup)

**Keep**: 1–2 lines at the top of a file/type; non-obvious why (races, magic numbers, security, regression history); `MARK`/region; TODO backlog.

**Delete**

- Restating the code, one comment per line, long essays on special cases, outdated type lists
- **Hedging comments**: "should work", "hopefully", "this might…"
- **Leftover alternatives**: Option 1/Option 2 commented-out alternative implementations — pick one, delete the other
- Step-numbering comments (`// Step 1:`), tutorial-style "You can also…"
- Changelog-style comments ("moved from X", "previously did Y") — that's git's job

## G. Naming bloat and temporal naming

`Enhanced`/`Improved`/`Comprehensive`/`Advanced` prefixes, `_v2`/`_new`/`_old`/`final` suffixes, overuse of `Manager`/`Handler`/`Helper`/`Util`, `Result` as a catch-all. The red-line list for temporal naming (obra/clank "Domain-Focused Naming"): New / Old / Legacy / Improved / Enhanced / Unified / Refactored / Updated / Modern — "`class NewAPI {}` — when does it stop being 'new'?" Name by domain concept, not by change history.

**Action**: renaming has a cascading cost; only fix a name when you **were going to touch this symbol anyway**; don't rename for its own sake. `_v2`/`_old` coexisting = most likely one of them is C1 compat residue; check under C1 first.

## G2. Debug leftovers and whole-file copies (lowest risk, can be scanned first)

**Cut**

- Leftover debug statements: `print` / `console.log` / function entry/exit tracing, "debugging" comments — the number one leftover from AI tools (top high-risk item in dabit3/deslop)
- Whole-file copies: `x_old` / `x_backup` / `x copy` coexisting with `x`; models love **creating new files** instead of changing existing ones ("My entire codebase is littered with files that I am constantly having to clean up"), leaving parallel implementations
- `enhanced_x` coexisting with `x` → first check under C1 which is the real implementation, then delete the other entirely

**Keep**: output that goes through a formal logging contract (Logger/log framework); diagnostic output in tests.

## G3. Near duplicates (careful: this is merging, not deleting)

When the model can't see an existing helper it writes another: "generates functionally equivalent code with different variable names, slightly different error handling, or a different loop structure" (GitClear data: in the AI era copy-paste share went 8.3%→12.3%, refactor 25%→10%).

**Criterion**: two bodies 90%+ identical, semantically equivalent, differences have no requirement basis → merge into the earlier one. **Action discipline**: merging is a small refactor, one pair at a time, run both sides' tests after merging; if the differences are in doubt (possibly an intentional fork) → `DEFER` and ask. No repo-wide similarity sweep — only handle what you run into within this cleanup's scope.

## H. Fake-done and masking (report, don't delete silently)

Stubs returning constants, `pass` + TODO pretending to be implemented, pipelines wired to nothing, interface-only classes, docs exaggerating actual behavior. These **are not cleanup targets, they are bugs** — deleting them would hide the fact that "the feature was never built". Mark `DEFER` and list them separately in the ledger.

Handled the same way: **sleep / retry masking races** — a flaky test "fixed" by `sleep(0.5)`, a retry loop with no basis for its backoff; they only lower how often the failure is visible, the root cause is still there. Don't delete blindly (that re-exposes the flakiness); mark `DEFER` and report as a race bug.

## I. Tests

**Tests that can be deleted**: only cover a deleted shell; only pin "unknown keys don't crash"; characterization strings pinning a deleted symbol with no behavior.

**Over-mocked tests (the three ailments of AI tests, akoskm)**: production logic rewritten inside the test, mock everything then assert the mock was called ("safety theatre"), asserting implementation details rather than intent. **Test = mutation**: delete the logic under test; if the test stays green → the test verifies nothing and can be deleted ("You can delete the filter entirely and this test still passes"). The same rule holds for any test you keep or write: it must fail when the behavior it covers is removed.

**Production APIs that must not be force-deleted as dead code**: public symbols referenced only by tests (`TEST_ONLY_API`). To delete them you must change the test contract or move the tests onto a live path. [scar] Zero production references ≠ deletable.

**Tautological**: `assert True`, comparing two literals for identity — delete or turn into a real assertion.

## M. Four classes of structural entropy (detail for SKILL.md §2b)

A–I are **local smells**: a piece of code itself looks wrong. This section is **structural entropy**: each piece of code looks reasonable on its own, but the system is forced to maintain extra truths / states / contracts. The criterion is not "this part is bloated" but "**how many copies of the truth does this system need**".

General rules: touch only one ownership boundary at a time; **you must read git history / decision records** to answer "does the problem that created this surface still exist", and if you can't find out, `DEFER` (for flattened repos see the escape hatch in SKILL.md §E1). Candidates in this section are often marked `COLLAPSE` rather than `DELETE_OK` — after merging two truths the line count may not change; what shrinks is the number of states.

**"Owner" in this section always means "who has the authority to change it", not "who holds this field".** The two readings give opposite conclusions: three retry timers all hang off the same connection object (holder reading → looks like duplication), but they are driven by the network monitor, a user-initiated pause, and the backoff policy respectively (authority reading → three real seams). **Use the authority reading.** [scar] This ambiguity is enough to make two reviewers reach opposite conclusions about the same code.

### M1. Mirrored fact

Two or more places record the same fact and must be kept in sync to avoid conflict: double caches, snapshot + live source, a derived field and its source, two events reporting the same thing, each adapter storing its own copy.

**Cut**: the copy that can be derived (compute it instead); the copy whose sync exists purely so you "don't forget"; whichever of two events has no independent subscriber.

**Keep**

- Intentionally independent representations: each backend / adapter's native representation, where merging would leak across layers
- A cache that is an explicit performance contract, with written invalidation discipline (has invalidate points, has tests)
- Across a process / actor boundary, where sharing one copy is physically impossible

**Action discipline**: collapse, don't "connect". **Adding a sync wrapper that keeps two truths more tightly in sync = adding entropy, not cleanup** — this is the most common fake fix in this class. Likewise, **using a guard test that "text-diffs two implementations for drift" as the solution also adds entropy**: it proves two truths exist without eliminating either.

**Cost criterion for collapsing across modules / SKUs** (corresponding to the "new dependency" item in §M3): when collapsing requires moving public types, changing package dependency direction, or recompiling multiple targets, first ask whether "the truth that goes away" is worth it. **If not, mark `DEFER` as its own batch; don't do it along the way** — it is no longer cleanup, it is an architecture change.

**Dead mirrors whose writer has been deleted** (the mirror is still there, always at its initial value, branches unreachable) belong to this class, not §M4: §M4 is "the description remains, the implementation is gone"; this class is "one of two truths has lost its driver". Criterion: does that field **still have a second possible value**.

[scar] Two caches were keyed by the same item id; during a key migration only one was re-keyed → lookups through the other silently returned the wrong item. The typical damage from a mirrored fact is not "the two copies disagree" being caught immediately, but **changing only one place during a migration / refactor**, with silent misalignment.

### M2. Lifecycle duplication

One transition expressed separately by several mechanisms: `isReady` + `readyContinuation` + `hasStarted`; `isSuspended` + `pauseCount` + whether a timer is nil; dispose using a flag, a queue barrier, and a sentinel at once.

**Detection (do it, don't go by feel)**: in one type, `is*`/`has*`/`did*` booleans + continuations/promises + queues/timers + state enums totaling ≥3 → fill in two columns for each:

| Mechanism | owner | Which transition it represents |
|---|---|---|

**Two rows with the same owner + same transition → merge candidate.**

**Keep**: different owners that happen to share a name (render ready ≠ session ready ≠ window ready); one is an externally observable contract, the other an internal implementation detail; a reentrancy count (`pauseCount`) and a boolean are **not** duplicates — the count carries information the boolean doesn't.

**Red line**: merging same-named states of different owners into one flag = creating cross-module coupling, worse than before.

### M3. Hand-rolled infrastructure

Locally implemented parsing, retry backoff, glob, diff, framing, date handling, ring buffers, LRU, where the standard library or a library **already in the dependency manifest** already covers it.

**Cut**: local implementations semantically equivalent to the standard facility, with no extra constraints.

**Keep**

- The hand-rolled version has a written why: working around a known platform bug, measured performance, avoiding a dependency, behavior that must match the other end bit for bit
- The standard facility has a version threshold (`#available` / minimum deployment target can't reach it)
- Anything tied to binary / wire / serialization layout — semantic equivalence is not byte equivalence

**Criterion for adding a dependency**: switch only when "the deleted implementation + its dedicated tests" > "the new dependency's glue + its dedicated tests + supply-chain cost". **If not, KEEP**; don't pull in a dependency just to delete code.

**Middle ground: both facilities have pitfalls.** The why behind a hand-rolled version is often not written down; it is "sidestepping another known trap in the standard API" (classic example: forgetting `removeTimeObserver` after `addPeriodicTimeObserver` leaks, while a hand-written `Task` + `weak` avoids it). **The standard facility is not automatically better** — it is a candidate only when its pitfalls are fewer than the hand-rolled one's. If you can't tell which is better → `DEFER` and write both sides' pitfalls into the ledger; don't force a choice.

### M4. Added-then-abandoned residue

The implementation is gone, but the things describing it remain: feature flags, config keys, schema fields, doc paragraphs, tests, compat branches, decision notes, capability lists in a README.

**Detection**: `git log --diff-filter=D --name-only` gives the deleted file / type names; rg the whole repo for places still mentioning them (including docs, strings, config, resources like xcstrings).

**Cut**: follow the "descriptions" all the way and delete them — a half-delete (flag still there but pointing at nothing) is worse than not deleting.

**Keep**: TODO backlog (the feature is still to be wired, see iron rule 1); shipped schema fields (users have data on disk); ADRs whose deletion record has value — **an ADR recording "why we no longer do X" is an asset, not residue**.

## J. KEEP master table

| Class | Examples |
|----|-----|
| TODO feature backlog | never wired / unconsumed / Adopt or retire |
| Intentional security | trust, CSP, path safety, lease |
| Dynamic entry points | reflection, selector, delegate, route strings, serialization key names, FFI exports |
| Named-contract compat | shipped schema defaults, public API, old paths still hit in production |
| Binary/ABI/serialization layout | uniform layout, wire format, MemoryLayout, alignment |
| Real seams of multiple build variants | real forks across `#if` flags / build flavors / multiple targets |
| Intentionally independent representations | each backend/adapter's native representation; one copy per process across processes (M1) |
| Same-named states of different owners | render ready ≠ session ready; reentrancy count ≠ boolean (M2) |
| Hand-rolled with a why | platform-bug workaround, measured performance, version threshold, byte-level alignment (M3) |
| ADRs recording "no longer doing X" | the deletion decision itself is an asset (M4) |
| DEBUG / `*ForTesting` | test surface, may stay by default |
| System-boundary validation | failure paths for user input / network / files / IPC |

## K. External sources (where the extended constraints come from)

| Source | What is used | URL |
|------|--------|-----|
| brianlovin deslop (original) | trust-model criterion; branch diff scope; 1–3 sentence report | github.com/brianlovin/claude-config |
| prathamdby deslop gist | "imported rather than native" dialect criterion | gist.github.com/prathamdby/587473fb7b80a2426aab375e463001c4 |
| steipete agent-scripts | named-contract whitelist for compat; "when unsure about alias/shim/fallback, ask first" | github.com/steipete/agent-scripts |
| sst/opencode AGENTS.md | ban on preemptive single-use helpers; avoid try/catch and `any` | github.com/sst/opencode |
| Sentry code-simplifier | two-way brake (Maintain Balance); only touch code changed in this session | github.com/getsentry/skills |
| slopbuster | 79 code slop patterns; catch-log-reraise; written naming-bloat rules | github.com/gabelul/slopbuster |
| sloppylint / AI-SLOP-Detector | Python AI-lint; fake-done detection; slop score CI gate | github.com/rsionnach/sloppylint · github.com/flamehaven01/ai-slop-detector |
| aislop | thin-wrapper, swallowed-exception, hidden-fallback | github.com/scanaislop/aislop |
| Karpathy / Ronacher / Osmani | root-cause narrative for over-defense and abstraction bloat (RL reward structure, local reasoning) | x.com/karpathy/status/1976077806443569355 · lucumr.pocoo.org/2026/6/23/the-coming-loop |
| dabit3/deslop · agent-sh/deslop | detection lists for debug leftovers, empty catch, defense overload | github.com/dabit3/deslop · github.com/agent-sh/deslop |
| obra/clank naming-by-domain | red line on temporal naming (New/Old/Legacy/Enhanced…) | github.com/obra/clank |
| akoskm / davidadamojr | three ailments of AI tests; mutation test | akoskm.substack.com/p/your-ai-tests-are-probably-useless |
| GitClear (cited via octopus-review) | quantitative background for copy-paste 8.3%→12.3% | octopus-review.ai/blog/your-ai-writes-the-same-code-5-times |
| Paul Hudson and other Swift sources | see the source table in swift.md | — |
| HN 45530486 + 44809787 etc. | first-hand complaints about compat habits; counterarguments on which defenses to keep | news.ycombinator.com/item?id=45530486 |
| Fowler Inline / Remove Dead Code | inline single-caller pure forwards; delete cleanly in one go | — |
| Yevanchen/reclaim-code-entropy | source of the four §M classes: mirrored fact / lifecycle duplication / hand-rolled infrastructure / added-then-abandoned; "collapse, no sync wrappers", "a new dependency must be a net reduction" | github.com/Yevanchen/reclaim-code-entropy (created 2026-08-17, no field record, use as ideas) |
| Common failure modes | TODO ≠ dead code; public must scan tests; shipped compat can't be cut; migration re-keyed only one of two caches → silent mismatch | — |

## L. Language comparison (thin wrapper / empty handling / compat residue)

| Language | What a thin wrapper looks like | Empty/fake handling | What compat residue looks like |
|------|------------|-----------|--------------|
| Swift | `func f() { g() }` / `return h(x)` | `catch {}` / `try?` / `?? []` | `@available(*, deprecated)` forward, typealias old name |
| TS/JS | `const f = (x) => g(x)` | `catch (e) { console.log(e) }` | `export { newName as oldName }`, `/** @deprecated */` forward |
| Python | `def f(*a, **k): return g(*a, **k)` | `except: pass` / `.get(k, {}).get(...)` | module-level alias `old_name = new_name`, inline import inside a function body |
| Go | `func F() { G() }` | `_ = err` / empty `if err != nil` | `// Deprecated:` forwarding function |
| Rust | `fn f(x: T) -> U { g(x) }` | `.unwrap()` on a non-test production path (usually KEEP and change, not silent) | `#[deprecated]` re-export, `pub use` old path |
