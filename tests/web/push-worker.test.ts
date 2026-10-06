import { serviceWorker } from "@web/pwa";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("received push", () => {
  it.each([true, false])(
    "always displays a notification with visible windows = %s",
    async (visible) => {
      const handlers = new Map<string, (event: unknown) => void>();
      const showNotification = vi.fn(() => Promise.resolve());
      runInNewContext(
        serviceWorker({
          css: "/static/app.css",
          js: "/static/client.js",
        }),
        {
          URL,
          self: {
            location: { href: "https://web.example/sw.js" },
            addEventListener: (
              name: string,
              handler: (event: unknown) => void,
            ) => handlers.set(name, handler),
            registration: { showNotification },
            clients: {
              matchAll: () =>
                Promise.resolve([
                  { visibilityState: visible ? "visible" : "hidden" },
                ]),
            },
          },
        },
      );
      const pending: Promise<unknown>[] = [];
      handlers.get("push")?.({
        data: {
          json: () => ({
            title: "Completed",
            body: "Task finished.",
            url: "/sessions/one",
          }),
        },
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      });
      await Promise.all(pending);
      expect(showNotification).toHaveBeenCalledWith(
        "Completed",
        expect.objectContaining({
          body: "Task finished.",
          data: { url: "/sessions/one" },
        }),
      );
    },
  );
});
