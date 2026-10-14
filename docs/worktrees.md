# Worktrees in web-pi

web-pi lists sessions globally and lets you choose a working folder for each new
session. Create, remove, and prune worktrees with Git or another tool. web-pi
does not perform those operations or change a worktree's branch.

## Choose a working folder

Open New Session, then its working-directory dropdown. Expand a repository to
see folders represented by its known sessions. This list is derived from session
history, not a fresh Git worktree scan. For a newly created worktree without a
session, use **Custom path…** and select its folder. Ordinary folders use the
same flow.

The dropdown groups original checkouts and linked worktrees by repository,
including worktrees backed by a bare repository. A repository subdirectory keeps
its own identity. This grouping does not filter the global sidebar.

New Session opens the composer directly, defaulting to the last explicitly
chosen folder, or the configured server default before any choice. Choosing a
folder opens its independent draft. The first message creates the session in
that folder; existing sessions cannot change cwd. Opening an old session changes
its header, explorer and file context, but never the new-session preference.
Every sidebar row shows its folder basename with a full-path tooltip and the
existing optional worktree branch badge.

Validation grants file access to the selected folder for the running server
process. It does not rewrite an existing session's cwd. The grant is forgotten
on restart; the new-session route validates the chosen folder again.

## Changes made by other tools

Reopening the picker or expanding a repository does not discover worktrees
created by another tool. The picker fetches its session-derived list once per
mounted menu; expanding a group only reveals its existing choices. Use **Custom
path…** to select a new working folder.

The picker can list a folder that no longer exists, because its session history
still does.

web-pi records observed folder-to-repository associations in
`web-pi/worktree-projects.json` inside the Pi agent directory. This keeps
history grouped after Git forgets a removed worktree and after web-pi restarts,
without editing transcripts. If the worktree disappeared before its association
was recorded, history remains under its original folder; the repository is not
guessed from the folder name. Existing top-level mappings move once during the
[web-state cutover](deployment.md#web-state-cutover-and-reset); deleting the new
folder resets remembered mappings without editing Pi transcripts.

## Sessions whose folders are missing

You can still read history, export it, inspect statistics, or stop an existing
runtime. web-pi shows a read-only notice and blocks folder-dependent actions:
activation, prompts, fork, clone, compaction, rewind, branch navigation, and
model changes. Tools and system-prompt inspection cannot resume a dormant
runtime when its folder is missing.

The backend checks availability again before these actions. web-pi neither
recreates the folder nor substitutes another one. Restore the folder and reload
the session to restore its controls; that alone does not activate an agent.

## Hono routes

These routes serve the browser workflow, not the old Next.js JSON API:

- `GET /sidebar/projects` renders the project choices. There is no
  `/sidebar/workspaces` route in this implementation.
- `GET /new?cwd=<folder>` opens the blank composer in that folder. The dropdown
  uses this route directly.
- `GET /sidebar` refreshes the global list. Existing
  `/sidebar?project=<root>&cwd=<folder>` links navigate to `/new?cwd=<folder>`;
  a project query alone no longer filters sessions. Old project cookies are
  ignored.
- `GET /workspaces/picker` opens the custom-folder dialog.
- `GET /workspaces/browse?path=<directory>` renders directory names without
  granting file-content access.
- `POST /workspaces/validate`, with a `cwd` form field, validates a custom
  choice. HTMX receives navigation to `/new?cwd=…`; non-HTMX callers receive
  JSON and the cwd preference cookie. This is not compatible with
  `/api/worktrees`.

The route owner is `src/web/routes/sidebar.tsx`; selection behavior is covered
by `tests/web/session-navigation.test.ts`.
