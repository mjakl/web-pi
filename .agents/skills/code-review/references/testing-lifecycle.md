# Testing and lifecycle audit lens

Use this lens to decide whether the complete reviewed scope and its affected contract are verified across the states and events they can encounter. The default scope is the complete branch; an explicitly narrow review remains limited as defined by the main workflow.

## Behavioral evidence and retained tests

Check whether:

- existing checks, focused tests, direct invocations, or temporary probes provide credible evidence for the changed behavior;
- evidence includes the real integration boundary when a narrow check cannot exercise the plausible mistake;
- expected values come from the specification, a worked example, or another independent source, not the new implementation;
- checks distinguish plausible wrong outcomes and important forbidden effects instead of only proving that code ran;
- doubles preserve collaborator behavior needed by the check rather than assume the disputed interaction works;
- execution claims include actual results and distinguish them from source inspection or reasoning;
- retained tests provide stable, worthwhile recurring protection without duplicating existing checks or actual compiler, type, and lint guarantees.

Assess current verification and permanent retention separately. A safely removed temporary probe can be sufficient evidence; missing new test files is not itself a defect. Follow explicit project retention policy, and prefer stable caller-visible seams for lasting tests. Checks of shared helpers or custom verifiers can be valuable when their failure would make other evidence falsely green; do not exclude them by category.

Require justification for weakening existing protection: an authorized contract or scope change, an assertion incorrect or obsolete under that contract, or equivalent protection that remains. Report any loss. Rare but reachable severe security, data-integrity, destructive-operation, or lifecycle consequences still need credible evidence; report a material gap rather than accept unrelated green checks. Do not judge verification by test count or line percentage.

## Data states

For every new or changed field, enumerate reachable values:

- values created by migrations for existing records;
- null, missing, empty, default, stale, and legacy values;
- partially written or partially migrated values;
- values read by older or concurrent processes.

Walk every material read site. Verify that missing values cannot be counted as success or compared as meaningful by accident.

## Files and artifacts

For every expected file or artifact, check behavior when it is:

- absent;
- empty or truncated;
- replaced between reads;
- from an older version;
- concurrently written;
- inaccessible or malformed.

Require evidence for consequential states the system can realistically produce, not a new permanent test for every state.

## Process and resource lifecycle

Trace:

- startup and initialization;
- normal operation;
- graceful shutdown;
- cancellation and timeout;
- crash and restart;
- retries and duplicate delivery;
- concurrent processes or connections;
- cleanup and recovery.

Verify library behavior from documentation when correctness depends on shutdown, cancellation, transaction, or process-exit semantics.

Check that resources remain owned until all users finish. Look for a database, file, client, worker, executor, or browser closed while another operation can still use it.

## Invariant placement

For an invariant such as “X never counts as Y” or “only Z may transition to Q,” check whether one structural boundary enforces it. Scattered optional checks are easy for a new caller or review fix to bypass.

## Complete-scope verification

Check that the reviewed scope updates all required affected surfaces:

- tests and fixtures;
- schema and migration behavior;
- configuration and environment examples;
- public types and consumers;
- documentation and operational instructions;
- lockfiles or generated files when project policy requires them.

After fixes, repeat the complete reviewed scope, including the correction set. A fix aimed at one state may make another state unsafe.
