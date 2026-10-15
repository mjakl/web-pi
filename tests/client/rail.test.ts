import { describe, expect, it, vi } from "vitest";
import {
  byId,
  frame,
  htmx,
  htmxEvent,
  mount,
  query,
  setGeometry,
  setRect,
} from "./helpers.ts";

// The conversation rail: which mark is lit for the reading line, click or
// drag to jump, the hover preview, and the branch graph's expansion. The
// positions come from `getBoundingClientRect`, which the tests set by hand.

const TARGET = 0.3;

async function load(
  options: { branched?: boolean; loaded?: string[]; strip?: number } = {},
) {
  const entries = (options.loaded ?? ["a", "b"])
    .map((id) => `<div id="entry-${id}"></div>`)
    .join("");
  mount(
    `<div class="chat-window"><div id="log"><div id="content">${entries}</div>
      <div class="chat-load-earlier" hx-get="/sessions/s1/earlier?before=x"></div></div>
      <div id="rail-column"><div id="rail" data-branched="${String(options.branched === true)}" data-strip-width="${String(options.strip ?? 36)}" data-graph-width="120">
        <div class="minimap-row" data-minimap-entry-id="a" data-preview="Hello there"></div>
        <div class="minimap-row" data-minimap-entry-id="b" data-preview="Second"></div>
        <div class="minimap-row" data-minimap-entry-id="c" data-preview=""></div>
        <div class="minimap-branch" data-branch data-preview="On a branch"></div>
      </div></div></div>`,
  );
  const view = byId("log");
  setGeometry(view, { scrollHeight: 4000, clientHeight: 500 });
  setRect(view, { top: 0, height: 500 });
  setRect(byId("rail-column"), { left: 0, width: 36 });
  for (const [index, id] of ["a", "b", "c"].entries()) {
    setRect(query(`[data-minimap-entry-id="${id}"]`), {
      top: 10 + index * 20,
      height: 10,
    });
  }
  const { setUpRail } = await import("@web/client/rail");
  setUpRail();
  return view;
}

function pointer(name: string, init: PointerEventInit = {}): PointerEvent {
  const event = new PointerEvent(name, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: 5,
    pointerId: 1,
    ...init,
  });
  byId("rail-column").dispatchEvent(event);
  return event;
}

function row(id: string): HTMLElement {
  return query(`[data-minimap-entry-id="${id}"]`);
}

describe("tracking the reading line", () => {
  it("lights the mark whose entry is nearest the reading line", async () => {
    const view = await load();
    setRect(byId("entry-a"), { top: 100 });
    setRect(byId("entry-b"), { top: 900 });
    frame();
    expect(row("a").classList.contains("is-active")).toBe(true);
    // Scrolled 700px down the rects move up by as much; the line sits at 850.
    view.scrollTop = 700;
    setRect(byId("entry-a"), { top: -600 });
    setRect(byId("entry-b"), { top: 200 });
    view.dispatchEvent(new Event("scroll"));
    frame();
    expect(row("a").classList.contains("is-active")).toBe(false);
    expect(row("b").classList.contains("is-active")).toBe(true);
  });
});

describe("jumping", () => {
  it("scrolls the pressed mark's entry to the reading line and drags on", async () => {
    const view = await load();
    setRect(byId("entry-a"), { top: 100 });
    setRect(byId("entry-b"), { top: 900 });
    const scrollTo = vi.spyOn(view, "scrollTo").mockImplementation(() => {});
    pointer("pointerdown", { clientY: 33 });
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: 900 - 500 * TARGET,
      behavior: "smooth",
    });
    expect(row("b").classList.contains("is-active")).toBe(true);
    pointer("pointermove", { clientY: 14 });
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: 100 - 500 * TARGET,
      behavior: "auto",
    });
    pointer("pointerup");
    pointer("pointermove", { clientY: 33 });
    expect(scrollTo).toHaveBeenCalledTimes(2);
    // The clicked mark stays lit while the scroll settles.
    frame();
    expect(row("a").classList.contains("is-active")).toBe(true);
    vi.advanceTimersByTime(1600);
    view.dispatchEvent(new Event("scroll"));
    frame();
    expect(row("a").classList.contains("is-active")).toBe(true);
  });

  it("ignores other buttons and presses on a branch mark", async () => {
    const view = await load();
    const scrollTo = vi.spyOn(view, "scrollTo").mockImplementation(() => {});
    pointer("pointerdown", { clientY: 14, button: 2 });
    const press = new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientY: 14,
    });
    query("[data-branch]").dispatchEvent(press);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("loads an entry that is not on the page through the sentinel", async () => {
    const view = await load({ loaded: ["a"] });
    const scrollTo = vi.spyOn(view, "scrollTo").mockImplementation(() => {});
    let settle: () => void = () => {};
    htmx().ajax.mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    pointer("pointerdown", { clientY: 33 });
    expect(htmx().ajax).toHaveBeenCalledWith(
      "GET",
      "/sessions/s1/earlier?before=x&through=b",
      { target: query(".chat-load-earlier"), swap: "outerHTML" },
    );
    expect(scrollTo).not.toHaveBeenCalled();
    byId("content").insertAdjacentHTML(
      "afterbegin",
      '<div id="entry-b"></div>',
    );
    setRect(byId("entry-b"), { top: 50 });
    settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(scrollTo).toHaveBeenCalledWith({
      top: 50 - 500 * TARGET,
      behavior: "auto",
    });
  });
});

describe("the hover preview", () => {
  it("shows the mark's prompt after a pause and hides it on leave", async () => {
    await load();
    pointer("pointermove", { clientY: 14 });
    expect(row("a").classList.contains("is-near")).toBe(true);
    const popover = query(".message-preview-popover");
    expect(popover.hidden).toBe(true);
    vi.advanceTimersByTime(180);
    expect(popover.hidden).toBe(false);
    expect(popover.textContent).toBe("Hello there");
    pointer("pointermove", { clientY: 33 });
    expect(row("a").classList.contains("is-near")).toBe(false);
    expect(popover.hidden).toBe(true);
    vi.advanceTimersByTime(180);
    expect(popover.textContent).toBe("Second");
    pointer("pointerleave");
    expect(popover.hidden).toBe(true);
    expect(row("b").classList.contains("is-near")).toBe(false);
  });

  it("previews a branch mark from the mark itself and skips marks without text", async () => {
    await load({ branched: true });
    const move = new PointerEvent("pointermove", {
      bubbles: true,
      clientX: 80,
      clientY: 14,
    });
    query("[data-branch]").dispatchEvent(move);
    vi.advanceTimersByTime(180);
    expect(query(".message-preview-popover").textContent).toBe("On a branch");
    pointer("pointermove", { clientY: 55 });
    vi.advanceTimersByTime(180);
    expect(query(".message-preview-popover").hidden).toBe(true);
    // Past the strip, in the graph, nothing is near.
    pointer("pointermove", { clientX: 80, clientY: 14 });
    expect(document.querySelector(".is-near")).toBeNull();
  });

  it("hides on any scroll", async () => {
    await load();
    pointer("pointermove", { clientY: 14 });
    vi.advanceTimersByTime(180);
    byId("log").dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(query(".message-preview-popover").hidden).toBe(true);
  });
});

describe("the branch graph", () => {
  it("widens the rail on hover and focus, and narrows it again", async () => {
    await load({ branched: true });
    const rail = byId("rail-column");
    expect(rail.classList.contains("has-branches")).toBe(true);
    expect(rail.classList.contains("is-expanded")).toBe(false);
    expect(rail.tabIndex).toBe(0);
    pointer("pointerenter");
    expect(rail.classList.contains("is-expanded")).toBe(true);
    expect(
      query(".chat-window").style.getPropertyValue(
        "--expanded-conversation-rail-width",
      ),
    ).toBe("120px");
    pointer("pointerleave");
    expect(rail.classList.contains("is-expanded")).toBe(false);
    rail.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(rail.classList.contains("is-expanded")).toBe(true);
    rail.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
    );
    expect(rail.classList.contains("is-expanded")).toBe(false);
  });

  it("takes the strip's width from the server", async () => {
    await load({ branched: true, strip: 90 });
    pointer("pointermove", { clientX: 80, clientY: 14 });
    expect(row("a").classList.contains("is-near")).toBe(true);
    pointer("pointermove", { clientX: 100, clientY: 14 });
    expect(document.querySelector(".is-near")).toBeNull();
  });

  it("leaves an unbranched rail at its strip width", async () => {
    await load();
    pointer("pointerenter");
    expect(byId("rail-column").classList.contains("is-expanded")).toBe(false);
    expect(byId("rail-column").style.width).toBe("");
  });
});

describe("rail owner replacement", () => {
  it("rebinds the persistent rail when only its scroller is replaced", async () => {
    const oldView = await load();
    const oldScroll = vi.spyOn(oldView, "scrollTo");
    const rail = byId("rail-column");
    const markup = oldView.outerHTML;
    oldView.outerHTML = markup;
    const view = byId("log");
    const scroll = vi.spyOn(view, "scrollTo");
    setGeometry(view, { clientHeight: 500, scrollHeight: 4000 });
    setRect(view, { top: 0, height: 500 });
    setRect(byId("entry-a"), { top: 600 });
    htmxEvent(view, "htmx:after:process");
    pointer("pointerdown", { clientY: 15 });
    expect(byId("rail-column")).toBe(rail);
    expect(scroll).toHaveBeenCalledWith({
      top: 450,
      behavior: "smooth",
    });
    expect(oldScroll).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".message-preview-popover")).toHaveLength(
      1,
    );
  });

  it("removes the old preview and cancels its pending hover when the body changes", async () => {
    await load();
    pointer("pointermove", { clientY: 15 });
    const oldRail = byId("rail-column");
    const oldPopup = query(".message-preview-popover");
    const markup = query(".chat-window").outerHTML;
    mount(markup);
    htmxEvent(document.body, "htmx:after:process");
    expect(oldPopup.isConnected).toBe(false);
    expect(document.querySelectorAll(".message-preview-popover")).toHaveLength(
      1,
    );
    vi.advanceTimersByTime(200);
    expect(oldPopup.hidden).toBe(true);
    expect(query(".message-preview-popover").hidden).toBe(true);
    oldRail.dispatchEvent(new PointerEvent("pointerenter"));
    htmxEvent(byId("rail"), "htmx:after:process");
    expect(document.querySelectorAll(".message-preview-popover")).toHaveLength(
      1,
    );
    setRect(row("a"), { top: 10, height: 10 });
    pointer("pointermove", { clientY: 15 });
    vi.advanceTimersByTime(200);
    expect(query(".message-preview-popover").hidden).toBe(false);
  });
});
