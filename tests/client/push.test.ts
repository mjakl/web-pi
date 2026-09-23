import { SettingsBody } from "@web/views/Settings";
import { describe, expect, it, vi } from "vitest";
import {
  byId,
  click,
  json,
  mockFetch,
  mount,
  serviceWorker,
  text,
} from "./helpers.ts";

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

class FakeNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn();
}

function registration() {
  const subscription = {
    options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
    toJSON: () => ({
      endpoint: "https://push/x",
      keys: { p256dh: "p", auth: "a" },
    }),
    unsubscribe: vi.fn(() => Promise.resolve(true)),
  };
  return {
    active: { state: "activated" },
    pushManager: {
      getSubscription: vi.fn(() =>
        Promise.resolve<null | typeof subscription>(null),
      ),
      subscribe: vi.fn((_options: PushSubscriptionOptionsInit) =>
        Promise.resolve(subscription),
      ),
    },
    subscription,
  };
}

async function load(
  reg = registration(),
  permission: NotificationPermission = "default",
  enrolled = false,
  registrationError?: Error,
) {
  FakeNotification.permission = permission;
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("isSecureContext", true);
  const worker = serviceWorker(reg);
  if (registrationError) worker.register.mockRejectedValue(registrationError);
  else worker.register.mockResolvedValue(reg);
  const fetch = mockFetch((url) =>
    url === "/push/config"
      ? json({ publicKey: "AQID" })
      : url === "/push/status"
        ? json({ subscribed: enrolled })
        : json({ ok: true }),
  );
  mount(SettingsBody({ section: "general", cwd: "/repo" }));
  document.body.dataset["swSrc"] = "/sw.js";
  const { setUpPush } = await import("@web/client/push");
  setUpPush();
  await flush();
  return { reg, worker, fetch };
}

function status() {
  return byId("push-status").textContent;
}
function toggle() {
  return byId("push-toggle") as HTMLButtonElement;
}

describe("manual browser push enrollment", () => {
  it("prepares the worker and key without subscribing or prompting, even with permission", async () => {
    const { reg, worker, fetch } = await load(undefined, "granted");
    expect(worker.register).toHaveBeenCalledWith("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    expect(fetch).toHaveBeenCalledWith("/push/config", expect.anything());
    expect(status()).toBe("Not subscribed on this browser.");
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("calls subscribe within the click and reports success only after server enrollment", async () => {
    const { reg } = await load();
    const saved = Promise.withResolvers<Response>();
    const fetch = vi.fn(() => saved.promise);
    vi.stubGlobal("fetch", fetch);
    click(toggle());
    expect(reg.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]).buffer,
    });
    expect(toggle().disabled).toBe(true);
    await flush();
    expect(status()).toBe("Subscribing…");
    saved.resolve(json({ ok: true }));
    await flush();
    expect(status()).toBe("Subscribed on this browser.");
    expect(fetch).toHaveBeenCalledWith(
      "/push/subscribe",
      expect.objectContaining({
        body: JSON.stringify({
          subscription: reg.subscription.toJSON(),
          publicKey: "AQID",
        }),
      }),
    );
  });

  it("waits for an in-flight enrollment when General is reopened", async () => {
    const { reg } = await load();
    const saved = Promise.withResolvers<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === "/push/subscribe"
          ? saved.promise
          : Promise.resolve(
              url === "/push/config"
                ? json({ publicKey: "AQID" })
                : json({ subscribed: true }),
            ),
      ),
    );
    click(toggle());
    await flush();
    reg.pushManager.getSubscription.mockResolvedValue(reg.subscription);
    mount(SettingsBody({ section: "general", cwd: "/repo" }));
    document.body.dispatchEvent(
      new Event("htmx:after:process", { bubbles: true }),
    );
    await flush();
    expect(toggle().disabled).toBe(true);
    saved.resolve(json({ ok: true }));
    await flush();
    expect(status()).toBe("Subscribed on this browser.");
    expect(toggle().disabled).toBe(false);
    expect(reg.pushManager.subscribe).toHaveBeenCalledOnce();
  });

  it("does not mistake browser subscription or permission for server registration", async () => {
    const reg = registration();
    reg.pushManager.getSubscription.mockResolvedValue(reg.subscription);
    const { fetch } = await load(reg, "granted", false);
    expect(status()).toBe("Not subscribed on this browser.");
    expect(fetch).toHaveBeenCalledWith("/push/status", expect.anything());
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("requires explicit cleanup of a stale server identity before a fresh subscribe gesture", async () => {
    const reg = registration();
    reg.subscription.options.applicationServerKey = new Uint8Array([
      4, 5, 6,
    ]).buffer;
    reg.pushManager.getSubscription.mockResolvedValue(reg.subscription);
    await load(reg, "granted");
    expect(status()).toContain("Server identity changed");
    expect(toggle().textContent).toBe("Unsubscribe");
    click(toggle());
    await flush();
    expect(reg.subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    expect(toggle().textContent).toBe("Subscribe");
    click(toggle());
    expect(reg.pushManager.subscribe).toHaveBeenCalledOnce();
    await flush();
  });

  it("unsubscribes only this browser and never silently re-subscribes", async () => {
    const reg = registration();
    reg.pushManager.getSubscription.mockResolvedValue(reg.subscription);
    const { fetch } = await load(reg, "granted", true);
    expect(status()).toBe("Subscribed on this browser.");
    click(toggle());
    await flush();
    expect(fetch).toHaveBeenCalledWith(
      "/push/unsubscribe",
      expect.objectContaining({
        body: JSON.stringify({ subscription: reg.subscription.toJSON() }),
      }),
    );
    expect(reg.subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(status()).toBe("Not subscribed on this browser.");
    window.dispatchEvent(new Event("focus"));
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("identifies rejected server registration without exposing the response body", async () => {
    await load();
    const fetch = mockFetch(() => text("private response", 409));
    click(toggle());
    await flush();
    expect(fetch).toHaveBeenCalledWith("/push/subscribe", expect.anything());
    expect(status()).toBe(
      "Browser subscription obtained, but server registration was not confirmed (HTTP 409). Try Subscribe again, or reload to check enrollment.",
    );
    expect(toggle().disabled).toBe(false);
    expect(toggle().textContent).toBe("Subscribe");
  });

  it.each([false, true])(
    "identifies browser enrollment failure without a POST (synchronous: %s)",
    async (synchronous) => {
      const { reg, fetch } = await load(undefined, "granted");
      const error = new DOMException("private browser details", "AbortError");
      reg.pushManager.subscribe.mockImplementation(() => {
        if (synchronous) throw error;
        return Promise.reject(error);
      });
      fetch.mockClear();
      click(toggle());
      await flush();
      expect(fetch).not.toHaveBeenCalled();
      expect(status()).toBe(
        "Browser push subscription failed (AbortError). Nothing was sent to the server. Try Subscribe again.",
      );
      expect(toggle().disabled).toBe(false);
    },
  );

  it("keeps transport failure distinct from browser enrollment and hides exception details", async () => {
    await load();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("secret endpoint")),
    );
    click(toggle());
    await flush();
    expect(status()).toBe(
      "Browser subscription obtained, but server registration was not confirmed (TypeError). Try Subscribe again, or reload to check enrollment.",
    );
    expect(toggle().disabled).toBe(false);
  });

  it("does not display arbitrary browser exception names or messages", async () => {
    const { reg } = await load();
    reg.pushManager.subscribe.mockRejectedValue(
      Object.assign(new Error("secret message"), { name: "secret name" }),
    );
    click(toggle());
    await flush();
    expect(status()).toBe(
      "Browser push subscription failed. Nothing was sent to the server. Try Subscribe again.",
    );
  });

  it("keeps unsubscribe available if browser cleanup fails", async () => {
    const reg = registration();
    reg.pushManager.getSubscription.mockResolvedValue(reg.subscription);
    reg.subscription.unsubscribe.mockRejectedValue(new Error("failed"));
    await load(reg, "granted", true);
    click(toggle());
    await flush();
    expect(status()).toContain("Could not finish unsubscribing");
    expect(toggle().textContent).toBe("Unsubscribe");
  });

  it("disables blocked permission with recovery instructions", async () => {
    const { reg } = await load(undefined, "denied");
    expect(status()).toContain("Blocked:");
    expect(toggle().disabled).toBe(true);
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it.each(["Notification", "PushManager", "isSecureContext"])(
    "explains unavailable %s",
    async (feature) => {
      await load();
      if (feature === "isSecureContext") vi.stubGlobal(feature, false);
      else Reflect.deleteProperty(window, feature);
      const old = byId("push-settings");
      const replacement = old.cloneNode(true);
      old.replaceWith(replacement);
      document.body.dispatchEvent(
        new Event("htmx:after:process", { bubbles: true }),
      );
      await flush();
      expect(status()).toContain("Unavailable");
      expect(toggle().disabled).toBe(true);
    },
  );

  it("reports registration rejection without waiting on serviceWorker.ready", async () => {
    await load(undefined, "default", false, new Error("Registration failed"));
    expect(status()).toContain("reload");
    expect(toggle().disabled).toBe(true);
  });

  it("detects a missing registration push manager", async () => {
    const reg = registration();
    Reflect.deleteProperty(reg, "pushManager");
    await load(reg);
    expect(status()).toContain("no push support");
    expect(toggle().disabled).toBe(true);
  });

  it("waits for activation before enabling Subscribe", async () => {
    const reg = registration();
    const active = Object.assign(new EventTarget(), { state: "activating" });
    reg.active = active;
    await load(reg);
    expect(toggle().disabled).toBe(true);
    active.state = "activated";
    active.dispatchEvent(new Event("statechange"));
    await flush();
    expect(toggle().disabled).toBe(false);
  });

  it("ends failed activation with a reload instruction instead of waiting forever", async () => {
    const reg = registration();
    reg.active = Object.assign(new EventTarget(), { state: "activating" });
    await load(reg);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(status()).toContain("reload");
    expect(toggle().disabled).toBe(true);
  });
});
