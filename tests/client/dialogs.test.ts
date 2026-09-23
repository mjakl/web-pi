import { describe, expect, it, vi } from "vitest";
import { byId, click, flush, htmxEvent, mount } from "./helpers.ts";

// Server-rendered `<dialog open>` fragments become real modals, and leave
// the page - or go back where they came from - when closed.

async function load(html: string) {
  mount(html);
  const dialogs = await import("@web/client/dialogs");
  dialogs.setUpDialogs();
  return dialogs;
}

function dialog(id: string): HTMLDialogElement {
  const element = byId(id);
  if (!(element instanceof HTMLDialogElement)) throw new Error("no dialog");
  return element;
}

describe("dialogs", () => {
  it("upgrades an open dialog to a modal once and removes it on close", async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const { dialogOpen, upgradeDialogs } = await load(
      '<dialog id="d" data-modal open><p>hi</p></dialog>',
    );
    upgradeDialogs();
    await flush();
    expect(showModal).toHaveBeenCalledOnce();
    expect(dialog("d").open).toBe(true);
    expect(dialogOpen()).toBe(true);
    dialog("d").close();
    await flush();
    expect(document.getElementById("d")).toBeNull();
    expect(dialogOpen()).toBe(false);
  });

  it("goes back to the page a full-page dialog names", async () => {
    await load(
      '<dialog id="d" data-modal data-close-href="/sessions/s1" open></dialog>',
    );
    dialog("d").close();
    await flush();
    expect(location.pathname).toBe("/sessions/s1");
  });

  it("closes on a backdrop click only when asked to", async () => {
    await load(
      '<dialog id="a" data-modal data-backdrop-close open><div id="panel">x</div></dialog>' +
        '<dialog id="b" data-modal open></dialog>',
    );
    click(byId("panel"));
    expect(dialog("a").open).toBe(true);
    click(dialog("b"));
    expect(dialog("b").open).toBe(true);
    click(dialog("a"));
    await flush();
    expect(document.getElementById("a")).toBeNull();
    expect(document.getElementById("b")).not.toBeNull();
  });

  it("upgrades dialogs that arrive by swap, whether the target is one or holds one", async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    await load('<div id="dialogs"></div>');
    byId("dialogs").innerHTML = '<dialog id="d" data-modal open></dialog>';
    htmxEvent(byId("dialogs"), "htmx:after:settle");
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialog("d").open).toBe(true);
    dialog("d").close();
    await flush();
    expect(document.getElementById("d")).toBeNull();
    byId("dialogs").innerHTML = '<dialog id="e" data-modal open></dialog>';
    htmxEvent(byId("e"), "htmx:after:settle");
    expect(showModal).toHaveBeenCalledTimes(2);
    expect(dialog("e").open).toBe(true);
    dialog("e").close();
    await flush();
    expect(document.getElementById("e")).toBeNull();
  });
});
