import { Composer } from "@web/views/Composer";
import { describe, expect, it, vi } from "vitest";
import {
  area,
  byId,
  field,
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
  sessionId = "s1",
): string {
  return render(
    Composer({
      sessionId,
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

function pick(...files: File[]): void {
  const input = field("#image-input");
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change"));
}

function attachedNames(): string[] {
  return [...(field("#image-input").files ?? [])].map((file) => file.name);
}

describe("composer owner lifecycle", () => {
  it("retains mixed attachments after a rejected submission", async () => {
    mount(markup());
    const { setUpComposer } = await import("@web/client/composer");
    setUpComposer();
    pick(
      new File(["image"], "photo.png", { type: "image/png" }),
      new File(["notes"], "notes.txt", { type: "text/plain" }),
    );
    await flush();
    type(area(), "Read these");
    const ctx = { response: new Response("rejected", { status: 400 }) };
    htmxEvent(byId("composer"), "htmx:before:request", { ctx });
    htmxEvent(byId("composer"), "htmx:before:response", { ctx });
    expect(attachedNames()).toEqual(["photo.png", "notes.txt"]);
    expect(area().value).toBe("Read these");
    expect(
      document
        .querySelector(".composer-action-primary")
        ?.hasAttribute("disabled"),
    ).toBe(false);
  });

  it("keeps attachments per session and clears only accepted files after navigation", async () => {
    mount(markup());
    const { setUpComposer } = await import("@web/client/composer");
    setUpComposer();
    pick(
      new File(["image"], "photo.png", { type: "image/png" }),
      new File(["notes"], "notes.txt", { type: "text/plain" }),
    );
    await flush();
    const ctx = {
      response: new Response("accepted", {
        headers: { "X-Web-Pi-Submission": "accepted" },
      }),
    };
    htmxEvent(byId("composer"), "htmx:before:request", { ctx });
    pick(new File(["later"], "later.csv", { type: "text/csv" }));
    await flush();
    replaceComposer(markup(undefined, [], "s2"));
    expect(attachedNames()).toEqual([]);
    pick(new File(["other"], "other.txt"));
    await flush();
    htmxEvent(document.body, "htmx:before:response", { ctx });
    expect(attachedNames()).toEqual(["other.txt"]);
    replaceComposer(markup());
    expect(attachedNames()).toEqual(["later.csv"]);
  });

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
