---
name: testing
description: Use when implementing or fixing behavior, refactoring code, or choosing verification for configuration, tooling, and eval changes. Apply behavior-first TDD where it provides fast feedback; select proportionate checks and decide which new tests merit permanent retention.
---

# Testing for fast feedback

Use tests to catch mistakes while they are cheap to fix and preserve confidence
in future changes. Optimize for trustworthy feedback, not coverage, test counts,
or apparent thoroughness.

Follow explicit project requirements. If a blanket gate forces unrelated work,
name the exact rule and propose a narrower alternative; do not silently skip it.
This skill does not authorize changing CI.

## Choose the feedback before writing code

Identify the promised outcome, a plausible mistake, and the cheapest distinguishing
check. Read nearby implementation and tests; reuse useful coverage rather than
adding a layer for the same risk. Keep this a brief working decision, not a
separate plan or per-test report.

For low-consequence supporting conveniences, use the one-off-check default below
even for deterministic logic. A temporary check may drive red-green; that alone
does not justify retention.

- For new rules, state transitions, meaningful transformations, and reproducible
  bugs, default to the TDD loop below.
- For behavior-preserving refactoring with adequate tests, run them before and
  after; do not invent changed expectations. Add characterization only for
  otherwise unprotected consequential uncertainty; establish the intended
  contract rather than freezing a known bug.
- For declarative configuration and standard tooling, first use the actual
  consumer's validator, build, dry run, or focused smoke check. Test custom logic
  with concrete failure consequences; file names do not determine risk.
- When expected behavior or API is unclear, run a bounded exploratory probe first.
  Settle expectations before turning it into a regression test; do not call
  test-after work TDD.
- For visual judgment or probabilistic model quality, use representative rendering
  or empirical evaluation. Deterministic assertions cannot establish subjective
  quality; surrounding deterministic logic can still benefit from TDD.

## Test outcomes at a useful boundary

Treat a unit as coherent behavior, possibly spanning cooperating functions or
classes. The boundary need not be an exported API, HTTP endpoint, or outermost
application boundary.

Choose the behavior and meaningful failure before choosing the test seam. Prefer
an existing caller-facing boundary that exercises that behavior. Move inward when
doing so materially reduces setup, runtime, or nondeterminism, but never bypass
the logic or interaction responsible for the failure being tested. Stop when the
boundary provides useful feedback at reasonable cost. Do not seek the smallest
function or isolate every collaborator.

Prefer returned results, observable state, persisted data, rendered output, and
required external effects. Avoid private-helper assertions, source-string
matching, arbitrary structure counts, and internal call scripts. Exact text,
counts, or ordering are appropriate when contractual, such as machine-readable
output or preventing duplicate payment.

Use cheap real deterministic collaborators. Substitute dependencies when needed
to control time, randomness, costly resources, unavailable services, or failure
conditions. Fakes do not prove real database, protocol, or provider compatibility;
retain focused real-boundary evidence for those risks. Do not mock away the
mechanism under test, such as transaction rollback.

Give each behavioral rule one primary testing home. Add layers only for distinct
risks such as wiring, authorization, serialization, or persistence. Broad tests
need not repeat every lower-level input variation.

## Use a small red-green-refactor loop

1. Briefly list relevant behavioral examples: ordinary results, meaningful
   boundaries, and consequential failures. Do not enumerate every imaginable
   input or write the whole suite in advance.
2. Choose one example and write one runnable test through a stable caller-facing
   interface. Derive expectations from the requirement, a known example, or
   independent reasoning, never by copying implementation output.
3. Run it before implementing the behavior. Confirm it fails because behavior is
   missing or wrong, not because of a broken fixture, missing dependency, or
   unrelated import error. If the test unexpectedly passes, check whether the
   behavior already exists, existing tests protect it, and the new test
   distinguishes it from a plausible mistake. Correct ineffective tests and
   rerun. If the behavior is already correct, make no production change for this
   example; decide retention below rather than manufacture a failure.
4. Implement the smallest coherent passing change, without speculative options,
   abstractions, or behavior for future examples. Once the test correctly
   expresses the requirement, keep its expected result fixed during Green;
   revise it only to correct a mistaken requirement or interpretation.
5. Run the new test and affected existing tests. On green, simplify concrete
   duplication or complexity while keeping behavioral assertions stable.
   Refactoring is available, not mandatory ceremony.
6. Repeat for the next distinct unresolved behavior. Stop when relevant outcomes
   and risks have adequate evidence, not at a quota.

For regressions, observe the intended failure without the fix when safe and
practical; do not disturb unrelated work to manufacture red-green evidence.

## Decide what to retain

Separate development feedback from permanent regression protection. Useful tests
of enduring application behavior normally stay; finishing today's implementation
does not justify removing a good regression.

For low-consequence supporting conveniences, such as one-off scripts,
documentation formatting, or exploratory eval bookkeeping, default to a focused
one-off check, not a new permanent test. Retain protection only when actual
recurring use with meaningful consequences, an observed recurring mistake, or a
consequential downstream decision warrants its ongoing cost. A possible regression,
exported function, or cheap test alone is insufficient.

Do not apply this default to tooling controlling secrets, permissions,
authoritative or otherwise consequential stored data, destructive operations, or
material expense. A release-gating scorer or shared verifier can deserve durable
tests even under `evals/`. Routine reuse alone does not make cosmetic output
consequential.

Before keeping new tests, ask: does each detect a distinct important mistake, and
can the implementation be reorganized without rewriting it? Remove disposable
probes introduced for this task when finished. Preserve existing protection unless
removal or replacement is within the assignment; never weaken assertions simply
to get green.

## Keep the feedback loop cheap

Run the focused check during development; broaden validation for affected
boundaries and required delivery gates, not every small edit. Inspect composed
commands so `qa`, `test`, and `ci` do not duplicate suite runs. Reuse evidence while
relevant code, inputs, and environment remain unchanged; rerun affected checks
after corrections.

When tests become slow, flaky, or hard to maintain, inspect setup and boundaries
before adding timeouts, retries, wrappers, or parallelism. Await actual completion,
not arbitrary sleeps. A real database test may be cheaper and more faithful than
elaborate mocks. Do not delete valuable slow tests just to improve runtime.

Briefly report checked behavior, its actual results, and material gaps. Zero new
permanent tests is valid when the chosen evidence suffices.

## Calibrate judgment with contrasting cases

- Formatter option: run the formatter on representative input and check the
  intended output. Do not retain a test that the configuration contains the
  option. Wrong-database environment guard: verify refusal through the real
  command boundary and retain it.
- Generated-guide rewording: regenerate and inspect it. Do not add a default suite
  snapshot solely to freeze presentation. Escaping published untrusted content:
  retain a focused behavioral regression for the exposure.
- Exploratory-only eval threshold matcher: run affected existing tests and a small
  known-input check; normally retain no new test. If its result gates release or
  another consequential decision, retain focused protection.
- Splitting an adequately tested module: preserve existing outcomes without new
  tests per helper. Partial database writes: induce a real later write failure
  and assert the persisted operation is all-or-nothing.
