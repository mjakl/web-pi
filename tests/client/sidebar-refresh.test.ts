import { describe, expect, it, vi } from "vitest";
import { byId, flush, htmx, htmxEvent, mount, query } from "./helpers.ts";

async function setup(hidden = false) {
  const visibility = vi
    .spyOn(document, "hidden", "get")
    .mockReturnValue(hidden);
  mount(
    '<main data-session-id="selected"></main><aside id="sidebar"><div id="session-nav"><div id="session-list"><div class="session-row" data-session-id="selected"></div></div><div id="sidebar-events"></div></div></aside>',
  );
  const { setUpSidebar } = await import("@web/client/sidebar");
  setUpSidebar();
  return visibility;
}

function connection(id = "sidebar-events") {
  htmxEvent(byId(id), "htmx:sse:after:connection");
}

function returnToPage() {
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  connection();
}

describe("automatic session-list refresh", () => {
  it("polls at exactly 30 seconds while visible and swaps only list contents", async () => {
    await setup();
    const owner = byId("sidebar-events");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(htmx().ajax).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(htmx().ajax).toHaveBeenCalledExactlyOnceWith(
      "GET",
      "/sidebar/rows?selected=selected",
      {
        source: byId("session-list"),
        target: byId("session-list"),
        swap: "innerHTML",
      },
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(htmx().ajax).toHaveBeenCalledTimes(2);
    expect(byId("sidebar-events")).toBe(owner);
  });

  it("folds a scheduled focus refresh into a polling tick and cancels it on hiding", async () => {
    const visibility = await setup();
    await vi.advanceTimersByTimeAsync(29_950);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(100);
    expect(htmx().ajax).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("focus"));
    visibility.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(htmx().ajax).toHaveBeenCalledOnce();
  });

  it("has no polling clock while hidden and coalesces visible return, focus and reconnect", async () => {
    const visibility = await setup(true);
    const clocks = vi.getTimerCount();
    connection();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(htmx().ajax).not.toHaveBeenCalled();
    visibility.mockReturnValue(false);
    returnToPage();
    await vi.advanceTimersByTimeAsync(100);
    expect(htmx().ajax).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(clocks + 1);
    await vi.advanceTimersByTimeAsync(29_900);
    expect(htmx().ajax).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(clocks);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(htmx().ajax).toHaveBeenCalledTimes(2);
  });

  it("refreshes on focus and both sidebar connection events, not transcript connections", async () => {
    await setup();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div id="session-events"></div>',
    );
    connection("session-events");
    await vi.advanceTimersByTimeAsync(100);
    expect(htmx().ajax).not.toHaveBeenCalled();
    for (const trigger of [
      () => {
        connection();
      },
      () => {
        connection();
      },
      () => window.dispatchEvent(new Event("focus")),
    ]) {
      trigger();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(htmx().ajax).toHaveBeenCalledTimes(3);
  });

  it("queues at most one follow-up during an in-flight refresh and uses the latest selection", async () => {
    await setup();
    let finish!: () => void;
    htmx().ajax.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    connection();
    await vi.advanceTimersByTimeAsync(100);
    returnToPage();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(htmx().ajax).toHaveBeenCalledOnce();
    byId("session-list")
      .querySelector(".session-row")
      ?.setAttribute("data-session-id", "next");
    document.querySelector("main")?.setAttribute("data-session-id", "next");
    finish();
    await flush();
    expect(htmx().ajax).toHaveBeenCalledTimes(2);
    expect(htmx().ajax.mock.calls[1]?.[1]).toBe("/sidebar/rows?selected=next");
  });

  it("suppresses queued automatic work when hidden and recovers after failure on the next trigger", async () => {
    const visibility = await setup();
    let fail!: (error: Error) => void;
    htmx().ajax.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    connection();
    await vi.advanceTimersByTimeAsync(100);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(100);
    visibility.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    fail(new Error("offline"));
    await flush();
    expect(htmx().ajax).toHaveBeenCalledOnce();
    visibility.mockReturnValue(false);
    returnToPage();
    await vi.advanceTimersByTimeAsync(100);
    expect(htmx().ajax).toHaveBeenCalledTimes(2);
  });

  it("keeps lifecycle-requested refresh immediate and single-flight", async () => {
    await setup();
    htmxEvent(document.body, "web-pi:sidebar-refresh");
    await flush();
    expect(htmx().ajax).toHaveBeenCalledOnce();
    expect(htmx().ajax.mock.calls[0]?.[1]).toBe(
      "/sidebar/rows?selected=selected",
    );
  });

  it("does not duplicate timers or listeners across navigation, list and sidebar processing", async () => {
    await setup();
    const clocks = vi.getTimerCount();
    for (const id of ["session-list", "sidebar", "session-nav"]) {
      htmxEvent(byId(id), "htmx:after:process");
      htmxEvent(byId(id), "htmx:after:process");
    }
    htmxEvent(query("main"), "htmx:after:process");
    expect(vi.getTimerCount()).toBe(clocks);
    const replacement = document.createElement("body");
    replacement.innerHTML = document.body.innerHTML;
    document.body.replaceWith(replacement);
    htmxEvent(document.body, "htmx:after:process");
    htmxEvent(document.body, "htmx:after:process");
    expect(vi.getTimerCount()).toBe(clocks);
    returnToPage();
    await vi.advanceTimersByTimeAsync(100);
    expect(htmx().ajax).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(29_900);
    expect(htmx().ajax).toHaveBeenCalledTimes(2);
    htmxEvent(byId("sidebar"), "htmx:before:cleanup");
    byId("sidebar").remove();
    expect(vi.getTimerCount()).toBe(0);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(htmx().ajax).toHaveBeenCalledTimes(2);
  });
});
