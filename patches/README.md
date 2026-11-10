# Vendored HTMX fixes

`htmx-4.0.0.patch` applies to the unminified files in `htmx.org@4.0.0`. It keeps
replacement-request queue ownership until that request finishes, distinguishes
intentional aborts from request failures (including timeouts), and observes the
SSE reader's cancellation promise during cleanup. Unexpected request and stream
errors still use HTMX's error events.

The browser loads the patched, minified copies in `static/vendor`, not the
package's JavaScript. The local revision in each filename keeps browsers from
reusing an unpatched cached asset. To regenerate them without changing
`node_modules`:

```sh
mkdir -p /tmp/web-pi-htmx/dist/ext
cp node_modules/htmx.org/dist/htmx.js /tmp/web-pi-htmx/dist/
cp node_modules/htmx.org/dist/ext/hx-sse.js /tmp/web-pi-htmx/dist/ext/
patch -d /tmp/web-pi-htmx -p1 < patches/htmx-4.0.0.patch
pnpm exec esbuild /tmp/web-pi-htmx/dist/htmx.js --minify --target=es2022 --outfile=static/vendor/htmx.min-4.0.0-web-pi.1.js
pnpm exec esbuild /tmp/web-pi-htmx/dist/ext/hx-sse.js --minify --target=es2022 --outfile=static/vendor/hx-sse.min-4.0.0-web-pi.1.js
```

When replacing the vendored version, check these fixes against the upstream
implementation and run `tests/web/htmx-cancellation.test.ts` and the existing
HTMX lifecycle tests.
