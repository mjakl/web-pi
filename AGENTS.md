# web-pi repository guide

web-pi is a server-rendered browser interface for the Pi coding agent: Hono
renders HTML, HTMX swaps fragments, and one SSE stream per open session pushes
re-rendered fragments while a turn runs. The server owns the conversation model;
the browser keeps drafts and presentation preferences, not a second transcript.

## Working agreement

- Use `pnpm` and the tool pins in `mise.toml`. Automation lives in the
  `justfile`; do not add `package.json` scripts.
- Run one complete final local gate before handoff: `just qa` (fix, lint, test),
  or `just ci` (build, lint, test, package smoke) when non-mutating validation
  is needed. Do not routinely run both on unchanged inputs. Keep focused
  development checks and the distinct package checks required below. After
  executable changes, rerun the gate; after prose-only corrections, recheck
  content, links, and the diff, reusing still-relevant runtime evidence.
- Non-executable documentation-only changes may use content, link/path, and diff
  checks instead of an application gate. Run
  `node scripts/check-doc-path-references.ts` (Node 24) and `git diff --check`,
  and inspect changed guidance and links. This exception does not cover runtime
  content, fixtures, configuration, dependencies, tests, executable skills,
  validation scripts, or workflows. CI uses an explicit documentation allowlist
  in `.github/workflows/validation.yml`; unknown or mixed changes run full CI.
  Packaged documentation changes ship on the next release; these lightweight
  checks do not validate a new tarball.
- Never start the dev server on port 30141 or write into `~/.pi/agent` from
  tests. Experiments that run a model use `PI_CODING_AGENT_DIR` pointing at a
  temporary directory with copied `auth.json`, `models.json`, and a minimal
  `settings.json`. Anything that writes settings, trust, skills or packages —
  every adapter in the configuration layer — takes the agent directory as an
  argument for exactly this reason; never call `getAgentDir()` from one.
- `npx skills add` is the one exception that cannot be redirected: it resolves
  Pi's agent directory itself and installs into the real `~/.pi/agent/skills`
  and `~/.agents/.skill-lock.json` whatever `PI_CODING_AGENT_DIR` says. Do not
  run a skill install from a test or an unattended check.
- The Pi SDK is never pinned: `src/host-pi.ts` points
  `node_modules/@earendil-works/*` at the `pi` on `PATH`. In a checkout
  `prepare` and every `just` recipe that compiles or runs code re-link first; in
  an installed package the bin does it on every start. Pi must be installed
  separately; `just doctor` reports which install was resolved. Never add an
  `@earendil-works/*` dependency to `package.json`.
- `dependencies` are only what stays external in `dist/server.js` (the Pi SDK,
  `web-push`, `undici`); everything else esbuild bundles and belongs in
  `devDependencies`. Changing either list means running `just smoke`.
- `CLAUDE.md` is a symlink to this file. Repository workflow skills live in
  `.agents/skills/`; `.claude/skills/` contains compatibility symlinks, not
  copies. Keep each skill's references, license, and provenance with it.

## Layout and boundaries

```text
src/core       rules and ports: transcript projection, session derivations
               (stars, statistics, branches), project selection, the
               conversation rail layout, terminal-output conversion, context
               usage, composer input rules, path containment and local file
               links, HTML escaping, file kinds, Git status parsing,
               patches, frontmatter, worktree identity,
               the skill frontmatter toggle, skill install metadata, package
               list semantics, startup model preferences, tool schemas,
               pending extension dialogs and custom-UI frames, terminal key
               encoding, the run-completion rule
src/core/workspace  the inbound port, one module per use-case family
               (sessions, live, files, config) over deps.ts, which holds the
               ports and the shared internals; index.ts composes them into
               the one `Workspace` object every route calls
src/adapters   Pi SDK, filesystem, Git, and in-memory implementations of the
               ports
src/web        Hono routes, JSX views, HTMX/SSE delivery, client bundle, the
               generated service worker and manifest. routes/, views/ and
               client/ are split one module per area of the screen — sidebar,
               shell, transcript, composer, files — so five ports can run at
               once; routes/shared.ts holds what they all need, and
               views/transcript/ holds the transcript's views one module per
               item kind behind the views/Items.tsx barrel
src/web/styles plain CSS, grouped by component owner; index.css fixes cascade
src/container.ts  the only file that wires adapters into the core
src/server.ts  process entrypoint; src/cli.ts the flags and startup behind the
               bin, src/host-pi.ts the SDK resolution both of them use,
               src/http.ts the proxy-aware global dispatcher
bin/web-pi.js  the published entry point: imports dist/cli.js, nothing else
tests/         vitest, mirrors src/ and scripts/; tests/client runs the
               bundle's modules in happy-dom, tests/smoke only from `just smoke`
scripts/       repository tooling: host Pi linking, doctor, doc checks
```

Rules enforced by `.oxlintrc.json`:

- `src/core` may import SDK **types** but never call the SDK, Node, or Hono.
- `src/adapters` never import `src/web`.
- `src/web` never imports adapters or the SDK; it talks to `Workspace`.
- No parent-relative imports; use `@/*` (src root), `@core/*`, `@adapters/*`,
  `@web/*`, `#/*` (tests).
- One escaper: `escapeHtml` in `src/core/html.ts`. Views, the ANSI converter,
  and the client bundle all build markup from untrusted text, and a second
  escaper is how one of them ends up missing an entity.
- Hono JSX uses `class`, never `className`. No dynamic imports in `src/`; the
  two exceptions carry a narrowed lint override — `src/web/client/mermaid.ts`
  loads the separately bundled `static/mermaid.js` by URL, and `src/cli.ts`
  loads the server only after the SDK links are in place.
- `src/web/client/*` is bundled by esbuild and may import `@core/*`; anything it
  imports must run in a browser (no Node, no SDK). `main.ts` and
  `mermaid-lib.ts` are the two bundle entry points.
- Anything a page can do without script does: the workspace menu is a native
  `popover` anchored in CSS, and the subagent fold and the extension widget
  panel are `<details>` elements the server fills on demand.
- Web-owned settings, push state and worktree mappings live under
  `<agentDir>/web-pi/`. Read `docs/deployment.md` before changing their cutover
  or reset behavior. Never let a test or unattended check reach the real store:
  `createWebPushNotifier` takes the directory, and its `send` is injectable so
  nothing has to talk to a push service.

## Styling

Preserve rendered appearance and behavior, not legacy CSS source placement.
`archive/nextjs-final` remains the historical reference. Minor consistency
changes follow the established Settings patterns, not a blanket redesign.

- Keep plain CSS and component/role-named, owner-scoped classes. Reuse existing
  tokens and demonstrated patterns, not utility classes or a new framework.
  Standard action buttons are 32px, compact actions 28px; dialogs use standard
  actions. Preserve meaningful density, hierarchy, semantic colors and focus.
- Put static presentation in CSS. Use semantic state (`disabled`, `open`,
  `aria-expanded`) where it fits, otherwise owner-scoped state classes. Remove
  replaced inline declarations and compensating overrides in the same change,
  including browser-created and streamed markup.
- Runtime depth, gutter widths, measured bounds, rail positions, keyboard
  viewport values and arbitrary ANSI colors may use narrow inline values or
  custom properties. Keep their surrounding static styling in CSS.
- `base.css`, `globals.css` and `web-pi.css` own reset, tokens, fonts and global
  browser/HTMX concerns. `settings.css` owns Settings/config components;
  `areas/shell.css` owns shell and shared dialog actions; the sidebar, composer
  (including extension shelf), files and transcript each own their area file.
  `code-theme.css` owns the syntax highlighting palette that transcript code
  blocks and the file viewer share. Move component rules to their owner rather
  than adding fallback layers. Keep the explicit cascade in `index.css`.
- Remove decorative entrance, sweep and repeating highlight effects. Use a
  static accent tint for widget updates, preserving their update duration. Keep
  restrained hover/focus and functional loading/compaction feedback, with
  reduced-motion support.
- Compare baseline and changed rendering in both themes and at desktop/mobile
  sizes, including affected breakpoints, overflow, focus/disabled states and
  HTMX/SSE updates. Fixture screenshots need visual inspection; snapshots and
  happy-dom do not prove pixel preservation.
- Icons come from `src/web/views/icons.tsx`, which holds every SVG pi-web draws.
  Add one there, copied from pi-web, rather than inline in a view.
- An HTMX swap has to replace a whole owner subtree (`.chat-transcript`,
  `.session-row`, `#file-panel`): pi-web's CSS keys on container relationships,
  and a partial swap breaks them silently.

Read `docs/architecture.md` before changing a port, the SSE contract, or context
accounting. Shell commands run with a sanitised environment; read
`docs/adr/0001-project-command-environment.md` before changing that.

Every file request goes through `authorize` in `src/core/workspace/deps.ts`; add
a root through the allowed-root flow there, never a check in a route handler.
Read `docs/behavior.md` before changing file behavior and `docs/worktrees.md`
before changing folder selection or worktree discovery.

## Validation

- `just test` runs vitest. Web tests call `app.request()` against the fake world
  in `src/adapters/fake/index.ts`; no Pi installation is needed. A new port
  method lands there in the same change, or every web test stops running.
- During development, use `just test-one <file-or-directory>` for focused
  feedback; append `-t "test name"` to select a scenario or use
  `just test-one --project client` for client tests. These do not replace the
  full-suite `just qa` handoff gate.
- Vitest detects supported agents and uses its concise reporter. If detection
  fails, append `--reporter=agent` to `just test-one`, or run
  `AI_AGENT=pi just qa`. Preserve failure diagnostics; do not silence or
  truncate test output.
- Tests that write session files build them with `SessionManager` in a `mkdtemp`
  directory and pass that as the agent directory. A test that loads skills or
  starts a session goes through `tests/adapters/temp-agent.ts`, which also
  points `HOME` at the temp root: the SDK reads `~/.agents/skills` from `HOME`
  whatever agent directory it is given.
- `tests/client` mounts the markup a view renders and dispatches DOM events at
  the client module; `setup.ts` fakes htmx and undoes every listener after each
  test. happy-dom has no layout, so a test that needs geometry sets it.
- Add or update the nearest test for changed behaviour; assert on rendered
  output or port behaviour, never on source text.
- `just build` writes `dist/` and the built assets; `just smoke` builds, packs
  the package, installs the tarball into a throwaway project, and serves a
  fixture session from it. Run it after touching `bin/`, `files`, dependencies,
  the build, or startup. With `just qa`, run this distinct package check once;
  `just ci` already includes it. Do not add a separate build when smoke covers
  the same inputs.
- Inspect `git status` and the diff before handoff.
