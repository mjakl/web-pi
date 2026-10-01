# Running web-pi as a service

web-pi is a long-running local server. On a workstation that means a systemd
user service: it starts with your session, restarts if it dies, and logs to the
journal.

## Install

Build a tarball from a checkout and install it globally, as
[the README](../README.md) describes. The install directory has to stay
writable: the bin symlinks the Pi SDK into its own `node_modules` at startup,
which is how a Pi upgrade reaches web-pi without a reinstall.

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

Upgrading is a new tarball, `npm install -g`, and
`systemctl --user restart web-pi`.

## Running from a checkout

For a checkout-based installation, install dependencies with
`pnpm install --frozen-lockfile` and run `just build` using the tools in
`mise.toml`. Keep the checkout and its `node_modules` available to the service.
Instead of the global package's `ExecStart`, use these service settings,
adjusted to your checkout:

```ini
WorkingDirectory=%h/Projects/web-pi
ExecStart=/usr/bin/mise exec -- node bin/web-pi.js
```

On lab, `~/.local/bin/web-pi-deploy` rebuilds the primary checkout and restarts
`web-pi.service`. The checkout stays at `/home/mjakl/Projects/pi-web` while the
live service and linked worktrees depend on that path; the unit's
`WorkingDirectory` stays there too. The helper contains:

```sh
#!/bin/sh
set -eu
cd /home/mjakl/Projects/pi-web
/usr/bin/mise exec -- just build
/usr/bin/systemctl --user restart web-pi.service
```

Run `~/.local/bin/web-pi-deploy` only when ready to interrupt the service and
all its Pi workers. The command does not pull, merge, or install dependencies.
First update the primary checkout to the merged commit, and run
`pnpm install --frozen-lockfile` if dependencies changed. The old helper name is
not an alias. Renaming the helper or repository does not deploy anything; the
service name, `WEB_PI_*` variables, loopback port 30142, and existing
`svc:web-pi` Tailnet mapping stay unchanged.

When moving a running installation, build the destination before downtime, stop
the old instance, change the unit's checkout path, run
`systemctl --user daemon-reload`, then start it. Verify the process working
directory, listener, and HTTP response through the existing URL before retiring
the old checkout. Preserve local refs, reflogs, ignored files, and any
checkout-local runtime data outside that checkout first. The default Pi agent
directory remains `~/.pi/agent`; do not replace it during a source-path cutover.

## Two apps, one agent directory

pi-web (the Next.js interface this one replaces) runs the same way, and both
read and write the same `~/.pi/agent`. That is the point — each sees the other's
sessions — but it has consequences:

- **Give them different ports.** pi-web defaults to 30141 and web-pi to 30142.
- **Web state is no longer shared with old interfaces.** Current web-pi uses
  `<agentDir>/web-pi/`; older web runtimes use top-level legacy files. Stop all
  affected old web runtimes before the cutover below, and do not restart them
  against that agent directory. Run only one web-pi server per agent directory;
  push state is held in memory and whole-file writes do not coordinate servers.
- **Use one writer per session.** The apps and terminal Pi do not coordinate
  cross-process writes or live in-memory state. Do not run simultaneous live
  turns, rename, star, rewind, delete, or otherwise edit the same session from
  both. SDK appends are format-compatible, not a concurrency guarantee. Stop the
  other runtime before handing a session over.

Point either app at a different agent directory with `PI_CODING_AGENT_DIR` if
you would rather keep them apart.

## Isolated coordinator trial

Do not start a second server against the live agent directory or point trial
coding sessions at a checkout another worker owns. Use a fresh agent directory,
HOME and disposable project. Do not restart the primary service or change its
Tailnet proxy for a trial. Cookies are not port-scoped; use a fresh browser
profile or a separate hostname.

After `pnpm install --frozen-lockfile` and `just build`, with Node 24 and host
Pi on PATH, this starts an offline coding demo on an otherwise unused port:

```bash
trial=$(mktemp -d /tmp/web-pi-coordinator.XXXXXX)
mkdir -p "$trial/home" "$trial/agent" "$trial/project"
printf '{"packages":[]}\n' > "$trial/agent/settings.json"
env -u OPENAI_API_KEY HOME="$trial/home" \
  PI_CODING_AGENT_DIR="$trial/agent" \
  WEB_PI_DEFAULT_CWD="$trial/project" \
  node bin/web-pi.js --runtime fake --host 127.0.0.1 --port 30143
```

Verify that port 30143 is unused before starting; choose another positive port
if needed, never the live service's port or 30141. The ready marker is
`web-pi … listening on http://127.0.0.1:30143 …`. Check `GET /new` returns 200.
Stop the foreground process with Ctrl+C, or send SIGTERM to that exact trial
process, and verify its listener disappears. Delete the disposable trial
directory only after stopping it and checking it contains no work to retain.

The offline demo deliberately has no OpenAI key: enabling the coordinator gives
its configuration error. For a separately authorized provider trial, supply
`OPENAI_API_KEY` through the launching shell's private environment and omit
`env -u OPENAI_API_KEY`. Do not put its value in arguments, Git, logs or browser
storage. API access to `gpt-live-1` and `gpt-4.1-mini-2025-04-14`, quota and
billing must be available. Subscription credentials are not a substitute.
Keeping `--runtime fake` lets the user try real conversational voice with
fictional coding sessions rather than paying for or modifying a real coding
task. Activate a demo session before asking the coordinator to send it work.

For an offline UI walkthrough without credentials, `just screenshots` starts the
existing isolated fixture. Its coordinator uses explicitly labeled scripted text
replies and rejects voice startup; it is not a production provider fallback.

A browser on the server machine can capture a microphone through localhost. A
browser on another device needs a trusted HTTPS origin; plain HTTP at a host or
Tailnet address cannot capture a microphone. An accepted private listener is not
by itself an HTTPS solution. Use only an already authorized private HTTPS route,
or arrange one separately without changing the current live proxy. Do not enable
Funnel or a public tunnel for this trial.

The coordinator does not persist audio or its small conversation window. Both
OpenAI requests set `store:false`, but ordinary abuse-monitoring retention can
still apply. Text-only mode expires 90 minutes after Enable. The first
successful provider voice connection starts a fresh 90-minute conversation
window; stopping and restarting voice does not extend it. Browser audio
negotiation follows the provider connection. The original ten-minute cutoff was
an app-level prototype budget, not a documented vendor requirement. Backend
reasoning and proactive summaries have no fixed request-count cutoff; each call
remains bounded and single-flight, with separate model usage charges.

Muting the microphone or playback does not stop billing. Ninety connected
minutes at the documented $0.05/minute rate cost $4.50 for voice, plus
coordinator and coding usage. End voice when not using it. Local Stop releases
microphone and playback immediately, but a replacement waits for outstanding
voice requests and server cleanup. A transport failure or missing provider-close
acknowledgment leaves shutdown unconfirmed; End coordinator before starting
voice again. Client cleanup failures block restart, but an unsolicited
provider-side disconnect can leave the restart button enabled despite its
warning. Do not treat that button as proof of provider finalization. Fake API
and browser checks do not establish real model access, microphone compatibility,
latency or wording quality.

### Isolated real Pi trial

For an authorized end-to-end trial, use the real runtime with a private copy of
Pi's credentials and model definitions, not its session store or settings. This
uses existing coding credentials without asking the user to paste them again. Do
not symlink `auth.json`: credential refreshes must not write the primary agent's
file. Copied credentials still grant the same account access; this is
session-store isolation, not a tool-execution sandbox. Keep the task disposable
and do not grant new folder trust or install extensions for the trial.

From the validated checkout, in a supervised foreground terminal:

```bash
umask 077
source_agent="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
trial=$(mktemp -d /tmp/web-pi-voice-trial.XXXXXX)
mkdir -p "$trial/home" "$trial/agent" "$trial/project"
install -m 600 "$source_agent/auth.json" "$trial/agent/auth.json"
if test -f "$source_agent/models.json"; then
  install -m 600 "$source_agent/models.json" "$trial/agent/models.json"
fi
printf '{"packages":[]}\n' > "$trial/agent/settings.json"
printf 'Disposable voice trial. Work only in this folder.\n' > "$trial/project/README.md"
printf 'Private trial directory: %s\n' "$trial"

# Only after authorization for paid voice and coding calls:
# supply OPENAI_API_KEY through this shell's private environment, not arguments.
env HOME="$trial/home" PI_CODING_AGENT_DIR="$trial/agent" \
  WEB_PI_DEFAULT_CWD="$trial/project" \
  node bin/web-pi.js --runtime pi --host 127.0.0.1 --port 30143
```

Check the same free-port, readiness and shutdown conditions as the offline demo.
No credentials are printed by these commands. Keep the private trial directory
out of logs, archives and Git; after stopping, remove it only when its
disposable work is no longer needed. Do not copy its settings or sessions back
to the live store. Credentials present on disk establish availability, not valid
quota or account access; only the separately authorized trial establishes that.

For a phone, use an unused HTTPS port with the installed Tailscale Serve CLI,
not a path under an existing service. Inspect `tailscale serve status --json`
and listening sockets first. On hosts supporting foreground Serve, the shape is:

```bash
tailscale serve --https=8444 http://127.0.0.1:30143
```

Keep this second process supervised, without `--bg`. Its startup must say
**within your tailnet**, and `https://<node-dns-name>:8444/new` must return 200.
Confirm that port is not in `AllowFunnel`, and that existing handlers/services
are unchanged. Do not reuse a Funnel-enabled port, run `serve reset`, use
`--yes` to overwrite configuration, or change the primary service route. Stop
this foreground process with Ctrl+C and verify its temporary route disappears. A
fresh private browser context avoids cookies shared with other ports on the same
hostname. The phone must be connected to the tailnet and allowed by its access
policy; a successful host-side check is not a phone reachability test.

Minimal paid smoke, only after explicit authorization:

1. Open `/new`, choose an available coding model and create a disposable session
   with: "Name this session Voice trial. Reply ready; do not run tools yet."
2. Enable the coordinator and start microphone/voice. Ask it to list sessions,
   choose the Voice trial handle, and say: "Ask it to create hello.txt
   containing hello in this trial folder."
3. Read the visible target, wording and delivery mode, then confirm once. Check
   actual admission, the resulting file in the disposable project and the brief
   proactive result. A spoken "yes" is not a submission or approval mechanism.
4. End voice, then End coordinator. Verify capture stops and inspect any
   finalization warning. Stop both supervised processes.

Allow about two connected minutes: voice is approximately $0.10, plus separately
metered coordinator and coding usage. Initialization bills 15 seconds credited
against running duration, so do not add it again to that estimate. Failed
initialization and unconfirmed shutdown can affect the actual charge. This smoke
is not a 90-minute endurance, phone-background or wording-quality validation.

### Phone and headphone trial limits

Live provider operation, continuous 90-minute WebRTC use and physical-device
behavior are unverified. This is not yet a validated locked-screen walking app.
Do not supply a key or run the paid trial without separate authorization.

Official sources checked on 2026-09-30:

- OpenAI's
  [Live session lifecycle](https://developers.openai.com/api/docs/guides/live-conversations)
  documents an `expired` close reason, automatic context management and
  application-controlled idle closing, but does not state a numeric WebRTC
  session-duration cap. The
  [create endpoint](https://developers.openai.com/api/reference/resources/live/methods/create)
  specifies a two-hour connected-call limit for outbound SIP, not WebRTC. That
  is not evidence of a WebRTC guarantee, and Realtime's limits are not Live's.
- The
  [Live sideband guide](https://developers.openai.com/api/docs/guides/voice-server-controls)
  attaches a server WebSocket to the same session as the primary media and
  requires finalization before cleanup. It does not establish a separate numeric
  sideband/idle lifetime guarantee. No rollover or automatic reconnect has been
  implemented to work around an assumed limit.
- [Microphone capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
  requires browser permission and a secure context. A permission prompt can
  remain unanswered indefinitely. Use a trusted HTTPS origin on the phone;
  localhost on the server is not localhost on the phone.
- Chrome's
  [Energy Saver policy](https://developer.chrome.com/blog/freezing-on-energy-saver)
  excludes active conferencing/capture from that particular freezing policy, but
  its
  [page lifecycle documentation](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
  explains that mobile operating systems may stop applications and discard pages
  without callbacks. Neither is a locked-screen endurance guarantee.
- A [WebKit change](https://trac.webkit.org/changeset/273069/webkit) explicitly
  supports background/locked-screen MediaStream playback while audio capture is
  active. This implementation evidence from 2021 is not validation of the
  current iPhone/browser/headset combination or protection from interruption.

The client uses the browser's default microphone and audio route, not a headset
selector or native background service. Ordinary in-app session navigation keeps
the coordinator; full navigation, reload, owner removal or SSE failure ends it.
A failed or disconnected peer stops voice without retry or ICE restart. A
Wi-Fi/cellular handoff can therefore require an explicit restart. Browser/OS
suspension can interrupt audio even without a connection-state error; a
"Listening" label alone does not prove the phone is still capturing.

While unmuted, capture is continuous and includes nearby voices, not only
commands. Collapsing the panel or putting the phone away does not intentionally
mute it. Stop speaking mutes playback only. Use Mute microphone for privacy and
End voice to release capture and stop the session. Both provider requests use
`store:false`, which does not disable ordinary abuse-monitoring retention.

Before relying on a walk, a separately authorized trial must check the actual
phone, OS/browser version and wired/Bluetooth headset: permission grant/denial,
initial playback, foreground/background and screen lock/unlock, long pauses,
headset disconnect/reconnect, an incoming call, Wi-Fi/cellular transitions,
network loss, explicit mute/stop/end and provider finalization. Verify
microphone indicators and that unrelated coding keeps running. Keep the page
accessible: submitting coding work and answering approval dialogs still require
visible human confirmation. No native app, wake lock, background service or
public exposure is part of this prototype.

## Web state cutover and reset

Pi resolves the agent directory normally: `PI_CODING_AGENT_DIR` when set,
otherwise usually `~/.pi/agent`. Current web-pi owns these standalone files:

- `<agentDir>/web-pi/settings.json`: shared `warnTokens` (default **100000**,
  positive safe integer), `theme` (**auto**, or light/dark), and `sound`
  (**true**, or false). Auto follows each device's OS appearance. Models is not
  stored here: Settings → Models edits Pi's global `enabledModels` in
  `<agentDir>/settings.json`, shared with terminal Pi. Project overrides remain
  in `.pi/settings.json` and apply only in trusted projects.
- `<agentDir>/web-pi/push.json`: private VAPID identity and browser
  subscriptions.
- `<agentDir>/web-pi/worktree-projects.json`: remembered folder/project
  mappings.

Writes use private **0600** files and atomic replacement. The folder is created
with mode **0700**. Shared Pi sessions, `settings.json`, trust, auth, models,
skills and packages are not relocated or reset. Session-embedded web metadata,
such as stars, stays in Pi's session files.

### Upgrade an existing installation

1. Build the new version without starting it against live state. Identify the
   agent directory and every old web runtime using it. Stop those runtimes
   before starting the new version, including any old Next.js interface. Keep a
   private backup of the two legacy files outside the new `web-pi` folder.
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

## Migration from Next.js

[mjakl/web-pi](https://github.com/mjakl/web-pi) contains web-pi's Hono
application. The history-preserving integration joins the old pi-web main as its
first parent and web-pi main as its second parent; neither history is squashed
or rebased.

The final Next.js main is
[`archive/nextjs-final`](https://github.com/mjakl/web-pi/tree/archive/nextjs-final),
commit `2e27b3ea067b654a8f28c2a16a44aa3a748e5eb0`. That tag retains the old
application and its documentation. The imported web-pi main is
`997b7374d6d06d5231f9ffffe8523fad0ea08a93`, including the performance hot-path
improvements. Both MIT notices remain in `LICENSE` and `LICENSE.pi-web`.

A repository update does not install or start a service, move Pi data, or rename
the runtime. The executable remains `web-pi`, with `WEB_PI_*` variables and
default port 30142. Retire an old Next.js service only after identifying its
exact unit and saving its definition and state outside the checkout. Preserve
its application data and configuration; do not stop a separate web-pi runtime.

For a local trial without touching live state:

1. Stop writers before taking a consistent backup of the Pi agent directory.
   Keep the backup private: it can contain credentials, transcripts, trust
   decisions, and push keys.
2. Make a separate trial copy and set `PI_CODING_AGENT_DIR` to that copy. To
   test resource loading in isolation, also set `HOME` to a temporary home; Pi
   can discover `~/.agents/skills` independently of its agent directory. Review
   the copied settings and executable extensions before starting live turns.
3. Build and install the web-pi tarball using the README commands, with Node 24+
   and a compatible host Pi on `PATH`. Start it explicitly:

   ```bash
   PI_CODING_AGENT_DIR=/absolute/path/to/trial-agent \
     web-pi --host 127.0.0.1 --port 30142
   ```

4. Read representative saved sessions, stars, branches, and file paths. The
   local test suite covers Pi SessionManager fixtures, not every historical
   session or installed extension. Verify your needed extensions before moving
   normal work; the retained limitations are in [Behavior](behavior.md).
5. For the eventual cutover, stop the old server and terminal writers before
   pointing web-pi at the live directory. Change the service executable and
   environment deliberately; the command remains `web-pi`, with `WEB_PI_*`
   variables. Old Next.js startup commands and `PI_WEB_*` options are not
   aliases.

### Compatibility and rollback limits

Both apps use Pi's session JSONL format and the host Pi SDK; compatibility
therefore also depends on the installed Pi version. App-owned custom metadata is
no longer shared, as described below. No database conversion is required, but
this is not a guarantee that an older Pi can read files changed by a newer Pi,
nor a guarantee of all extension/UI behavior.

Web-owned push and worktree state now has a one-time cutover into `web-pi/`,
with the reset and rollback limits described above. Pi settings, model
configuration, and trust remain user-owned. The installed-package smoke test
reads a disposable SessionManager session without a provider call.

The old and new HTTP interfaces differ. Ports also create different browser
origins: localStorage drafts, service workers, PWA installs, and notification
permissions are not automatically transferred from port 30141 to 30142. Cookies
are **not port-scoped**; do not treat two ports on one hostname as cookie
isolation. If a later cutover reuses an origin, remove the old PWA and
service-worker registration and reload before installing the new one. Re-enable
notifications only in the chosen app.

Rollback means stopping web-pi and restarting the verified old version with a
compatible Pi install. Rewind/delete and newer writes are not undone by changing
the executable. Restore a backup only after deciding which later work would be
lost; never overwrite a live agent directory as an automatic rollback step.

### Clean-cut naming

The repository is `mjakl/web-pi`, renamed from `mjakl/pi-web`. Existing clones
should set their remote and GitHub CLI default explicitly:

```bash
git remote set-url origin git@github.com:mjakl/web-pi.git
gh repo set-default mjakl/web-pi
```

Owned runtime names use `web-pi`, without migration or compatibility aliases:

- Stars use `web-pi:star`. Old `pi-web:star` entries no longer count as stars;
  star an answer again to record it under the new name.
- New rewinds write `web-pi-rewind`, not `pi-web-rewind`. Existing rewind leaves
  remain ordinary Pi custom entries; the parent chain still defines the branch.
- Only `web-pi:subagent` exempts a child transcript from reparenting when its
  parent is deleted. Old `pi-web:subagent` markers no longer grant that
  exemption.
- Explorer folding uses `web-pi:file-explorer:open`; panel widths use
  `web-pi-sidebar-width` and `web-pi-right-panel-width`. Their former
  `pi-web:file-explorer:open`, `pi-sidebar-width` and `pi-right-panel-width`
  keys are ignored. Theme is now a shared web setting; neither `pi-theme` nor
  `web-pi-theme` is read. Other local presentation state and drafts keep their
  existing keys.

The naming change does not rewrite existing session files, remove old browser
keys, or alter Git history. Normal explicit session edits still write files. Pi
SDK identifiers, license notices and historical upstream references retain their
names. The later web-state cutover above supersedes the legacy storage paths.

### Validation workflow

The GitHub workflow's application lane runs `just ci` on Node 24 with pnpm
12.3.4. That command includes build, lint, typecheck, tests, and the
installed-package smoke. Its host Pi version is a CI fixture, not a pinned
product SDK dependency.

Changes limited to the workflow's explicit prose-documentation allowlist run
only whitespace and documentation-path checks, without application installs,
builds, tests, or smoke. Unknown or mixed changes use the application lane.
Packaged documentation ships on the next release; a docs-only success does not
validate a new tarball.

The required GitHub Actions check is **Source validation**. It reports the
selected lane's result and fails if required validation fails or is cancelled.
It replaces the old pair of **Source validation** and **Node 22.19 runtime
smoke** checks; Node 22 is no longer a supported runtime. Keep strict up-to-date
checks and unrelated repository protections unchanged. Merge the migration PR
with a genuine merge commit, never squash or rebase, so main retains both
complete histories.

## Exposing it

Only to a network you trust, and preferably behind something that authenticates.
web-pi has no accounts and no login; see the security note in
[the README](../README.md). `--lan` (or `WEB_PI_HOST=0.0.0.0`) binds every
interface and says so on startup.
