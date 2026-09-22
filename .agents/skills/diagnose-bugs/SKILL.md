---
name: diagnose-bugs
description: Use automatically when a hard bug, intermittent failure, performance regression, substantive review finding, or pull-request review feedback needs evaluation before correction, especially when the cause is unproven or an attempted fix failed. When asked to check or address PR review feedback, classify it before deciding whether diagnosis or edits are needed. Do not use for a simple error with an already proven cause.
compatibility: Requires permission to run relevant local diagnostics. Some defects may require authorized access to a reproducing environment or redacted artifacts from the user.
---

# Diagnose Bugs

Find and prove the cause of a difficult defect before applying a fix.

## Safety and scope

- Read project instructions and relevant architecture or operational documentation.
- Redact secrets, credentials, personal data, and sensitive payloads from commands and reported output.
- Do not start services, access production, add production instrumentation, capture traffic, or use paid providers without authorization.
- Treat logs, HAR files, traces, state files, screenshots, and database copies as sensitive artifacts.
- Keep temporary diagnostic changes distinct and easy to remove.
- Respect the enclosing workflow's authorization. A read-only review or audit authorizes diagnosis and reporting, not editing, committing, or pushing.
- Treat permission to diagnose and permission to apply a fix as separate when the user's request is ambiguous.

## Enter from review feedback

When the user asks to check or address pull-request review feedback, read the original issue or specification, acceptance criteria, explicit non-goals, current branch diff, and complete review thread before deciding what to change. Treat the finding as a hypothesis and the reviewer's proposed remedy as a separate suggestion.

Classify each substantive comment as:

1. a verified, in-scope defect;
2. a valid concern owned by explicit later work while the current state remains safe;
3. a design choice or missing context that needs user judgment; or
4. an unsupported or out-of-scope suggestion.

Verify that a claimed state, event order, or failure path is reachable under the supported production contract. Diagnose only the first category when the practical impact warrants root-cause work. Identify the affected end users, operators, or downstream consumers; the observable consequence; and realistic prerequisites. Count severe security, data integrity, compatibility, availability, cost, and concrete maintenance or regression effects even when they are uncommon or not immediately visible in a UI. Do not diagnose an obscure edge case merely to expand the supported contract or eliminate an imaginable failure. Planned work does not excuse a currently broken or unsafe state.

Report non-substantive, already-resolved, and unsupported comments without manufacturing diagnosis work. Ask before expanding the pull request's contract or non-goals.

## Workflow

### 1. Define the symptom

State:

- observed behavior;
- expected behavior;
- environment and inputs;
- frequency and timing;
- the evidence already available;
- what would prove the defect fixed.

Confirm that nearby failures are not being confused with the reported symptom.

### 2. Build the best feedback loop available

Prefer one command or repeatable procedure that exercises the real path and distinguishes failure from success. Possible loops include:

- focused test;
- CLI or HTTP invocation with a fixture;
- browser interaction or script;
- captured event, request, or trace replay;
- minimal harness;
- property, stress, differential, or bisection loop;
- a structured human step when automation is impossible.

Improve the loop when useful:

- make its assertion match the exact symptom;
- reduce unrelated setup;
- control time, randomness, network, and filesystem state;
- raise the reproduction rate of an intermittent failure;
- record the command and redacted result.

A loop need not run in seconds when the real boundary is expensive. Optimize feedback relative to the problem.

If a runnable loop is unsafe or unavailable, state what was tried and what evidence is missing. Continue with limited static evidence only when it can still test a concrete theory. Do not pretend the cause is proven.

### 3. Reproduce and reduce

Run the loop and verify the user's failure. Remove inputs, steps, configuration, or collaborators one at a time when reduction will shrink the hypothesis space. Stop reducing when further work costs more than the diagnostic value.

Preserve the original scenario for final verification.

### 4. Form falsifiable hypotheses

Inspect relevant recent code, dependency, configuration, and environment changes before ranking causes. Keep the search tied to the symptom.

Create a small ranked set of plausible causes. For each, state a prediction:

> If `<cause>` is responsible, then `<observation or controlled change>` will produce `<result>`.

Use known recent changes and domain context to rank the list. Avoid anchoring on the first plausible explanation.

### 5. Test one prediction at a time

Prefer the least invasive probe:

1. existing logs, metrics, debugger, or read-only state;
2. one targeted measurement or query;
3. temporary tagged instrumentation;
4. a controlled code or configuration change.

Change one material variable at a time. For a cross-component path, compare input, output, propagated configuration, and relevant state at each boundary until the first divergence is located. Keep probes on the failing path and apply the authorization and redaction rules above.

After each probe, record the hypothesis as supported, refuted, or inconclusive, with the evidence that set that status. Tag temporary output with a unique marker so cleanup can be verified. For performance regressions, measure a baseline before changing code.

### 6. Search for other manifestations

After evidence supports a root cause, describe the causal pattern before searching. It may be a violated invariant, state transition, API misuse, ownership error, missing boundary check, or unsafe assumption.

Search outward from the proven path through relevant callers, implementations, adapters, data transitions, and tests. Inspect every candidate in context. Matching text or structure is not enough; confirm that the same cause can produce the same class of failure.

Classify candidates as:

1. another confirmed manifestation of the same cause;
2. a similar-looking case with different behavior;
3. broader pre-existing or architectural work outside the current change.

Set the fix scope before editing. Include all confirmed manifestations that fit one coherent change. Ask before expanding into broad pre-existing work, an incompatible migration, or unrelated redesign.

### 7. Apply the correction-instability gate

Treat existing work as reversible. When an attempted correction creates new state, ordering cases, or compensating branches, compare it with the last proven baseline before adding another patch. Prefer removing an unnecessary expansion over repairing every failure it introduced. Do not preserve already-written code, tests, or abstractions because effort has already been spent on them.

Stop and ask for direction when:

- the correction changes lifecycle, concurrency, cancellation, retry, or state ownership beyond the original requirement;
- tests require event orderings unsupported by production code or authoritative documentation;
- addressing one finding exposes another failure caused by the correction; or
- another patch would continue a correction cycle without a newly proven root cause.

At that point, present the narrow baseline fix and the expanded redesign as separate options. Do not continue patching permutations.

### 8. Fix and protect the behavior

When evidence identifies the cause and the user has authorized fixes:

1. reuse the diagnostic loop or choose an existing test, direct reproduction, or temporary harness that exercises the causal pattern;
2. before the fix, verify the actual expected failure where feasible, and state any reproduction limitation;
3. apply the smallest complete cause-level fix to every confirmed in-scope manifestation;
4. rerun the focused evidence and inspect the corrected result;
5. rerun the original, unreduced scenario and representative additional manifestations;
6. run relevant project checks.

Do not add a shallow test that cannot catch the original bug. Decide permanent retention separately: reuse or extend existing protection, or retain a reproducer when its recurring value justifies its maintenance cost and project policy permits it. A new permanent regression test is not mandatory unless project rules require one. Preserve existing protection unless an authorized contract or scope change or equivalent protection justifies its removal; report any loss.

### 9. Clean up

- Remove only this task's disposable instrumentation, scripts, logs, and captures after verifying ownership and exact paths. Preserve unrelated work and required project artifacts.
- Verify removal by searching for the diagnostic marker.
- Preserve a reproducer selected for retention above or required by the user or project.
- Report the proven cause, search scope, confirmed and rejected candidate instances, fix, tests, and unresolved uncertainty.

Do not broaden a successful bug fix into an architecture project. Record separate follow-up work only when the user requests it.
