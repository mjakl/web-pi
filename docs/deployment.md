# Running web-pi as a service

web-pi is a long-running local server. On a workstation that means a systemd
user service: it starts with your session, restarts if it dies, and logs to the
journal.

## Process ownership

The backend owns one Workspace: live Pi sessions, tools and subprocesses,
session writes, extension UI, completion notifications and warm metadata caches.
The web process renders HTTP and browser SSE against it over a private Unix
socket. Restarting or crashing web does not stop backend work. Browser streams
reconnect and recover current state; requests are never automatically replayed.
A submission whose response was lost may already have been accepted.

A backend restart interrupts active work and loses warm caches. Its saved data
stays in the existing agent directory. Run **one backend per agent directory**,
and retain the existing one-writer-per-session rule with terminal Pi.

The ordinary `web-pi` CLI and `just dev` remain standalone by default: one
process owns both sides. `--role backend` serves only the private socket;
`--role web` connects to it. These direct CLI roles run the named package,
useful for development. For a manual **deployed** start, use
`web-pi-service backend` or `web-pi-service web`; those launchers perform
release selection. Both accept `--socket PATH` (or `WEB_PI_SOCKET`). The default
is `$XDG_RUNTIME_DIR/web-pi/backend.sock`. The containing directory must belong
to the user and have no group/other permissions; the socket is 0600. A live
socket is never replaced. No backend TCP listener or public endpoint is added.

## Immutable releases

`web-pi-deploy` remains a manual command:

- No arguments: build and publish a **complete** release, select it as
  `web-current` and `backend-next`, then restart **only web**.
- `--full`: publish the same complete artifact, then restart backend and web,
  interrupting current work, including a tool or session that invoked the
  deploy. Invoke it from an external terminal when you need to receive its final
  exit status; a killed invoking session cannot report completion.
- `just release`: prepare and publish without restarting services, for initial
  installation. It is not a reduced web-only build.

Every build still refreshes Pi to stable latest under
[ADR 0002](adr/0002-package-owned-pi-runtime.md). Publication packs the compiled
code/assets with `pnpm pack`, installs that tarball with production dependencies
in an isolated consumer, and checks that installation's exact Pi ownership. The
completed consumer lockfile records the transitive versions actually installed;
the checkout lockfile alone does not freeze consumer resolution. No startup
installs, updates or builds anything, and no dependency link points back to the
checkout. Configured external extensions retain Pi's existing
installation/loading behavior; they are not frozen into a release.

The default root is `~/.local/share/web-pi`; `WEB_PI_RELEASE_ROOT` can select
another root consistently for publication and both services:

```text
releases/<unique-id>/       complete installation, tarball, lockfile, release.json
web-current -> releases/…  selected web release
backend-current -> …       release selected at the last backend start
backend-next -> …          latest pending backend release (optional)
```

Backend startup, including systemd crash restart, promotes `backend-next` to
`backend-current` before launching; absent next, it uses current. A newer
deployment replaces any earlier pending next. Thus a backend crash deliberately
adopts the latest deployment, even after a web-only deploy.
Selection/publication share a short filesystem lock; neither holds that lock
while the service runs. The backend launcher also holds a separate lifetime lock
so a duplicate start cannot consume a pending release or race stale-socket
recovery. Launchers resolve real paths before executing. Leave every running or
referenced release intact, including its full dependency tree: old processes may
load code or launch subprocesses later. There is no automatic deletion.

A build, pack, install or validation failure leaves existing pointers unchanged.
The two final pointer renames are not a transaction: an I/O failure during
publication can leave next updated before web-current, and is reported as a
failure. Inspect the pointers before retrying. Startup failures do not fall back
to old code. There are no idle checks, drains, prompts, compatibility gates,
automatic full deploys or automatic rollbacks. A changed private interface may
require an explicit `--full`.

## systemd installation and first cutover

The templates in [deploy/](../deploy/) keep web and backend in **independent
cgroups**. Web is ordered after backend but neither requires nor stops the
other. Both retain the SSH agent socket, shell/PATH setup and private HTTP
listener. They use `Type=notify`: startup succeeds only after the listener is
ready, so `systemctl restart` reports failed startup. Node 24 and
`systemd-notify` must already be installed; mise selects the installed Node, not
a system Pi.

Coordinate the first cutover: the old monolith must stop before backend starts
against the same agent directory. The first stop necessarily interrupts its
agents. Build only in a separate worktree while it is still running. Back up
host configuration and mutable agent data privately before the stop. The code
must also be available in `~/Projects/pi-web` before later no-argument manual
deployments; that is the wrapper's default source path, overridable with
`WEB_PI_SOURCE`.

From the validated new checkout, at the agreed cutover time:

```sh
just release                         # complete release; no service restart
backup="$HOME/.local/share/web-pi/migration-backup"
install -d -m 700 "$backup"
mkdir -p "$HOME/.local/bin"
cp -a "$HOME/.local/bin/web-pi-deploy" "$backup/"
cp -a "$HOME/.config/systemd/user/web-pi.service" "$backup/"
cp -a "$HOME/.config/systemd/user/web-pi.service.d" "$backup/"
systemctl --user stop web-pi.service
# Use the effective agent directory if PI_CODING_AGENT_DIR is overridden.
cp -a "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "$backup/agent"
install -m 755 bin/web-pi-deploy bin/web-pi-service bin/web-pi-release.js "$HOME/.local/bin/"
install -m 644 deploy/web-pi.service deploy/web-pi-backend.service "$HOME/.config/systemd/user/"
mkdir -p "$HOME/.config/systemd/user/web-pi-backend.service.d"
install -m 644 deploy/web-pi-backend.service.d/environment.conf "$HOME/.config/systemd/user/web-pi-backend.service.d/"
systemctl --user daemon-reload
systemctl --user enable --now web-pi-backend.service
systemctl --user enable --now web-pi.service
systemctl --user status web-pi-backend.service web-pi.service
journalctl --user -u web-pi-backend.service -u web-pi.service -n 50
```

Keep the existing web `cloudflare.conf` environment-file drop-in. The supplied
backend drop-in reads the **same** `~/.config/web-pi/secrets.env`; do not print
or copy its contents into a unit. Mirror any other existing runtime environment
or agent-directory override onto backend; retain HTTP settings on web. Systems
without that environment file should omit the supplied backend drop-in. This
procedure changes no tunnel, firewall, credential policy or HTTP exposure.

The backend log names its actual Pi version and resolved release path. Web's
startup log obtains the connected backend's versions, which can differ from the
web package's `--version` output. After a backend crash/restart, consult its new
startup log and `backend-current`, not web's old startup line.

For a web-only rollback, select a retained compatible release as web-current and
restart only web. A backend rollback requires stopping backend, deliberately
selecting backend-current and removing/replacing any pending backend-next before
starting it again. Do not restore the monolith while backend is running. No
binary rollback undoes session/settings writes or upstream Pi migrations; use
backups and assess compatibility before downgrading.

### Pi upgrade compatibility

A build adopts a new stable Pi as soon as it is published, breaking changes
included, because Pi's runtime packages are exempt from pnpm's 24-hour
release-age delay ([ADR 0002](adr/0002-package-owned-pi-runtime.md)). It fails
on update or type errors rather than silently keeping a stale SDK.

The bundled SDK still uses the existing agent directory and does not reset or
move sessions, credentials, settings, trust, skills or extensions. Upstream Pi
can change their interpretation. For example, Pi 1.0.3 renamed provider
`azure-openai-responses` to `azure`: Azure users must deliberately update their
provider references in `auth.json`, `models.json` and settings, or
reauthenticate as upstream directs. web-pi does not rewrite these files during
build/install.

Review Pi's release notes and test needed user extensions before a production
upgrade. The local suite checks SDK integration with disposable sessions, mock
model streams and fixture extensions; it does not prove paid-provider access or
compatibility with every installed extension. SDK sessions also do not
automatically gain every CLI built-in extension.

The runtime packages are exact build-version dependencies, but a consumer
package manager resolves their transitive dependencies at install time; the
checkout lockfile does not freeze the entire consumer dependency graph. Do not
assume an older terminal Pi can read sessions subsequently changed by a newer
bundled Pi. Keep backups and one writer per session; downgrading web-pi does not
undo newer writes.

## Voice dictation

Set `OPENAI_API_KEY` in the **backend process environment** and restart backend
to use the composer's **Dictate** button. For a service, supply it through a
private environment file or your service manager's secret mechanism, not a
checked-in unit or browser setting. Pi provider credentials and ChatGPT
subscriptions are not used for this feature; the key needs OpenAI API access and
billing.

Dictation uses OpenAI's fixed `/v1/audio/transcriptions` endpoint and
[`gpt-transcribe`](https://developers.openai.com/api/docs/models/gpt-transcribe),
the
[recommended model for new file-transcription integrations](https://developers.openai.com/api/docs/guides/transcription).
There is no model selector, spoken response, or realtime voice session. The
browser needs microphone permission and HTTPS or localhost; plain HTTP on a LAN
address cannot record. WebM/Opus and MP4/AAC are selected according to browser
support. Test the target browser and your languages, accents, and technical
vocabulary before relying on transcript accuracy.

Only explicitly recorded audio is uploaded. web-pi buffers audio in memory for
request handling, does not save recordings or log audio/transcripts, and leaves
transcripts in the ordinary editable browser draft. OpenAI handles the uploaded
audio under your API account's data controls; web-pi does not control provider
retention. One upload/transcription runs at a time per server process, with a 20
MiB file limit and a 180-second upstream timeout. The browser caps recordings at
ten minutes; the server checks container signatures and size, not decoded
duration. Failures leave existing draft text unchanged. See the
[interaction rules](behavior.md#composer).

Like other endpoints, dictation relies on loopback/trusted-network access or an
external authentication layer. Its custom request header rejects cross-origin
simple form posts; this is not login or rate-limit protection for an exposed
server. Do not expose web-pi publicly without access control.

## Uploaded files

Non-image composer attachments are stored under
`<agentDir>/web-pi/uploads/upload-<unique-id>/`. Each submission gets a private
**0700** directory; files use **0600** permissions, exclusive creation, numbered
filenames and a safe, length-limited form of the original filename. Duplicate
names and simultaneous submissions do not overwrite earlier files. File bytes
are unchanged. Images instead remain inline in Pi session messages.

A message includes the uploaded files' absolute server paths. Keep the uploads
with the agent directory so those paths remain usable after restart, session
resume, fork or clone. Moving to another machine or directory requires
preserving those paths; a session export alone does not contain non-image
attachment bytes. The server does not execute, extract, convert or publicly
serve these uploads. Existing transcript-reference file authorization still
applies.

Retention is **indefinite**, with no cleanup daemon or automatic deletion on
session deletion or rewind. A completed upload is also retained when subsequent
prompt dispatch fails or its acceptance is uncertain: an agent or saved message
may already reference it. Retrying can create another copy. A failed batch write
is not dispatched and its new directory is removed where possible; a crash or
cleanup failure can leave an incomplete batch. Storage errors reject submission
and leave the browser draft available. Monitor disk usage and back up uploads
alongside sessions. Remove files manually only after confirming that no retained
session, fork, clone or agent work needs them. Resetting the whole `web-pi/`
folder also deletes uploads and breaks their recorded paths.

The composer accepts at most **10 attachments of 10 MiB each**, images included,
and bounds the whole multipart request at **101 MiB**. It buffers uploads in
memory and has no total disk quota. These limits are not authentication or
public-service abuse protection; keep the existing trusted-network or external
authentication boundary described below.

## Completion-notification grace period

Set `WEB_PI_NOTIFICATION_GRACE_PERIOD` in the backend environment to change the
fixed delay after the first eligible completion while away. The default is **15
minutes**. Acceptable values are decimal whole minutes from **0 to 35791**, with
surrounding whitespace allowed. **0** means immediate delivery while away, not
disabled notifications. Empty, fractional, negative, nonnumeric or larger values
fail startup with a configuration error. The upper bound keeps timers within
Node's signed 32-bit millisecond limit instead of overflowing into immediate
delivery. Changing the setting takes effect on the next backend start; there is
no UI preference.

For example, `WEB_PI_NOTIFICATION_GRACE_PERIOD=30` delays the broadcast thirty
minutes from the first completion. The
[notification contract](behavior.md#extensions-and-notifications) describes
which completions it collects and what cancels it.

## Running standalone from a checkout

To run the service from a checkout instead, install dependencies with
`pnpm install --frozen-lockfile` and run `just build` using the tools in
`mise.toml`. Keep the checkout and its `node_modules` available to the service.
Instead of the global package's `ExecStart`, use these service settings,
adjusted to your checkout:

```ini
WorkingDirectory=%h/Projects/web-pi
ExecStart=/usr/bin/mise exec -- node bin/web-pi.js
```

The service then runs whatever that checkout's `dist/`, `static/` and
`node_modules` hold. A pull, a dependency install or a build can change them
under the running process, so stop the service before updating or building that
checkout and start it again afterwards. Develop in another checkout or a linked
worktree.

## One agent directory, one writer

web-pi reads and writes the same agent directory as terminal Pi and any other
interface pointed at it, so each sees the other's sessions. Nothing coordinates
their writes:

- **Run one backend (or standalone web-pi) per agent directory.** Push state is
  held in memory, and whole-file writes do not coordinate servers.
- **Use one writer per session.** web-pi and other Pi runtimes do not coordinate
  cross-process writes or live in-memory state. Do not run simultaneous live
  turns, rename, star, rewind, delete, or otherwise edit the same session from
  two of them. SDK appends are format-compatible, not a concurrency guarantee.
  Stop the other runtime before handing a session over.

Point another server at a different agent directory with `PI_CODING_AGENT_DIR`
to keep them apart.

## Web state cutover and reset

Pi resolves the agent directory normally: `PI_CODING_AGENT_DIR` when set,
otherwise usually `~/.pi/agent`. Current web-pi owns these standalone files:

- `<agentDir>/web-pi/settings.json`: General's shared settings, `warnTokens` (a
  positive safe integer), `theme` (`auto`, `light` or `dark`), `sound` (`true`
  or `false`) and `systemPromptAddition` (`null` for the built-in note, or the
  text that replaces it). [Behavior](behavior.md#workspaces-and-configuration)
  gives their defaults. Models is not stored here: Settings → Models edits Pi's
  global `enabledModels` in `<agentDir>/settings.json`, shared with terminal Pi.
  Project overrides remain in `.pi/settings.json` and apply only in trusted
  projects.
- `<agentDir>/web-pi/push.json`: private VAPID identity, browser subscriptions,
  and the global `awayConsumed` latch. `true` means the one away broadcast has
  been used; `false` means a foreground return has rearmed it. A legacy file
  without the latch allows one initial away broadcast. Malformed latch values
  fail startup rather than resetting the allowance.
- `<agentDir>/web-pi/worktree-projects.json`: remembered folder/project
  mappings.
- `<agentDir>/web-pi/unread.json`: pending unread session IDs and opaque
  completion versions, shared by all browsers of this server.

Writes use private **0600** files and atomic replacement. The folder is created
with mode **0700**. Shared Pi sessions, `settings.json`, trust, auth, models,
skills and packages are not relocated or reset. Session-embedded web metadata,
such as stars, stays in Pi's session files.

### Unread activity persistence

Reading a session acknowledges its displayed activity across browsers. Pending
versions and successful acknowledgments survive ordinary server restarts; a
reconnecting browser receives the current map, not a replay of old markers. This
assumes one backend owns the agent directory. Work completed while that process
is stopped, or solely by another Pi process, is not reconstructed as unread
activity.

On upgrade, reload open browsers. Old `web-pi:unread` localStorage IDs are
discarded rather than imported: they cannot distinguish old reads from new
completions. Existing history starts without unread marks, and subsequent web-pi
activity uses the shared state. Removing `unread.json` while the server is
stopped deliberately resets pending marks.

An unreadable or malformed file prevents startup rather than silently resetting
it. Failed runtime writes are logged and keep the current state in memory,
without a restart-durability guarantee. A failed acknowledgment write returns an
error and leaves the mark pending; the browser asks the reader to resolve
storage or connection errors and reload to try again. As with other web state, a
failed directory flush may follow a completed atomic replacement.

### Push allowance persistence and failures

Scheduling or coalescing a grace-period completion does not write the allowance.
At the deadline the notifier rechecks presence and synchronously writes and
flushes `awayConsumed: true` before attempting any broadcast. Concurrent
completions cannot claim the same allowance. Delivery failures still consume it:
all subscriptions enrolled at admission are attempted once, there is no
automatic retry until a foreground return, and HTTP 404/410 subscriptions are
pruned as before. Other delivery failures retain enrollment. A foreground return
durably writes `false` only when the latch needs rearming; active lease
refreshes otherwise do not write. Enrollment changes, reading the public key and
pruning do not rearm it.

If consumption cannot be persisted, no broadcast starts and this running server
keeps the allowance consumed in memory. Later enrollment writes preserve that
conservative latch. If rearming cannot be persisted, it remains consumed in
memory; a later foreground report retries the write. These failures log a safe
diagnostic without endpoints or keys. A pruning write failure does not refund an
already consumed allowance or retry delivery.

No process can guarantee crash persistence when storage itself cannot be
written. Atomic replacement can also finish before a later directory flush
reports failure. On restart the server reads the file actually left on disk; it
refuses unreadable or malformed state but cannot recover an in-memory latch that
was never saved. Resolve storage errors before restarting rather than using
restart to retry notifications. Foreground leases and their short-lived ordering
records are memory-only and expire after 60 seconds; the durable latch survives
ordinary restarts. Pending timers and completion counts survive web restart but
not backend restart or shutdown, and disposal cancels scheduling without
recalling an already admitted broadcast. A future completion can start a new
timer if the allowance remains available. Reporting remains best effort while
clients reconnect.

### Upgrade an existing installation

1. Build the new version without starting it against live state. Identify the
   agent directory and every old web runtime using it. Stop those runtimes
   before starting the new version, including any old Next.js interface, and do
   not start them against that agent directory again. Keep a private backup of
   the two legacy files outside the new `web-pi` folder.
2. Start the new version once. It moves `<agentDir>/web-push.json` to
   `web-pi/push.json` and `<agentDir>/web-worktree-projects.json` to
   `web-pi/worktree-projects.json`. Valid keys, subscriptions and mappings are
   preserved. Originals are retired only after the destination is durably
   written. If interrupted with equal source and destination copies, the next
   startup finishes retirement. There is no permanent fallback to the old paths.
3. If startup reports malformed or conflicting files, preserve both and resolve
   them deliberately before restarting. It does not discard bad entries, choose
   a winning identity or merge conflicting state. A partially completed cutover
   can have one file moved and the other still at its old path.
4. Reload browsers and open **Settings → General**. Legacy `web-pi-warn-tokens`,
   `web-pi-theme`, and `web-pi:sound` values are ignored, with no import: custom
   values deliberately reset once to shared defaults. Reapply any wanted
   preferences there. Drafts and navigation remain local. Existing push
   enrollment is recognized only when the browser subscription matches the
   server record.

### Reset or remove web state

After a successful cutover, stop both services (or standalone web-pi) and delete
only `<agentDir>/web-pi/`. Starting again restores shared defaults and creates a
new push identity on first use. This also deletes all
[uploaded files](#uploaded-files); back them up first if retained sessions still
need them. Pi session files are untouched; removed-worktree grouping may be lost
until rediscovered. Do not restore legacy files beside Pi's settings, because a
legacy source is an explicit pending cutover, not a reset marker.

Browser permissions and subscriptions survive a server-folder deletion. General
checks actual server enrollment, not permission alone. If the server identity
changed, use **Unsubscribe** to clear this browser's old subscription, then
**Subscribe** again. Neither action changes other browsers or revokes
permission. Nothing silently re-subscribes. An already queued notification may
still arrive.

### Rollback

Older web versions do not read the new folder. Stopping current web-pi and
restarting an old executable does not reverse the cutover. A rollback needs an
explicit choice of which private backup to restore to the legacy paths, with all
affected web runtimes stopped. Later subscriptions, unsubscribe decisions and
mappings are not in that backup. Do not overwrite newer state or copy files back
automatically. Returning to the new version with different legacy and new copies
will stop on a conflict. Shared Pi writes are not undone by either path.

## Exposing it

Only to a network you trust, and preferably behind something that authenticates.
web-pi has no accounts and no login; see the security note in
[the README](../README.md). `--lan` (or `WEB_PI_HOST=0.0.0.0`) binds every
interface and says so on startup.
