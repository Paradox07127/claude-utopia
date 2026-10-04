# Swift / Xcode-specific criteria

Used with `../SKILL.md` and `criteria.md`. The nine general classes still apply; this page covers only Swift-specific forms. The overall criteria (dialect consistency + trust model) and the iron rules are unchanged.

## 1. Concurrency escapes (the Swift form of lint suppression, highest priority)

**Cut**: using `@unchecked Sendable` / `nonisolated(unsafe)` / `@preconcurrency` without a reason to silence Swift 6 concurrency compile errors. Several production teams have written this into hard bans for AI — element-x-ios AGENTS.md: "Never `@unchecked Sendable` / `nonisolated(unsafe)`. Dev add these." (humans may add them, AI may not); FluidAudio CLAUDE.md has a whole section "NEVER USE `@unchecked Sendable`".

**Handling**: change to an actor / `@MainActor` / an explicit lock; if unchecked is truly needed, the same line must state who guarantees thread safety and by what mechanism; if you can't write that, change the design.

**Keep**: existing `@unchecked Sendable` that already has a same-line comment explaining the guarantee mechanism (humans added it, and it went through a different review).

## 2. Mixing DispatchQueue and actors

**Cut**

- Sprinkling `DispatchQueue.main.async` whenever a concurrency problem shows up — Paul Hudson: "you can expect to see `DispatchQueue.main.async` used an unreasonable number of times"; wrapping again when already in a `@MainActor` context
- Redundant `@MainActor` annotations: if the project has `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor` enabled, annotating type by type is noise

**Keep**: real thread hops where code meets C APIs / KVO / old delegate callbacks; when unsure about isolation semantics, mark `DEFER`, don't delete blindly.

## 3. `[weak self]` overuse

**Cut**: `[weak self]` + `guard let self else { return }` where there is no retain cycle. A confirmed misconception: Claude claims that a `Task { }` capturing self creates a cycle — in fact Task does not create a retain cycle by default (shown by SIL disassembly). Criterion: the closure is **not stored long-term** (one-shot completion, Task body, `withCheckedContinuation`) → weak is noise.

**Cut (more subtle)**: weak-guard-return in places that "must run even if self is dead" — on paths where a completion must be called or a resource must be released, a silent return is a breeding ground for dropped-event bugs.

**Keep**: closures stored long-term (Combine sink, Timer, callbacks stored in properties) — the qualifier in Sentry AGENTS.md is exactly "closures **stored by** the SDK".

## 4. Swift forms of swallowed errors (two-way brake)

- `try?` with no policy, empty `catch`, `?? default` with no requirement basis → cut under general classes 4/8
- **Reverse overshoot from fear of force unwrapping**: `guard … else { return nil }` turning errors into silent nils passed up layer by layer = hidden fallback. Two-way criterion: production paths allow neither a bare `!` nor a silent nil — an error must either throw or be visible with context
- Cooperative cancellation `catch is CancellationError` / catch-return is KEEP

## 5. Swift forms of compat residue

- **`if #available(...)` below the deployment target**: use the compiler's criterion directly — when the Xcode warning "Unnecessary check … minimum deployment target ensures guard will always be true" appears, it is DELETE_OK (together with the dead else branch)
- `@available(*, deprecated, renamed:)` forwards, typealias old names → judge by the general C1 named-contract whitelist (deprecated forwards on an app's internal private API are almost always dead; a library's public API is a contract)
- Models default to writing older-generation APIs (observed: "by default it writes iOS 16 style code"): `NavigationView`, `Task.sleep(nanoseconds:)`, `cornerRadius()`, `foregroundColor()`, `onTapGesture` instead of Button (an accessibility trap). **This is modernization, not deletion** — only swap them in files you were going to touch anyway; don't sweep the repo for them

## 6. SwiftUI shells and noise (Paul Hudson + SwiftAgents evidence)

**Cut / fix**

- Unnecessary `AnyView` ("unless it is absolutely required")
- `GeometryReader` combined with fixed frame sizes ("cardinal sin")
- Hard-coded font sizes `.font(.system(size:` (frequent with Claude), hard-coded padding/spacing
- Splitting views into **computed properties** — breaks `@Observable` invalidation granularity; split into separate View types instead
- New code using `ObservableObject`/`@Published`/`@StateObject` instead of `@Observable` (given the project has already migrated)
- A stack of types piled into one file (slows incremental builds)

**Keep**: if any of the above matches the file's existing style (the whole repo is still on the ObservableObject generation), judge KEEP by dialect consistency; migration is a separate task.

## 7. Dynamic entry point KEEP list (Swift forms; rg finding no callers ≠ dead)

`@objc` / selector strings, `IBAction`/`IBOutlet`, `Codable` `CodingKeys` and property names (serialization contract), Core Data entity/field names, `NSNotification.Name` strings, `NSUserActivity` / URL scheme routing, class names referenced from Info.plist, test methods discovered by XCTest reflection.

## 8. Swift forms of tests

- That AI-generated tests are largely "flawed and useless" is a first-hand consensus (twocentstudios' experience rewriting a 12-year-old app) — screen them with the general test criteria, focusing on "delete the logic under test and the test stays green"
- The general iron rules still apply: a public symbol referenced only by tests = `TEST_ONLY_API`, not dead code; use suite granularity for `-only-testing`; check the N in `Test run with N tests`

## 9. Tools

- **Periphery**: must be able to see the test targets (`exclude_tests:true` falsely reports production symbols used only by tests as dead)
- Compiler unused warnings, and the redundant `#available` warning above
- API hallucinations (nonexistent APIs that don't compile) are caught by the compiler; this skill doesn't need to handle them

## Sources

| Source | What is used | URL |
|------|--------|-----|
| Paul Hudson, "What to fix in AI-generated Swift code" | DispatchQueue overuse, the full SwiftUI set, list of old APIs | hackingwithswift.com/articles/281 |
| twostraws/SwiftAgents | original LLM-facing Swift rules (AnyView, GCD, force try) | github.com/twostraws/SwiftAgents |
| element-hq/element-x-ios AGENTS.md | "Never @unchecked Sendable… Dev add these" | github.com/element-hq/element-x-ios |
| getsentry/sentry-cocoa AGENTS.md | weak self qualified as "stored by the SDK" | github.com/getsentry/sentry-cocoa |
| FluidInference/FluidAudio CLAUDE.md | NEVER @unchecked Sendable; no print in production | github.com/FluidInference/FluidAudio |
| Task retain-cycle refutation experiment | Claude's misconception about Task + weak self (SIL evidence) | dev.to/artozf38bc119d5/…-4gmg |
| twocentstudios ObjC rewrite log | "writes iOS 16 style code"; useless tests; adding features beyond scope | twocentstudios.com/2025/06/22/vinylogue-swift-rewrite |
| Alamofire#937 / IQKeyboardManager#352 | redundant #available warning as an objective criterion | github.com/Alamofire/Alamofire/issues/937 |
