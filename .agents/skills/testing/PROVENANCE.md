# Provenance

## User-supplied experimental variant

The evaluated version at `d1290881eb02dfdd69deb4e581eebac7334287de` copied the
complete user-supplied `/tmp/tdd-research-2026-09-22/proposal/testing/SKILL.md`,
including frontmatter, byte-for-byte. That supplied file's SHA256 is
`8ef72356018e2c29d92b303044af0a14f036288fbc5c3f4bab92c7e3aa13a50f`.
The packaging baseline is PR #15 at `66a6972d4deb013daa66b12cf84359dce2a52f07`;
`diagnose-bugs`, `code-review`, and all licenses remain unchanged.

Three user-authorized post-evaluation refinements clarify cost-aware seam selection
without bypassing the failure mechanism, keeping correct expected results fixed
during Green while allowing correction of mistaken requirements or interpretations,
and handling unexpectedly passing tests without manufacturing a failure or an
unnecessary production change. A subsequent user-approved compaction preserves
these clarifications and the feedback, retention, and authority policies while
moving seam selection before the TDD loop and reducing repetition. The revised
text has not been model-evaluated. The notes below describe the prior PR #15
design, not new source consultation or claims about this experimental variant.

## Intent

Help agents catch implementation mistakes while changes are small. Organize one general testing skill around useful feedback now, with permanent regression protection as a separate retention decision.

## Sources

- `mattpocock/skills` `tdd` at `8b78b531ab965735c5dc74f6f7a219e1e37326df`
- `cursor/plugins` pstack `principle-make-operations-idempotent` at `fd6dd6f7276956a532bb78a748a8d2818b6eb5f4`
- Self-written project testing and testing-audit guidance
- User direction for feedback during implementation, independent expected results, low setup cost, and selective permanent retention

The repository revisions above record earlier source consultation, not a new upstream review. This revision is independently authored from the catalog baseline `d31d142a65aac84c7d927de634e654d54bd34527` as an alternative to PR #14, not derived from that branch.

## Durable decisions

- Replace the stable-seam and regression-mode structure with a feedback loop: establish the intended result and a plausible mistake, ground expectations independently, choose cheap credible evidence, run and correct while the change is small, then decide retention.
- Trigger ordinary implementation that benefits from runtime feedback as well as explicit testing. Exclude prose and static-only edits from a runtime ritual; keep planning-level evidence needs and general review distinct from concrete test design.
- Preserve the earlier behavior focus, independent expected values, and small implementation increments. Stable caller-visible seams remain useful for lasting tests, not a prerequisite for every temporary check.
- Treat existing checks, native tests, direct invocation, and temporary probes as valid choices. Neither a scratch phase nor a new permanent test is required by default. Follow explicit project gates and retention policy.
- Use guarantees actually supplied by the compiler, type checker, and linter without duplicating them. Untrusted runtime boundary validation remains behavioral. Shared helpers and custom checkers are not universally excluded when their failure could make verification falsely green.
- Prefer cheap real collaborators when integration is in question. Keep doubles for unsafe or uncontrollable operations without assuming away the behavior under test. Reject layer ratios and one-owner or per-function quotas.
- Preserve actual expected-failure verification for bugs where feasible and recheck after correction; reject shallow regressions. Use baseline, differential, or temporary characterization evidence for refactors without treating old output as proof of correctness.
- Keep test-first available for clear contracts with cheap red examples and honor explicit TDD requests or policy. Do not impose universal ordering or remove working implementation merely to manufacture red.
- Retain worthwhile recurring protection at reasonable cost, and distinguish owned disposable artifacts from existing protections. Removing or weakening existing assertions requires contract-grounded justification or equivalent protection; report losses and limitations honestly.
- Preserve the adapted pstack lifecycle concern without universal idempotence: check representative reachable partial or repeated work and the required final state. Rare severe reachable consequences still need credible evidence, not mandatory expensive tooling or exhaustive state matrices.
- Keep execution and cleanup within task authority, preserve unrelated work and sensitive state, and keep the skill independently installable without new dependencies or evaluation machinery.

## Evidence limits

This is a workflow design, not a measured improvement in generated code. More new test files are not treated as universally beneficial; accurate independent executable expectations are the useful mechanism. The design does not assert a universally superior TDD order or test-layer ratio. Comparative model evaluation remains separate from structural validation and reasoning walkthroughs.
