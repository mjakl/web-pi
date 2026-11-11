import { expect, it, vi } from "vitest";
import type { HTMLInputElement, HTMLButtonElement } from "happy-dom";
import { htmxBrowser } from "#/web/htmx4-browser";
import { FAKE_MODEL } from "@adapters/fake";
import { parseHtml, required } from "#/web/helpers";
import { testApp } from "#/web/fixtures/test-app";

it("renders Settings without a workspace or modal and keeps its action hosts", async () => {
  const { app } = testApp();
  const doc = parseHtml(
    await (await app.request("/settings?session=s1&section=general")).text(),
  );
  expect(doc.querySelector(".settings-page")).not.toBeNull();
  for (const selector of [
    "dialog",
    "#composer",
    ".chat-transcript",
    "#session-sidebar",
    "[hx-sse\\:connect]",
  ])
    expect(doc.querySelector(selector)).toBeNull();
  expect(doc.querySelector("#dialogs")).not.toBeNull();
  expect(doc.querySelector("#toasts")).not.toBeNull();
});

it("pins session and folder through desktop and mobile navigation despite another tab's cookie", async () => {
  const { app } = testApp();
  const first = parseHtml(
    await (
      await app.request("/settings?session=s1&section=general", {
        headers: { cookie: "web-pi-session=s2" },
      })
    ).text(),
  );
  const link = required(
    first.querySelector('a.settings-section-tab[href*="section=models"]'),
  );
  const url = new URL(link.getAttribute("href") ?? "", "http://localhost");
  expect(url.searchParams.get("session")).toBe("s1");
  expect(url.searchParams.get("cwd")).toBe("/repo/one");
  const next = parseHtml(
    await (
      await app.request(url.pathname + url.search, {
        headers: { cookie: "web-pi-session=s2" },
      })
    ).text(),
  );
  expect(next.querySelector('[name="sessionId"]')?.getAttribute("value")).toBe(
    "s1",
  );
  expect(next.querySelector(".settings-back")?.getAttribute("href")).toBe(
    "/sessions/s1",
  );
  const form = required(next.querySelector("form.settings-mobile-nav"));
  expect(form.getAttribute("method")).toBe("get");
  expect(form.querySelector('[name="session"]')?.getAttribute("value")).toBe(
    "s1",
  );
  expect(form.querySelector('[name="cwd"]')?.getAttribute("value")).toBe(
    "/repo/one",
  );
  expect(form.querySelector("[hx-get]")).toBeNull();
});

it("keeps an explicit empty session and rejects a deleted or invalid origin", async () => {
  const { app } = testApp();
  const doc = parseHtml(
    await (
      await app.request("/settings?session=&cwd=%2Frepo&section=general", {
        headers: { cookie: "web-pi-session=s1" },
      })
    ).text(),
  );
  expect(doc.querySelector(".settings-back")?.getAttribute("href")).toBe(
    "/new?cwd=%2Frepo",
  );
  for (const link of doc.querySelectorAll("a.settings-section-tab"))
    expect(
      new URL(
        link.getAttribute("href") ?? "",
        "http://localhost",
      ).searchParams.get("session"),
    ).toBe("");
  for (const session of ["missing", "../s1"])
    expect(
      (
        await app.request(`/settings?session=${encodeURIComponent(session)}`, {
          headers: { cookie: "web-pi-session=s1" },
        })
      ).status,
    ).toBe(404);
});

it("keeps dirty model choices on a failed real HTMX save and clears them only on success", async () => {
  const { app, world } = testApp({
    models: [FAKE_MODEL, { ...FAKE_MODEL, id: "other", name: "Other" }],
  });
  const b = await htmxBrowser(
    await (await app.request("/settings?session=s1&section=models")).text(),
    (request) => app.request(request),
  );
  const unload = (): unknown =>
    b.window.eval(
      '!window.dispatchEvent(new Event("beforeunload", {cancelable:true}))',
    );
  expect(unload()).toBe(false);
  const checkbox = required(
    b.document.querySelector<HTMLInputElement>('input[name="model"]'),
  );
  checkbox.click();
  expect(unload()).toBe(true);
  const save = vi
    .spyOn(world.models, "saveSettings")
    .mockRejectedValueOnce(new Error("Cannot write settings"));
  required(
    b.document.querySelector<HTMLButtonElement>("[data-model-save]"),
  ).click();
  await expect
    .poll(() => b.document.querySelector("#toasts")?.textContent)
    .toContain("Cannot write settings");
  expect(checkbox.isConnected).toBe(true);
  expect(checkbox.checked).toBe(false);
  expect(unload()).toBe(true);
  await expect.poll(() => checkbox.disabled).toBe(false);
  const refresh = required(
    b.document.querySelector<HTMLButtonElement>("[data-model-refresh]"),
  );
  expect(refresh.disabled).toBe(true);
  const refreshCatalogs = vi.spyOn(world.models, "refresh");
  refresh.click();
  expect(refreshCatalogs).not.toHaveBeenCalled();
  expect(checkbox.isConnected).toBe(true);
  expect(checkbox.checked).toBe(false);
  save.mockRestore();
  required(
    b.document.querySelector<HTMLButtonElement>("[data-model-save]"),
  ).click();
  await expect
    .poll(() => b.document.querySelector("[data-model-status]")?.textContent)
    .toBe("Selection saved.");
  expect(unload()).toBe(false);
  expect(
    b.document.querySelector('[name="sessionId"]')?.getAttribute("value"),
  ).toBe("s1");
});

it("guards fragment navigation from an unsubmitted plugin source without blocking its save", async () => {
  const { app, world } = testApp({ trustRequired: ["/repo/one"] });
  const b = await htmxBrowser(
    await (await app.request("/settings?session=s1&section=plugins")).text(),
    (request) => app.request(request),
  );
  await b.window.eval(
    "htmx.ajax('GET', '/settings/plugins?cwd=%2Frepo%2Fone&add=1', {source:'#settings-body', target:'#settings-body'})",
  );
  const source = required(
    b.document.querySelector<HTMLInputElement>("#plugin-source"),
  );
  source.value = "npm:pending-plugin";
  const confirm = vi.fn(() => false);
  Object.assign(b.window, { confirm });
  await b.window.eval(
    "htmx.ajax('GET', '/settings/plugins?cwd=%2Frepo%2Fone', {source:'#plugin-source', target:'#settings-body'})",
  );
  expect(confirm).toHaveBeenCalledOnce();
  expect(source.isConnected).toBe(true);
  const save = vi
    .spyOn(world.packages, "run")
    .mockRejectedValueOnce(new Error("Install failed"));
  source.form?.requestSubmit();
  await expect
    .poll(() => b.document.querySelector("#toasts")?.textContent)
    .toContain("Install failed");
  expect(source.isConnected).toBe(true);
  expect(source.value).toBe("npm:pending-plugin");
  expect(confirm).toHaveBeenCalledOnce();
  await expect.poll(() => source.disabled).toBe(false);
  expect(
    b.document.querySelector<HTMLInputElement>(
      '[name="scope"][value="project"]',
    )?.disabled,
  ).toBe(true);
  save.mockRestore();
  source.form?.requestSubmit();
  await expect.poll(() => source.isConnected).toBe(false);
  expect(
    b.window.eval(
      '!window.dispatchEvent(new Event("beforeunload", {cancelable:true}))',
    ),
  ).toBe(false);
  expect(confirm).toHaveBeenCalledOnce();
});
