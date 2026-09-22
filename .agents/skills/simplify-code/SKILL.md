---
name: simplify-code
description: Use when the user explicitly asks to simplify, untangle, or clean up a scoped, already-working implementation or test suite without changing observable behavior, including a distinct simplification phase of a compound request. Test-suite cleanup may reduce maintenance or runtime cost while preserving valid behavioral protection. Do not use for read-only review, defect diagnosis or fixes, performance optimization outside scoped test-suite cleanup, architecture redesign, or formatting-only cleanup.
disable-model-invocation: true
compatibility: Requires Git for workspace isolation and change inspection. Project-specific validation may require additional commands declared by that project.
---

# Simplify Code

Make a working implementation easier to understand, modify, and debug without changing what callers can observe. Remove complexity rather than compressing it or moving it elsewhere.

## Authorization and scope

- Treat simplification as an editing task. A review finding alone does not authorize edits.
- Limit work to the paths or coherent change the user identified. Record Git status plus staged and unstaged changes before editing, and preserve unrelated work and staging exactly.
- Ask when the intended scope is ambiguous or a simplification would cross a public contract, persistent format, dependency, ownership boundary, or several unrelated modules.
- When a request combines simplification with a feature, fix, optimization, commit, or push, split it into explicit phases. Do not intermingle behavior-changing work with the simplification diff.
- Do not add features, fix unrelated defects, redesign architecture, add dependencies, or discard valid test protection without specific authorization during the simplification phase.
- If the code is already clear enough, or the expected maintenance benefit does not justify regression risk and diff noise, say so and leave it unchanged.

## 1. Establish the behavioral contract

Before editing:

1. Read project instructions and representative neighboring code.
2. Identify the implementation's responsibility, callers, inputs, outputs, errors, state changes, external effects, and ordering or concurrency guarantees. Treat prompts, user-facing text, protocol values, schema or configuration keys, and other literals consumed outside the implementation as observable behavior when their exact content matters.
3. Read tests and documentation that express those expectations.
4. Inspect history only when an unusual structure may preserve a compatibility, performance, platform, or lifecycle constraint.
5. Run the smallest relevant existing checks when practical. Record pre-existing failures so they are not confused with regressions.

Write down the observable invariants that must remain true. Internal structure is not part of the contract unless callers, supported extensions, or project rules depend on it. If important behavior cannot be determined safely, ask rather than guessing.

## 2. Choose a real simplification

Look for concrete comprehension or change-cost problems, such as:

- control flow that hides the main path or repeats the same decision;
- understanding one behavior requires excessive navigation or keeping hidden mutable state in mind;
- names that conceal responsibility or state;
- one file or module that combines separable responsibilities, forcing readers to hold unrelated concepts in mind or causing unrelated changes to collide;
- duplicated policy that can drift;
- indirection that adds no ownership, contract, policy, or useful seam;
- stale compatibility paths or dead code whose lack of callers can be demonstrated;
- responsibilities scattered across locations that always change together;
- abstractions introduced for possibilities the code does not support.

Choose the smallest change that removes concepts, branches, duplication, or unnecessary indirection. Prefer explicit, conventional code over dense expressions and clever compression.

Treat a large file as a reason to inspect, not a reason to split. Extract a private module only when each resulting module owns a coherent responsibility, the split reduces what a reader must understand at once, and public contracts and dependency direction remain unchanged.

Do not simplify mechanically from line counts, nesting depth, or pattern names. Preserve helpers that give a concept a useful name, boundaries that isolate policy or effects, and duplication that represents intentionally independent ownership. If the real problem requires a new architectural boundary or behavior change, stop and present that as a separate decision.

For explicitly scoped test-suite cleanup, prioritize candidates by maintenance and setup cost; use measured runtime when speed is a goal. Compare the failures each candidate can detect with retained checks, considering exercised paths and boundaries. Keep, simplify, consolidate, or remove accordingly. Similar assertions alone do not establish redundancy.

Remove redundant tests or assertions only when retained checks protect against the same relevant failures. Remove obsolete or invalid expectations only when the current contract establishes that they no longer express a valid requirement. Do not discard a test solely because it covers internal code or tooling, or runs slowly. State any deliberate loss of valid protection and obtain authorization unless that specific loss is already authorized.

Verify retained behavior and protection after cleanup. When speed is a goal, compare representative before-and-after timings under comparable conditions, reusing suitable measurements. Report uncertainty or measurement limits; do not claim a speedup without supporting evidence.

## 3. Plan reversible steps

For each proposed step, state:

- what complexity it removes;
- why the existing structure is not earning its cost;
- which observable invariants could be affected;
- which focused check will detect a regression.

Keep each step independently understandable and reversible. Avoid mixing the simplification with formatting churn or opportunistic cleanup.

## 4. Edit incrementally

Apply one coherent simplification at a time.

- Follow project-native vocabulary, style, and existing utilities.
- Preserve outputs, errors, side effects, state transitions, ordering, and required performance characteristics.
- Preserve valid behavioral protection across the suite, not every individual test or assertion. Update tests when they depend on private structure that the authorized refactor necessarily changes or as part of explicitly scoped test-suite cleanup. Any deliberate loss of valid protection requires separate authorization unless that specific loss is already authorized.
- Remove newly unused imports, helpers, comments, and branches only after confirming they are no longer needed.
- Run the focused check after each step that could independently alter behavior.
- If a step fails validation or requires compensating behavior changes, reverse only edits introduced by that step and reconsider rather than patching around it. Never use a broad restore, reset, checkout, or stash that could erase pre-existing work. Stop if the edits cannot be separated safely.

Complete and verify simplification before any separately requested commit. A simplification request by itself does not authorize staging, committing, or pushing.

## 5. Verify the result

1. Inspect the complete diff for scope drift and accidental behavior changes.
2. Re-run the focused checks and the relevant wider test, build, type, lint, or formatting commands available in the project.
3. Re-check important callers, error paths, side effects, and lifecycle behavior against the original invariants.
4. Compare before and after: the result should require fewer concepts, branches, navigation steps, or hidden mutable state without hiding decisions or weakening a useful boundary, or reduce test-suite maintenance or runtime cost while preserving valid behavioral protection except for specifically authorized loss.
5. Remove only the current workflow's edits when they merely relocate complexity or make the code shorter but harder to understand. Preserve every pre-existing change.

Report:

- the scope simplified;
- the complexity removed and why removal was safe;
- checks run and their results;
- any behavior, environment, or caller not verified;
- any larger redesign or defect deliberately left outside scope.
