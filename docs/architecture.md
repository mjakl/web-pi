# Architecture

The server owns the conversation. Pi's session files and the live `AgentSession`
are the only conversation state; the browser shows HTML the server rendered and
keeps only drafts and presentation preferences. A second copy of the
conversation in the browser would have to be reconciled with the server's
through deltas, snapshot merges and recovery polling, and every derived number,
such as context usage, would be computed on both sides. Here a page load, an
HTMX response and a stream frame all render the same views from the same server
state.

[Behavior](behavior.md) describes what the reader sees; this document describes
how it works and why.

## Layers

- `src/core` holds the rules and the ports. It may describe Pi's session format
  with SDK types but never calls the SDK, Node or Hono.
- `src/core/workspace/` is the inbound port. `createWorkspace(deps)` in its
  `index.ts` composes one flat `Workspace` object from four use-case families
  that never import each other: `sessions.ts` (the sidebar, a session's page,
  and the edits Pi's `SessionManager` writes), `live.ts` (the running agent and
  what only its entries can answer), `files.ts` (the file panel and `@`
  completion) and `config.ts` (folder choice, `/new`, trust, skills, packages).
  `deps.ts` holds what several families need: session lookup and decoration,
  folder availability and `authorize`. `views.ts` defines what pages render.
- The outbound ports are the fields of `WorkspaceDeps` in
  `src/core/workspace/deps.ts`. Their types live in `src/core/ports.ts`, apart
  from `WebSettingsStore` in `src/core/web-settings.ts`. `src/adapters`
  implements them with the Pi SDK, the file system and Git, and the fake world
  in `src/adapters/fake/index.ts` implements every one in memory for the web
  tests and `WEB_PI_RUNTIME=fake`.
- `src/web` holds the Hono routes, the JSX views and the client bundle, each
  split into one module per area of the screen (shell, sidebar, transcript,
  composer, files), so work on different areas does not collide. Hono matches on
  the path, so the order in which `src/web/app.tsx` registers the route modules
  carries no meaning. The web layer talks only to `Workspace`.
- `src/container.ts` is the composition root, the only file outside
  `src/adapters` that imports adapters.

`AGENTS.md` lists the import rules that oxlint enforces.

`LiveSession` is the deep module: the SDK's event choreography (partial
messages, compaction, retries, the queue, extension notices) stays inside the
adapter, and callers read a `snapshot()` and receive four events: `activity`,
`turn_done`, `completed` (see [Notifications](#notifications)) and `stopped`.
`AgentRuntime.subscribeAll` reports every live session's lifecycle as `opened`,
`started` (the session became busy, not every token), `finished` (a turn ended),
`completed` and `stopped`.

## Rendering a session

`SessionView` carries the settled conversation (`items`), the current turn
(`turn`), `settledCursor` (the last settled raw entry, empty at the root), the
live `status`, context `usage` and the model choices. History and the current
turn come from one snapshot: the runtime moves the turn boundary to the end of
the branch when a run settles, so the two never overlap. Pages, HTMX responses
and stream frames reuse the same views.

Reading a session does not consume its pending notices or the text an extension
put in the composer; only the session stream does (`consumePending`), because it
is what delivers them. It takes them before awaiting project or model
enrichment, so anything that arrives meanwhile goes out with the next frame.

`src/core/transcript.ts` projects one branch into items, and `src/core/turns.ts`
groups them into turns, pages them and writes the activity line. Every
transcript fragment renders through `Items`, which `src/web/views/Items.tsx`
re-exports from `src/web/views/transcript/`: one module per item kind
(`user.tsx`, `assistant.tsx`, `tools.tsx`, `subagent.tsx`, `notes.tsx`),
`deferred-tool.tsx` for tool bodies fetched on demand, `shared.tsx` for what
they all use, and `turns.tsx` for grouping, pages and the running turn. A
running turn renders flat; everything else is grouped into turns.
`src/core/session-entries.ts` derives what raw entries imply: starred answers,
statistics and active time, the path to a branch tip, and a sidebar row's
summary. Adapters hand the core entries; no core rule reads a file.

### Pages and deferred bodies

A page holds the last 50 session entries of a branch. It counts entries, not
cards, because one card can stand for several entries (a tool call and its
result), and it may begin mid-turn. A sentinel with
`hx-trigger="intersect once"` swaps itself for the page before it, and the
client keeps the distance to the bottom so the text does not move.
`through=<entryId>` widens a page until that entry is on it.

Long sessions are mostly reasoning, so once a page holds 20,000 characters of
thinking, older thinking blocks are sent as placeholders that fetch their text
when opened. The running turn applies the same budget to its finished messages,
never to the partial one, which has no entry to fetch from yet.

Completed tool calls send a body placeholder, never their arguments or result,
in pages, stored turns and live frames alike. Opening a card fetches
`GET /sessions/:id/entries/:entryId/tool-result/:callId`, which cuts ordinary
tools to the [limits in Behavior](behavior.md#sessions-and-conversation), with a
button for the rest, and renders a subagent's results in full. An open card
fetches by itself when its running call completes. Body requests do not consume
pending notices. `hx-morph-skip` keeps pending requests and loaded bodies
through later morphs, and HTMX drops a duplicate request while one is pending.

The conversation rail is server-rendered from all of the session's entries, not
from the page, so paging never changes it; it keeps at most 400 marks, dropping
the oldest. `src/core/conversation-rail.ts` lays out the active path, lanes,
rows and the target leaf of each lane, and the view positions marks with
`calc()` against the rail's own height, so the server needs no measurement of
the reader's viewport. `src/web/client/rail.ts` measures the transcript for the
active mark, the hover preview and press-and-drag, and reaches a mark the page
has not loaded through the "load earlier" sentinel with `through=`.

### The session stream

`GET /sessions/:id/events` is one SSE stream per open session page. Its unnamed
messages are HTML built from HTMX 4 `hx-partial` elements, each naming its
target and swap. Runtime `activity` is coalesced over 100 ms windows, with at
most one activity render waiting to start when enrichment or transport is slow.
`turn_done` queues a distinct render immediately. Each render sends one frame
with `id: settled=<cursor>`:

- `#messages` gets the settled items after the cursor the stream last delivered
  (`beforeend`).
- `#turn` gets the current turn (`innerMorph`), keyed by entry and tool-call
  IDs; a partial assistant message is keyed by its timestamp until Pi gives it
  an entry ID. While a turn runs, its finished messages come first: everything
  before the first message still in flight (the partial message, a running shell
  command, or a message waiting for tool results). The rest sits in
  `#turn-live`. The stream remembers which finished messages it sent, and while
  the same run goes on and the cursor stays put, a frame sends only the newly
  finished messages and morphs `#turn-live` (`outerMorph`), so frames do not
  grow with the run. The first frame of a connection, a moved cursor, a replaced
  transcript, and a turn that starts or stops morph the whole of `#turn`.
  Morphing ignores `open`, so disclosure choices survive.
- `#rail` gets the conversation rail when its marks or branch state changed.
- `#status` gets model-scope warnings, the queue, retry and compaction notes,
  the running state and an extension's title. The cumulative counts, tooltip and
  context gauge morph together as `#stats-trigger`, preserving the button and
  its separate popover; the compact button also follows out of band. The model
  selector is re-sent only when its choices changed, because it may hold an open
  menu.

Then, each only when it changed, because each may hold what the reader is doing:
`#shelf` (the extension status line and widgets, `outerHTML`),
`#extension-dialog` (the dialog an extension waits on), `#custom-ui` (the panel
around a custom UI, when the request changes) and `#custom-frame` (each new
frame inside it). Text an extension puts in the composer goes to
`#editor-insert`, and notices go to `#toasts` (`beforeend`). Empty partials
clear the turn and closed extension UI.

Named events carry their data in `event.detail.data`: `settled` (the session ID)
follows a frame whose cursor moved or that ended a turn; `done` (the session ID)
follows a completed run; `web-pi:saved` hands the page back to saved observation
(below). Client effects that depend on a region run on per-task
`htmx:after:settle`, which also fires for out-of-band updates.

The stream URL carries the page's settled cursor (`after=`). The SSE extension
returns the last frame's `id` as `Last-Event-ID` when it reconnects, and the
stream sends every settled entry after that cursor, however many settlements
were missed, without resending delivered history or replaying sounds and
notices; only those missing entries bypass the 50-entry page. If navigation or a
rewind took the cursor off the active branch, the stream replaces `.chat-body`
with the same `Transcript` view a page load renders (log, pagination, live tail
and rail) and a fresh cursor. Disposing the old scroller aborts its HTMX
requests and rejects their late responses, so an old pagination request cannot
bring the discarded branch back. Any other render failure shows an error toast
and ends the stream.

The core HTMX script is parser-blocking, so it sees `readyState=loading` and
initializes on `DOMContentLoaded`; the deferred SSE extension and the module
client have run by then. Deferring the core as well would let its initialization
run before a late extension registered, leaving the first stream without a
trigger. The extension runs with `pauseOnBackground: false`, so a hidden tab
adds no disconnects. It reconnects only after a first successful SSE response,
so `src/web/client/sse.ts` starts each stream itself, through the
`web-pi:sse-start` trigger, after installing its failure handlers: network
failures and HTTP 408, 429, 500, 502, 503 and 504 are retried after 500, 1,000,
2,000, 4,000 and 8,000 ms, and any other response or a sixth failure shows a
toast asking the reader to reload.

### Saved sessions and handoff

A page whose session no web-pi runtime owns, including every inspection-only
subagent, observes the saved file instead of a stream. While visible it asks
`GET /sessions/:id/saved` every two seconds, pauses while hidden and asks at
once on return, with at most one request per page. The catalog stats the known
file and parses it only when its revision (size, mtime, ctime, device and inode)
changed. Saved reads never open a runtime, call a model, or repair, migrate or
write the file, and an incomplete or unstable read keeps the displayed history.

The observation cursor carries the last revision, the observed branch tip and
the last content entry. Parent links advance that branch even when later entries
belong to a sibling, and when competing continuations arrive between checks,
observation advances along their shared path and stops at the fork rather than
choosing a child. The content entry must stay on the branch, because a rewind
can keep metadata tips while deleting the messages before them. The browser
morphs canonical message and rail HTML, so keyed disclosures and fetched bodies
survive.

When web-pi starts a runtime for such a page, the page connects the session
stream with `saved=1` and `through=` its oldest loaded entry, and the first
frame morphs its whole loaded window: an append-only cursor cannot account for a
tool result added to an existing card. When the runtime stops, or a connection
finds no runtime (a first connection or a reconnect that missed the stop), the
stream sends `web-pi:saved` and closes, and the page returns to saved checks
from the branch it rendered, not the file's current one. Live frames carry that
branch tip and content entry, with a template that clears status and extension
UI when a stop was missed. Inspection-only sessions never hand off.

### The sidebar

`GET /events` is the global session list's stream. On `opened`, `started`,
`finished` and `stopped` it re-renders the list's first page through
`hx-partial`; a render that has not started yet covers every event queued before
it, so a burst of events costs one scan of the store. Named `finished` and
`completed` events carry `{"id": …}`: the browser marks a finished session
unread in `localStorage`, including rows it has not loaded, and plays the
completion tone for another session's `completed`, since the session on screen
already rang through its own `done`. The list and its stream owner live in
`#session-nav` and survive conversation and folder navigation.

The browser also refreshes the list every 30 seconds while visible, when the
stream connects or reconnects, and when the page becomes visible or focused,
with one 100 ms window for those. Refreshes request `/sidebar/rows`, which
leaves the stream owner in place, and run one at a time with at most one
waiting. That is how sessions written by another process appear, once Pi has
written them to the session directory.

The list is a global tree of delegations, paged because a real store of about
2,750 sessions in 256 folders made every page 3 MB when it shipped every row.
`src/core/session-tree.ts` groups persisted delegation origins across folders.
Each sibling subtree sorts by its most urgent member (running, then live, then
stored), then its newest member's mtime, then ID; a row's own timestamp and
status never inherit its descendants'. Roots come 50 at a time, and children
load in pages of 50 when expanded. A selected session's off-page ancestor is
included on the first page and left out of later pages.

Every sidebar request lists and stats every session file; a header is read again
only when its file is new or was replaced (another inode), and concurrent
requests share one listing. Header IDs, not file names, identify sessions and
delegation parents. Root discovery classifies known runtimes and the selected
session's ancestry first, resolves each candidate's ancestors, and stops once
timestamp intervals prove the first `offset + 50` roots and one more root for
the next-page cursor. Duplicate IDs, timestamp ties and short pages can require
classifying every file; there is no fixed cutoff and no background index.
Classification reads to the end of the file or uses a cache stamped with the
file's revision, and a scan keeps a snapshot of that cache from its start, so
early misses cannot evict later hits. The order is certified against the
revisions seen, not an atomic snapshot: changed or unreadable files are left out
and reconciled by later refreshes. Counts of children can miss older or
late-arriving edges, which is accepted rather than adding checking controls.
Expanding a row classifies the sessions created no earlier than its parent,
through to the end of each file, so its child pages are exact.

A delegation origin is a `pi-subagent:delegation` custom entry
(`{version:1, childSessionId, parentSessionId, agent, handle}`) and belongs only
to the session whose header ID equals `childSessionId`; copies in forks and
parent-seeded children establish nothing. Conflicting, malformed and
self-referencing claims create no edge, all edges of a cycle are dropped, and a
child must not be older than its parent by header timestamp, so clock rollback
or an imported future-dated parent loses the edge without changing any file.
Pi's own `parentSession` never creates a delegation edge. A child whose parent
is missing becomes a root with its descendants.

Delegated sessions are inspection-only. A session with an own-ID origin claim,
even a malformed one, or a legacy `subagent.*` ID is read-only, and the
workspace refuses every mutation, runtime attachment, extension input and
runtime-starting panel for it, whatever the request. Its pages read catalog
snapshots, never a runtime. Unreadable or unstable classification never admits a
writer; a missing file is usable only by a runtime web-pi already owns, whose
first reply may not be on disk yet.

## The browser

`src/web/client/main.ts` is the entry of the one client bundle besides htmx,
built into `static/client.js` and loaded as a module with a content hash in its
URL. It imports one module per screen area (shell, sidebar, transcript,
composer, files) and four that serve every page: request fields (`htmx.ts`),
stream startup (`sse.ts`), navigation, and foreground presence for push
(`push-presence.ts`). The cached offline page loads the same bundle and runs
only the presence reporter. The only inline script reads the theme in `<head>`,
because it has to run before the first paint.

Stateful regions mount through `setUpRegion` in `client/lifecycle.ts`, keyed by
their owner element, on the first load and on HTMX's `after:process`. Replacing
an owner aborts its listeners, requests and timers. HTMX emits cleanup only for
elements it powers, so processing and settling also dispose of owners that left
the document; swaps inside an owner keep its state.

Server-rendered `<dialog open>` elements show without script, and
`client/dialogs.ts` upgrades them with `showModal()` for the backdrop, focus
trap and top layer. It removes `open` before `showModal()` instead of calling
`close()`, whose queued `close` event would remove the dialog again. The
extension shelf's widget panels are a scripted toggle, because the stream
replaces the shelf whenever its status line or a widget changes: the client
keeps the open panel per session and follows the panel the server opens until
the reader picks one.

General's settings are shared and stored on the server. The server renders the
`light`, `dark` or `auto` preference on `<html>`, the pre-paint script applies
it, and `client/theme.ts` follows the operating system for `auto`. The client
applies confirmed writes and reloads the settings when focus or visibility
returns.

### Navigation and drafts

Session links replace `#session-region` (the top bar, the stream owner and the
composer) and keep the sidebar and file panel; the same views render that region
for HTMX and the whole shell for a direct load. Changing folders refreshes the
explorer's context, never the session list or its stream. HTMX owns URL pushes,
`HX-Location` after creating a session or choosing a folder, and history
restores.

The displayed session and folder live on `main` (`data-session-id`, `data-cwd`).
Every HTMX request names them in `X-Web-Pi-Session` and `X-Web-Pi-Cwd`, the
folder percent-encoded because a header cannot carry characters above U+00FF; a
full page load falls back to its referrer and the `web-pi-session` cookie. A
navigation cancels the one before it, and responses for an older navigation or a
departed page are rejected, including their `HX-Trigger` headers, which HTMX
would otherwise still fire. The `web-pi-session` and `web-pi-cwd` cookies are
written only once a winning response is on screen, so a cancelled response
cannot change them.

A draft belongs to a session, or to `new:<cwd>` until the server names the new
session. `client/drafts.ts` saves its text and selected skills to `localStorage`
300 ms after a change, on `pagehide` and when its composer unmounts; images stay
in the page's memory. A submission clears only what it sent (the text's version,
the skills it carried, the images' generation), so edits made while it was
pending survive, and nothing is resent automatically. Fork and rewind put the
restored request in the composer with a marker that wins over the stored draft,
even when the request's text is empty.

The composer's rules live in `src/core/composer.ts`, which the client bundle
imports: slash ranking, `@` queries and fzf ranking, insert text, history
cycling and attachment limits run in the browser where a round trip would be
felt and are unit-tested on the server. The `@` menu and shared settings use
JSON endpoints, since a keystroke cannot wait for a rendered fragment;
everything else the composer opens is server-rendered HTML.

## The Pi runtime

### Folder preparations

`src/adapters/pi/session-services.ts` builds the trust-gated
`AgentSessionServices` a session in a folder would get, and keeps unbound
preparations for the four most recently used folders. Page renders, a stopped
session's slash menu and model listings reuse them without starting a session.
Starting a session claims its folder's preparation, removing it from the cache
before the first await, so independent sessions never share a bound loader,
extension callbacks, queued images or a mutable provider registry. Live queries
use the services of the session they name, never another runtime in the same
folder.

A preparation is not inert: it loads the allowed extension factories and may
install missing configured packages through Pi. Project settings start
untrusted, and Pi's saved trust decides whether project resources load. Dropping
a preparation never emits `session_shutdown`, so extensions must keep long-lived
resources for real session events, and providers must register from their
factory to take part in discovery and startup; one registered at `session_start`
arrives after the model was chosen.

A preparation is rebuilt when its inputs change: the content of `auth.json`; the
stamps of `models.json`, `trust.json` and the folder's `.pi/settings.json`; the
global settings other than model preferences; and the web system-prompt
addition, which is captured when the preparation is built. Model preferences are
re-read without a rebuild, so they never run extension factories again, and Pi
creating an empty `auth.json` changes nothing. Trust grants, skill and package
changes and explicit reloads drop the preparations they affect, which for a
skill toggle, a global skill or a user-scope package is all of them. None of
this restarts a running session.

Every preparation registers Pi's `codemode`, `tool-search` and `mcp` as
replaceable built-in extensions and replaces the agent's `bash` tool with one
that runs in the project's environment
([ADR 0001](adr/0001-project-command-environment.md)). MCP reads Pi's
process-wide agent directory, which `loadConfig()` also takes from
`getAgentDir()`. After exclusions and replacements, a loaded `builtin:mcp` must
agree with the runtime's agent directory, or startup and reload fail before MCP
can read another directory's configuration or credentials. The runtime never
swaps the process environment to serve several directories.

### Live sessions

`PiLiveSession` runs initial extension binding, admitted resource reloads and
final shutdown through one sequential lane, so extensions cannot start again
after disposal; a reload emits `session_shutdown` before rebuilding. Compact and
reload require an idle session, with reload checking inside that lane. Stop
closes admission and extension UI at once, cancels completion tracking and
signals the shell and the turn to abort. It also waits for pending SDK prompts:
input hooks can still be waiting when the SDK reports idle. A normal run
admitted by the SDK during shutdown is aborted without accepting the submission;
a command already handled by an extension keeps its result. Only after that work
finishes does Stop emit `session_shutdown` and dispose the SDK session.
Concurrent stops share one promise, and a failed operation does not skip the
cleanup. A session stopped during its initial binding is never registered, and
its open rejects with `Session stopped during startup.` Extension work that
ignores cancellation and does not await UI can still delay a stop.
`AgentRuntime.open` locks a session before its first await, so two concurrent
opens cannot start two writers on one file, and reopens a stopping session only
after its stop finished; a stop that has not finished within 10 seconds
(`stopsInTime` in `src/core/sessions.ts`) fails the open with
`Cannot reopen a session that is still stopping.` Delete, rewind and Stop
likewise wait for a stop already under way, with the same limit, before they
touch the file; when it runs out they fail with
`This session is still stopping. Try again once it has stopped.` The workspace
runs deletes, rewinds and its runtime opens of the same session one at a time,
in the order they arrive (`serialised` in `src/core/workspace/deps.ts`), so no
runtime loads a file that is about to be rewritten or writes one that was
removed; an open queued behind a delete fails as for an unknown session. Server
shutdown stops every live session the same way.

`runBash()` resolves when the session admits the command, before it finishes, so
a new session can show its URL and Stop control at once; later failures arrive
as notices. Pi writes a new session's file once it holds a user or assistant
message, so for a session that has only run shell commands the adapter creates
the file itself before `turn_done` and then leaves appends to the SDK. `!!`
entries keep `excludeFromContext`, and no assistant message is invented.

### Models

Settings → Models lists `ModelRuntime.getAvailable()`, every model with
credentials, before `enabledModels` narrows it.
`src/adapters/pi/model-settings.ts` owns pattern resolution and writes only the
global `enabledModels`, through Pi's `SettingsManager`, whose locked field-level
write keeps unrelated edits. Load and write errors are reported, including those
`flush()` records instead of throwing. Unchanged wildcard and fuzzy patterns
keep their spelling and reasoning pins. Excluding a model expands only the
patterns that matched it into the remaining exact identities, which then stop
admitting future matches. A generated list must resolve back to exactly the
selected models and pins, or the save is refused, and so is a form whose
patterns no longer match the file. Model views read Pi's settings for each
projection, so a save refreshes the selectors without rebuilding services.

The model menu's default scope and new-session startup share Pi's scope
resolution. Startup checks an explicit model against every credentialed model,
not just the cycling scope, applies a matching scope pin or Pi's default
reasoning, and refuses a missing model instead of replacing it. `startupWrites`
in `src/core/models.ts` then writes the choice as Pi's default only when the
session really started on that model, and the reasoning level unless it was
clamped to `off` on a model that cannot reason. The session is constructed with
the choice, and `setModel` is never called again: a second call would append a
duplicate session entry and a duplicate extension event.

### Context usage

`src/core/context-usage.ts` is the only context formula: Pi's context count, the
model's window, a percentage and the warning level. The badge, the compact
button, statistics and stream renders all use it with the current shared
threshold. After compaction, Pi withholds its count until a new answer reports
usage; meanwhile the runtime estimates the rebuilt messages with the SDK's
`estimateTokens`, the method the compaction divider uses, and marks the count as
estimated, also after reopening the session. Pre-compaction usage of retained
messages never replaces that estimate. Per-message usage and session totals are
separate.

## Sessions on disk

The catalog (`src/adapters/pi/session-catalog.ts`) parses raw JSONL and indexes
it with an in-memory `SessionManager`: a read never opens the file with a
writable manager, repairs a partial append, initializes an empty file, locks it
or persists a migration. An old-format file is migrated in memory, with stable
IDs across reads. If a writer later migrates those IDs, saved links resolve
against the current entries, star responses use the writer's target ID, and a
stale stream cursor resets the transcript so element IDs catch up.

The workspace keeps the last read of each stopped session, because a page's
images, deferred thinking, tool bodies and shell captures would otherwise parse
the whole file once each (`savedRead` in `src/core/workspace/deps.ts`). Every
use first asks the catalog whether the file still has the kept revision, reads
of one session queue behind each other, and the kept reads come from at most 32
MiB of session files.

Renames, stars, forks and clones go through Pi's `SessionManager`, so terminal
Pi and web-pi agree on the format; stars are `web-pi:star` custom entries. Only
delete and rewind rewrite a file, because the SDK cannot remove entries, and
both write atomically and keep the file's permissions. Delete points the deleted
session's fork children at its own parent, but never rewrites a delegated child
(one with a delegation record or a `web-pi:subagent` entry). Fork and rewind
read the selected request's text and images before any rewrite; the composer
takes the images through the queue-recall slot without recompressing them.

HTML export spawns the bundled Pi CLI under web-pi's own Node binary, because
the SDK's exporter sits behind the package's export map. It exports a temporary
snapshot in a private folder, not the source, because the CLI opens a writable
manager. The exported page's recursive tree walks are rewritten as iterative
ones, or a long session overflows the browser's stack; when a rewrite no longer
matches Pi's template, the page is served unpatched.

## Files and folders

Every file request goes through `authorize` in `src/core/workspace/deps.ts`,
which applies the rules in `src/core/path-access.ts`: a lexical check before any
file system call, then the same check on the resolved path against the resolved
roots. The roots are the open session's folder and its repository, plus the
folders a reader validated through `POST /workspaces/validate`, kept in memory
until restart. A path outside them widens the search to every session's folder,
and then to the repositories those sit in, before it is refused; concurrent
requests share that list, which is reused for five seconds and rebuilt when
web-pi creates or deletes a session or validates a folder. A file the session's
transcript names literally (`referencesPath`) may be read, since the agent
already showed it, but its folder may not be listed: naming a file does not open
its folder. A shell-output capture also needs a `pi-bash-*.log` name directly in
the temporary directory and a `bashExecution` entry of that session that names
it. Refusals carry the status the route sends (400, 403, 404, 413). `@` path
completion is the one exception; see [Behavior](behavior.md#files-and-git).

The file panel is server-rendered, and the browser keeps only the tabs. Each
directory is fetched when opened, the change list and tree re-render when a turn
settles (`settled from:body`), and the viewer is one fragment per mode.
`client/files.ts` owns what the server cannot know: the panel width, the open
paths, each tab's mode, wrap and scroll position, the `EventSource` of the
active tab, and the selection a line-range mention comes from. A file is
coloured on the server (`src/web/syntax.ts`), because a whole file has to be
split into numbered rows; the browser colours transcript code blocks with the
same module. highlight.js colours settled blocks and the running turn's finished
messages but never `#turn-live`, whose text changes every frame, and
`hx-morph-skip` keeps a coloured block through later morphs.

The new-session folder is the `web-pi-cwd` cookie, and validating a folder is
what grants access to it, so `/new` validates the cookie again on every load
instead of trusting it. The picker commits through `POST /workspaces/validate`;
browsing (`GET /workspaces/browse`) shows directory names only and stays outside
the policy, because a reader has to see a folder before asking for it.
`web-pi:last-cwd` in `localStorage` only pre-fills the browse box.
`src/core/cookies.ts` names every cookie.

`src/core/workspaces.ts` holds the repository identity rules: bare repositories,
linked worktrees, and subdirectories that keep their own identity. The resolver
in `src/adapters/pi/projects.ts` runs Git, caches answers for 60 seconds and
answers an expired one while refreshing it, because a sidebar render resolves
every folder at once (a branch switch may show one render late). It checks that
a folder exists before using the cache, so a deleted folder is never masked. Git
forgets a worktree when it is removed, so the resolver writes observed
folder-to-repository mappings to `<agentDir>/web-pi/worktree-projects.json`,
atomically and only when one changed; that map keeps a removed worktree's
sessions grouped.

A session whose folder is missing still reads, exports, shows statistics and
stops. Everything that would run the agent there is refused by one
`requireFolder` guard in the workspace, with the sentence the page shows, so a
new route cannot forget it.

## Extensions

An extension dialog is a pending request, not a message.
`src/core/extension-ui.ts` holds both state machines: unanswered dialogs with
their timeouts and abort signals, and the custom UIs whose frames the panel
shows. Several of each may be open, because the SDK keys them by ID and an
extension may ask twice, but only the newest is on screen; an older one waits
for its own timeout or the session's stop, because answering an invisible dialog
is worse than leaving it. IDs are random, so a form left over from an earlier
runtime cannot answer a newer request. `POST /sessions/:id/ui/:requestId`
resolves the SDK's promise, so the first tab to answer wins. A cancel carries no
value, which is how the SDK spells its default (`undefined`, or `false` for
`confirm`). Stop closes both hosts for good: pending and later requests get the
cancel default, factories cannot start, and components already created are
disposed. Aborting a turn does not close them.

A custom UI is a pi-tui component with no terminal under it.
`src/adapters/pi/extension-ui.ts` hands the factory a `TUI` that is only a size
and a `requestRender` callback, and a theme that applies no colour. The panel
unwraps the box the component drew for a terminal (`normalizeFrame` in
`src/core/ansi.ts`), because the browser draws its own. Keystrokes go back as
terminal bytes (`src/core/terminal-input.ts`, shared with the client bundle),
percent-encoded rather than multipart, because a lone carriage return, which is
what Enter sends, does not survive a multipart parser. A panel sends one
keystroke at a time, so the component sees keys in the order they were typed.
Closing is Ctrl+C, since a pi-tui component has no close command.

Extensions write status lines and widgets for a terminal. `src/core/ansi.ts`
turns SGR colour and bold into `<span style>` and escapes everything else, so
extension text never becomes markup; other escape sequences are dropped. A
widget whose content is a component renders through the same headless pi-tui as
a custom UI. Raw HTML in Markdown is escaped, not sanitised: there is no
allowlist to maintain, and no script can pass.

The extension API is limited where a browser page has no counterpart:

- `addAutocompleteProvider` is a no-op and `getEditorText` returns an empty
  string: the `@` and `/` menus are the server's, and the composer belongs to
  the reader, not the session. `setEditorText` and `pasteToEditor` insert text
  at the cursor.
- An extension cannot replace the session it runs in: `newSession`, `fork` and
  `switchSession` answer `{cancelled: true}`, while `navigateTree`,
  `waitForIdle` and `reload` work. The page follows one session, and swapping it
  underneath the reader is not something HTMX could follow. A shutdown request
  shows a notice and stops the session.
- Themes and terminal chrome are stubbed: `setTheme` refuses, `getAllThemes` is
  empty, and the footer, header, working indicator and `setToolsExpanded` do
  nothing.

## Notifications

`src/core/turn-completion.ts` decides when a run completed: a run has to have
started, and the session has to be idle when it settles, so a stop, an abort
before the model answered, or a shell command alone never notifies. The adapter
turns that into the `completed` event. The workspace reads the owned runtime's
snapshot synchronously, skips inspection-only sessions, and hands the completion
to `PushNotifier` before any await, so a foreground return cannot slip in
between. The session stream sends `done` for the page's tone.

`src/core/push-suppression.ts` aggregates foreground leases, which each page
refreshes every 20 seconds and which expire after 60, rejects out-of-order
reports, and claims the single away broadcast synchronously. `PushNotifier`
(`src/adapters/pi/web-push.ts`) starts one unref'd timer at the first eligible
completion while away, collects later ones without extending it, cancels on an
accepted foreground report, and at the deadline persists its latch in
`web-pi/push.json` before sending. Subscribing calls `pushManager.subscribe`
from the click itself, with `userVisibleOnly: true`, to keep the user gesture.
The service worker shows every push it receives; suppression happens before
sending. [Behavior](behavior.md#extensions-and-notifications) and
[Deployment](deployment.md#push-allowance-persistence-and-failures) describe the
user-facing rules and the persistence limits.

The service worker is generated, not shipped: its precache list names this
build's hashed asset URLs, so `src/web/pwa.ts` writes it and `/sw.js` serves it
uncached with the asset hash as its version. It caches `/static/*` and the
offline page and nothing else, because a cached answer from this server is
always the wrong one.

## Settings

`/settings` re-renders the page the reader was on (the open session, else the
new-session view) with the settings dialog over it. Its sections are
server-rendered, the last one is kept in the `web-pi-settings` cookie, and the
mobile navigation is the same list as a native `<select>`. A section that fails
to load says so, because falling back to General would show the wrong page under
the right tab.

Trust is a gate, not a setting. Pi's `hasTrustRequiringProjectResources` decides
whether a folder needs it; a grant writes Pi's own trust store, is refused while
a session in that folder is running a turn, and then stops the folder's sessions
so they restart with project resources loaded. Untrusted projects keep working
with their extensions, skills and prompts dormant.

The skill toggle is a line edit, never a re-serialisation:
`src/core/skill-toggle.ts` inserts, rewrites or deletes one
`disable-model-invocation` line in the front matter, after a byte-order mark if
there is one. Presence is tested, not truthiness, so an explicit `false` is
rewritten in place instead of gaining a duplicate key, which would make the file
unparseable and drop the skill. A shape the edit cannot reach is refused rather
than guessed at.

Disabling a package rewrites its entry as an object with four empty resource
lists, and enabling writes the plain source string back, so filters the entry
carried are lost. That is Pi's own representation; the button's title says so.

## Packaging and process

Pi is a package-owned runtime, refreshed at build time; see
[ADR 0002](adr/0002-package-owned-pi-runtime.md).

The package ships a bundle, and the checkout runs the sources. `just build`
bundles `src/server.ts`, `src/server-runtime.ts` and `src/cli.ts` into `dist/`,
leaving the Pi SDK, `web-push` and `undici` external, so a consumer install has
its own runtime and no build toolchain. `just dev` runs the TypeScript through
`tsx` and the tests run it through Vitest; tests that ran against `dist/` would
test the bundler. `just smoke` (`tests/smoke/packaging.smoke.test.ts`) is the
one check of the package: it packs, installs into a throwaway project and serves
a fixture session from the result, which is the only way to catch a missing
`files` entry or an import that resolves only in a checkout. `dist/` is not
minified, so a stack trace from an install names real functions.

`bin/web-pi.js` only imports `dist/cli.js`. `src/cli.ts` parses the flags into
the environment `loadConfig()` reads and then imports the server, so flags
arrive before configuration loads and `--help` and `--version` never start a
server. `src/server-runtime.ts` warns when the bind address is not loopback.

`src/http.ts` installs undici's `EnvHttpProxyAgent` as the global dispatcher, so
every server-side fetch honours `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`;
Node's built-in fetch ignores them. It keeps undici's 300-second idle timeout,
which a streaming turn that pauses between tokens needs, and attaches an error
listener to every client it creates, because undici can emit an internal `error`
while tearing a response down and an unhandled one would stop the server.

UI strings are English and live in the views that show them; one locale does not
justify a message layer.
