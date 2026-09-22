# Provenance

## Source

Adapted from `mattpocock/skills` `diagnosing-bugs` at commit `8b78b531ab965735c5dc74f6f7a219e1e37326df`.

## Durable decisions

- Keep the feedback loop, reproduction, useful reduction, falsifiable hypotheses, tagged instrumentation, and cause-level fix. Establish the actual expected failure where feasible and recheck the correction with existing tests, direct reproduction, or temporary evidence; do not require a new permanent regression test by default.
- Separate useful diagnostic evidence from permanent retention. Keep worthwhile recurring protection under project policy, preserve existing protections unless their removal is justified, report losses, and clean up only owned disposable artifacts. This aligns with the catalog's feedback-first testing design without adding a skill dependency or changing diagnosis authority and correction gates.
- Load automatically for hard defects and whenever the user asks to check or address pull-request review feedback; classify comments before deciding whether substantive diagnosis is needed. Do not use root-cause machinery for simple errors with a proven cause.
- Qualify review feedback against the original requirement, non-goals, current diff, supported production contract, and complete thread before diagnosis. Treat findings as hypotheses and proposed remedies separately so planned later work, unsupported event orderings, and missing context do not cause patchwork fixes. Require practical impact that warrants root-cause work, including severe latent project effects, and reject obscure edge-case diagnosis that only expands the supported contract.
- After proving a cause, search relevant code for other manifestations of the causal pattern and distinguish confirmed instances from superficial matches.
- Fix every confirmed instance that fits one coherent scope; ask before broadening into pre-existing architectural or migration work.
- Treat attempted corrections as reversible. If a correction creates new state, unsupported ordering tests, or compensating branches, compare it with the last proven baseline and prefer removing unnecessary expansion over preserving sunk effort. Stop for human direction before continuing a correction cycle without a newly proven cause.
- Prefer a runnable red-capable loop, but permit clearly limited evidence-led diagnosis when reproduction is unsafe or unavailable.
- Judge loop speed relative to the real system rather than requiring seconds.
- Reduce a reproducer only while reduction provides diagnostic value.
- Remove the bundled Bash human-in-the-loop template and named dependencies on architecture, browser, review, or commit skills.
- Keep production access, instrumentation, external effects, and sensitive artifacts behind explicit authorization.
- Keep diagnosis subordinate to the enclosing workflow's authorization; read-only review does not authorize editing, committing, or pushing.
