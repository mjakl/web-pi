import { Composer } from "@web/views/Composer";
import { describe, expect, it, vi } from "vitest";
import { area, byId, frame, htmxEvent, mount, render } from "./helpers.ts";

function region(id: string): string {
  return `<div id="session-region"><main data-session-id="${id}" data-cwd="/repo">${render(Composer({ sessionId: id, cwd: "/repo" }))}</main></div>`;
}
async function page() {
  mount(
    `<a id="link" data-session-link href="/sessions/s2">Session</a><button id="elsewhere">Other</button>${region("s1")}`,
  );
  const { setUpComposer } = await import("@web/client/composer");
  const { setUpNavigation } = await import("@web/client/navigation");
  setUpComposer();
  setUpNavigation();
}
function request(path = "/sessions/s2", history = false) {
  const ctx = {
    target: byId("session-region"),
    sourceElement: byId("session-region"),
    request: {
      action: path,
      signal: new AbortController().signal,
      headers: history ? { "HX-History-Restore-Request": "true" } : {},
    },
  };
  htmxEvent(ctx.sourceElement, "htmx:before:request", { ctx });
  return ctx;
}
function arrive(id = "s2") {
  const old = byId("session-region");
  htmxEvent(old, "htmx:before:cleanup");
  old.outerHTML = region(id);
  htmxEvent(byId("session-region"), "htmx:after:process");
}

describe("session input autofocus", () => {
  it("focuses after sidebar navigation even while the persistent link has focus", async () => {
    await page();
    frame();
    byId("link").focus();
    byId("link").click();
    request();
    arrive();
    frame();
    expect(document.activeElement).toBe(area());
  });

  it("focuses once on initial load after restoring the draft, without scrolling", async () => {
    history.replaceState(null, "", "/sessions/s1");
    localStorage.setItem("web-pi:draft:s1", "saved draft");
    await page();
    const focus = vi.spyOn(area(), "focus");
    frame();
    expect(document.activeElement).toBe(area());
    expect(area().value).toBe("saved draft");
    expect(area().selectionStart).toBe(11);
    expect(area().selectionEnd).toBe(11);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    byId("elsewhere").focus();
    htmxEvent(byId("composer"), "htmx:after:process");
    htmxEvent(byId("composer"), "htmx:after:settle");
    window.dispatchEvent(new Event("focus"));
    frame();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("focuses after history navigation", async () => {
    await page();
    frame();
    byId("elsewhere").focus();
    request("/sessions/s2", true);
    arrive();
    frame();
    expect(document.activeElement).toBe(area());
  });

  it.each([false, true])(
    "creation's HX-Location preserves cancellation: %s",
    async (interact) => {
      await page();
      frame();
      const ctx = {
        target: byId("elsewhere"),
        sourceElement: byId("composer"),
        request: {
          action: "/sessions",
          signal: new AbortController().signal,
          headers: {},
        },
        response: new Response(null, {
          headers: {
            "HX-Location": JSON.stringify({
              path: "/sessions/s2",
              target: "#session-region",
            }),
          },
        }),
      };
      htmxEvent(ctx.sourceElement, "htmx:before:request", { ctx });
      if (interact) byId("elsewhere").focus();
      htmxEvent(ctx.sourceElement, "htmx:before:response", { ctx });
      request();
      arrive();
      frame();
      expect(document.activeElement === area()).toBe(!interact);
    },
  );

  it.each([
    [640, false, false],
    [641, false, true],
    [1024, true, false],
    [640, true, false],
  ])(
    "width %i, coarse %s: autofocus %s, manual focus unchanged",
    async (width, coarse, allowed) => {
      window.innerWidth = width;
      const media = window.matchMedia.bind(window);
      vi.stubGlobal("matchMedia", (query: string) =>
        query === "(max-width: 640px), (pointer: coarse)"
          ? { matches: width <= 640 || coarse }
          : media(query),
      );
      await page();
      frame();
      expect(document.activeElement === area()).toBe(allowed);
      area().focus();
      expect(document.activeElement).toBe(area());
    },
  );

  it.each(["pointerdown", "keydown", "focus", "focusout", "blur"])(
    "cancels on %s during loading",
    async (interaction) => {
      await page();
      frame();
      request();
      if (interaction === "focus") byId("elsewhere").focus();
      else if (interaction === "blur") window.dispatchEvent(new Event("blur"));
      else
        byId("elsewhere").dispatchEvent(
          new Event(interaction, { bubbles: true }),
        );
      arrive();
      const focus = vi.spyOn(area(), "focus");
      frame();
      expect(focus).not.toHaveBeenCalled();
    },
  );

  it("cancels interaction after mounting but before the focus frame", async () => {
    await page();
    byId("elsewhere").focus();
    const focus = vi.spyOn(area(), "focus");
    frame();
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(["disabled", "readOnly", "hidden", "dialog", "missing"])(
    "skips %s inputs and does not retry",
    async (guard) => {
      await page();
      const input = area();
      const focus = vi.spyOn(input, "focus");
      if (guard === "disabled") input.disabled = true;
      if (guard === "readOnly") input.readOnly = true;
      if (guard === "hidden") input.hidden = true;
      if (guard === "missing") input.remove();
      if (guard === "dialog")
        document.body.insertAdjacentHTML(
          "beforeend",
          "<dialog open>Dialog</dialog>",
        );
      frame();
      expect(focus).not.toHaveBeenCalled();
      input.disabled = false;
      input.readOnly = false;
      input.hidden = false;
      document.querySelector("dialog")?.remove();
      htmxEvent(byId("composer"), "htmx:after:process");
      frame();
      expect(focus).not.toHaveBeenCalled();
    },
  );

  it("does not autofocus a composer replacement without navigation", async () => {
    await page();
    frame();
    arrive("s1");
    const focus = vi.spyOn(area(), "focus");
    frame();
    expect(focus).not.toHaveBeenCalled();
  });

  it("rejects stale requests and focuses only the winning navigation", async () => {
    await page();
    const oldInput = area();
    const oldFocus = vi.spyOn(oldInput, "focus");
    const old = request();
    const winner = request("/sessions/s3");
    const event = new CustomEvent("htmx:before:swap", {
      bubbles: true,
      cancelable: true,
      detail: { ctx: old },
    });
    old.sourceElement.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(old.request.signal.aborted).toBe(true);
    expect(winner.request.signal.aborted).toBe(false);
    arrive("s3");
    frame();
    expect(oldFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(area());
  });

  it("cancels a pending frame when navigating away", async () => {
    await page();
    const focus = vi.spyOn(area(), "focus");
    const ctx = {
      target: byId("elsewhere"),
      sourceElement: byId("elsewhere"),
      request: {
        action: "/sidebar?cwd=/other",
        signal: new AbortController().signal,
        headers: {},
      },
    };
    htmxEvent(ctx.sourceElement, "htmx:before:request", { ctx });
    frame();
    expect(focus).not.toHaveBeenCalled();
  });
});
