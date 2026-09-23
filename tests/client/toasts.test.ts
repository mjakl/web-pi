import { describe, expect, it, vi } from "vitest";
import { byId, click, htmxEvent, mount, query } from "./helpers.ts";

// The notice shelf: at most five cards, five seconds each, paused under the
// pointer, whether a card came from the stream or from a client failure.

async function load() {
  mount('<div id="toasts"></div>');
  const toasts = await import("@web/client/toasts");
  toasts.setUpToasts();
  return toasts;
}

function cards(): HTMLElement[] {
  return [
    ...byId("toasts").querySelectorAll<HTMLElement>(".notice-shelf-item"),
  ];
}

describe("toasts", () => {
  it("shows a card with the level's role and colour, and drops it after five seconds", async () => {
    const { showToast } = await load();
    showToast("Saved.", "info");
    showToast("Careful.", "warning");
    showToast("Broken.");
    expect(cards().map((card) => card.getAttribute("role"))).toEqual([
      "status",
      "status",
      "alert",
    ]);
    expect(cards().map((card) => card.className)).toEqual([
      "notice-shelf-item is-info",
      "notice-shelf-item is-warning",
      "notice-shelf-item is-error",
    ]);
    expect(cards()[0]?.firstElementChild?.className).toBe("notice-shelf-dot");
    expect(cards()[2]?.textContent).toBe("Broken.");
    vi.advanceTimersByTime(4_999);
    expect(cards()).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(cards()).toHaveLength(0);
  });

  it("keeps the newest five", async () => {
    const { showToast } = await load();
    for (let index = 0; index < 7; index += 1)
      showToast(`n${String(index)}`, "info");
    expect(cards().map((card) => card.textContent)).toEqual([
      "n2",
      "n3",
      "n4",
      "n5",
      "n6",
    ]);
  });

  it("waits while the pointer rests on a card, and goes on a click", async () => {
    const { showToast } = await load();
    showToast("Read me.", "info");
    const card = query(".notice-shelf-item");
    vi.advanceTimersByTime(4_000);
    card.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(10_000);
    expect(cards()).toHaveLength(1);
    card.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(4_999);
    expect(cards()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(cards()).toHaveLength(0);
    showToast("Dismiss me.", "info");
    click(query(".notice-shelf-item"));
    expect(cards()).toHaveLength(0);
  });

  it("turns an HX-Trigger event into a card and ignores malformed ones", async () => {
    await load();
    const trigger = (detail: unknown) => {
      document.body.dispatchEvent(new CustomEvent("web-pi:toast", { detail }));
    };
    trigger({ message: "Upload failed.", level: "warning" });
    trigger({ message: "Plain." });
    trigger({ message: 42 });
    trigger("nope");
    expect(cards().map((card) => card.getAttribute("role"))).toEqual([
      "status",
      "alert",
    ]);
  });

  it("gives server-rendered cards the same clock and cap", async () => {
    await load();
    const list = byId("toasts");
    list.innerHTML = Array.from(
      { length: 6 },
      (_, index) => `<div class="notice-shelf-item">s${String(index)}</div>`,
    ).join("");
    htmxEvent(list, "htmx:after:settle");
    expect(cards().map((card) => card.textContent)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
    ]);
    vi.advanceTimersByTime(2_500);
    htmxEvent(list, "htmx:after:settle");
    vi.advanceTimersByTime(2_499);
    expect(cards()).toHaveLength(5);
    vi.advanceTimersByTime(1);
    expect(cards()).toHaveLength(0);
  });
});
