import { describe, expect, it, vi } from "vitest";
import { byId, FakeAudioContext, htmxEvent, mount } from "./helpers.ts";

async function load(html = ""): Promise<void> {
  mount(
    `<main data-session-id="s1"><div id="toasts"></div><div id="session-stream"></div><div id="extension-dialog"></div><div id="sidebar-stream"></div>${html}</main>`,
  );
  const { setUpNotifications } = await import("@web/client/notify");
  setUpNotifications();
}

function done(): void {
  htmxEvent(byId("session-stream"), "done", { data: "s1" });
}

describe("completion feedback", () => {
  it("plays two notes when the run on screen finishes", async () => {
    await load();
    document.dispatchEvent(new Event("pointerdown"));
    done();
    expect(FakeAudioContext.played).toBe(2);
  });

  it("stays quiet when the shared preference is off", async () => {
    document.documentElement.dataset["sound"] = "false";
    await load();
    document.dispatchEvent(new Event("keydown"));
    done();
    expect(FakeAudioContext.played).toBe(0);
  });

  it("plays for another session's completion, not twice for this one", async () => {
    await load();
    const completed = (id: string) =>
      htmxEvent(byId("sidebar-stream"), "completed", {
        data: JSON.stringify({ id }),
      });
    completed("s1");
    expect(FakeAudioContext.played).toBe(0);
    completed("s2");
    expect(FakeAudioContext.played).toBe(2);
    htmxEvent(byId("sidebar-stream"), "completed", { data: "not json" });
    expect(FakeAudioContext.played).toBe(2);
  });

  it("stays quiet for another session's turn that only finished", async () => {
    await load();
    // A shell command, a failed prompt or an abort: the dot, not the tone.
    htmxEvent(byId("sidebar-stream"), "finished", {
      data: JSON.stringify({ id: "s2" }),
    });
    expect(FakeAudioContext.played).toBe(0);
  });

  it.each(["default", "granted", "denied"])(
    "never prompts or duplicates push notifications with permission %s",
    async (permission) => {
      const requestPermission = vi.fn();
      const notification = vi.fn();
      Object.assign(notification, { permission, requestPermission });
      vi.stubGlobal("Notification", notification);
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      await load();
      done();
      expect(byId("toasts").childElementCount).toBe(0);
      expect(requestPermission).not.toHaveBeenCalled();
      expect(notification).not.toHaveBeenCalled();
      expect(localStorage.getItem("web-pi:notify-asked")).toBeNull();
    },
  );

  it("still plays for an extension input request", async () => {
    await load();
    byId("extension-dialog").innerHTML =
      "<dialog><h3>Pick a branch</h3></dialog>";
    htmxEvent(byId("extension-dialog"), "htmx:after:settle");
    expect(FakeAudioContext.played).toBe(2);
    byId("extension-dialog").innerHTML = "";
    htmxEvent(byId("extension-dialog"), "htmx:after:settle");
    expect(FakeAudioContext.played).toBe(2);
  });
});
