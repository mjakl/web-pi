import { Composer } from "@web/views/Composer";
import { describe, expect, it, vi } from "vitest";
import {
  area,
  byId,
  flush,
  htmxEvent,
  keydown,
  mockFetch,
  mount,
  render,
  text,
  type,
} from "./helpers.ts";

function markup(
  draft?: string,
  images: { data: string; mimeType: string }[] = [],
): string {
  return render(
    Composer({
      sessionId: "s1",
      cwd: "/repo",
      ...(draft === undefined ? {} : { draft }),
      images,
    }),
  );
}

function replaceComposer(html: string): HTMLElement {
  const previous = byId("composer");
  htmxEvent(previous, "htmx:before:cleanup");
  previous.outerHTML = html;
  const owner = byId("composer");
  htmxEvent(owner, "htmx:after:process");
  return owner;
}

describe("composer owner lifecycle", () => {
  it("mounts replacement owners once and removes old keyboard handlers", async () => {
    mount(markup());
    const { setUpComposer } = await import("@web/client/composer");
    setUpComposer();
    setUpComposer();
    const old = area();
    type(old, "unsent text");
    const owner = replaceComposer(markup("restored"));
    htmxEvent(owner, "htmx:after:process");
    const submits = vi.fn((event: Event) => {
      event.preventDefault();
    });
    owner.addEventListener("submit", submits);
    keydown(area(), "Enter");
    expect(submits).toHaveBeenCalledOnce();
    expect(keydown(old, "Enter").defaultPrevented).toBe(false);
    vi.advanceTimersByTime(300);
    expect(localStorage.getItem("web-pi:draft:s1")).toBe("restored");
  });

  it("restores image-only history immediately without stale text or duplicate attachments", async () => {
    localStorage.setItem("web-pi:draft:s1", "unrelated local draft");
    const bytes = "historical bytes";
    mount(markup("", [{ data: btoa(bytes), mimeType: "image/png" }]));
    const { setUpComposer } = await import("@web/client/composer");
    setUpComposer();
    const input = byId("image-input") as HTMLInputElement;
    expect(area().value).toBe("");
    expect(input.files).toHaveLength(1);
    expect(await input.files?.[0]?.text()).toBe(bytes);
    htmxEvent(byId("composer"), "htmx:after:process");
    htmxEvent(byId("composer"), "htmx:after:settle");
    htmxEvent(document.body, "htmx:after:settle");
    expect(input.files).toHaveLength(1);
    expect(localStorage.getItem("web-pi:draft:s1")).toBeNull();
  });

  it("does not let a pending clipboard completion clear a replacement draft", async () => {
    mount(`<div id="toasts"></div>${markup()}`);
    mockFetch(() => text("answer"));
    const pending = Promise.withResolvers<undefined>();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockReturnValue(pending.promise);
    const { setUpComposer } = await import("@web/client/composer");
    setUpComposer();
    type(area(), "/copy");
    keydown(area(), "Enter");
    await flush();
    expect(write).toHaveBeenCalledExactlyOnceWith("answer");
    replaceComposer(markup("/copy"));
    pending.resolve(undefined);
    await pending.promise;
    await flush();
    expect(area().value).toBe("/copy");
    expect(localStorage.getItem("web-pi:draft:s1")).toBe("/copy");
    expect(byId("toasts").textContent).toBe("");
  });

  it("cancels autocomplete requests and pending debounce work on disposal", async () => {
    mount(markup());
    const requests: AbortSignal[] = [];
    const fetch = vi.fn((_url: unknown, options?: RequestInit) => {
      if (options?.signal) requests.push(options.signal);
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetch);
    const { setUpComposer } = await import("@web/client/composer");
    setUpComposer();
    type(area(), "@file");
    expect(requests).toHaveLength(1);
    replaceComposer(markup(""));
    expect(requests[0]?.aborted).toBe(true);
    type(area(), "/command");
    replaceComposer(markup(""));
    vi.advanceTimersByTime(300);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("flushes a disposed owner's pending draft before another owner mounts", async () => {
    mount(markup());
    const { setUpComposer } = await import("@web/client/composer");
    setUpComposer();
    type(area(), "last keystroke");
    replaceComposer(markup());
    expect(area().value).toBe("last keystroke");
    type(area(), "new owner's text");
    vi.advanceTimersByTime(300);
    expect(localStorage.getItem("web-pi:draft:s1")).toBe("new owner's text");
  });
});
