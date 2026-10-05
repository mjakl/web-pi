# web-pi

**Your Pi conversations, project files, and changes in one workspace.**

Read an answer, review its diff, and write the next request with both still in
view. web-pi gives the [Pi coding agent](https://github.com/earendil-works/pi) a
server-rendered browser interface built with Hono, Hono JSX, and HTMX.

It reads the session files Pi already keeps under `~/.pi/agent` and runs live
turns in-process through Pi's SDK. History stays with Pi. Pages and fragments
come from the server, with SSE updates while a turn runs; the browser keeps no
second conversation model. Drafts and navigation stay local; General's theme,
context-warning threshold and completion sound are shared across browsers.

[Install and run](#install-and-run) ·
[Explore the interface](#explore-the-interface) ·
[Migration and deployment](docs/deployment.md)

![A release-helper answer beside its working-tree diff and follow-up draft](docs/images/file-diff.png)

_All screenshots show this Hono interface with fictional sessions and a
temporary example project. [Reproduce them](docs/screenshots.md) from a
checkout._

## Explore the interface

### Find the answer you wanted to keep

Star a decision, explanation, or result. Sidebar counts show which sessions have
stars; the desktop conversation rail takes you to prompts and starred answers.
Hover over a prompt mark to preview it before jumping, including prompts in
history that has not loaded yet. Stars are saved in the Pi session, and the
session menu can clear them all.

The naming cutover does not read old `pi-web:star` metadata, so those answers
must be starred again. See
[the clean-cut naming change](docs/deployment.md#clean-cut-naming).

![Starred release decisions and the desktop conversation rail](docs/images/session-navigation.png)

### Read the result, then inspect the process

Keep process details collapsed while reading the answer. Expand reasoning, tool
calls, command output, or a subagent result when you need the evidence. Subagent
results include separate prompt, run-details, and raw-output disclosures.
Subagent tools and orchestration come from your installed Pi extensions.

![An expanded fictional subagent correctness review](docs/images/session-tools.png)

### Discuss a plan in more than plain text

Read formatted tables and highlighted code alongside the answer. Mermaid blocks
switch between source and diagram preview. Choose light, dark, or system
appearance in Settings.

![A release plan and Mermaid diagram in light mode](docs/images/conversation-light.png)

### Keep working on a smaller screen

The mobile layout gives the conversation the screen. Open the sidebar and file
panel when you need them. The composer keeps model and reasoning controls close
to the request. An installable PWA supplies a separate app window, but live
sessions still need a connection to the host.

<img src="docs/images/mobile.png" width="360" alt="The release conversation and composer on an emulated mobile viewport" />

_This is browser emulation, not a physical-device test. Read
[Security](#security) before making the server reachable from another device._

## What you can do

- Browse all Pi sessions in one paginated list, with folder labels and live
  activity. Activate, stop, rename, export, fork, clone, delete, rewind, or
  navigate branches within a session.
- Choose a model and reasoning level, attach images, use slash commands, compact
  context, steer running work, or queue a follow-up.
- Inspect token usage, context, active time, and estimated streaming tokens and
  tokens per second. History pages backwards; tool results load when opened.
- Browse project files, preview source and document formats, inspect Git diffs,
  and insert file or line references into the composer.
- Open New Session directly in the composer and choose its working directory
  before sending. The choice is remembered independently of old sessions.
  Sessions remain readable when their folder disappears. See
  [Worktrees](docs/worktrees.md).
- Manage Pi skills and plugin packages globally or for a trusted project.
  Receive completion notifications and extension input requests in the browser.

web-pi does not manage Git worktrees or branches, configure provider accounts,
add a separate subagent runtime, or update itself through the browser. Configure
providers in the Pi terminal. The SDK resolves credentials for live sessions;
web-pi has no credential-management page.

This repository now contains the Hono implementation. The previous Next.js
application, its documentation, and its history remain at
[`archive/nextjs-final`](https://github.com/mjakl/web-pi/tree/archive/nextjs-final).
The import preserves both Git histories, including web-pi's performance work.

This implementation reuses the visual design and applicable behavior of that
Next.js application, a fork of [agegr/pi-web](https://github.com/agegr/pi-web).
It is not a promise of complete feature or API parity.
[Behavior and limitations](docs/behavior.md) describes what is retained and what
remains unfinished.

## Install and run

Use **Node 24 or newer**. web-pi installs its own Pi runtime; no system `pi` is
required or changed. Configure provider credentials in the existing Pi agent
directory before starting real turns. If you use terminal Pi for login, it
continues to share those credentials. Windows is not currently supported.

Every `just build` queries the npm registry for Pi's stable `latest` release,
updates the exact local `pi-coding-agent`, `pi-ai`, `pi-agent-core`, and
`pi-tui` dependencies and lockfile, then typechecks and bundles web-pi. Builds
require network access and fail if the required update or typecheck fails. The
named Pi runtime packages are exempt from pnpm's 24-hour release-age delay;
other dependencies retain that delay. This follows new stable Pi releases
immediately, including upstream breaking changes. web-pi does not require
`pi-server`.

web-pi is not on npm. From a checkout, install the development tools and build a
tarball:

```bash
mise install
pnpm install --frozen-lockfile   # pnpm 12.3.4
just build                     # refreshes and records stable latest Pi
just doctor                    # reports the locally installed Pi
pnpm pack                      # web-pi-0.1.0.tgz
npm install -g --ignore-scripts ./web-pi-0.1.0.tgz
web-pi                         # http://127.0.0.1:30142
```

The tarball declares the exact Pi runtime version used for its build. Installing
it installs that runtime and its dependencies; startup performs no update or
relink and needs no writable package directory. `web-pi --version` reports the
installed web-pi and Pi versions. To upgrade Pi, rebuild, validate, and
reinstall web-pi; upgrading a system Pi does not change web-pi. Documentation
and screenshots ship inside the tarball so these relative links also work in an
installed package.

Use the documented global npm installation or pnpm 12.3.4's default isolated
checkout/consumer layout. Runtime checks refuse ancestor SDKs, legacy links to
system Pi, mismatched versions, hoisted local npm installs, and pnpm's global
virtual store. These layouts cannot establish the same package-owned dependency
edges; do not work around a missing runtime by putting system Pi on `PATH`.

The agent directory remains `~/.pi/agent` (or `PI_CODING_AGENT_DIR`). Builds and
installation do not move or reset sessions, credentials, extensions or settings.
See [Pi upgrade compatibility](docs/deployment.md#pi-upgrade-compatibility)
before starting a rebuilt version against your existing data.

| Flag               | Default                       |
| ------------------ | ----------------------------- |
| `--host <name>`    | `127.0.0.1`, or `WEB_PI_HOST` |
| `--port <number>`  | `30142`, or `WEB_PI_PORT`     |
| `--lan`            | bind `0.0.0.0`; read Security |
| `--runtime <name>` | `pi`, or `fake` for a demo    |
| `--help`           | show flags                    |
| `--version`        | show web-pi and Pi versions   |

Environment: `WEB_PI_HOST`, `WEB_PI_PORT`, `WEB_PI_RUNTIME`,
`WEB_PI_DEFAULT_CWD` (home by default), and `PI_CODING_AGENT_DIR` (defaults to
Pi's agent directory). Server-side HTTP honors `HTTP_PROXY`, `HTTPS_PROXY`, and
`NO_PROXY`.

Browser baseline: **Chrome/Edge 125+, Firefox 147+, Safari 26+**. Native
popovers, CSS anchor positioning, `@starting-style`, `:has()`, and
`field-sizing` are required, not optional enhancements. These are the declared
support floors, not a claim that every minimum browser was exercised for this
change.

## Settings and notifications

**Settings → General** holds shared appearance (default **auto**), dumb-zone
warning threshold (**100000 tokens**), and completion sound (**on**). Auto
follows each device's OS appearance. These settings, push state and remembered
worktree mappings live under `<agentDir>/web-pi/`, separate from Pi's own
configuration. Existing browser preferences are deliberately reset, not
imported.

Subscribe or unsubscribe **this browser** in General. Push requires HTTPS (or
localhost) and browser push support; iPhone/iPad users must open a Home Screen
web app, not a normal browser tab. Permission alone does not enroll a browser,
and nothing subscribes automatically. Notifications cover completed runs in this
web server, not terminal Pi, and OS delivery is not guaranteed.

Before an upgrade or reset, read
[web-state cutover and reset](docs/deployment.md#web-state-cutover-and-reset).
Stop affected old web runtimes for the one-time file migration. With the server
stopped after cutover, deleting only `<agentDir>/web-pi/` resets web state
without touching Pi data. Browsers then need to confirm enrollment again.

## Security

web-pi runs agent tools and project commands. It has no accounts, login, or
built-in authentication, and does not check `Host` or `Origin` headers. Keep it
on `127.0.0.1` unless you have a trusted network or an external access-control
layer. `--lan` prints a warning for the same reason.

Project resources can run local code. Extensions, skills, and other
trust-requiring project resources stay dormant until you trust the project.
Trust only repositories you control or have reviewed.

File-content access goes through the server's allowed-root policy. The folder
picker can list other readable directory names; selecting a folder grants access
to it for the server process. This file boundary does not sandbox agent tools.
See [Behavior](docs/behavior.md) and [Deployment](docs/deployment.md), including
the restrictions on concurrent access to one session.

## Work on it

After the checkout setup above:

```bash
just dev              # http://127.0.0.1:30142, sources and asset watchers
just qa               # format/fix, lint, typecheck, tests
just ci               # refresh/build, non-fixing checks, installed-package smoke
just test-one tests/web
```

`just build` writes the bundled server in `dist/` and built assets in `static/`.
Tests run against sources; `just smoke` packs the build, installs it into a
throwaway consumer without system Pi, and serves a fictional session from the
installed bin. Tests and `just dev` use the installed local dependencies without
refreshing them; `just update-pi` refreshes Pi without building. A normal build
may change `package.json` and `pnpm-lock.yaml`; commit both together after
checks pass.

Contributor guidance lives in `AGENTS.md` in the checkout, with `CLAUDE.md` as
its symlink. Framework-independent workflows live in `.agents/skills`, with
compatibility links under `.claude/skills`. See
[Architecture](docs/architecture.md) for ownership and
[Screenshots](docs/screenshots.md) for the capture fixture.

## License

[MIT](LICENSE), copyright Michael Jakl. Copied pi-web CSS, code, and adapted
supporting material retain [pi-web's MIT notice](LICENSE.pi-web), copyright
agegr. Preserved workflow skills carry their own licenses and provenance.
