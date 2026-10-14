// The System, Tools and Session info panels under the top bar, with the
// shipped htmx. happy-dom has no Popover API, so the test delivers the toggle
// events the browser sends when a panel opens and closes.

import { expect, it } from "vitest";
import { fixture } from "#/web/fixtures/session-navigation";
import { required } from "#/web/helpers";

it("fills a panel each time it opens and leaves it empty while closed", async () => {
  const b = await fixture();
  const toggle = (id: string, newState: "open" | "closed") => {
    b.window.eval(
      `document.getElementById(${JSON.stringify(id)}).dispatchEvent(Object.assign(new Event("toggle"), { newState: ${JSON.stringify(newState)} }))`,
    );
  };
  const fetched = (path: string) =>
    b.requests.filter((request) => new URL(request.url).pathname === path)
      .length;
  const panel = required(b.document.getElementById("system-panel"));
  expect(
    b.document
      .querySelector('[popovertarget="system-panel"]')
      ?.getAttribute("aria-label"),
  ).toBe("System prompt");

  toggle("system-panel", "open");
  await expect
    .poll(() => panel.querySelector(".system-prompt-panel"))
    .not.toBeNull();
  toggle("system-panel", "closed");
  expect(panel.childElementCount).toBe(0);
  toggle("system-panel", "open");
  await expect
    .poll(() => panel.querySelector(".system-prompt-panel"))
    .not.toBeNull();
  // Closing fetched nothing: a request it sent would have gone out first.
  expect(fetched("/sessions/s1/system-prompt")).toBe(2);

  // A tool chosen inside its panel replaces that panel's content.
  const tools = required(b.document.getElementById("tools-panel"));
  toggle("tools-panel", "open");
  await expect
    .poll(() => tools.querySelector(".tool-definitions-item"))
    .not.toBeNull();
  expect(
    tools.querySelector(".tool-definitions-item")?.getAttribute("hx-target"),
  ).toBe("#tools-panel");
  toggle("stats-panel", "open");
  await expect
    .poll(() => b.document.querySelector("#stats-panel .session-info-popover"))
    .not.toBeNull();
});
