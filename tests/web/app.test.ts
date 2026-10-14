// What createWebApp itself answers for, whatever the route: documents
// against HTMX fragments, page caching, and session ids that cannot be one.

import { describe, expect, it } from "vitest";
import { testApp } from "#/web/fixtures/test-app";

describe("dynamic page caching", () => {
  describe.each(["/", "/new", "/sessions/s1", "/settings?section=general"])(
    "%s",
    (path) => {
      it.each<{ variant: string; headers: Record<string, string> }>([
        { variant: "document", headers: {} },
        { variant: "HTMX fragment", headers: { "HX-Request": "true" } },
        {
          variant: "history restoration",
          headers: {
            "HX-Request": "true",
            "HX-History-Restore-Request": "true",
          },
        },
      ])("does not store the $variant response", async ({ headers }) => {
        const { app } = testApp();
        const response = await app.request(path, { headers });
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(html).toContain('id="session-region"');
        expect(html).toContain('id="session-sidebar"');
        if ("HX-Request" in headers) {
          expect(html).not.toContain("<html");
          expect(html).not.toContain('<link rel="stylesheet"');
        } else {
          expect(html).toContain("<html");
          expect(html).toContain('<link rel="stylesheet"');
        }
        if (path.startsWith("/settings"))
          expect(html).toContain('<dialog class="settings-dialog"');
        expect(response.headers.get("cache-control")).toBe("no-store");
      });
    },
  );

  describe.each(["/new", "/sessions/s1"])("%s navigation", (path) => {
    it.each([false, true])(
      "does not store a session-region fragment (history restoration: %s)",
      async (restore) => {
        const { app } = testApp();
        const response = await app.request(path, {
          headers: {
            "HX-Request": "true",
            "HX-Target": "div#session-region",
            ...(restore ? { "HX-History-Restore-Request": "true" } : {}),
          },
        });
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(html).toContain('id="session-region"');
        expect(html).not.toContain('id="session-sidebar"');
        expect(html).not.toContain("<html");
        expect(html).not.toContain('<link rel="stylesheet"');
        expect(response.headers.get("cache-control")).toBe("no-store");
      },
    );
  });
});

describe("web app", () => {
  it("returns a fragment for HTMX requests and 404 for unknown ids", async () => {
    const { app } = testApp();
    const fragment = await (
      await app.request("/sessions/s1", { headers: { "HX-Request": "true" } })
    ).text();
    expect(fragment).not.toContain("<html");
    expect((await app.request("/sessions/nope")).status).toBe(404);
    expect((await app.request("/sessions/..%2Fetc")).status).toBe(404);
  });

  it.each([
    ["GET", "last-assistant-text"],
    ["POST", "prompt"],
  ])(
    "answers %s %s for a malformed session id with 404",
    async (method, action) => {
      const { app } = testApp();
      const response = await app.request(`/sessions/..%2Fetc/${action}`, {
        method,
      });
      expect(response.status).toBe(404);
    },
  );
});
