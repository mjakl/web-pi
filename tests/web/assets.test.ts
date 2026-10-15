import { createFakeWorld } from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { staticAssets } from "@web/assets";
import { HTMX_SRC, HTMX_SSE_SRC } from "@web/HtmlLayout";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function staticRoot(css: string, js: string): string {
  root = mkdtempSync(join(tmpdir(), "web-pi-static-"));
  writeFileSync(join(root, "app.css"), css);
  writeFileSync(join(root, "client.js"), js);
  writeFileSync(
    join(root, "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  return root;
}

describe("static asset URLs", () => {
  it("stamps each asset with a hash of its content", () => {
    const first = staticAssets(staticRoot("a{}", "let a"));
    expect(first.css).toMatch(/^\/static\/app\.css\?v=[0-9a-f]{8}$/);
    expect(first.js).toMatch(/^\/static\/client\.js\?v=[0-9a-f]{8}$/);
    expect(staticAssets(root).css).toBe(first.css);
    expect(staticAssets(staticRoot("b{}", "let a")).css).not.toBe(first.css);
  });

  it("still produces a URL when nothing is built yet", () => {
    expect(staticAssets("/nonexistent")).toEqual({
      css: "/static/app.css?v=dev",
      js: "/static/client.js?v=dev",
    });
  });
});

describe("static asset caching", () => {
  function serve(path: string) {
    const app = createWebApp({
      workspace: createWorkspace(createFakeWorld()),
      staticRoot: staticRoot("a{}", "let a"),
      defaultCwd: "/repo",
      renderIntervalMs: 1,
    });
    return app.request(path);
  }

  it.each(["app.css", "client.js", "icon.svg"])(
    "lets the browser keep hashed %s forever",
    async (asset) => {
      const res = await serve(`/static/${asset}?v=0123abcd`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    },
  );

  it.each(["app.css", "client.js", "icon.svg", "client.js?v=dev"])(
    "caches unhashed or unbuilt %s for a day only",
    async (asset) => {
      const res = await serve(`/static/${asset}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    },
  );
});

describe("vendored htmx", () => {
  // The client compiles against the htmx.org package, but the browser runs
  // these copies: an upgrade has to replace them too.
  it("serves exactly the installed htmx.org release", () => {
    const htmx = join("node_modules", "htmx.org");
    const { version } = JSON.parse(
      readFileSync(join(htmx, "package.json"), "utf8"),
    ) as { version: string };
    for (const [src, original] of [
      [HTMX_SRC, "dist/htmx.min.js"],
      [HTMX_SSE_SRC, "dist/ext/hx-sse.min.js"],
    ] as const) {
      expect(src).toContain(`.min-${version}.js`);
      const vendored = readFileSync(
        join("static", src.replace("/static/", "")),
      );
      expect(vendored.equals(readFileSync(join(htmx, original))), src).toBe(
        true,
      );
    }
  });
});
