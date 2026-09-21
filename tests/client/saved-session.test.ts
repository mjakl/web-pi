import { describe, expect, it, vi } from "vitest";
import { byId, flush, htmx, htmxEvent, mount } from "./helpers.ts";

function response(
  kind = "unchanged",
  headers: Record<string, string> = {},
  body?: string,
) {
  return new Response(body ?? null, {
    status: body === undefined ? 204 : 200,
    headers: { "X-Web-Pi-Saved": kind, ...headers },
  });
}

async function page({ hidden = false, child = false, owned = false } = {}) {
  let invisible = hidden;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => invisible);
  mount(
    `<div id="session-region"><main id="saved" data-session-id="s1" ${owned ? 'hx-sse:connect="/sessions/s1/events"' : ""} data-saved-session="/sessions/s1/saved" data-saved-revision="stamp-1" data-saved-leaf="leaf-1" data-saved-content-leaf="content-1" ${child ? "" : 'data-live-events="/sessions/s1/events"'}><div id="log"><div id="messages"><button id="earlier" class="load-earlier">Earlier</button><div class="turn" id="turn-oldest">Saved history</div></div></div></main></div>`,
  );
  const swap = vi.fn(() => Promise.resolve());
  Object.assign(htmx(), { swap });
  const fetch = vi.fn<
    (input: string | URL, init?: RequestInit) => Promise<Response>
  >(() => Promise.resolve(response()));
  vi.stubGlobal("fetch", fetch);
  const { setUpSavedSession } = await import("@web/client/saved-session");
  setUpSavedSession();
  return {
    fetch,
    swap,
    owner: byId("saved"),
    visibility: (value: boolean) => {
      invisible = value;
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

function deferred() {
  return Promise.withResolvers<Response>();
}

function request(target: HTMLElement) {
  const ctx = {
    sourceElement: target,
    target,
    request: {
      action: "/sessions/s1",
      signal: new AbortController().signal,
      headers: {},
    },
  };
  htmxEvent(target, "htmx:before:request", { ctx });
  return () => htmxEvent(target, "htmx:finally:request", { ctx });
}

function transport(owner: HTMLElement): HTMLElement {
  const stream = owner.querySelector<HTMLElement>("[hx-sse\\:connect]");
  if (!stream) throw new Error("No SSE transport on saved session");
  return stream;
}

function callAt<T>(calls: T[], index: number): T {
  const call = calls[index];
  if (!call) throw new Error(`No request at index ${String(index)}`);
  return call;
}

function saved(
  stream: HTMLElement,
  data: {
    revision?: string;
    leaf?: string | null;
    contentLeaf?: string | null;
  } = {},
) {
  htmxEvent(stream, "web-pi:saved", { data: JSON.stringify(data) });
}

const changed = () =>
  response(
    "changed",
    {
      "X-Web-Pi-Revision": "stamp%202",
      "X-Web-Pi-Leaf": "leaf%202",
      "X-Web-Pi-Content-Leaf": "content%202",
    },
    '<div id="messages" hx-swap-oob="outerHTML">Updated history</div>',
  );

describe("saved session polling", () => {
  it("checks the loaded window every two seconds without swapping unchanged history", async () => {
    const { fetch, swap, owner } = await page();
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = callAt(fetch.mock.calls, 0);
    const url = new URL(input);
    expect(url.pathname).toBe("/sessions/s1/saved");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      revision: "stamp-1",
      leaf: "leaf-1",
      contentLeaf: "content-1",
      through: "oldest",
    });
    expect(init?.cache).toBe("no-store");
    expect(swap).not.toHaveBeenCalled();
    expect(owner.dataset["savedRevision"]).toBe("stamp-1");
    expect(byId("turn-oldest").textContent).toBe("Saved history");
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stays idle when mounted hidden and checks immediately on return", async () => {
    const { fetch, visibility } = await page({ hidden: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).not.toHaveBeenCalled();
    visibility(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    visibility(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts hidden work and never overlaps an abort-ignoring request during rapid returns", async () => {
    const { fetch, swap, visibility, owner } = await page();
    const pending = deferred();
    fetch.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(2000);
    visibility(true);
    expect(callAt(fetch.mock.calls, 0)[1]?.signal?.aborted).toBe(true);
    visibility(false);
    visibility(true);
    visibility(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(1);
    pending.resolve(changed());
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(swap).not.toHaveBeenCalled();
    expect(owner.dataset["savedLeaf"]).toBe("leaf-1");
  });

  it.each([false, true])(
    "cleans up a removed owner with pending request=%s",
    async (inFlight) => {
      const { fetch, swap, owner } = await page();
      const pending = deferred();
      fetch.mockReturnValueOnce(pending.promise);
      if (inFlight) await vi.advanceTimersByTimeAsync(2000);
      htmxEvent(byId("session-region"), "htmx:before:cleanup");
      owner.remove();
      if (inFlight)
        expect(callAt(fetch.mock.calls, 0)[1]?.signal?.aborted).toBe(true);
      pending.resolve(changed());
      await flush();
      await vi.advanceTimersByTimeAsync(10000);
      expect(fetch).toHaveBeenCalledTimes(inFlight ? 1 : 0);
      expect(swap).not.toHaveBeenCalled();
    },
  );

  it.each(["session-region", "body"])(
    "pauses and cancels while navigating to %s",
    async (target) => {
      const { fetch, swap } = await page();
      const pending = deferred();
      fetch.mockReturnValueOnce(pending.promise);
      await vi.advanceTimersByTimeAsync(2000);
      const finish = request(target === "body" ? document.body : byId(target));
      expect(callAt(fetch.mock.calls, 0)[1]?.signal?.aborted).toBe(true);
      pending.resolve(changed());
      await flush();
      await vi.advanceTimersByTimeAsync(10000);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(swap).not.toHaveBeenCalled();
      finish();
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("discards a stale loaded-window response when earlier history loads", async () => {
    const { fetch, swap, owner } = await page();
    const pending = deferred();
    fetch.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(2000);
    const finish = request(byId("earlier"));
    expect(callAt(fetch.mock.calls, 0)[1]?.signal?.aborted).toBe(true);
    byId("turn-oldest").insertAdjacentHTML(
      "beforebegin",
      '<div class="turn" id="turn-older">Earlier history</div>',
    );
    pending.resolve(changed());
    await flush();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(swap).not.toHaveBeenCalled();
    expect(owner.dataset["savedRevision"]).toBe("stamp-1");
    expect(owner.dataset["savedLeaf"]).toBe("leaf-1");
    finish();
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      new URL(callAt(fetch.mock.calls, 1)[0]).searchParams.get("through"),
    ).toBe("older");
    expect(byId("turn-older").textContent).toBe("Earlier history");
  });

  it("acknowledges unavailable revisions without replacing the branch or history", async () => {
    const { fetch, swap, owner } = await page();
    fetch.mockResolvedValueOnce(
      response("unavailable", {
        "X-Web-Pi-Revision": "unavailable%20stamp",
        "X-Web-Pi-Leaf": "other-leaf",
        "X-Web-Pi-Content-Leaf": "other-content",
      }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(owner.dataset["savedRevision"]).toBe("unavailable stamp");
    expect(owner.dataset["savedLeaf"]).toBe("leaf-1");
    expect(owner.dataset["savedContentLeaf"]).toBe("content-1");
    expect(byId("turn-oldest").textContent).toBe("Saved history");
    expect(swap).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      Object.fromEntries(new URL(callAt(fetch.mock.calls, 1)[0]).searchParams),
    ).toEqual({
      revision: "unavailable stamp",
      leaf: "leaf-1",
      contentLeaf: "content-1",
      through: "oldest",
    });
  });

  it("delivers changed HTML to HTMX and advances the acknowledged revision and leaf", async () => {
    const { fetch, swap, owner } = await page();
    fetch.mockResolvedValueOnce(changed());
    await vi.advanceTimersByTimeAsync(2000);
    expect(swap).toHaveBeenCalledWith({
      sourceElement: owner,
      target: owner,
      text: '<div id="messages" hx-swap-oob="outerHTML">Updated history</div>',
      swap: "none",
    });
    expect(owner.dataset["savedRevision"]).toBe("stamp 2");
    expect(owner.dataset["savedLeaf"]).toBe("leaf 2");
    expect(owner.dataset["savedContentLeaf"]).toBe("content 2");
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      Object.fromEntries(new URL(callAt(fetch.mock.calls, 1)[0]).searchParams),
    ).toEqual({
      revision: "stamp 2",
      leaf: "leaf 2",
      contentLeaf: "content 2",
      through: "oldest",
    });
  });

  it("hands an owned session to ordinary SSE with the loaded window and stops polling", async () => {
    const { fetch, swap, owner } = await page();
    fetch.mockResolvedValueOnce(response("owned"));
    await vi.advanceTimersByTimeAsync(2000);
    const stream = transport(owner);
    expect(stream.getAttribute("hx-sse:connect")).toBe(
      "/sessions/s1/events?saved=1&through=oldest",
    );
    expect(stream.getAttribute("hx-sse:close")).toBe("web-pi:saved");
    expect(stream.hidden).toBe(true);
    expect(owner.hasAttribute("hx-sse:connect")).toBe(false);
    expect(htmx().process).toHaveBeenCalledWith(stream);
    expect(swap).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns to polling after eviction and creates a fresh SSE transport for the new loaded window", async () => {
    const { fetch, owner } = await page();
    fetch.mockResolvedValueOnce(response("owned"));
    await vi.advanceTimersByTimeAsync(2000);
    const first = transport(owner);
    saved(first, {
      revision: "evicted-stamp",
      leaf: "evicted-leaf",
      contentLeaf: "evicted-content",
    });
    await flush();
    expect(first.isConnected).toBe(false);
    expect(owner.dataset["savedRevision"]).toBe("evicted-stamp");
    expect(owner.dataset["savedLeaf"]).toBe("evicted-leaf");
    byId("turn-oldest").insertAdjacentHTML(
      "beforebegin",
      '<div class="turn" id="turn-older">Earlier history</div>',
    );
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(response("owned"));
    await vi.advanceTimersByTimeAsync(1);
    expect(
      Object.fromEntries(new URL(callAt(fetch.mock.calls, 1)[0]).searchParams),
    ).toEqual({
      revision: "evicted-stamp",
      leaf: "evicted-leaf",
      contentLeaf: "evicted-content",
      through: "older",
    });
    const second = transport(owner);
    expect(second).not.toBe(first);
    expect(second.getAttribute("hx-sse:connect")).toBe(
      "/sessions/s1/events?saved=1&through=older",
    );
    expect(htmx().process).toHaveBeenLastCalledWith(second);
    saved(second);
    await flush();
    expect(second.isConnected).toBe(false);
    expect(owner.dataset["savedRevision"]).toBe("evicted-stamp");
    expect(owner.dataset["savedLeaf"]).toBe("evicted-leaf");
    expect(owner.dataset["savedContentLeaf"]).toBe("evicted-content");
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not poll an initially live main until its named saved event", async () => {
    const { fetch, owner } = await page({ owned: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).not.toHaveBeenCalled();
    saved(owner, { revision: "final-stamp", leaf: null, contentLeaf: null });
    await flush();
    expect(owner.isConnected).toBe(true);
    expect(owner.hasAttribute("hx-sse:connect")).toBe(false);
    expect(owner.dataset["savedLeaf"]).toBe("");
    expect(owner.dataset["savedContentLeaf"]).toBe("");
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(
      Object.fromEntries(new URL(callAt(fetch.mock.calls, 0)[0]).searchParams),
    ).toEqual({
      revision: "final-stamp",
      leaf: "",
      contentLeaf: "",
      through: "oldest",
    });
  });

  it.each([
    "prompt",
    "activate",
    "commands",
    "compact",
    "model",
    "model-selector",
    "system-prompt",
    "tools",
  ])(
    "observes a successful local %s immediately without assuming ownership",
    async (action) => {
      const { fetch, owner } = await page();
      htmxEvent(owner, "htmx:finally:request", {
        ctx: {
          sourceElement: owner,
          target: owner,
          request: { action: `/sessions/s1/${action}` },
          response: { raw: new Response(null, { status: 204 }) },
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(htmx().process).not.toHaveBeenCalled();
      expect(owner.hasAttribute("hx-sse:connect")).toBe(false);
      fetch.mockResolvedValueOnce(response("owned"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(htmx().process).toHaveBeenCalledWith(transport(owner));
    },
  );

  it.each([
    { action: "/sessions/s1/prompt", status: 400 },
    { action: "/sessions/s2/prompt", status: 204 },
    { action: "/sessions/s1/rename", status: 204 },
  ])(
    "does not accelerate observation for $action returning $status",
    async ({ action, status }) => {
      const { fetch, owner } = await page();
      htmxEvent(owner, "htmx:finally:request", {
        ctx: {
          sourceElement: owner,
          target: owner,
          request: { action },
          response: { raw: new Response(null, { status }) },
        },
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a hidden page suspended through visibility changes until pageshow", async () => {
    const { fetch, swap, visibility } = await page();
    const pending = deferred();
    fetch.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(2000);
    window.dispatchEvent(new Event("pagehide"));
    expect(callAt(fetch.mock.calls, 0)[1]?.signal?.aborted).toBe(true);
    pending.resolve(changed());
    await flush();
    visibility(true);
    visibility(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(swap).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pageshow"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not resume polling when an older navigation finishes before a newer one", async () => {
    const { fetch } = await page();
    const finishOlder = request(byId("session-region"));
    const finishNewer = request(byId("session-region"));
    finishOlder();
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetch).not.toHaveBeenCalled();
    finishNewer();
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["messages settle", "ownership lost"])(
    "replays deferred pagination once after %s using the current sentinel",
    async (release) => {
      const { fetch, owner } = await page();
      fetch.mockResolvedValueOnce(response("owned"));
      await vi.advanceTimersByTimeAsync(2000);
      const stream = transport(owner);
      const earlier = byId("earlier");
      const action = "/sessions/s1/messages?before=oldest&leaf=leaf-1";
      const ctx = {
        sourceElement: earlier,
        target: earlier,
        request: { action, signal: new AbortController().signal, headers: {} },
      };
      const event = new CustomEvent("htmx:before:request", {
        bubbles: true,
        cancelable: true,
        detail: { ctx },
      });
      earlier.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      htmxEvent(earlier, "htmx:finally:request", { ctx });
      await vi.advanceTimersByTimeAsync(6000);
      expect(htmx().ajax).not.toHaveBeenCalled();
      htmxEvent(owner, "htmx:after:settle");
      expect(htmx().ajax).not.toHaveBeenCalled();

      earlier.outerHTML =
        '<button id="current-earlier" class="load-earlier">Earlier</button>';
      const sentinel = byId("current-earlier");
      if (release === "messages settle")
        htmxEvent(byId("messages"), "htmx:after:settle");
      else saved(stream);
      await flush();
      expect(htmx().ajax).toHaveBeenCalledExactlyOnceWith("GET", action, {
        source: sentinel,
        target: sentinel,
        swap: "outerHTML",
      });
      expect(earlier.isConnected).toBe(false);
      htmxEvent(byId("messages"), "htmx:after:settle");
      if (release === "messages settle") saved(stream);
      await flush();
      expect(htmx().ajax).toHaveBeenCalledTimes(1);
    },
  );

  it("never connects a child transcript to SSE or processes a live runtime", async () => {
    const { fetch, swap, owner } = await page({ child: true });
    fetch.mockResolvedValueOnce(response("owned"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(owner.hasAttribute("hx-sse:connect")).toBe(false);
    expect(htmx().process).not.toHaveBeenCalled();
    expect(swap).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
