---
name: testing
description: Use automatically when adding, changing, or organizing tests; choosing a concrete test boundary; creating regression coverage; or working through red-green-refactor. Do not use merely to name high-level test needs in an implementation plan. During general review, use only when test-focused analysis is requested or a correction requires concrete test design.
---

# Testing

Test observable behavior through the smallest stable seam used by a real caller. Keep tests stable while implementation details change.

## Start with project context

1. Read project testing instructions, commands, configuration, and representative nearby tests.
2. Identify the behavior, caller, and boundary being verified.
3. Use project terminology and native test support before adding new helpers or conventions.
4. Choose the narrowest test that can exercise the real behavior and failure mode.

Project rules override generic taxonomy. Do not create a new test layer when an existing layer already owns the behavior.

Preserve existing observable behavior and contracts unless a change is explicitly requested or necessary to achieve the stated outcome. Implementation convenience or incidental side effects do not authorize behavior changes. Explain necessary implied changes; ask before proceeding when their necessity or intended outcome is materially ambiguous.

Make tests reflect the authorized contract, not merely the implementation. When changing or removing a behavioral assertion, identify the authorized behavior change, evidence that the assertion is incorrect or obsolete under that contract, or the equivalent protection that remains.

## Stable seams

A useful seam may be:

- an application use case;
- a module's public interface;
- an HTTP endpoint;
- a CLI command;
- a message or event contract;
- an adapter contract;
- an important end-to-end workflow.

Outside-in testing does not mean every test uses the complete deployed system. Begin from behavior visible to a caller and drive inward only as needed.

Use the smallest stable seam that:

- can reproduce the behavior;
- includes the important ownership or integration boundary;
- survives internal refactoring;
- fails when the behavior is wrong.

## Test ownership

- Give each behavior one primary test owner.
- Use focused module tests for stable pure policies and algorithms.
- Use contract tests when several adapters or implementations must follow one boundary.
- Use slice or integration tests when real composition, storage, transactions, or process behavior matters.
- Keep a small number of end-to-end tests for critical wiring and user workflows.
- Avoid repeating the same assertions at every layer.

A narrow test is not automatically better. A broad test is not automatically more realistic. Choose the boundary that owns the behavior.

## Test design

Good tests:

- state behavior in caller or domain language;
- arrange data explicitly;
- use expected values from a specification, worked example, or independent source;
- assert the important output or external effect;
- cover realistic failure and lifecycle paths;
- make failures easy to interpret.

Avoid:

- direct tests of private methods;
- exporting internal helpers only for tests;
- mocks of the system's own collaborators when the real behavior depends on their interaction;
- call-count or call-order assertions without contractual meaning;
- tautological expected values computed like the implementation;
- broad snapshots without a clear behavioral claim;
- shared implicit fixtures that hide the state under test;
- tests that break during harmless refactoring.

Use test doubles for external, slow, expensive, destructive, or non-deterministic boundaries. Before replacing a collaborator, identify its observable side effects and whether the test depends on them. If it does, keep a real or lightweight implementation, or replace only the lower external operation. Keep doubles and builders in test support code.

## Repeated and interrupted operations

When work can run more than once or stop partway, test the repeated or resumed operation and verify its final observable state.

- Establish the required result first: converge, resume, roll back, or reject safely.
- Exercise only the applicable repeated-invocation, retry, duplicate operation or delivery, interruption, crash, restart, startup, or shutdown behavior.
- Assert the final caller-visible result and important side effects, including effects that must not happen twice.
- When interruption or partial execution applies, cover representative boundaries and resulting partial state. Do not require idempotence universally or test every instruction boundary.
- When a test owns a local process, use the project's existing helper to start it, wait for observable readiness, exercise the caller, propagate its result, and guarantee cleanup.

State the limitation when the realistic lifecycle cannot be exercised safely or economically.

## Characterization mode

For behavior-preserving refactoring with weak coverage, first add the smallest characterization test that records current observable behavior at the stable seam. Refactor in small green steps. If a step fails, reverse only that step to the last known green state and take a smaller step. Use regression mode instead for known defects; do not encode a defect as desired behavior.

## TDD mode

Use this mode when the user requests test-first work, project policy requires it, or an existing red-green-refactor loop is underway.

1. Select one behavior and its stable seam.
2. Write one test that describes the desired behavior.
3. Run it and verify that it fails for the expected reason.
4. Add only enough implementation to make it pass.
5. Run the focused test and relevant nearby tests.
6. Refactor hidden implementation while tests remain green.
7. Repeat with the next vertical slice.

Do not write all tests and then all implementation. Let each cycle refine the next behavior and boundary.

Ask the user about a seam only when the choice changes public design, cost, or confidence materially. Do not require approval for every routine test placement.

## Regression mode

For an existing defect:

1. Reproduce the observed failure.
2. Choose the seam that can catch the real pattern.
3. Add a test and verify that it fails for that reason.
4. Apply the fix.
5. Verify the focused test and original scenario.
6. Run the relevant wider project checks.

Do not add a regression test at a seam too shallow to reproduce the defect. State the coverage limitation when no suitable seam exists.

## Finish

Report:

- behavior and seam tested;
- test command and result;
- why the chosen boundary is appropriate;
- broader checks run;
- important behavior or environment not verified.
