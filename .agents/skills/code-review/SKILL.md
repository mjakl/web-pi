---
name: code-review
description: Use when the current branch or PR-ready change set needs its primary readiness review before pull-request creation, after authorized review corrections or behavior-preserving simplification, when the user asks whether current work is ready, or when they explicitly request a focused review such as "what could this break?". A narrow standalone review applies only when explicitly requested; finding closure applies only after a completed primary review. Do not use for edits, root-cause diagnosis, external CLI review, or evaluating hosted PR feedback.
compatibility: Requires Git for branch-range discovery. Project-specific validation may require additional commands declared by that project.
---

# Code Review

For a complete primary review, review the proposed change as one system and decide whether it is ready for a pull request. For the built-in finding-closure exception, decide whether named blockers are closed and whether correction breadth preserves the primary readiness conclusion. Produce one integrated, evidence-driven report. Zero findings is a valid result.

## Operating rules

- Work read-only in the repository. Do not edit, stage, commit, push, or repair repository files.
- A focused safety proof may use a disposable script outside the repository only when execution is known to be local and non-destructive. Remove it before reporting.
- Default standalone review to the complete current branch against its merge base, including pending worktree changes. Use the bounded finding-closure scope only after this primary review is complete.
- Read project instructions, architecture, standards, and relevant decisions before applying generic judgment.
- Trace affected behavior beyond edited lines into callers, data, configuration, tests, delivery, and operations.
- Prefer zero strong findings to a broad list of possibilities. Do not rubber-stamp, but do not manufacture concerns.
- Never start services, run migrations, modify test data, call production systems, or use diagnostics that can change external state.
- Never print secret values. Refer only to secret names and handling paths.
- Run only checks known to be read-only. State unavailable, destructive, or prohibitively expensive validation.
- Produce one synthesized report. Do not dump separate lens reports.

## Establish the review range

1. Resolve the repository root and inspect staged, unstaged, and untracked paths.
2. Use the user's explicit base when provided. Otherwise, determine the default branch from project instructions or the remote default ref. Ask when the base is ambiguous.
3. Compute the merge base. Inventory every commit and changed file from that point through `HEAD`.
4. Include relevant pending worktree changes. State that a branch with pending changes is not reproducible or PR-ready until the intended state is committed.
5. Before analyzing the diff, confirm the intended outcome, established acceptance criteria, latest scope, and non-goals from the current conversation and direct issue, ticket, specification, PR, or commit references. Read authoritative sources as needed; do not scan unrelated tracker stores or infer requirements solely from the diff. If essential intent is missing, ask once before concluding readiness.
   - When delegating this review, provide a self-contained brief with that context and authoritative issue, ticket, or specification references, if any. Keep implementation claims and validation results separate from requirements. Pass the same brief to independently delegated specialists.
   - Conversation or direct briefing is sufficient; do not require a new artifact or tracker.
6. Read relevant composition points, representative callers, tests, schemas, configuration, migrations, documentation, and delivery paths for every materially affected workflow.
7. Identify changed trust, performance, architecture, data, and lifecycle surfaces before choosing deeper lenses.

A standalone focused or narrower review requires an explicit user request. Establish its range precisely, inspect its complete affected contract, label the result scope-limited, and never use it to establish complete PR readiness.

The bounded finding-closure review after a completed primary branch review is the explicit built-in exception to that request requirement. Its composite scope is the named findings, affected contracts and callers, and every correction edit. It must not reopen unrelated surfaces or independently repeat the complete readiness assessment.

## Review tests and verification evidence early

Read changed and representative existing tests early to understand claimed behavior, coverage, and repository conventions. Tests are evidence, not authority: reconcile them with requirements, callers, stored state, configuration, and operational behavior.

Determine what tests, builds, type checks, lint checks, manual checks, screenshots, migrations, or other evidence are claimed or required. Run appropriate read-only project commands when available. Verify that the evidence can actually fail when the changed behavior is wrong; do not equate command success with complete correctness.

## Keep diagnosis outside review iteration

Use the strongest cheap read-only evidence available to corroborate a finding. When a substantive finding or proposed correction still depends on unproven runtime behavior, event ordering, lifecycle ownership, or another uncertain cause, report the precise hypothesis and missing evidence, then stop review iteration for root-cause diagnosis. Do not let review comments or test doubles define new supported runtime permutations.

If a review-driven correction has already failed or created another lifecycle or state-ordering problem, do not propose another compensating patch from review. Diagnosis must compare the correction with the last proven baseline and establish one cause before further editing.

## Prove decisive safety claims when needed

Use this analysis when the user explicitly asks what a change could break or when review shows that safety depends on a material, non-obvious invariant. Do not force a decisive claim onto routine changes.

1. State the one or few facts that make the changed behavior safe. Avoid replacing analysis with a long caller list.
2. Follow each fact beyond text search when necessary: inspect the pinned dependency or local patch, execution timing and lifecycle, stored or wire formats, generated code, feature exposure, and downstream consumers.
3. Take each fact to the strongest cheap evidence available:
   - cite the exact source or dependency behavior;
   - trace why the realistic failure path cannot reach the unsafe state;
   - run an existing focused check;
   - when useful, run a small disposable script against the real local code;
   - use an already available authorized runtime reproduction only when it does not require starting a service or changing state.
4. Classify the result as confirmed by execution, supported by a traced unreachable path, supported only by source inspection, or unverified.

Prefer existing project checks. Do not add repository test files or build a substantial harness during review. Lack of runtime proof blocks readiness only when the unverified fact carries material risk; otherwise report the precise validation gap.

Integrate the result into the existing report. Mention a decisive proven invariant only when it materially supports the assessment. Keep every unverified claim in **Risks, gaps, and missing validation**; report a finding only after the existing corroboration and confidence rules support it. Do not add a safety-proof section mechanically.

## Review the complete change

### Intent and scope

Check whether the branch:

- delivers the requested outcome and acceptance criteria;
- omits or only partially implements required behavior;
- introduces behavior, hardening, cleanup, or dependencies outside the agreed scope;
- preserves explicit non-goals and settled decisions;
- remains coherent when work assigned to later changes is excluded.

Planned later work is acceptable only when the current branch remains independently correct, compatible, and safe. It does not excuse data loss, security exposure, broken migration states, or unusable intermediate behavior.

### Correctness, state, and lifecycle

Look for a concrete reachable failure path:

- wrong results, missing validation, regressions, or inconsistent errors;
- changed callers, interfaces, schemas, configuration, or stored values that were not updated;
- null, missing, default, stale, legacy, or partially migrated state;
- absent, truncated, replaced, malformed, or concurrently changed files and artifacts;
- startup, shutdown, cancellation, timeout, retry, crash, restart, and duplicate-delivery behavior;
- unsafe resource ownership across workers, connections, requests, files, and transactions;
- races, stale responses, replay, or check-then-act failures;
- invariants enforced only by optional call-site flow instead of one reliable boundary;
- interactions between individually plausible commits that leave the final branch inconsistent.

For a stateful finding, describe the state, event order, code site, and wrong outcome. Do not report a state that no realistic path can produce.

### Project quality and testing

Check whether the branch:

- follows repository architecture, vocabulary, coding, and documentation rules;
- introduces complexity, duplication, or indirection with concrete maintenance or regression impact;
- assigns behavior and state to a coherent owner;
- tests changed behavior through stable, caller-visible evidence;
- covers important failure and lifecycle states;
- uses expected values that can disagree with the implementation;
- updates required fixtures, configuration, migrations, generated artifacts, documentation, and operational instructions.

Generic smells, formatting preferences, and theoretical cleanup are not findings. When complexity is a real problem, explain its impact and suggest the smallest complete correction direction. Distinguish accidental implementation complexity from a wrong ownership boundary and from necessary domain complexity. A review finding is not authorization to refactor.

### Dependency and lockfile changes

When dependencies or lockfiles change:

- check whether the existing stack or standard library already covers the need;
- read relevant changelogs and migration notes instead of trusting the version number alone;
- inspect direct and transitive lockfile effects;
- for a new direct dependency, assess available evidence about source trust, active maintenance, known security concerns, and project-policy compatibility;
- identify changed runtime, compatibility, security, licensing, bundle, or operational behavior when relevant;
- verify behavior through project-native evidence, not installation success alone;
- flag hand-edited, stale, or unintentionally omitted lockfiles.

Do not assume one package manager, invoke ecosystem-specific audit commands generically, or require one dependency per change.

## Apply conditional lenses

Read the lenses justified by the changed surfaces. An explicitly requested architecture, security, performance, testing, lifecycle, or operational focus selects that lens even when initial surface classification is uncertain:

- [Architecture](references/architecture.md) when the branch changes ownership, module or service boundaries, state, orchestration, integrations, framework coupling, test seams, or compatibility contracts.
- [Security](references/security.md) when it changes authentication, authorization, untrusted input, secrets, files, processes, network calls, stored data, public interfaces, or another trust boundary.
- [Performance](references/performance.md) when it changes query loops, batch work, search, caching, serialization, large data movement, concurrency, provider calls, or latency-sensitive paths.
- [Testing and lifecycle](references/testing-lifecycle.md) for every material branch, deeply when schemas, migrations, jobs, retries, resources, caches, startup, shutdown, or deployment behavior change.

An explicit risk focus does not excuse a concrete high-impact problem from another lens. A focused explicit range still receives any lens its changed surface requires. A large diff does not automatically justify every lens.

## Corroborate findings

For each proposed finding:

1. State the required behavior, contract, or invariant.
2. Trace the reachable state and event sequence.
3. Cite the relevant code and project rule.
4. Check callers, tests, configuration, and known intent.
5. Identify the affected users, operators, or downstream consumers, the observable consequence, and the realistic conditions under which it occurs.
6. Separate observed behavior from assumptions.
7. Recommend the smallest complete correction direction.

Use practical impact as a gate, not immediate UI visibility as the only test. Count effects on end users, operators, downstream consumers, security, data integrity, compatibility, availability, cost, and concrete maintenance or regression risk. An uncommon path can still matter when its consequence is severe, but an obscure edge case warrants correction only when it is realistically reachable and its impact justifies the added complexity. Do not expand the supported contract merely to eliminate an imaginable failure.

For a structural finding, propose a useful move rather than saying only that code is complex. Depending on the evidence, that may mean collapsing duplicate branches, separating orchestration from policy, restoring one owner, reusing the canonical implementation, making a contract explicit, or removing pass-through indirection. Do not prescribe a pattern without showing why it removes current complexity rather than relocating it.

### Keep recommended remedies proportional

Separate the validity of a finding from the reviewer's preferred remedy. A confirmed finding establishes a violated requirement or invariant; it does not make one suggested implementation mandatory. Recommend the required outcome and the smallest complete correction direction rather than prescribing unproven machinery.

When a possible remedy adds substantial state, branches, coordination, retries, dependencies, or maintenance burden, compare it with reusing an existing invariant, adding a boundary guard, failing or refusing conservatively, or retaining an explicitly accepted limitation. Do not require a heuristic or best-effort component to become an audit-grade mechanism unless its documented contract demands that guarantee. If the simplest complete correction is still complex, say so plainly; never weaken a concrete correctness, security, or data-loss finding merely to keep the implementation small.

Discard:

- style-only comments;
- generic best practices;
- unmeasured micro-optimizations;
- speculative architecture work without current pressure;
- duplicate symptoms of one underlying invariant;
- work explicitly assigned to a later change when this branch is safe and coherent.

When a configured tool has already surfaced a formatting, import-ordering, lint, or trivial-typo issue, do not duplicate it as a manual finding. Report failed required checks and any change that weakens or bypasses their enforcement.

Lead with high-impact, high-confidence findings. Direct language is preferable to softened ambiguity when evidence shows a real defect.

## Severity and confidence

Use:

- **Critical:** practical path to data loss, broad compromise, outage, or severe correctness failure.
- **High:** practical major bug, security risk, regression, or unsafe contract with important impact.
- **Medium:** concrete robustness, performance, testing, or maintainability problem with meaningful impact.
- **Low:** real but non-blocking problem worth considering before the PR.

State confidence separately:

- **Confirmed:** directly visible or reproduced.
- **Probable:** strongly supported, but one precondition is not verified.
- **Unverified:** plausible but needs evidence; report it as a gap, not a confirmed finding.

Prefer zero through five confirmed findings. Group related symptoms under their shared invariant.

## Report

```markdown
## Summary
<Intent, reviewed range, selected lenses, validation, and direct readiness assessment.>

## Confirmed findings
- **<Severity> / <Confidence> — <title>** (`path:line`)
  - Invariant and evidence
  - Failure sequence and impact
  - Smallest complete correction direction

## Risks, gaps, and missing validation
- <Unverified concern, measurement gap, or unavailable check>

## Healthy patterns worth preserving
- <Only when useful to constrain corrections or future work>

## Overall assessment
<Primary: ready for PR, ready after named corrections, or not ready. Standalone focused review: scope-limited. Finding closure: blockers closed or open, and primary readiness conclusion preserved or invalidated.>
```

Write `None found` in an empty findings section. For a complete primary review, say plainly when the branch is ready. For finding closure, report whether each blocker is closed and whether correction breadth preserves or invalidates the primary readiness conclusion. Do not call closure independently ready; a complete primary review plus clean closure is the readiness evidence.

## Bound the review cycle

Run one complete primary review. After review-driven corrections, wait until one coherent authorized correction set is complete, then run one scoped finding-closure review as the built-in exception above. Cover every original finding, the affected contract and callers, and every correction edit. Verify that each cause is closed without regression, but do not reopen unrelated surfaces or generate preference-only follow-ups. State the exact closure scope, whether the original readiness blockers are resolved, and whether correction breadth invalidates the primary readiness conclusion. A clean closure combined with the primary review establishes readiness evidence; closure alone does not.

If closure finds a sibling manifestation of the same cause, or the correction introduces new lifecycle states, ordering cases, or failures caused by the correction itself, stop review iteration. Require explicit root-cause diagnosis and state-space or event-sequence modeling before one cause-level correction. Treat removal of the reviewed expansion and return to the last proven baseline as a real correction option. This is a workflow transition, not authorization to diagnose or edit, and it does not create a dependency on another skill.

Run at most one complete branch re-review after the primary review. Use it only when correction breadth materially affects architecture, persistence or data compatibility, lifecycle or concurrency, security or trust boundaries, public behavior, or exposes a broader shared root cause beyond the original affected contract. If another correction would trigger another complete branch re-review, stop and require human direction rather than loop.

When this review is enclosed by an independent final-review phase, that phase may receive at most one authorized correction followed by one rerun of its selected reviewer set. Adding another reviewer does not reset the allowance. If any rerun finds a new root cause, stop and require human direction.

Behavior-preserving simplification before the primary review does not itself consume a review cycle. Avoid review-after-every-edit and nitpick spirals. The review remains read-only and never authorizes diagnosis, changes, commits, or pushes.
