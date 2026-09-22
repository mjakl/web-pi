---
name: manage-issues
description: Use when the user asks to read or assess one GitHub issue, or to draft, create, update, comment on, label, or close a PR-sized GitHub issue. Do not use for a multi-PR initiative map, repository-local tk tickets, or a local task queue.
compatibility: Requires Git, an authenticated GitHub CLI (`gh`), network access to GitHub, and issue access in the target repository.
---

# Manage Issues

Manage durable GitHub change requests. Bound each issue to one coherent pull request. Follow repository instructions and issue templates before this skill's defaults.

## Boundaries

- Treat GitHub issues as durable requests, specifications, and team discussion.
- Do not use issues as a local execution queue.
- Do not inspect or modify local task stores as part of an issue operation.
- Reading an issue does not authorize changing it.
- Drafting an issue does not authorize creating it.
- Create, edit, comment, label, close, or reopen only the issue and operation the user authorized.
- Do not add a triage state machine or default label vocabulary. Use labels only when the user requests them or repository policy clearly requires them.

## Establish context

1. Resolve the target repository from the user's request or the current Git remote.
2. Read project instructions and relevant files under `.github/ISSUE_TEMPLATE/`.
   - For a YAML issue form, preserve required fields, allowed options, title prefixes, labels, and field order. Ask only for required information that is missing.
   - If a required confirmation asserts that a check was performed, perform the safe read-only check or ask the user; do not mark it complete without evidence.
3. Verify the repository and authentication with read-only `gh` commands.
4. Preserve the user's intended repository when the current directory points elsewhere.

## Read an issue

Use `gh issue view` with the explicit repository when needed. Read the body and relevant discussion before summarizing or acting.

Report:

- the requested outcome;
- important scope and acceptance criteria;
- settled decisions and unresolved questions;
- dependencies or related work that materially affect the request.

Flag missing context that prevents understanding the request; reading alone does not authorize repairing the body. Do not turn an issue summary into an implementation plan unless the user asks.

## Check cold-reader context

Before presenting a draft or an authorized body edit, check whether a contributor with only the issue and repository can understand the problem or need, why it matters, intended outcome, scope, and observable completion—without agent chat or private review context.

- Keep the essential explanation in the body. Use repository documentation and durable links for supporting detail, not as substitutes for that explanation; do not duplicate established repository contracts.
- Replace unexplained finding IDs, session names, or workstream shorthand with meaningful names and relevant facts, including for excluded work. Omit unrelated process history.
- Explain dependencies and ordering: name the prerequisite, what it provides, and why it must come first. State this issue's own problem and scope without copying sibling issues.
- Recover missing context from repository evidence and relevant linked issues, commits, or discussion. Distinguish established facts from hypotheses. If essential context remains unresolved, ask a focused question rather than inventing a mapping, rationale, or requirement.

Keep the result concise; this check does not require extra sections.

## Draft an issue

Use the repository's issue template when one fits. Otherwise, use this minimal structure:

```markdown
# <Outcome-oriented title>

## Context
<Why this change is needed.>

## Desired outcome
<What should be true when the issue is complete.>

## Acceptance criteria
- <Observable result>
```

For a bug without a matching repository template, include reproduction steps, expected and actual behavior, environment or version, and relevant logs when known.

Add only the sections that help:

- **Scope and non-goals** when the boundary is easy to misunderstand;
- **Constraints or decisions** for durable implementation restrictions;
- **Dependencies** when another issue must happen first;
- **Open questions** for uncertainty that the team must resolve.

Guidance:

- State outcomes and observable behavior before implementation details.
- Keep one coherent PR-sized request per issue.
- Do not invent acceptance criteria that the discussion did not establish.
- Do not copy long discussion or existing documents when a stable link is enough.
- Avoid implementation checklists while implementation remains undecided.
- Use project vocabulary and concise technical language.

Show the final title and body before creation. Let the user revise them.

## Apply an authorized operation

Before every mutation, show the exact proposed operation and wait for confirmation.

- Create with `gh issue create` only after the final draft is confirmed.
- For an edit, fetch the current issue first, then show the complete field or body change and preserve every field the user did not authorize changing. Wait before applying it.
- For a comment, show the final text. Preserve the user's meaning and identify when the comment is AI-authored if project policy requires it.
- For labels, inspect available labels first and show the exact additions and removals.
- For close or reopen, state the resulting issue state and reason. Before proposing closure as fixed, duplicate, or out of scope, verify and cite the fixing pull request or commit, original issue, or repository policy. If the evidence is unavailable, state that and do not invent it.
- Use a temporary body file when multiline shell quoting would be fragile. Remove it afterward.

After mutation, fetch the issue again and verify the intended state. Report the issue URL and the operation completed.
