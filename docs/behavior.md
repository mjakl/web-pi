# Behavior and remaining work

This is the retained behavior reference for web-pi. It replaces the six
historical Next.js porting extracts and the completed phase plan. Current source
and tests are authoritative; this document does not promise full pi-web parity.

## Sessions and conversation

Pi session JSONL and the live runtime own the conversation. The server projects
settled history and a non-overlapping live tail into the same views for pages,
HTMX responses, and SSE updates. History pages backwards, while the desktop rail
covers all prompts and starred answers. Stars use `web-pi:star` custom entries;
old `pi-web:star` entries are not recognized or migrated.

Open persisted conversations managed outside web-pi, including inspection-only
subagents, check for saved updates every two seconds while the page is visible.
Checks pause in the background and run immediately on return. Only changed files
are read; no runtime is attached and no source file is modified. Completed saved
messages and tool results appear without a reload, not token by token. The
observed branch follows its continuation, not externally written siblings. When
competing continuations appear between checks, updates advance along their
shared path and hold at the ambiguous fork rather than guessing which child to
follow. Missing files, incomplete appends and rewrites that remove displayed
content keep the displayed history. Reload or navigation can select the current
saved branch. Readers at the bottom follow new content. Readers scrolled up keep
their place and can use “New messages” to jump to the latest content. Loaded
older history and expanded details remain in place. Unopened transcripts are not
observed.

Session actions include rename, delete with child reparenting, export, fork,
clone, rewind, and branch navigation. Fork and rewind restore the selected
request's text and images into the composer. Rewind is destructive: it removes
later entries rather than merely hiding them. It stops the runtime before the
rewrite, then reactivates the session without sending the recalled request. Rail
branch selection changes the session's active leaf and can return a prompt for
editing; it is not read-only historical browsing.

Tool cards load their settled bodies on first opening, initially limited to **16
KiB text and 200 diff rows**, with a control to fetch the rest. Older thinking
blocks are also deferred. Subagent calls have result, original-prompt,
run-details, and raw-output disclosures when their structured result is
recognized. Tool arguments are visible while streaming. Assistant headers show
estimated streaming tokens and tokens per second; completed usage remains
distinct from that estimate.

The SSE delivery/recovery contract and context-accounting thresholds live in
[Architecture](architecture.md). Do not introduce a second browser conversation
model or a second context formula.

## Composer

- Slash completion combines built-ins, extension commands, prompt templates, and
  skills. Commands that require idle state are refused while running.
- `@` supports indexed project files, directory-by-directory path completion,
  quoted paths, and line-range references.
- Attach up to **10 images, 10 MiB each**. Image drafts survive in-app
  navigation in memory, not a reload. Text drafts persist per session or
  new-session folder.
- A successful submit clears only the originating draft revision and submitted
  attachments, not edits made while the response was pending.
- During a run, sending steers by default; Alt selects a queued follow-up. Queue
  recall restores text and images. Input history is scoped to the composer.
- `!command` runs a shell command whose output enters context; `!!command`
  records it with `excludeFromContext`. Both use the project-command boundary in
  [ADR 0001](adr/0001-project-command-environment.md).
- Above **640 px**, plain Enter completes or sends. At **640 px and below**, it
  inserts a newline. Ctrl, Meta, or Alt permits completion/send; Shift keeps a
  newline. IME composition and the **100 ms** grace after it suppress sending.

## Files and Git

The explorer loads directories on demand, previews source, Markdown, images,
audio and PDF, offers downloads and line references, and displays Git status and
per-file diffs. Tabs and panel preferences belong to the browser; file changes
use a server watcher. Settled turns refresh the tree and changes.

Every file request uses `authorize` in `src/core/workspace/deps.ts`: lexical
containment before filesystem access, followed by realpath containment against
resolved roots. Roots include the session/project and validated folders; lookup
can widen to other known session roots. A transcript reference can permit
reading a named file outside those roots, never listing its directory. A
shell-output capture also needs a permitted `pi-bash-*.log` path and a persisted
shell entry that references it. Directory-name browsing in the folder picker is
separate from file-content authorization.

## Workspaces and configuration

[Worktrees](worktrees.md) owns folder selection, grouping, and missing-folder
behavior. Project trust gates executable project resources and project installs.
Granting trust is refused mid-turn and stops idle sessions in that folder so
subsequent activation reloads resources under the new trust decision.

The browser offers model/reasoning choices, tool definitions, system-prompt
inspection, skills, packages, and general settings. Pi remains responsible for
provider configuration and resource discovery. Skill toggles change only
`disable-model-invocation` frontmatter. Re-enabling a disabled package loses its
per-resource filters, matching Pi's representation.

Preserved repository workflow skills live under `.agents/skills`, together with
references, licenses, and provenance; `.claude/skills` links there. The root
`skills-lock.json` is retained unchanged. These are project resources for Pi
loading/trust, but web-pi currently displays this location as **path-scoped**,
without project install/update metadata. Do not relocate or duplicate them
merely to change that label.

General holds shared appearance, dumb-zone threshold and completion sound, with
defaults **auto**, **100000 tokens**, and **on**. Auto follows the current
device's OS appearance. Saves apply across browsers; a returning page refreshes
on focus/visibility, and live context renders use the current server threshold.
Legacy browser preferences are ignored, not imported. Drafts, navigation and
browser notification permission remain device-local. See
[Deployment](deployment.md#web-state-cutover-and-reset) before upgrading or
resetting web-owned storage.

## Extensions and notifications

Extension dialogs are request-ID-keyed pending operations, not transcript
messages. Only the newest is shown; cancellation returns the SDK default. Custom
UI uses headless pi-tui frames and terminal-byte keyboard input. ANSI conversion
applies to the extension shelf and custom UI, not ordinary tool output.

A completion notification requires an agent run in this web server to have
started and then settled idle. Stops, aborts before an answer, and shell-only
runs do not notify. Terminal Pi runs are outside this scope.

Use **Settings → General → Subscribe** for this browser. No permission prompt
appears automatically and permission alone does not mean subscribed. The control
prepares an active service worker and the server's public key before the click,
then confirms both browser and server enrollment. **Unsubscribe** removes only
this browser's subscription and matching server record; it keeps permission, the
worker, other browsers and the VAPID identity. It does not silently undo an
unsubscribe on reload.

Push requires a secure context, Notification, service workers, PushManager and
the registration's push manager. Missing capabilities show an unavailable
reason; blocked permission gives browser/system-setting instructions. On iPhone
and iPad, use an installed Home Screen web app, not an ordinary browser tab.
Supported desktop tabs need not be installed. Delivery depends on the browser,
push service and OS; enrollment is not a delivery guarantee.

Every received push displays a system notification, even with a visible window.
The page plays the completion tone but does not duplicate that notification.
Extension input requests retain their browser dialog and tone. The generated
service worker caches static assets and the offline page, not session history or
commands.

## Unfinished work retained from the port

These are known gaps, not work authorized by the documentation migration:

- Git worktree discovery in the picker UI. The fresh-discovery route exists, but
  the picker lists folders from known sessions. Use Custom path… for a worktree
  that has no session yet; see [Worktrees](worktrees.md).
- ANSI rendering in ordinary tool cards. Output is currently preformatted text.
- Read-only historical branch selection. Current rail navigation changes the
  active leaf and offers an editable prompt.
- Explorer create, rename, delete, upload, and expanded-tree persistence across
  reloads. The current explorer is a reader, not a file manager.
- A running-session cap. Unpersisted drafts already shut down after **10
  minutes** idle or immediately on an explicit stop; there is no general
  live-session cap.

The old plan's queue-image recall, phone-keyboard handling, streaming tool
arguments, subagent run details, and streaming token/TPS items are implemented
and are not outstanding migration requirements.

Deliberate limitations remain in [Architecture](architecture.md): attachment
drafts do not survive reloads, UI strings are English without a locale layer,
and terminal-only extension APIs are stubbed. No Next.js runtime, old PWA,
translation layer, or historical porting script is needed here.
