# Reproduce the README screenshots

The five PNGs in `docs/images` are captured from the real Hono app, its built
CSS and client bundle, and a fictional **Field Notes** project. Sessions use the
existing in-memory fake world. Files and Git diffs come from a temporary Git
repository. No model, credentials, installed extensions, or real session store
are used.

## Start the fixture

From a development checkout with dependencies installed:

```bash
just screenshots
```

The command builds assets, then runs `scripts/screenshot-fixture.ts`. It binds
only `127.0.0.1` on an OS-assigned port and prints the release-session URL. Do
not use the normal server or port 30141. Stop with Ctrl+C; the fixture removes
its temporary project. A forced kill may leave a `web-pi-screenshots-*`
directory in the system temporary directory, containing only fictional files.

The README scenarios are `/sessions/release`, `/sessions/navigation`,
`/sessions/tools`, and `/sessions/light`. A fifth session, `/sessions/scale`,
covers long code and compaction for the [style-scale checks](style-scale.md).
Use sidebar links to move between them. All controls are the application's own
controls, not screenshot-only markup.

## Capture

Use an already installed browser and agent-browser, or the same steps manually.
Do not reuse an authenticated browser profile. For agent-browser, load its
installed core guide first and use a dedicated session:

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix screenshots)"
agent-browser skills get core
agent-browser open http://127.0.0.1:<printed-port>/sessions/release
agent-browser set viewport 1440 1000
agent-browser snapshot -i
```

Set dark appearance through Settings → General. This changes the fixture's
shared in-memory settings, not your real Pi agent directory. Theme is no longer
read from localStorage; use the same General controls for scripted captures.

Refresh the accessibility snapshot after navigation and lazy row loading, then
use the current references. Wait for fonts, requested file content, Mermaid
SVGs, and panel animations before capturing. For example:

```bash
agent-browser eval 'Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))).then(() => document.fonts.ready).then(() => true)'
agent-browser screenshot docs/images/file-diff.png
```

Capture these states:

- **file-diff.png**, 1440 × 1000, dark: Release checklist. Keep the sidebar
  open, select the changed-files button above the explorer, then
  **src/release.ts** in the fictional project. Keep its Diff tab visible at the
  default 605 px panel width at this viewport. Enter “Add a regression test for
  surrounding whitespace.” without sending it.
- **session-navigation.png**, 1440 × 1000, dark: Decisions worth keeping. Hide
  the file panel and show the three requests, saved decision, sidebar star
  counts, and conversation rail.
- **session-tools.png**, 1440 × 1000, dark: Review the release helper. Open
  Process details, then Subagent · reviewer. Keep Prompt, Run details, Raw
  input, and Raw output collapsed beneath the rendered review.
- **conversation-light.png**, 1440 × 1000, light: Plan the next release. Switch
  appearance to light, then select Preview on the Mermaid block. Wait for the
  diagram, not merely the Preview button response.
- **mobile.png**, 390 × 844, dark: Release checklist with sidebar and file panel
  closed and an empty composer. This is viewport emulation, not a device test.

Use `agent-browser close` when finished and stop the fixture. Do not commit
browser profiles, cookies, HAR files, or temporary session data. Relative
timestamps and font rendering can vary by capture date and browser; this is a
reproducible scenario fixture, not a pixel-comparison test suite.

## Settings scroll regression

With the fixture running and agent-browser plus a local Chromium installed, run:

```bash
just settings-scroll http://127.0.0.1:<printed-port>
```

This checks the real rendered layout after switching away from General and back
through HTMX. It scrolls to the notification control and focuses the reset
control at 1440×1000, 1024×480, 641×360, 640×360, 390×480 and 320×320 in both
themes, asserting that controls are not clipped or covered and the close button
stays reachable. It uses a dedicated browser session and closes it on
completion. It does not save preferences or request notification permission.

The check saves the focused state at each size to `dist/settings-scroll/`. This
opt-in check needs browser layout, which happy-dom does not provide. It is not
part of `just qa` or CI and does not replace screenshot inspection.

## Composer layout regression

With the same isolated fixture and local Chromium running, check textarea growth
and control reachability:

```bash
node --import tsx scripts/check-composer-layout.ts http://127.0.0.1:<printed-port>
```

The check fills but never submits a draft. In both themes at 390, 640, 641 and
1440px it measures growth from an empty textarea to the 200px cap, tests
internal scrolling, and checks that send, attachment and model controls are not
clipped or covered. At mobile widths it also opens the overflow menu. Captures
go to `dist/composer-layout/` for visual inspection. This opt-in check replaces
CSS source-declaration assertions; it is not part of `just qa` or CI and does
not simulate a physical keyboard or prove layout in other browser engines.

## Verification record

The committed images were visually inspected after capture with local headless
Chromium **153**. They show the current Hono diff, rail/stars, structured
subagent result, rendered Mermaid diagram in light mode, and mobile composer.
Desktop captures use 1440 × 1000; mobile uses 390 × 844. No public listener or
external provider was used. These captures do not establish minimum-version
Firefox, Safari, Edge, or physical-device compatibility.

`just smoke` verifies that the documentation and image links in the installed
README and docs resolve after packing and consumer installation. It also checks
both product license notices. Visual content is checked by inspecting the
images, not by those file-presence assertions.
