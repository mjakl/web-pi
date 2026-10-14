import { describe, expect, it } from "vitest";
import { htmxEvent, mount } from "./helpers.ts";

// What every htmx request tells the server about the page it came from.

describe("request context", () => {
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
