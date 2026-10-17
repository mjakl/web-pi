# Running web-pi as a service

web-pi is a long-running local server. On a workstation that means a systemd
user service: it starts with your session, restarts if it dies, and logs to the
journal.

## Install

Build a tarball from a checkout and install it globally, as
[the README](../README.md#install-and-run) describes. The package brings its own
Pi ([ADR 0002](adr/0002-package-owned-pi-runtime.md)), so the service needs no
system Pi, and a Pi upgrade reaches it only through a new build and reinstall.

## The unit

`~/.config/systemd/user/web-pi.service`:

```ini
[Unit]
Description=web-pi
After=network.target

[Service]
Type=simple
ExecStart=%h/.local/share/npm/bin/web-pi
Environment=WEB_PI_HOST=127.0.0.1
Environment=WEB_PI_PORT=30142
Environment=PI_CODING_AGENT_DIR=%h/.pi/agent
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

`ExecStart` is wherever your package manager put the bin — `npm prefix -g` says
where. Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now web-pi
journalctl --user -u web-pi -f
loginctl enable-linger "$USER"   # keep it running while you are logged out
```

## Upgrade

Upgrading is a new tarball, `npm install -g`, and
`systemctl --user restart web-pi`. Builds move Pi to its latest stable release
and record it in `package.json` and `pnpm-lock.yaml`. Run `just ci` against the
refreshed dependency set before installing it; this checks sources and the
installed tarball without a model call. A failed refresh or validation is not a
deployable upgrade. Keep a note of what `web-pi --version` reports: it names the
web-pi and Pi versions you deployed.

When a build has changed `package.json` and `pnpm-lock.yaml` and you have not
committed them, a later `git pull` can refuse to overwrite them. The changes
only record the Pi release that build installed, so discard them and update; the
next build refreshes Pi again:

```bash
git restore package.json pnpm-lock.yaml
git pull
pnpm install --frozen-lockfile
```

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

Set `OPENAI_API_KEY` in the **server process environment** and restart web-pi to
use the composer's **Dictate** button. For a service, supply it through a
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
MiB file limit and a 60-second upstream timeout. The browser caps recordings at
two minutes; the server checks container signatures and size, not decoded
duration. Failures leave existing draft text unchanged. See the
[interaction rules](behavior.md#composer).

Like other endpoints, dictation relies on loopback/trusted-network access or an
external authentication layer. Its custom request header rejects cross-origin
simple form posts; this is not login or rate-limit protection for an exposed
server. Do not expose web-pi publicly without access control.

## Completion-notification grace period

Set `WEB_PI_NOTIFICATION_GRACE_PERIOD` in the server environment to change the
fixed delay after the first eligible completion while away. The default is **15
minutes**. Acceptable values are decimal whole minutes from **0 to 35791**, with
surrounding whitespace allowed. **0** means immediate delivery while away, not
disabled notifications. Empty, fractional, negative, nonnumeric or larger values
fail startup with a configuration error. The upper bound keeps timers within
Node's signed 32-bit millisecond limit instead of overflowing into immediate
delivery. Changing the setting takes effect on the next server start; there is
no UI preference.

For example, `WEB_PI_NOTIFICATION_GRACE_PERIOD=30` delays the broadcast thirty
minutes from the first completion. The
[notification contract](behavior.md#extensions-and-notifications) describes
which completions it collects and what cancels it.

## Running from a checkout

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

- **Run one web-pi server per agent directory.** Push state is held in memory,
  and whole-file writes do not coordinate servers.
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

Writes use private **0600** files and atomic replacement. The folder is created
with mode **0700**. Shared Pi sessions, `settings.json`, trust, auth, models,
skills and packages are not relocated or reset. Session-embedded web metadata,
such as stars, stays in Pi's session files.

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
ordinary restarts. Pending timers and completion counts do not survive restart
or shutdown, and disposal cancels scheduling without recalling an already
admitted broadcast. A future completion can start a new timer if the allowance
remains available. Reporting remains best effort while clients reconnect.

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

After a successful cutover, stop the web-pi server and delete only
`<agentDir>/web-pi/`. Starting again restores shared defaults and creates a new
push identity on first use. Pi data is untouched; removed-worktree grouping may
be lost until rediscovered. Do not restore legacy files beside Pi's settings,
because a legacy source is an explicit pending cutover, not a reset marker.

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
