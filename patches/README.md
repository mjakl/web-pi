# Vendored HTMX fixes

`htmx-4.0.1.patch` applies to `dist/htmx.js` in `htmx.org@4.0.1`. It retains two
corrections: only suppress an `AbortError` when the request's signal was
actually aborted (and not by a timeout), and discard already-read `HX-Trigger`
headers when cancellation interrupts response-body reading. Upstream 4.0.1
suppresses unrelated `AbortError`s and still dispatches those cancelled headers
from its `finally` block. Unexpected request errors and timeouts must still
reach HTMX's error events.

The [4.0.1 release](https://github.com/bigskysoftware/htmx/releases/tag/v4.0.1)
fixes replacement-request queue ownership, so that patch is removed. The
[upstream SSE fix](https://github.com/bigskysoftware/htmx/issues/4078) cancels
the reader before aborting and clears its reference when releasing the lock. The
shipped source and cancellation tests confirm the original SSE cleanup failure
is fixed; `hx-sse.js` no longer needs a local patch.

The browser loads the minified copies in `static/vendor`, not the package's
JavaScript. Versioned filenames prevent reuse of older cached assets; the core's
local revision also distinguishes it from unpatched upstream. To regenerate
without changing `node_modules`:

```sh
mkdir -p /tmp/web-pi-htmx/dist
cp node_modules/htmx.org/dist/htmx.js /tmp/web-pi-htmx/dist/
patch -d /tmp/web-pi-htmx -p1 < patches/htmx-4.0.1.patch
pnpm exec esbuild /tmp/web-pi-htmx/dist/htmx.js --minify --target=es2022 --outfile=static/vendor/htmx.min-4.0.1-web-pi.1.js
pnpm exec esbuild node_modules/htmx.org/dist/ext/hx-sse.js --minify --target=es2022 --outfile=static/vendor/hx-sse.min-4.0.1.js
```

When replacing the vendored version, check these fixes against the shipped
upstream source. Run `tests/web/htmx-cancellation.test.ts`, the existing HTMX
lifecycle tests, and real-browser cancellation/navigation checks.
