import { ICONS } from "@web/pwa";
import type { AppEnvironment } from "@web/hono";
import type { Context } from "hono";
import { raw } from "hono/html";
import type { PropsWithChildren } from "hono/jsx";

export const HTMX_SRC = "/static/vendor/htmx.min-4.0.0.js";
export const HTMX_SSE_SRC = "/static/vendor/hx-sse.min-4.0.0.js";

// The shared preference is rendered before paint; auto resolves on this device.
const THEME_SCRIPT = `var t=document.documentElement.dataset.theme;if(t==="dark"||(t==="auto"&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark");`;

export function HtmlLayout(
  { children }: PropsWithChildren,
  context: Context<AppEnvironment>,
) {
  if (context.req.header("HX-Request") === "true") {
    return <>{children}</>;
  }
  const assets = context.get("assets");
  const settings = context.get("workspace").webSettings();
  return (
    // `translate=no` on both elements: a page translation would rewrite the
    // transcript under the reader.
    <html
      lang="en"
      translate="no"
      class="notranslate"
      data-theme={settings.theme}
      data-sound={String(settings.sound)}
    >
      <head>
        <meta charset="UTF-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
        />
        <meta name="google" content="notranslate" />
        {/* Keep streams connected in hidden tabs. Compaction and package actions
            also retain v2's unlimited request time rather than v4's 60 seconds. */}
        <meta
          name="htmx-config"
          content={JSON.stringify({
            extensions: "sse",
            sse: { pauseOnBackground: false },
            defaultTimeout: 0,
            // Disclosure choices belong to the reader, including while a tool changes.
            morphIgnore: ["data-htmx-powered", "open"],
          })}
        />
        {/* The real one is "<folder> - web-pi", set by the shell module from
            the folder on the page: only the browser knows which page won. */}
        <title>web-pi</title>
        <meta
          name="theme-color"
          media="(prefers-color-scheme: light)"
          content="#ffffff"
        />
        <meta
          name="theme-color"
          media="(prefers-color-scheme: dark)"
          content="#1a1a1a"
        />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
        <meta name="apple-mobile-web-app-title" content="web-pi" />
        <meta name="format-detection" content="telephone=no" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link
          rel="icon"
          href={ICONS.faviconLight}
          media="(prefers-color-scheme: light)"
          sizes="64x64"
          type="image/png"
        />
        <link
          rel="icon"
          href={ICONS.faviconDark}
          media="(prefers-color-scheme: dark)"
          sizes="64x64"
          type="image/png"
        />
        <link rel="apple-touch-icon" href={ICONS.apple} sizes="180x180" />
        <script>{raw(THEME_SCRIPT)}</script>
        <link rel="stylesheet" href={assets.css} />
        {/* Core must see readyState=loading, so initialization waits for the
            deferred SSE extension and module client at DOMContentLoaded. */}
        <script src={HTMX_SRC}></script>
        <script src={HTMX_SSE_SRC} defer></script>
        <script type="module" src={assets.js}></script>
      </head>
      <body
        {...{
          "hx-status:4xx:inherited": "swap:none",
          "hx-status:5xx:inherited": "swap:none",
        }}
        translate="no"
        class="notranslate"
        // The service worker is registered with this build's asset hash, so a
        // new build replaces the worker and its cache instead of being served
        // stale assets from the old one.
        data-sw-src={`/sw.js?v=${assets.js.split("=").at(-1) ?? "dev"}`}
      >
        {children}
      </body>
    </html>
  );
}
