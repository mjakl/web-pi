import type { StaticAssets } from "@web/assets";

// The three files that make web-pi installable: the manifest, the service
// worker, and the page the worker serves when the local server is not there.
// The worker is generated rather than shipped as a file because its precache
// list has to name this build's hashed asset URLs.

export const THEME_COLOUR = "#1a1a1a";

export const ICONS = {
  small: "/static/icons/icon-192.png",
  large: "/static/icons/icon-512.png",
  apple: "/static/icons/apple-touch-icon.png",
  // pi-web switches the tab icon by the operating system's scheme, not by the
  // app's own theme.
  faviconLight: "/static/icons/favicon-light.png",
  faviconDark: "/static/icons/favicon-dark.png",
} as const;

export function manifest(): Record<string, unknown> {
  return {
    id: "/",
    name: "web-pi",
    short_name: "web-pi",
    description: "Browser interface for the Pi coding agent",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: THEME_COLOUR,
    theme_color: THEME_COLOUR,
    categories: ["developer", "productivity"],
    lang: "en",
    icons: [
      { src: ICONS.small, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: ICONS.large, sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}

export const OFFLINE_URL = "/offline.html";

/**
 * What the worker caches on install. The hashed asset URLs make the whole
 * cache new on every deploy, which is why the worker can serve them without
 * ever revalidating.
 */
export function precacheUrls(assets: StaticAssets): string[] {
  return [
    OFFLINE_URL,
    "/manifest.webmanifest",
    ICONS.small,
    ICONS.large,
    ICONS.apple,
    assets.css,
    assets.js,
  ];
}

/**
 * The service worker. It never touches anything the server has to answer
 * live: the session pages, the SSE streams, and every route that changes
 * state go straight to the network, and only `/static/*` is served from the
 * cache. A navigation that cannot reach the server falls back to the offline
 * page. Every received push displays a notification, including with a visible
 * window, as required by Apple's user-visible push contract.
 */
export function serviceWorker(assets: StaticAssets): string {
  const precache = JSON.stringify(precacheUrls(assets));
  return `const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE = "web-pi-" + VERSION;
const OFFLINE_URL = ${JSON.stringify(OFFLINE_URL)};
const PRECACHE = ${precache};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // One at a time: addAll rejects atomically, so a single asset missing
      // during a restart would leave the worker permanently uninstalled.
      .then((cache) =>
        Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {}))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("web-pi-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/sw.js") return;
  // Live traffic: the streams, and anything a page fetches for itself.
  if (url.pathname === "/events" || url.pathname.endsWith("/events")) return;
  if (request.headers.get("accept") === "text/event-stream") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(OFFLINE_URL);
        return cached || Response.error();
      }),
    );
    return;
  }

  if (url.pathname.startsWith("/static/") || PRECACHE.includes(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Even malformed pushes must display a visible notification.
  }
  if (!payload || typeof payload !== "object") payload = {};
  const title = typeof payload.title === "string" && payload.title ? payload.title : "web-pi";
  const body = typeof payload.body === "string" && payload.body ? payload.body : "A run finished.";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    data: { url: typeof payload.url === "string" ? payload.url : "/" },
    ...(typeof payload.tag === "string" && payload.tag ? { tag: payload.tag } : {}),
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const requested = event.notification.data && event.notification.data.url;
  let target = new URL("/", self.location.origin);
  try {
    const candidate = new URL(
      typeof requested === "string" ? requested : "/",
      self.location.origin,
    );
    if (candidate.origin === self.location.origin) target = candidate;
  } catch {
    // Malformed data keeps the root URL.
  }
  event.waitUntil(focusOrOpen(target.href));
});

async function focusOrOpen(target) {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const exact = clients.find((client) => client.url === target);
  const candidates = exact
    ? [exact, ...clients.filter((client) => client !== exact)]
    : clients;
  for (const client of candidates) {
    try {
      const focused =
        client.url === target ? client : (await client.navigate(target)) || client;
      await focused.focus();
      return;
    } catch {
      // The window may have closed since matchAll; try the next one.
    }
  }
  await self.clients.openWindow(target);
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}
`;
}

/** Served from the cache when the local server is not answering. */
export function offlinePage(assets: Pick<StaticAssets, "js">): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="${THEME_COLOUR}" />
    <title>web-pi is offline</title>
    <script type="module" src="${assets.js}"></script>
    <style>
      :root { color-scheme: dark; background: ${THEME_COLOUR}; color: #e8e8e8;
        font-family: system-ui, sans-serif; }
      body { min-height: 100dvh; margin: 0; display: grid; place-items: center;
        padding: 32px; text-align: center; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0; color: #9ca3af; font-size: 14px; }
      button { margin-top: 20px; padding: 8px 16px; border-radius: 6px;
        border: 1px solid #3a3a3a; background: #242424; color: inherit;
        font: inherit; cursor: pointer; }
    </style>
  </head>
  <body data-offline-page>
    <main>
      <h1>web-pi is offline</h1>
      <p>Start the local web-pi server, then try again.</p>
      <button type="button" onclick="location.reload()">Try again</button>
    </main>
  </body>
</html>
`;
}
