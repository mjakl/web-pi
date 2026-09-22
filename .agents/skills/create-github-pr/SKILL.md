---
name: create-github-pr
description: Use when the user asks to open, draft, or submit a GitHub pull request from the current branch, or to write or revise an existing pull request description. Do not use for reviewing or monitoring a pull request.
compatibility: Requires Git and GitHub CLI (gh), authenticated for the target GitHub host.
---

# Create GitHub Pull Request

Create one pull request, or draft or update an existing pull request description, and stop. Do not start an automated review workflow.

## Workflow

### 1. Read project rules

Read repository instructions, the contribution guide, and pull request templates. Project rules take precedence over this fallback workflow.

### 2. Resolve the pull request target

For an existing-description request, resolve the explicit target repository and pull request; ask if ambiguous. Read its published body, diff, and referenced issue with `gh`, along with the applicable project rules and template. Apply section 5 to the published change, not unpushed local work. Preserve relevant existing content and distinguish previously reported validation from checks run now; never imply earlier checks were rerun.

Skip new-PR preparation and pushing. For a draft-only request, return the proposed body without editing GitHub. When an update is authorized, change only the description with `gh pr edit <number> --repo <owner/repository> --body-file <file>`, read back the body to verify its content and formatting, report the URL and result, and stop.

For a new pull request, determine and verify:

- target repository;
- target base branch;
- local head branch;
- remote that owns the target base branch;
- remote that will receive the head branch.

Useful commands:

```bash
gh repo view --json nameWithOwner,defaultBranchRef
git remote -v
git branch --show-current
git status --short --branch
```

Do not create a pull request from the default branch. Ask the user if the target repository or base branch is unclear, especially when the local repository is a fork.

Check whether an open pull request already exists for the head branch. If it exists, return its URL instead of creating a duplicate unless the user requested a description revision; in that case, use the existing-description route above.

### 3. Inspect the committed change

A dirty worktree does not change the committed pull request diff, but it can make validation unclear.

- Never commit or include dirty files automatically.
- Continue only when dirty files are known to be unrelated and do not prevent validation.
- Ask the user when ownership or relevance is unclear.

Fetch the selected base branch from its remote. Compare `HEAD` with the fetched base reference:

```bash
git log <base-ref>..HEAD --oneline
git diff --stat <base-ref>...HEAD
git diff <base-ref>...HEAD
```

Confirm that the pull request contains the intended commits and no unrelated changes. Run the project checks required for the changed area. Record what ran and what could not run.

### 4. Push the head branch safely

If the head branch has not been pushed, use a normal push and set its upstream.

If the remote branch exists, fetch it and check for divergence before pushing. Do not force-push. Ask the user when local and remote history have diverged.

Creating a pull request authorizes the normal push needed for that branch. It does not authorize rewriting remote history.

### 5. Prepare the title and body

Use this order of precedence:

1. Repository instructions
2. The selected pull request template
3. The style of recent pull requests in the target repository
4. The fallback below

If several templates exist, choose the one that matches the change. Ask when the choice is unclear. Preserve required headings and checkbox structure. Use `N/A` only for a required field that is genuinely inapplicable.

Write for a reviewer who has the pull request, code changes, and referenced issue, but has not followed the task conversation. Together, these should explain why the change is needed, what it achieves, and what the reviewer needs to assess it. Keep the essential explanation in the body; use the issue and other links for supporting detail rather than repeating them in full.

Start with the problem or need and the outcome this change provides. Then explain the approach where it helps the reviewer understand an important decision, trade-off, or part of the diff. Describe the resulting change, not the sequence of implementation attempts.

Use plain English and concrete facts. Keep simple changes brief. A maintenance reason or technical guarantee can be the point; do not invent user benefits, urgency, root causes, or measurements to make the change sound bigger. Keep claims consistent with the actual pull request diff.

For example, assuming a verified stale-export bug:

- Before: “Invalidate the report cache after edits.”
- After: “Exported reports still show old values after an edit. This change invalidates the report cache so subsequent exports include saved edits.”

Include important behavior changes and scope boundaries. Explain non-obvious choices instead of listing files or repeating the diff. Report validation actually run: the check or command, observed result, and environment needed to interpret or reproduce it. Distinguish completed from planned checks and preserve material gaps. Explain risks, unresolved behavior, and follow-up affecting review, use, or rollout.

Summarize useful evidence in the body. Link supporting reports, screenshots, or documentation when helpful and accessible to intended reviewers. A temporary path such as `/tmp/remy-video-hero-qa/` is not usable evidence: describe the observations instead. Local checks can be accurately reported without publishing raw artifacts; do not commit or upload artifacts merely to make a reference usable.

Translate task history into facts the reviewer needs. Review counts and internal budgets do not explain the state of the change; report the remaining concern or verification gap instead. Omit session cleanup, internal handoffs, and coordination unless they affect reproduction, evaluation, or action. Preserve meaningful limitations when removing history.

Follow repository instructions and the selected template. Preserve required headings, checkboxes, and order, placing the explanation in the appropriate field. Recent PRs guide tone and format, not unclear writing.

Fallback body:

```markdown
## Summary

<problem or need and resulting outcome; important approach, behavior changes, and scope boundaries>

## Validation

<checks actually run, observed results, and relevant environment; distinguish planned checks and material gaps>

## Reviewer notes

<non-obvious choices, risks, unresolved behavior, or follow-up affecting review, use, or rollout; omit when empty>
```

Use a clear title that follows the repository's style. Do not apply or reject Conventional Commit prefixes unless repository policy requires that choice.

Link a known issue when appropriate:

- `Closes #<number>` when the pull request resolves it.
- `Refs #<number>` when it is related but does not resolve it.

Do not guess issue numbers. Do not repeat the full diff in the body.

Check the complete body alongside the diff and referenced issue before publication:

- Can an unfamiliar reviewer understand the need, outcome, and important approach without the task conversation?
- Does every section help explain, verify, or review the change rather than manage the task?
- Are claims and results supported, with uncertainty and limitations preserved?
- Are essential observations in the body rather than hidden behind inaccessible paths or private shorthand?

Revise unclear or unnecessary passages. This is a writing check, not an added code-review cycle.

### 6. Create and verify the pull request

Pass the repository, base branch, and head branch explicitly. Use `<head-branch>` when the branch is in the target repository. Use `<head-owner>:<head-branch>` when the branch is in a fork. Preserve real newlines by reading the body from standard input:

```bash
gh pr create \
  --repo "<owner/repository>" \
  --base "<base-branch>" \
  --head "<head-spec>" \
  --title "<title>" \
  --body-file - <<'EOF'
<body>
EOF
```

Add `--draft` only when the user asks for a draft.

Query the created pull request. Verify its URL, repository, base, head, and draft state, and read back the body to check its content and formatting. Report the URL, a short summary, validation results, and any remaining staged, unstaged, or untracked work. Confirm that remaining work was not included in the pull request.
