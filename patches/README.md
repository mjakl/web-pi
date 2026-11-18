# Vendored HTMX fixes

`htmx-4.0.2.patch` applies to `dist/htmx.js` in `htmx.org@4.0.2`. The
[4.0.2 release](https://github.com/bigskysoftware/htmx/releases/tag/v4.0.2)
leaves both cancellation paths unchanged:

- Suppress an `AbortError` only if the request's signal was actually aborted and
  its reason was not a timeout. Unexpected errors and timeouts must still reach
  `htmx:error`.
- Discard already-read `HX-Trigger` headers if cancellation interrupts the
  response body. Otherwise HTMX still dispatches them in `finally`.

The replacement-request queue fix from 4.0.1 is still upstream. The
[SSE cleanup fix](https://github.com/bigskysoftware/htmx/issues/4078) still
cancels the reader before aborting and clears its reference when releasing the
lock. We ship `hx-sse.js` unpatched; web-pi already uses `hx-sse:*` attributes,
so 4.0.2's removal of legacy `sse-*` attributes needs no migration.

The browser loads the minified copies in `static/vendor`, not the package's
JavaScript. Versioned filenames prevent reuse of older cached assets; the core's
local revision distinguishes it from unpatched upstream. To regenerate without
changing `node_modules`:

```sh
scratch=$(mktemp -d)
mkdir "$scratch/dist"
cp node_modules/htmx.org/dist/htmx.js "$scratch/dist/"
patch -d "$scratch" -p1 < patches/htmx-4.0.2.patch
pnpm exec esbuild "$scratch/dist/htmx.js" --minify --target=es2022 --outfile=static/vendor/htmx.min-4.0.2-web-pi.1.js
pnpm exec esbuild node_modules/htmx.org/dist/ext/hx-sse.js --minify --target=es2022 --outfile=static/vendor/hx-sse.min-4.0.2.js
```

When replacing the vendored version, check these fixes against the shipped
upstream source. Run `tests/web/htmx-cancellation.test.ts`, the existing HTMX
lifecycle tests, and real-browser cancellation/navigation checks.
