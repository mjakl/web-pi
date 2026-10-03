import { createFakeWorld, userEntry } from "@adapters/fake/index";
import type { PushPresence } from "@core/ports";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { afterEach, describe, expect, it } from "vitest";
import { htmxBrowser } from "#/web/htmx4-browser";

const browsers: Awaited<ReturnType<typeof htmxBrowser>>[] = [];
afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
});

describe("assembled app-wide presence", () => {
  it("gives separate tabs/devices distinct leases and waits for the last one to leave", async () => {
    const world = createFakeWorld();
    const app = createWebApp({
      workspace: createWorkspace(world),
      staticRoot: "/nonexistent",
      defaultCwd: "/repo",
    });
    const markup = await (await app.request("/new")).text();
    const reports: PushPresence[] = [];
    const open = async () => {
      const browser = await htmxBrowser(
        markup,
        async (request) => {
          const presence =
            new URL(request.url).pathname === "/push/presence"
              ? ((await request.clone().json()) as PushPresence)
              : undefined;
          const response = await app.request(request);
          if (presence) reports.push(presence);
          return response;
        },
        {
          afterMarkup: (window) => {
            window.document.hasFocus = () => true;
          },
        },
      );
      browsers.push(browser);
      return browser;
    };
    // Presence works before enrollment exists on any device.
    const first = await open();
    const second = await open();
    expect(new Set(reports.map((report) => report.clientId)).size).toBe(2);
    world.push.subscribe({
      endpoint: "https://push.example/one",
      keys: { p256dh: "p", auth: "a" },
    });
    const message = {
      title: "done",
      body: "finished",
      tag: "one",
      url: "/new",
    };
    first.window.dispatchEvent(new first.window.Event("pagehide"));
    await expect
      .poll(() => reports.filter((report) => !report.foreground).length)
      .toBe(1);
    await world.push.send(message);
    expect(world.push.sent).toHaveLength(0);
    second.window.dispatchEvent(new second.window.Event("pagehide"));
    await expect
      .poll(() => reports.filter((report) => !report.foreground).length)
      .toBe(2);
    await world.push.send(message);
    await world.push.send(message);
    expect(world.push.sent).toHaveLength(1);
  });
  it.each(["/new", "/settings", "/sessions/s1", "/offline.html"])(
    "reports foreground from %s and preserves document identity through restoration",
    async (path) => {
      const world = createFakeWorld({
        sessions: [
          {
            summary: {
              id: "s1",
              cwd: "/repo",
              createdAt: "2026-09-01T00:00:00.000Z",
              modifiedAt: "2026-09-02T00:00:00.000Z",
              fileSize: 10,
            },
            entries: [userEntry("u1", null, "hello")],
          },
        ],
      });
      const app = createWebApp({
        workspace: createWorkspace(world),
        staticRoot: "/nonexistent",
        defaultCwd: "/repo",
      });
      world.push.subscribe({
        endpoint: "https://push.example/one",
        keys: { p256dh: "p", auth: "a" },
      });
      const reports: PushPresence[] = [];
      const markup = await (await app.request(path)).text();
      const browser = await htmxBrowser(
        markup,
        async (request) => {
          const presence =
            new URL(request.url).pathname === "/push/presence"
              ? ((await request.clone().json()) as PushPresence)
              : undefined;
          const response = await app.request(request);
          if (presence) {
            expect(response.status).toBe(200);
            reports.push(presence);
          }
          return response;
        },
        {
          afterMarkup: (window) => {
            window.document.hasFocus = () => true;
          },
        },
      );
      browsers.push(browser);
      expect(reports[0]?.foreground).toBe(true);
      const message = {
        title: "done",
        body: "finished",
        tag: "one",
        url: "/sessions/s1",
      };
      await world.push.send(message);
      expect(world.push.sent).toHaveLength(0);
      browser.window.dispatchEvent(new browser.window.Event("pagehide"));
      await expect.poll(() => reports.at(-1)?.foreground).toBe(false);
      await world.push.send(message);
      await world.push.send(message);
      expect(world.push.sent).toHaveLength(1);
      // BFCache restoration, icon launches and notification navigation all use
      // the same focused document lifecycle, not service-worker messages.
      browser.window.dispatchEvent(new browser.window.Event("pageshow"));
      await expect.poll(() => reports.at(-1)?.foreground).toBe(true);
      await world.push.send(message);
      expect(world.push.sent).toHaveLength(1);
      browser.window.dispatchEvent(new browser.window.Event("pagehide"));
      await expect.poll(() => reports.at(-1)?.foreground).toBe(false);
      await world.push.send(message);
      expect(world.push.sent).toHaveLength(2);
      expect(new Set(reports.map((report) => report.clientId)).size).toBe(1);
      expect(reports.map((report) => report.sequence)).toEqual(
        reports.map((_, index) => index + 1),
      );
    },
  );
});
