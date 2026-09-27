import { CommandMenu } from "@web/views/Composer";
import { describe, expect, it, vi } from "vitest";
import {
  area,
  byId,
  flush,
  keydown,
  mockFetch,
  mount,
  query,
  render,
  text,
} from "./helpers.ts";

async function setup() {
  mount(
    '<form id="composer" data-session-id="s1">' +
      '<textarea id="composer-text"></textarea>' +
      '<div id="slash-menu" hidden></div></form>',
  );
  const fetch = mockFetch(() =>
    text(
      render(
        CommandMenu({
          commands: [
            { name: "skill:find-skill", source: "skill", description: "Find" },
          ],
          query: "skill:fi",
        }),
      ),
    ),
  );
  const { menuEndpoints } = await import("@web/client/editor");
  const { setUpSlashMenu } = await import("@web/client/slash-menu");
  const form = byId("composer");
  if (!(form instanceof HTMLFormElement)) throw new Error("no composer form");
  return { menu: setUpSlashMenu(menuEndpoints(form)), fetch };
}

function draft(value: string, caret = value.length): void {
  area().value = value;
  area().setSelectionRange(caret, caret);
}

async function open(
  menu: Awaited<ReturnType<typeof setup>>["menu"],
): Promise<void> {
  menu.refresh();
  await vi.advanceTimersByTimeAsync(80);
  await flush();
}

describe("leading skill completion", () => {
  it("queries from the caret, then replaces the whole skill token without duplicating its suffix or arguments", async () => {
    const { menu, fetch } = await setup();
    draft("/skill:find-older explain the issue", "/skill:fi".length);
    await open(menu);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "/sessions/s1/commands?q=skill%3Afi",
    );
    expect(byId("slash-menu").hidden).toBe(false);
    expect(menu.handleKey(keydown(area(), "Tab"), false)).toBe(true);
    expect(area().value).toBe("/skill:find-skill explain the issue");
    expect(area().selectionStart).toBe("/skill:find-skill ".length);
    expect(byId("slash-menu").hidden).toBe(true);
  });

  it("inserts one trailing space for an unfinished skill with no arguments", async () => {
    const { menu } = await setup();
    draft("/skill:fi");
    await open(menu);
    expect(menu.handleKey(keydown(area(), "Enter"), true)).toBe(true);
    expect(area().value).toBe("/skill:find-skill ");
  });

  it("applies a mouse pick to the leading token and keeps the existing separator", async () => {
    const { menu } = await setup();
    draft("/skill:fi\nnext line", "/skill:fi".length);
    await open(menu);
    query('[data-command="skill:find-skill"]').dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    expect(area().value).toBe("/skill:find-skill\nnext line");
  });

  it("does not complete an inline skill or query unrelated commands with arguments", async () => {
    const { menu, fetch } = await setup();
    draft("ask /skill:fi");
    await open(menu);
    draft("/name Bob", "/na".length);
    await open(menu);
    expect(fetch).not.toHaveBeenCalled();
    expect(byId("slash-menu").hidden).toBe(true);
  });

  it("drops a lookup when the caret moves into request text before its reply", async () => {
    let reply: ((value: Response) => void) | undefined;
    const { menu, fetch } = await setup();
    fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    const value = "/skill:fi explain";
    draft(value, "/skill:fi".length);
    menu.refresh();
    vi.advanceTimersByTime(80);
    draft(value);
    reply?.(
      text(
        '<button data-index="0" data-command="skill:find-skill">Skill</button>',
      ),
    );
    await flush();
    expect(byId("slash-menu").hidden).toBe(true);
  });
});
