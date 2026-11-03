import { describe, expect, it } from "vitest";
import { htmxEvent, mount } from "./helpers.ts";

// What every htmx request tells the server about the page it came from.

describe("request context", () => {
  it.each([
    ["attachments[]", "bytes"],
    ["attachments[]", ""],
    ["images[]", "bytes"],
    ["images[]", ""],
  ])(
    "does not treat /clone with a named file in %s (%j) as navigation",
    async (field, contents) => {
      mount(
        '<div id="session-region"><main data-session-id="s1" data-cwd="/repo"><form id="composer"></form></main></div>',
      );
      const { setUpNavigation } = await import("@web/client/navigation");
      setUpNavigation();
      const target = document.getElementById("session-region");
      const sourceElement = document.getElementById("composer");
      const opening = {
        target,
        sourceElement,
        request: {
          action: "/sessions/s2",
          signal: new AbortController().signal,
          headers: {},
        },
      };
      htmxEvent(document.body, "htmx:before:request", { ctx: opening });
      const body = new FormData();
      body.set("text", "/clone");
      body.append(
        field,
        new File([contents], "file.txt", { type: "text/plain" }),
      );
      const sending = {
        target: sourceElement,
        sourceElement,
        request: {
          action: "/sessions/s1/prompt",
          signal: new AbortController().signal,
          headers: {},
          body,
        },
      };
      htmxEvent(document.body, "htmx:before:request", { ctx: sending });
      expect(opening.request.signal.aborted).toBe(false);
    },
  );

  it("names the session on screen, or none, whatever the URL says", async () => {
    mount('<main data-session-id="s2" data-cwd="/repo"></main>');
    const { setUpNavigation } = await import("@web/client/navigation");
    setUpNavigation();
    const headers: Record<string, string> = {};
    htmxEvent(document.body, "htmx:config:request", {
      ctx: { request: { action: "/sidebar/rows?after=50", headers } },
    });
    expect(headers["X-Web-Pi-Session"]).toBe("s2");
    document.querySelector("main")?.setAttribute("data-session-id", "");
    htmxEvent(document.body, "htmx:config:request", {
      ctx: { request: { action: "/sidebar/rows?after=50", headers } },
    });
    expect(headers["X-Web-Pi-Session"]).toBe("");
  });

  it("sends the folder on screen as ASCII, whatever it is called", async () => {
    const cwd = "/home/me/Проекты/日本 zażółć 🦉";
    mount(`<main data-session-id="" data-cwd="${cwd}"></main>`);
    const { setUpNavigation } = await import("@web/client/navigation");
    setUpNavigation();
    const headers: Record<string, string> = {};
    htmxEvent(document.body, "htmx:config:request", {
      ctx: { request: { action: "/sidebar/projects", headers } },
    });
    // A browser refuses a header value with characters above U+00FF.
    expect(headers["X-Web-Pi-Cwd"]).toMatch(/^[\x20-\x7e]*$/);
    expect(decodeURIComponent(headers["X-Web-Pi-Cwd"] ?? "")).toBe(cwd);
  });
});
