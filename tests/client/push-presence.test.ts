import type { PushPresence } from "@core/ports";
import { offlinePage } from "@web/pwa";
import { describe, expect, it, vi } from "vitest";
import { flush, mount } from "./helpers.ts";

async function setup(visible = true, focused = true) {
  mount("<main data-session-id='other-session'></main>");
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue(visible ? "visible" : "hidden");
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  const fetcher = vi.fn().mockResolvedValue(new Response(""));
  vi.stubGlobal("fetch", fetcher);
  const { setUpPushPresence } = await import("@web/client/push-presence");
  setUpPushPresence();
  const reports = () =>
    fetcher.mock.calls.map(
      ([, init]) =>
        JSON.parse((init as RequestInit).body as string) as PushPresence,
    );
  return { visibility, focus, fetcher, reports };
}

function lifecycle(type: string): void {
  (type === "visibilitychange" ? document : window).dispatchEvent(
    new Event(type),
  );
}

describe("app-wide push presence", () => {
  it("the cached offline page loads the app client and reconfirms presence without HTMX when connectivity returns", async () => {
    const page = new DOMParser().parseFromString(
      offlinePage({ js: "/static/client-version.js" }),
      "text/html",
    );
    mount(page.body.innerHTML);
    document.body.toggleAttribute(
      "data-offline-page",
      page.body.hasAttribute("data-offline-page"),
    );
    document.title = page.title;
    expect(
      page.querySelector('script[type="module"]')?.getAttribute("src"),
    ).toBe("/static/client-version.js");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.stubGlobal("htmx", undefined);
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    await import("@web/client/main");
    await flush();
    expect(document.title).toBe("web-pi is offline");
    const reports = () =>
      fetcher.mock.calls.filter(([path]) => path === "/push/presence");
    expect(reports()).toHaveLength(1);
    fetcher.mockResolvedValue(new Response(""));
    lifecycle("online");
    await flush();
    expect(reports()).toHaveLength(2);
    const received = reports().map(
      ([, init]) =>
        JSON.parse((init as RequestInit).body as string) as PushPresence,
    );
    expect(received[1]).toMatchObject({ foreground: true, sequence: 2 });
  });
  it("reports a focused launch immediately without Settings or push capabilities and refreshes every 20 seconds", async () => {
    vi.stubGlobal("Notification", undefined);
    const { reports, fetcher } = await setup();
    expect(reports()).toHaveLength(1);
    expect(reports()[0]).toMatchObject({ sequence: 1, foreground: true });
    expect(reports()[0]?.clientId).toMatch(/^[a-z0-9-]+$/);
    expect(fetcher).toHaveBeenCalledWith(
      "/push/presence",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(reports()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reports()[1]).toEqual({ ...reports()[0], sequence: 2 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reports()[2]).toEqual({ ...reports()[0], sequence: 3 });
    expect(
      fetcher.mock.calls.every(([path]) => path === "/push/presence"),
    ).toBe(true);
  });

  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])(
    "does not rearm or poll on a launch with visible=%s and focused=%s",
    async (visible, focused) => {
      const { reports } = await setup(visible, focused);
      lifecycle("pageshow");
      lifecycle("focus");
      await vi.advanceTimersByTimeAsync(100_000);
      expect(reports()).toEqual([]);
    },
  );

  it("releases on blur or hiding, stops refreshes, and rearms only when both visible and focused", async () => {
    const { reports, focus, visibility } = await setup();
    focus.mockReturnValue(false);
    lifecycle("blur");
    expect(reports().at(-1)?.foreground).toBe(false);
    const count = reports().length;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(reports()).toHaveLength(count);
    visibility.mockReturnValue("hidden");
    focus.mockReturnValue(true);
    lifecycle("focus");
    expect(reports()).toHaveLength(count);
    visibility.mockReturnValue("visible");
    lifecycle("visibilitychange");
    expect(reports().at(-1)?.foreground).toBe(true);
    visibility.mockReturnValue("hidden");
    lifecycle("visibilitychange");
    expect(reports().at(-1)?.foreground).toBe(false);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(reports()).toHaveLength(count + 2);
  });

  it("releases on pagehide even before focus changes and reports foreground on restored pageshow", async () => {
    const { reports } = await setup();
    lifecycle("pagehide");
    expect(reports().at(-1)?.foreground).toBe(false);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(reports()).toHaveLength(2);
    lifecycle("pageshow");
    expect(reports().at(-1)?.foreground).toBe(true);
    expect(reports().map((report) => report.sequence)).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reports()).toHaveLength(4);
    expect(new Set(reports().map((report) => report.clientId)).size).toBe(1);
  });

  it("reconfirms focused presence after network recovery and tolerates failed reports", async () => {
    const { fetcher, reports } = await setup();
    fetcher.mockRejectedValueOnce(new Error("offline"));
    lifecycle("focus");
    await flush();
    lifecycle("online");
    expect(reports().map((report) => report.foreground)).toEqual([
      true,
      true,
      true,
    ]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reports()).toHaveLength(4);
  });
});
