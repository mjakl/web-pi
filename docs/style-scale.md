# Interface style scale

`src/web/styles/globals.css` owns the non-color scale. Component rules stay in
`settings.css` and their `areas/` stylesheet; `index.css` keeps the cascade.

## Choices

- Spacing tokens use a 2px unit: `--space-1/2/3/4/5/6/8/10/12/16` are
  2/4/6/8/10/12/16/20/24/32px. They apply to gaps, padding and margins, not
  control dimensions, measured panel widths or rail positions. Existing 5px and
  7px gaps become 6px and 8px. Optical padding, negative offsets and
  document-relative spacing remain local.
- Radius roles follow Settings: `--radius-sm` is 3px, `--radius-md` is 5px, and
  `--radius-lg` is 8px. Former 4/6/7/10px corners become 3/5/8/8px. Circles,
  pill shapes and tiny indicator/rail geometry retain their radii.
- Small-text tokens are `--text-xs/sm/md` at 11/12/13px. The two 12.5px
  declarations become 13px. Relative Markdown text, including `0.92em`, is
  intentionally unchanged, as are 16px mobile inputs and smaller annotations.
- Named layers preserve every existing z-index value and stacking context. The
  list in `globals.css` records their order. Native dialogs and popovers remain
  in the browser's top layer; raising a document z-index cannot cover that
  layer.
- Viewport queries use compact **480px**, mobile **640px**, and desktop
  **960px** boundaries. The file toolbar's former 380px compression now applies
  through 480px; the compaction header's former 520px compression now ends at
  480px. Sidebar and file-panel behavior at 640/641 and 959/960px is unchanged.
  Media queries keep literal values because CSS custom properties do not work in
  media conditions. Coarse-pointer alternatives use the same query order;
  pointer, standalone, reduced-motion and container conditions stay independent.
- One query is a deliberate exception: `(max-width: 400px)` in
  `src/web/styles/areas/composer.css`. At phone widths it hides the reasoning
  level beside the model name, which the model menu still shows, and narrows the
  model and Skills buttons, so the model name keeps its room. Moving it to the
  480px boundary would also hide the level and narrow the buttons from 401 to
  480px, which is not pixel-neutral, so it stays at 400px.

## Reproduce the visual comparison

Use the isolated fixture described in [Screenshots](screenshots.md). It adds a
`/sessions/scale` session with long code and a compaction marker. No provider,
credentials or real agent state is used. Capture output belongs in ignored
`dist/`, not in the published README images.

Start `just screenshots` and use its ephemeral loopback URL in another terminal:

```bash
just style-scale http://127.0.0.1:<port> dist/style-scale-after
just settings-scroll http://127.0.0.1:<port>
cp -R dist/settings-scroll dist/style-scale-after-settings
```

For the pre-token baseline, start a fresh fixture, then replace only its built
CSS before opening the browser. These commands use the same browser targets as
`just build-css` and leave source files unchanged:

```bash
mkdir -p dist/style-scale-baseline
git archive fc391d6 src/web/styles | tar -x -C dist/style-scale-baseline
pnpm exec esbuild dist/style-scale-baseline/src/web/styles/index.css \
  --bundle --minify --target=chrome125,edge125,firefox147,safari26 \
  '--external:/static/*' --outfile=static/app.css
just style-scale http://127.0.0.1:<port> dist/style-scale-before
just settings-scroll http://127.0.0.1:<port>
cp -R dist/settings-scroll dist/style-scale-before-settings
```

Stop that fixture before capturing the changed version. `just screenshots`
rebuilds current assets and resets fictional sessions, including the one turn
sent by the check. Do not run before and after captures concurrently against one
fixture.

The style check captures both themes, desktop/mobile conversations, the model
popover, a subagent result, file panels, compaction, the mobile sidebar menu and
toolbar, the new-session directory menu, and a completed fake SSE turn. The
existing Settings scroll check owns Settings capture and verifies its HTMX
section swap before measuring layout. The style check checks for page overflow
and verifies mobile input size, disabled Send, and hit-tested control
reachability. File-panel widths are 320/380/381/480/481/640/641/959/960/1440px;
compaction widths are 320/480/481/520/521/640/641px. Settings scroll separately
checks 1440×1000, 1024×480, 641×360, 640×360, 390×480 and 320×320 in both
themes. The directory-menu check repeats the fixture's rendered folder group to
fill the list and checks that Custom path stays reachable at 1440×1000, 390×844
and 320×320, without inventing a separate rendering of the menu.

Each surface starts in a fresh browser to avoid carrying drafts, panel state or
streams into the next scenario. Resize checks reuse the page within a surface.
These checks do not claim coverage of a long chain of full-page navigations.

Inspect the PNGs side by side. Passing geometry assertions does not establish
visual quality or pixel preservation. Browser emulation does not establish
physical-device, installed-PWA, or minimum-version cross-browser compatibility.

## Verification record

On 2026-09-14, local Chromium 153.0.8010.36 captured 49 style scenarios and 12
Settings states for both the baseline CSS at `fc391d6` and the migrated CSS. All
geometry checks passed. All 61 pairs were visually inspected in comparison
sheets, with full-resolution inspection of representative conversation,
compaction and subagent states. No visual correction was needed.

The compact file toolbar stays usable between 381 and 480px. Compaction remains
readable on both sides of 480px and at the old 520px boundary. The existing
960px resize case still squeezes the conversation when retaining a wide file
panel; this change deliberately does not alter panel-width policy. Fake-turn
timestamps differ between captures.

Supplementary mobile inspection covered the session-info overlay and slash
completion with reduced motion enabled. Coarse-pointer hardware, physical
keyboards on phones, installed-PWA safe areas, and other browser engines were
not exercised.
