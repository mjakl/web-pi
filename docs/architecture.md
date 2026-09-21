# Architecture

## Problem

pi-web (Next.js + React) keeps a second copy of the conversation in the browser
and reconciles it against the server with a three-layer protocol (deltas,
snapshot merges, polling recovery). Context usage was computed in five places
with three estimators. Every screen needed both a React component and an API
route.

web-pi removes the browser copy. Pi's session JSONL and the live `AgentSession`
are the conversation state; the browser shows whatever the server last rendered.
Browser-local drafts and selections are separate from that model. General's
appearance, token threshold, completion sound and system prompt addition are
shared server settings.

## Boundary and ports

Internal interfaces, all consumers in this repository. Defined in
`src/core/ports.ts`:

| Port               | Purpose                                                                                                                           | Adapter                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `SessionCatalog`   | List headers and delegation origins; read a non-writing snapshot; row metadata; rename, delete, star, fork, clone, rewind, export | `src/adapters/pi/session-catalog.ts` |
| `AgentRuntime`     | Open or resume a `LiveSession`; list the open ones; watch every session's lifecycle                                               | `src/adapters/pi/agent-runtime.ts`   |
| `LiveSession`      | `snapshot()`, `prompt()`, `abort()`, `commands()`, `compact()`, `clearQueue()`, `runBash()`, `navigateTree()`, `subscribe()`      | same                                 |
| `ModelCatalog`     | Models Pi has credentials for, narrowed by `enabledModels`, with the configured default and per-pattern reasoning pins            | `src/adapters/pi/model-catalog.ts`   |
| `ProjectResolver`  | The repository a working folder belongs to, and its branch                                                                        | `src/adapters/pi/projects.ts`        |
| `ProjectResources` | Prompt templates and skills of a folder, without starting an agent                                                                | `src/adapters/pi/resources.ts`       |
| `Files`            | The `@` completion index, directory listings, file bytes and text, shell-output captures                                          | `src/adapters/fs/file-tree.ts`       |
| `Git`              | `git status` of a folder and the patch for one file                                                                               | `src/adapters/git/git.ts`            |
| `Watcher`          | One file's changes on disk, deduplicated                                                                                          | `src/adapters/fs/watch.ts`           |
| `PushNotifier`     | VAPID identity, per-browser enrollment and encrypted completion messages                                                          | `src/adapters/pi/web-push.ts`        |

`WebSettingsStore` in `src/core/web-settings.ts` owns shared General
preferences; `src/adapters/fs/web-settings.ts` persists them. All standalone
web-owned state lives in `<agentDir>/web-pi/`: `settings.json`, `push.json` and
`worktree-projects.json`. Pi configuration and session files stay outside that
folder. [Deployment](deployment.md#web-state-cutover-and-reset) owns the
one-time legacy-file cutover, reset procedure and rollback limitations.

General's system prompt editor replaces only web-pi's Markdown rendering note.
An absent or null `systemPromptAddition` uses the unchanged built-in note; a
string replaces it verbatim, including an empty string to omit the addition.
Reset to default saves null. The Pi adapter captures the effective addition when
starting a runtime and preserves the loader's other appended instructions and
Pi's base prompt. New and stopped-and-reactivated sessions read the saved
setting; active runtimes retain their captured addition through `/reload` and
browser refresh. Saving does not interrupt a turn or restart a session.

`LiveSession` is the deep module: SDK event choreography (partial messages,
compaction, retries, queue, extension notices) stays inside; callers only read a
snapshot and receive `activity`, `turn_done`, and `stopped`.

`runBash()` resolves when the session admits the command, before execution
finishes, so a new session can expose its URL and Stop control immediately. The
adapter owns the completion promise, reports later failures through notices, and
saves real `bashExecution` entries before `turn_done`. Pi normally defers its
first JSONL write until an assistant reply; shell-only sessions use pi-web's
exclusive initial flush and then return to SDK appends. `!!` entries retain
`excludeFromContext`; no assistant message is invented. Stopping a session
aborts its shell and awaits settlement before disposal.

Settings → Models lists the full `ModelRuntime.getAvailable()` catalog before
`enabledModels` narrowing: built-in and configured models with credentials, not
the unauthenticated registry. Like the existing catalog, it does not load
project extensions to discover extension-only providers. Availability is the
SDK's credential check, not a provider request proving account access.

Models edits only global `enabledModels` in `<agentDir>/settings.json` through
Pi's `SettingsManager`. The terminal shares this pattern-based cycling scope;
General's web-specific preferences remain separate. The editor reads global
patterns, not the project-merged setting, and identifies trusted project
overrides without writing them. Untrusted project settings remain unloaded.

Absent or empty `enabledModels` means all available models, including future
models. Opening Settings and saving an unchanged selection write nothing.
Ordinary saves require at least one available selection. “Use all models”
explicitly writes an empty array. With no available models, the controls are
disabled and the saved configuration remains untouched. Nonempty unmatched
patterns remain visible as unavailable entries and are retained by ordinary
edits; they do not silently expose all choices.

The Pi adapter owns pattern resolution and persistence. Unchanged wildcard and
fuzzy patterns retain their spelling and reasoning pins. Excluding a match
expands only its affected pattern into remaining current identities with their
effective pins; that pattern then stops admitting future matches. Unavailable
patterns remain, but diagnostic warnings on successfully resolved patterns do
not classify them as unavailable. Generated patterns must round-trip through
Pi's resolver to exactly the requested provider/ID pairs and preserved pins;
ambiguous or unrepresentable identities are rejected. A stale form is rejected
rather than overwriting a changed global model list. Pi's locked field-level
write preserves unrelated external edits; load errors and drained write errors
are surfaced, including failures swallowed by `flush()`.

Saving invalidates all folder model caches and triggers an HTMX refresh of the
mounted selector. Config stamps include global and project settings for external
edits. New-session, stored-session and live/SSE selectors read the effective
trusted Pi scope. Running and stored sessions retain their current model even
when it is removed from that scope; no save switches a conversation.

The model menu's default scope and new-session startup share SDK scope
resolution. Startup applies the effective model and reasoning pin without
passing them to `startupWrites` as user choices. Only deliberate overrides reach
that unchanged persistence rule. A deliberate startup choice is validated
against the full credential-available catalog, not the cycling scope. A matching
scope pin still applies; otherwise Pi supplies the model's normal reasoning
default. Missing or uncredentialed choices are rejected, never silently
replaced. Project trust still gates project settings, and existing conversations
retain SDK model/reasoning restoration.

`src/core/workspace/` is the inbound port: `createWorkspace(deps)` in
`src/core/workspace/index.ts` composes one flat `Workspace` object from four
use-case families that never import each other —
`src/core/workspace/sessions.ts` (the sidebar, one session's page, and the edits
Pi's `SessionManager` writes), `src/core/workspace/live.ts` (the running agent
and what only its entries can answer), `src/core/workspace/files.ts` (the file
panel and `@` completion) and `src/core/workspace/config.ts` (folder choice,
`/new`, trust, skills, packages). `src/core/workspace/deps.ts` holds the
`WorkspaceDeps` ports and the internals more than one family needs (session
lookup and decoration, folder availability, `authorize`), and
`src/core/workspace/views.ts` the view types a page renders. Every route calls
the workspace and renders the returned `SessionView`. The fake world in
`src/adapters/fake/index.ts` implements every outbound port in memory; web tests
and `WEB_PI_RUNTIME=fake` use it.

## One rendering of UI state

`SessionView` holds `items` (settled conversation), `turn` (the current turn,
including the in-progress assistant message), `settledCursor` (the last settled
raw entry ID, or empty at the root), `status`, `usage`, and `models`. Settlement
moves the runtime boundary to the end of the branch. History and the live tail
come from that same snapshot and never overlap. Page load, HTMX responses, and
SSE events reuse the same views. Session reads are non-consuming by default. The
SSE renderer opts into `consumePending` because it delivers notices and composer
insertions. It captures and consumes the batch synchronously, before awaiting
project or model enrichment. Events arriving during those awaits belong to the
next delivery. Page loads, selectors, metadata, history fragments and alternate
branch reads leave pending output for the session stream.

The session stream sends unnamed HTML messages containing native HTMX 4
`hx-partial` elements with explicit targets and swap modes:

- `#messages` receives canonical items after the delivered settled cursor
  (`beforeend`);
- `#rail` receives the conversation rail out of band when its marks or branch
  state change, including during a running turn; unchanged rails stay in place;
- `#turn` receives the current turn (`innerMorph`), keyed by entry and tool-call
  IDs. Partial assistant messages use their message timestamp until Pi assigns
  an entry ID. Morphing ignores `open`, so disclosure choices survive changing
  content. Completed ordinary tools and subagents send body placeholders, not
  their arguments or results. Opening a card fetches its body through the same
  endpoint used by stored turns. `hx-morph-skip` keeps both pending requests and
  loaded bodies in place, including full output, selection and local scroll;
- `#status` receives model, state, queue, compaction, and the context badge;
- `#shelf` receives the extension status line and widgets (`outerHTML`), and
  only when one of them actually changed, because it holds an open panel;
- `#extension-dialog` receives the modal an extension is waiting on, and
  `#custom-ui` the panel around a terminal component — both only when the
  request itself changed, or a re-render would wipe what the reader typed;
  `#custom-frame` inside the panel takes every new frame, so the keyboard stays
  where it is;
- `#toasts` receives notices (`beforeend`), and `#editor-insert` receives text
  an extension put in the composer.

Empty partials explicitly clear the current turn and closed extension UI. Named
events carry semantic data in `event.detail.data`: `settled` follows the
messages append and turn clear, and `done` carries the completed session ID.
Client region effects use per-task `htmx:after:settle`, including OOB updates,
rather than the request-source swap batch.

The SSE endpoint coalesces activity into one re-render per 100 ms. Every render
reconciles canonical history after the delivered cursor, then morphs the live
tail and updates status in the same HTML frame. The initial stream URL carries
the page's settled cursor. Each frame sets `id: settled=<cursor>`; the bundled
extension returns it as `Last-Event-ID` on reconnect. Recovery covers any number
of missed settlements without resending already delivered history, discarding
older loaded pages, or replaying completion sounds and notices. The usual
50-entry backwards pagination is unchanged; only missing entries after the
cursor bypass the tail limit. This replaces the runtime's last-settled-turn
slot, not the transport's retry policy.

If a navigation or rewind removes that cursor from the active branch, the
projection marks its fresh bounded page as a replacement. The stream replaces
`.chat-body` through the same `Transcript` view used for initial pages,
including its `#log`, pagination, live tail and rail column, and sends the
matching status and fresh cursor. The old scroller's lifecycle is disposed,
along with the old rail column's interaction state. Transcript cleanup aborts
ordinary HTMX requests and rejects late responses from detached sources, so an
old pagination request cannot insert the discarded branch again. Other
projection failures show an error toast and end that stream instead of being
mistaken for a missing cursor or followed by a completion notification.

The core HTMX script is parser-blocking so it sees `readyState=loading` and
initializes on `DOMContentLoaded`. The SSE extension stays deferred and the
client stays a module; both finish before that event. Deferring core as well
would let its initialization timer run before a delayed extension registers,
leaving the first stream without a trigger.

The bundled SSE extension has `pauseOnBackground: false` so hiding a tab does
not introduce additional disconnects. The client starts each owner through its
native `web-pi:sse-start` trigger after installing failure handlers. Before the
first SSE connection, network failures and HTTP 408, 429, 500, 502, 503, and 504
get five retries, delayed by 500, 1,000, 2,000, 4,000, and 8,000 ms. Other
non-SSE responses or six failed attempts show a toast asking the reader to
reload. Removing an owner cancels its pending startup; after connection, the
bundled extension alone handles reconnection. Ordinary requests retain the
previous unlimited timeout for compaction and package actions. Inherited 4xx/5xx
no-swap rules preserve error toasts without replacing the requested region.

A second stream, `GET /events`, belongs to the global sidebar rather than one
session or project. Opening, starting a turn, finishing and stopping replace the
sorted first 50 root subtrees through `hx-partial`. Delegation discovery
precedes pagination; transcript bodies are not retained for the list. The
runtime announces `started` only when it becomes busy, not for every token. A
named `finished` event carries the session id, which the browser records as an
unread dot in `localStorage`, including for rows that have not loaded yet. The
list and its small `#sidebar-events` owner live in `#session-nav` and survive
conversation and directory navigation. No cookie or query scopes the stream. Row
selection is projected from the displayed `main` on processing and settlement,
including paginated rows, star responses and stream updates.

`src/core/transcript.ts` projects one branch into items, and `src/core/turns.ts`
groups those items into turns, pages them, and writes the activity line. Every
transcript fragment — a page load, an earlier page, the settled turn appended to
the log, the running turn — renders through the one `Items` view, which
`src/web/views/Items.tsx` re-exports from `src/web/views/transcript/`: one
module per item kind (`user.tsx`, `assistant.tsx`, `tools.tsx`, `subagent.tsx`,
`notes.tsx`), `shared.tsx` for what they all use (Markdown, the copy button,
times, images, history actions) and `turns.tsx` for the grouping, the pages and
the running turn. The markup is pinned by `tests/web/transcript-items.test.tsx`
against a rendered fixture; the running turn renders flat and everything else
renders grouped.

`src/core/session-entries.ts` derives everything a session's raw entries imply:
starred answers, statistics and active time, the tip of every branch, and the
sidebar row summary. The catalog hands the core entries; no rule reads a file.

### Context usage

`src/core/context-usage.ts` is the only formula: Pi's context count, the model's
window, a percent, and the thresholds. Context is critical at **75%** of the
model window. Below that, it warns at the shared token threshold (pi-web's "dumb
zone", **100,000** by default). There is no percentage-based yellow warning;
critical takes precedence over the token threshold. General saves the positive
safe integer in `web-pi/settings.json`. Page, statistics and live-stream renders
read the current shared value, never the old `web-pi-warn-tokens` cookie. The
badge and compaction button use the same formula.

After compaction, Pi withholds its count until a new assistant reports valid
usage. The runtime then estimates Pi's current rebuilt messages with the SDK's
`estimateTokens`, the same method used by the compaction divider and success
status. It marks that count as estimated, including after reopening a session;
retained assistants' pre-compaction usage must not replace it. New messages are
included in each estimate, and valid subsequent usage restores Pi's count. The
transcript usage fallback remains for an unavailable SDK count, while stored
sessions without a runtime keep their existing empty gauge. Per-message usage
and session totals are separate and unchanged.

### Session navigation and drafts

Ordinary session links and the new-chat link request `#session-region`, which
contains the top bar, session stream owner and composer. The same page views
render that region for HTMX and the whole shell for direct loads. Same-session
clicks only close the mobile drawer; modified clicks retain native link
behavior. A different session replaces the region when ready, retaining the
sidebar and file panel. Directory changes refresh the explorer context, never
the session list or its stream; same-folder switches also keep the expanded
tree. File requests derive their authorization context from the displayed
session.

HTMX owns URL pushes, `HX-Location` after creation or custom-folder selection,
and `hx-history-elt` restores. New Session opens the composer directly, using
`web-pi-cwd` or the configured server default. Its directory selector reuses the
session-derived project/worktree options and custom-folder picker. Selecting a
directory opens that folder's draft; the first message creates a session with
fixed cwd. Opening old sessions never overwrites this preference. Clone and
deletion of the displayed session use the same region navigation.

Navigation cancellation covers normal and history request shapes. A pending
request identity rejects reversed responses; admission epochs also reject an old
command's navigation/notice effects while a newer choice is still loading. The
guard clears parsed HX headers because HTMX fires `HX-Trigger` even after
response cancellation, including a canceled response body read. Displayed
session identity and contextual cwd live on `main`. Request headers derive from
that owner; only a mounted blank new-session view commits the directory
preference, so canceled responses and old-session navigation cannot change it.
The notice shelf uses native `hx-preserve` across region replacements.

Text drafts remain keyed by session or `new:<cwd>`, debounced for 300 ms and
flushed on owner departure and `pagehide`. File drafts stay in per-key memory;
compression belongs to the draft, while previews and their object URLs belong to
the mounted form. An accepted response clears only its originating text revision
and sent Files, even after that form leaves. Later attachments remain. New text
edits and explicit history-restored payloads invalidate older revisions.
Rejected or ambiguous submissions retain the draft; no response is retried
automatically.

The composer decides Enter's meaning before either completion menu or an exact
built-in can handle it. Composition state, `isComposing`, and key code 229
suppress commands; send shortcuts also consume Enter during the 100 ms grace
after composition ends. Above 640 px, plain Enter completes or sends. At 640 px
and below it remains a newline, even with a menu open. Ctrl, Meta or Alt permits
completion/send; Shift always leaves Enter as a newline. Both menus share the
same arrow, Escape, Tab and admitted-Enter dispatch.

`/copy` fetches plain text from `GET /sessions/:id/last-assistant-text`. The
workspace reads the complete active branch from its current writer, without
opening a runtime or using the paginated view. Like Pi's `getLastAssistantText`,
it selects the latest completed assistant message, skips empty aborted messages,
and concatenates its text blocks without separators. Streaming partials do not
count; a latest thinking-only, tool-only or blank answer has nothing to copy.
Unlike the SDK's final trim, the response preserves source whitespace. The
browser copies only while the requesting composer and text revision remain
current. Failed lookups or clipboard writes retain the command; success clears
only that revision, never later attachments. Existing per-message source-copy
buttons keep their rendered process/answer-half behavior.

## Dependency rules

Enforced by `.oxlintrc.json` (see `AGENTS.md`). `src/container.ts` is the
composition root and the only importer of Pi adapters.

## Decisions

- **Preserve rendered appearance and behavior with owner-scoped plain CSS.**
  `archive/nextjs-final` is the historical reference, not an immutable source
  layout. The styling rules in `AGENTS.md` allow minor normalization to the
  established Settings controls while preserving meaningful density, hierarchy,
  accessibility and responsive behavior. Static styles and finite presentation
  states belong to the component's stylesheet, including generated HTML and
  HTMX/SSE fragments. Only runtime values such as measured geometry and
  arbitrary ANSI colors stay inline. Reset, tokens, fonts and browser/HTMX
  concerns remain global; Settings, shell/dialog actions, sidebar,
  composer/shelf, files and transcript own their component rules. `index.css`
  declares the cascade and esbuild bundles it into `static/app.css`, without a
  utility framework. Decorative entrance, sweep and repeating highlight effects
  are removed; restrained interaction and functional progress feedback remain.
  Rendered baseline comparisons, not source or snapshot equality, validate this
  contract. The declared web-pi browserslist floor is (chrome/edge ≥125, firefox
  ≥147, safari ≥26): native popovers, CSS anchor positioning, `@starting-style`,
  `:has()` and `field-sizing` are load-bearing, not progressive enhancement.
- **One module per area of the screen, on both sides.** `src/web/routes/` holds
  `sidebar`, `shell`, `transcript`, `composer` and `files`; `createWebApp`
  builds one `RouteContext` (the dependencies plus the request helpers that
  answer in more than one area) and composes them, and Hono matches on the path,
  so registration order carries no meaning. `src/web/client/main.ts` is an entry
  and nothing else: it imports the same five modules. The split exists so five
  agents can port five regions of pi-web at once without touching each other's
  files.
- **General preferences are shared; auto appearance resolves per device.** The
  server renders `light`, `dark` or `auto` on `<html>`. A pre-paint script
  applies it before the stylesheet loads; `src/web/client/theme.ts` follows OS
  changes for auto. General's controls save through the workspace settings port.
  The browser applies confirmed writes and refreshes settings when focus or
  visibility returns. Legacy theme/sound localStorage and threshold cookies are
  ignored, not imported. Drafts, navigation, panel geometry and notification
  permission remain device-local.

- **Pi SDK resolved from the host `pi` on `PATH`**, never pinned. web-pi reads
  and writes the same session files as the installed CLI, so a pin would let the
  two drift apart silently. `src/host-pi.ts` walks `PATH` for the first `pi`
  outside our own `node_modules/.bin`, finds the
  `@earendil-works/pi-coding-agent` package that owns it (a bare version-manager
  shim is rejected: it says nothing about the version), resolves `pi-ai`,
  `pi-agent-core`, and `pi-tui` through Node from that package, checks all four
  report the same version, and symlinks them into
  `node_modules/@earendil-works/`. A checkout links from `prepare` and from
  every `just` recipe that compiles or runs code; an installed package links
  into itself from the bin, on every start, so upgrading Pi needs only a
  restart. Trade-off: a fresh checkout needs Pi installed before `pnpm install`
  succeeds, and an installed package needs a writable install directory.
- **The package ships a bundle; the checkout runs the sources.** `just build`
  bundles `src/server.ts` and `src/cli.ts` with esbuild into `dist/`, leaving
  only the Pi SDK, `web-push`, and `undici` external, so the published
  `dependencies` list the latter two and a consumer install has no toolchain in
  it. `just dev` and every test still run the TypeScript through `tsx`: tests
  that ran against `dist/` would test the bundler. The one check that does run
  against the package is `just smoke` (`tests/smoke/packaging.smoke.test.ts`),
  which packs, installs into a throwaway project, and serves a fixture session
  from the result — the only way to catch a missing `files` entry or an import
  that resolves solely in a checkout. `dist/` is not minified: a stack trace
  from an install should name real functions.
- **The bin is composition only.** `bin/web-pi.js` is three lines of JavaScript
  that need no build; `src/cli.ts` parses the flags into the environment
  `loadConfig()` already reads, links the host Pi, warns when the bind address
  is not loopback, and then imports `dist/server.js` — which must not load
  earlier, because its module graph reaches the SDK the link step has yet to put
  in place.
- **One HTTP dispatcher, proxy-aware.** `src/http.ts` installs undici's
  `EnvHttpProxyAgent` globally, so `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`
  are honoured by every server-side fetch — Node's built-in fetch ignores them,
  and a model call behind a corporate proxy simply fails. It keeps undici's own
  300 s idle timeout, which a streaming turn pausing between tokens needs, and
  attaches an error listener to every client it creates: undici can emit an
  internal `error` while tearing a response body down, and an unhandled one
  would take the server with it.
- **Raw HTML in Markdown is escaped**, not sanitised. No allowlist to maintain,
  no script can pass.
- **The sidebar is a global, paged delegation tree.** A real store holds ~2,750
  sessions across ~256 projects; shipping every row made a session page 3.0 MB.
  `src/core/session-tree.ts` groups only persisted delegation origins, across
  working folders. Each sibling subtree sorts by its best known local activity
  (running, then live, then stored), newest member mtime, and ID for ties. A
  row's own timestamp and status never inherit its descendants' values. The
  workspace returns 50 roots at a time; child siblings load in pages of 50 on
  expansion. An off-page selected ancestor is included on the first page and
  omitted from later pages to avoid duplicates. Every row keeps its own folder
  and optional worktree branch. The old project cookie and query do not filter
  the list.
- **Listing discovers origins before pagination.** The catalog reads each header
  and streams changed files for delegation origins. Visible rows also stream
  their row metadata. Both use bounded file-stamp caches rather than retaining
  transcript bodies. This makes cold discovery more expensive than header-only
  listing, but avoids hiding children on another page or in another working
  folder. Initial pages, refreshes, pagination and SSE list replacements use the
  same projection. Unreadable files are omitted; untitled and empty sessions
  keep fallback labels. Page offsets count unreadable rows. External appends and
  new sessions are discovered on refresh or local rescan; there is no
  external-session watcher or live-status promise.
- **Delegation origin is separate from Pi fork ancestry.** The
  `pi-subagent:delegation` custom entry has data
  `{version:1, childSessionId, parentSessionId, agent, handle}`. An origin
  belongs only to the header whose ID equals `childSessionId`; copied entries in
  forks and parent-seeded children do not establish ownership. Conflicting,
  malformed or self-origin claims create no edge. All edges within a cycle are
  discarded. Missing parents become roots without losing their descendants. Pi's
  header `parentSession`/summary `parentId` never creates a delegation edge.
  Deleting an ordinary parent does not delete or rewrite delegated children;
  refresh promotes them. Cloning an ordinary session does not clone its
  delegation tree. Only new named persisted children receive producer records;
  there is no backfill, historical reconstruction, registry, or ephemeral child
  row.
- **Delegated conversations are strictly inspection-only.** Own-ID origin claims
  (even malformed ones) and legacy `subagent.*` IDs are read-only. Legacy IDs
  alone imply no ancestry. The workspace refuses all source mutations, runtime
  attachment, extension input and runtime-starting panels, including direct HTTP
  requests. Saved transcript pages, earlier messages, thinking, tools, images
  and copy use catalog snapshots, never an external runtime. The conversation
  shows an inspection notice and no composer or mutation controls; sidebar cards
  have no activity or menu icon. The native disclosure footer counts direct
  children. Browser-local expansion preferences survive row/list swaps; selected
  ancestors are revealed without changing those preferences. Row-only actions
  replace the card body inside a stable tree wrapper, and keyboard shortcuts
  number only visible rows.
- **The conversation rail is server-rendered and positioned in percentages.**
  `src/core/conversation-rail.ts` is pi-web's `lib/conversation-rail.ts` fed
  from the flat entry list rather than a compressed tree: web-pi already holds
  every entry with its parent, so the tree walk disappears and the layout
  (active path, lanes, rows, target leaf per lane) is what is left. Marks sit at
  `calc(12px + (100% - 42px) * row/rows)`, so the server needs no measurement of
  the reader's viewport, and the connector SVG is stretched over the same box.
  The rail covers the whole session from the first render — the marks come from
  the entries, not from the page, so paging never changes it. Even a single mark
  is shown. The stream re-sends it when its marks or branch state change,
  independently of transcript settlement. `src/web/client/rail.ts` measures the
  transcript for the active mark, the hover preview, and press-and-drag; a mark
  whose entry the page has not loaded is reached through the "load earlier"
  sentinel with `through=`.
- **An extension dialog is a pending request, not a message.**
  `src/core/extension-ui.ts` holds both state machines: unanswered dialogs with
  their timeouts and abort signals, and the custom UIs whose frames the panel
  shows. Several of each may be open — the SDK keys them by id and an extension
  may ask twice — and only the newest is on screen; an older one waits for its
  own timeout or for the session to stop, because answering an invisible dialog
  is worse than leaving it. `POST /sessions/:id/ui/:requestId` resolves the
  SDK's promise, so the first tab to answer wins and the others watch the dialog
  disappear on the next render. A cancel carries no value at all, which is
  exactly how the SDK spells its default (`undefined`, or `false` for
  `confirm`): an extension cannot tell a cancel from an empty answer.
- **A custom UI is a pi-tui component with no terminal under it.**
  `src/adapters/pi/extension-ui.ts` hands the factory a `TUI` that is a size and
  a `requestRender` callback, and a theme that applies no colour.
  `render(width)` returns lines; the panel unwraps the box the component drew
  for a terminal (`normalizeFrame` in `src/core/ansi.ts`) because the browser
  supplies its own, and converts what is left through the same ANSI converter as
  the shelf. Keystrokes go back as terminal bytes (`src/core/terminal-input.ts`,
  shared by the client bundle), percent-encoded rather than multipart, because a
  lone carriage return — which is what Enter sends — does not survive a
  multipart parser. Closing is Ctrl+C: a pi-tui component has no close command
  to receive.
- **Push enrollment is manual and belongs to this browser.** General prepares
  worker registration/activation and the public key before enabling Subscribe.
  The click calls `pushManager.subscribe` directly with `userVisibleOnly: true`,
  preserving the user gesture. Permission alone or a browser subscription does
  not establish server enrollment; status checks the matching server record.
  Unsubscribe removes only that record and browser subscription, not permission,
  the worker or other browsers. Nothing automatically subscribes on load or
  completion. Missing capabilities and blocked permission have disabled controls
  with explanations; failed preparation ends with a reload instruction.
- **Notifications key off the agent's own idle, not off the turn ending.**
  `src/core/turn-completion.ts` is pi-web's rule: a run has to have started, and
  the session has to be idle when it settles. A stop, an abort before the model
  answered, or a shell command on its own never notifies. The adapter turns that
  into a `completed` runtime event; the server sends one Web Push from it, and
  the session stream sends `done` to the page for the shared completion tone.
  The service worker alone displays completion notifications, for every received
  push even if a window is visible, as Apple requires. Extension input requests
  retain their dialog and tone, not a second system-notification path. This
  covers completed runs in this web server, not terminal Pi; OS delivery is not
  guaranteed.
- **The service worker is generated, not shipped.** Its precache list has to
  name this build's hashed asset URLs, so `src/web/pwa.ts` writes the script and
  `/sw.js` serves it uncached with the asset hash as its version. It caches
  `/static/*` and the offline page and nothing else: every session page, stream
  and command goes to the network, because a cached answer from this server is
  always the wrong one.
- **Extension output is converted server-side.** Extensions write status lines
  and widgets for a terminal. `src/core/ansi.ts` turns SGR colour and bold into
  `<span style>` and escapes everything else, so extension text can never become
  markup; every other escape sequence is dropped. The shelf below the composer
  holds the one status line and a chip per widget, with at most one panel open
  (`<details name>`, no script). A widget whose content is a component is
  rendered through the same headless pi-tui as a custom UI.
- **Session edits go through Pi's `SessionManager`.** Renames, stars, forks and
  clones use the SDK, so the CLI and web-pi agree on the JSONL format; stars are
  `web-pi:star` custom entries. Catalog reads instead parse raw JSONL and
  project it through an in-memory manager: they never open the source with a
  writable `SessionManager`, repair a partial append, initialize an empty file,
  lock it, or persist a migration. Old-format migration stays in memory, with
  stable IDs for repeated inspection requests. If an ordinary session's writer
  later migrates those IDs, saved links resolve against the current entries
  without another file read; star responses use the writer's target ID. A stale
  SSE cursor still resets the transcript so mounted element IDs catch up. The
  old `pi-web:star` type is not recognized or migrated. Only delete
  (re-parenting children) and rewind rewrite a file, because the SDK cannot
  remove entries. Delegated children are not Pi fork children and are never
  rewritten by parent deletion. Fork and rewind return an `EditableMessage`
  containing the selected user's text and images, extracted before any rewrite.
  The replacement composer consumes images through the queue-recall slot,
  without recompressing stored bytes. A restored-draft marker makes even empty
  history text authoritative over localStorage. Images still do not persist as
  drafts across reloads.
- **HTML export spawns the Pi CLI** for ordinary sessions: the SDK's exporter is
  behind the package export map. It receives a temporary snapshot, not the
  source path, because the CLI opens a writable manager. The exported page's
  recursive tree walks are rewritten as iterative ones, or a long session
  overflows the browser's stack; if a rewrite no longer matches the SDK's
  template the page is still served.
- **The transcript pages backwards, and defers old reasoning.** A page holds the
  last 50 items of the branch, extended back to a turn boundary, and a sentinel
  with `hx-trigger="intersect once"` swaps itself for the page before it; the
  client keeps the distance to the bottom so the text does not move under the
  reader. `through=<entryId>` widens a page until a given entry is on it, which
  is how a link into an unloaded part of a long session works. Once a page
  carries more than 20,000 characters of thinking, the older blocks are sent as
  placeholders that fetch their text when opened.
- **Two lazily-loaded libraries, each in its own bundle.** highlight.js is part
  of `static/client.js` and colours settled code blocks (never the running turn,
  whose text changes every frame). Mermaid is larger than everything else put
  together, so `src/web/client/mermaid-lib.ts` builds to `static/mermaid.js` and
  the page imports it by URL only when a reader asks for a diagram preview.
  Source is the default view, as in pi-web.
- **One client bundle besides htmx.** `src/web/client/main.ts` (scroll-follow,
  theme, keyboard shortcuts) is bundled by esbuild into `static/client.js` and
  loaded as a module with a content hash in its URL. The only inline script is
  the two-line theme read in `<head>`, which has to run before the first paint.
  Global delegated handlers install once. `client/lifecycle.ts` mounts stateful
  regions on initial load and native HTMX `after:process`, keyed by owner node.
  Replacing an owner aborts its listeners, requests and timers and disconnects
  its observers. HTMX emits cleanup only for powered elements, so processing and
  settlement also remove detached plain owners. Inner fragment swaps keep their
  enclosing owner and its state; no whole-page setup rerun is needed.
- **The composer's rules live in `src/core/composer.ts`**, and the client bundle
  imports them (esbuild resolves `@core` the same way tsconfig does). Slash
  ranking, `@`-token extraction, fuzzy scoring, insert text, history cycling,
  and the attachment limits are one implementation, unit-tested server-side and
  executed in the browser where a round trip would be felt. The `@` menu uses
  JSON endpoints because a keystroke cannot wait for a rendered fragment. Shared
  web settings and push enrollment also use JSON. Everything else the composer
  opens — the slash menu, the queue panel, the notice shelf — is server-rendered
  HTML.
- **One containment policy, in one function.** `authorize` in
  `src/core/workspace/deps.ts` answers every file request the same way, and
  `src/core/path-access.ts` holds the rules it applies: a lexical check before
  any file system call, then the same check on the resolved path against the
  resolved roots. The roots are the open session's folder and the repository it
  belongs to, plus the folders a reader validated through
  `POST /workspaces/validate` (in memory, forgotten on restart, as in pi-web); a
  path outside those widens the search to every session's folder before it is
  refused. The one exception is a file the session's transcript literally names
  (`referencesPath`): the agent already showed its contents, so it may be read —
  but never listed, because naming a file does not open its folder. Failures
  carry the status the route sends (400, 403, 404, 413). Shell-output captures
  need both a `<tmpdir>/pi-bash-*.log` name and a persisted `bashExecution`
  entry in that session that references the file.
- **The file panel is server-rendered; the browser keeps only the tabs.** Each
  directory is fetched when it is opened (`hx-get` per node), the changes list
  and the tree re-render when a turn settles (`settled from:body`), and the
  viewer is one fragment per mode. `src/web/client/files.ts` owns what the
  server cannot know: the panel width (`web-pi-right-panel-width`), which paths
  are open, each tab's mode, wrap and scroll position, the `EventSource` on the
  active tab, and the text selection a line-range mention comes from. Syntax
  colouring for a file happens on the server (`src/web/syntax.ts`, shared with
  the transcript's browser-side highlighter), because a whole file has to be
  split into numbered rows and highlight.js colours a block, not a line.
- **Completed tool bodies are fetched when opened, including in the live turn.**
  `GET /sessions/:id/entries/:entryId/tool-result/:callId` renders the
  arguments, output and diff of an ordinary tool, cut to 16 KB of text and 200
  diff rows, with a button for the rest. The same endpoint renders a subagent's
  results, prompts, run details and raw payloads without truncation. The result
  entry identifies its branch within that session, including alternate stored or
  live branches. Body requests read folder context without consuming pending
  notices or composer insertions. Initial pages, stored turns and every live
  frame carry only a placeholder for these bodies. An open card fetches
  automatically when its running call completes; closed cards wait for an
  opening toggle. HTMX drops duplicate requests while one is pending, and a
  failed fetch can be retried by closing and reopening the card. Loaded bodies
  survive later live morphs without another render or transfer. Unfinished tool
  arguments, subagent progress and partial thinking remain inline and continue
  updating. Settlement still appends fresh stored-turn cards and clears the live
  tail.
- **Project commands run in the project's environment.** See
  [ADR 0001](adr/0001-project-command-environment.md).
- **The chosen folder is a cookie, and validating it is what grants access.**
  `web-pi-cwd` holds the folder new sessions start in, `web-pi-settings` the
  open settings section, and `web-pi-skill` the skill that folder was last
  reading. Existing session navigation updates only `web-pi-session`, not cwd.
  These navigation cookies are local; General preferences are shared in the
  server's web settings store. The picker commits through
  `POST /workspaces/validate`, which adds the folder to the in-memory allowed
  roots — so the new-session composer gets `@` completion, the slash menu and a
  model picker, and `/new` re-validates its cookie on every load rather than
  trusting it. Browsing (`GET /workspaces/browse`) is deliberately outside that
  policy: it exposes directory _names_ only, and a reader has to be able to see
  a folder before asking for it. pi-web keeps the last custom path in
  `localStorage`; here the cookie is the memory and `web-pi:last-cwd` only
  pre-fills the browse box.
- **Worktree discovery is a rule plus a map.** `src/core/workspaces.ts` holds
  the identity rules (bare repositories, linked worktrees, subdirectories keep
  their own identity) and the parse of `git worktree list --porcelain -z`; the
  adapter runs git, caches for 60 s and answers an expired entry as it stands
  while refreshing it behind the reply (a sidebar render resolves every folder
  at once, and a branch switch may show up one render late), checks availability
  _before_ the cache so a deleted folder can never be masked, and writes
  `<agentDir>/web-pi/worktree-projects.json` atomically at mode 0600 and only
  when a mapping actually changed. Git forgets a worktree the moment it is
  deleted; that map is what keeps its sessions grouped under the repository.
- **A missing working folder is read-only, not an error.** The session still
  reads, exports, shows statistics and stops; sending, branching, forking,
  cloning, compacting, rewinding, switching model and activating all disappear,
  and `createWorkspace` refuses them server-side with the same sentence the page
  shows. One `requireFolder` guard, in the workspace, so a new route cannot
  forget it.
- **Trust is a gate, not a setting.** `hasTrustRequiringProjectResources`
  decides whether a folder is gated at all; a grant writes Pi's own `trust.json`
  through `ProjectTrustStore`, is refused while a session in that folder is
  mid-turn, and then **stops** that folder's sessions so they restart with
  project resources loaded. Untrusted projects keep working, with their
  extensions, skills and prompts dormant.
- **Settings is a route that renders as a dialog.** `/settings` re-renders the
  page the reader was on — the open session, else the new-session view — and
  puts the modal over it, because that is where pi-web keeps it. Its four
  sections (general, models, skills, plugins) are server-rendered, the last one
  remembered in a cookie rather than `localStorage`, and the mobile navigation
  is the same list as a native `<select>` — no script. A section that fails to
  load says so; falling back to general would quietly show the wrong page under
  the right tab.
- **Dialogs are `<dialog open>` from the server, upgraded in the browser.**
  `src/web/client/dialogs.ts` removes the `open` attribute and calls
  `showModal()` for backdrop, focus trap, top layer and focus restore, and
  removes the element when it closes. It must not call `close()` first: that
  queues a `close` event which would fire after the listener is attached and
  take the dialog straight back out of the page.
- **The skill toggle is a line edit, never a re-serialisation.**
  `src/core/skill-toggle.ts` inserts, rewrites or deletes one
  `disable-model-invocation` line inside the frontmatter block. Presence is
  tested, not truthiness, so an explicit `false` is rewritten in place instead
  of collecting a duplicate key — which would make the file unparseable and drop
  the skill. A shape the line edit cannot reach is refused rather than guessed
  at. The file belongs to whoever wrote it.
- **Startup model preferences are written only when Pi honoured them.**
  `src/core/models.ts` is pi-web's `persistExplicitStartupPreferences`: the
  default model is written when the session really started on the requested one,
  the reasoning level unless it was clamped to `off` on a model that cannot
  reason. The session is constructed with the choice, so `setModel` is never
  called a second time; repeating it would append a duplicate session entry and
  a duplicate extension event.
- **The models cache is stamped, not just timed.** Credentials and model
  metadata are edited in the Pi terminal, so the cache key carries the
  modification times of `auth.json`, `models.json` and global/project
  `settings.json`: a terminal login or configuration edit shows up on the next
  request instead of after the whole 60 s TTL. Granting trust, a plugin action,
  or writing a new default invalidates it outright.
- **Re-enabling a package loses its filters.** Disabling rewrites the entry as
  an object whose four resource lists are empty; enabling writes the plain
  source string back, so per-resource filters an entry carried do not survive
  the round trip. That is Pi's own spelling and pi-web's behaviour; the UI says
  so in the button's title rather than pretending otherwise.

## Remaining work

[Behavior and remaining work](behavior.md) retains the unfinished port
requirements: ANSI in tool cards, read-only historical branch browsing, explorer
mutations and expanded-state persistence, and a running-session cap. These are
not part of the documentation migration.

Streaming token count and tokens per second are implemented. The runtime
estimates tokens from streamed text and thinking, and reports a rate after more
than 0.5 s when tokens are nonzero. The assistant header labels the count as
estimated; completed provider usage and context accounting remain separate.

## Deliberately not carried over

Decisions, not gaps:

- **Attachments survive in-app navigation, not reloads.** Unsent Files stay in
  session/folder-keyed memory. Only text reaches localStorage; image bytes are
  never serialized there. Reloading the browser discards attachment drafts.
- **No message layer.** pi-web's 477 English keys are one locale behind an
  indirection; web-pi is English only and the strings live where they are read,
  in the views.
- **`addAutocompleteProvider` is a no-op**, as in pi-web. The `@` and `/` menus
  are server-rendered from the workspace, and an extension cannot reach into
  them. `getEditorText` returns the empty string for the same reason: the
  composer is the browser's, not the session's.
- **An extension cannot replace the session it runs in.** `newSession`, `fork`
  and `switchSession` on the command context answer `{cancelled: true}`; only
  `navigateTree`, `waitForIdle` and `reload` do anything. The page follows one
  session, and swapping it underneath the reader is not something HTMX could
  follow. A `shutdownHandler` request is honoured — a notice, then the session
  stops — because here that is a real operation.
- **Themes and the terminal chrome stay stubbed.** `setTheme` refuses,
  `getAllThemes` is empty, and the footer, header, working indicator and
  `setToolsExpanded` do nothing: they describe a terminal's furniture, and this
  one has none.
