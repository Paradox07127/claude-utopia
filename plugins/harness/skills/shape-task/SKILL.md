---
name: shape-task
description: Use when a time-boxed coding task has to be done in about 30 minutes — technical interviews, hackathons, a sprint before a demo, timed take-homes. Speed first - the skeleton is the contract, no plan documents, no subagents, no review. Not for code review (use /mm:review), not for exploring an unfamiliar codebase (use /harness:interrogate), and not for architecture decisions when time is plentiful. 触发词:限时任务、面试题。
---

# shape-task

Reply in the user's language.

**The plan is not the deliverable; the skeleton is.** If an output cannot be executed or run directly, do not write it.

## Do not use this for

- Reviewing changes → `/mm:review`
- Exploring an unfamiliar existing codebase → `/harness:interrogate`
- Plenty of time, or the direction itself is uncertain → this skill is built for time-boxed work; don't use it

## Time budget (for 30 minutes; scale proportionally for other lengths)

```
0–2    read the task, state the direction out loud + say explicitly what gets cut
2–4    write the skeleton
4–20   fill in the implementation, one file at a time
20–25  integrate, get the end-to-end loop running
25–30  docs + demo
```

⚠️ **You cannot read the wall clock reliably.** After each file, report "file N of M" so the person can interrupt you.

**Hard stop: if the skeleton isn't done after 4 minutes, stop planning immediately and start writing code.** Planning overrun is the most common way these tasks die.

## 1 Skeleton is the contract (≤2 minutes)

No plan document. Create the file tree directly, and put in each file:

- Exact function signatures and types — `add(title: string): Todo`, not "an add method"
- Empty implementations (`throw new Error('TODO')` / `raise NotImplementedError`)
- One comment line at the top of the file: **acceptance command + expected output**

This one step produces the contract, the directory layout, the task list, and the acceptance criteria. Four things written at once.

When done, `ls` it and show the other person — this is the cheapest course-correction point in the whole run.

Rules:
- **Each file has exactly one owner.** No file may be changed by two things at once
- **Once a signature is written, it is frozen.** To change it, say so first; no drifting while you write

## 2 Fill in the implementation

**Write it yourself. No subagents.**

Dispatching an agent has a fixed overhead: writing the prompt, waiting for the result, reviewing a diff you didn't write, fixing interfaces that don't match. Within 30 minutes that cost doesn't pay off.

**The only exception**: when you need a technical check that is independent of the main line ("does this library work", "does this API respond"), send one agent to try it while you keep writing the main line. That is the only case worth dispatching.

Rhythm: **change → run → read output → next.** Don't save the runs for the end.

## 3 Verify

Run each file's own acceptance command right after you finish it.

- **UI**: capture the window and read the image; don't capture the full screen
- **Web**: load the page and read the rendered result
- **CLI / API**: actually call it and read the real response

Two kinds of false green; treat them as red when you see them:
- Green tests after a failed build don't count
- An incremental build may leave stale artifacts, so you are running the previous version of the code

**No review.** In a time-boxed setting review has negative return — an unfinished project doesn't need reviewing.

## 4 Deliver (last 5 minutes)

- Run the full loop once, watching it from start to finish
- The doc covers only four things: **what was chosen / what was cut / how it was verified / what is still unverified**
- **Name the unverified parts yourself.** Don't appear more certain than you are

## Forbidden

Any vague phrase means the step is not done: "appropriate error handling", "as needed", "adjust as necessary", "polish it up".

Test: could someone who wasn't in the discussion act on this line directly?
