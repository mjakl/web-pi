import { BUILTIN_COMMANDS, rankCommands } from "@core/composer";
import { CommandMenu, Composer } from "@web/views/Composer";
import { describe, expect, it, vi } from "vitest";
import {
  area,
  byId,
  flush,
  json,
  keydown,
  mockFetch,
  mount,
  render,
  text,
  type,
} from "./helpers.ts";

type MenuKind = "slash" | "at" | "builtin";

async function setup(menu: MenuKind, width: number) {
  window.innerWidth = width;
  mockFetch((url) => {
    if (url.includes("/commands")) {
      const query = new URL(url, "http://x").searchParams.get("q") ?? "";
      return text(
        render(
          CommandMenu({
            commands: rankCommands(BUILTIN_COMMANDS, query),
            query,
          }),
        ),
      );
    }
    return json({ files: ["file.ts", "file2.ts"] });
  });
  mount(
    `<main data-session-id="s1"><div id="toasts"></div>${render(Composer({ sessionId: "s1", cwd: "/repo" }))}</main>`,
  );
  const submits = vi.fn((event: Event) => {
    event.preventDefault();
  });
  byId("composer").addEventListener("submit", submits);
  const { setUpComposer } = await import("@web/client/composer");
  setUpComposer();
  area().focus();
  const initial =
    menu === "at" ? "look @fi" : menu === "builtin" ? "/compact" : "/co";
  type(area(), initial);
  await vi.advanceTimersByTimeAsync(80);
  await flush();
  const menuElement = byId(menu === "at" ? "at-menu" : "slash-menu");
  expect(menuElement.hidden).toBe(false);
  return { submits, initial, menuElement };
}

type DispatchCase = {
  name: string;
  width: number;
  key: string;
  init: KeyboardEventInit;
  sends: boolean;
};
const boundaries: DispatchCase[] = [
  { name: "desktop Enter", width: 641, key: "Enter", init: {}, sends: true },
  { name: "phone Enter", width: 640, key: "Enter", init: {}, sends: false },
  {
    name: "Shift+Enter",
    width: 641,
    key: "Enter",
    init: { shiftKey: true },
    sends: false,
  },
  {
    name: "phone Ctrl+Enter",
    width: 640,
    key: "Enter",
    init: { ctrlKey: true },
    sends: true,
  },
  { name: "phone Tab", width: 640, key: "Tab", init: {}, sends: false },
];

// Modifier admission is shared before either menu or the exact-command branch.
const modifiers: DispatchCase[] = [
  {
    name: "phone Meta+Enter",
    width: 640,
    key: "Enter",
    init: { metaKey: true },
    sends: true,
  },
  {
    name: "phone Alt+Enter",
    width: 640,
    key: "Enter",
    init: { altKey: true },
    sends: true,
  },
  {
    name: "Ctrl+Shift+Enter",
    width: 641,
    key: "Enter",
    init: { ctrlKey: true, shiftKey: true },
    sends: false,
  },
  {
    name: "Meta+Shift+Enter",
    width: 641,
    key: "Enter",
    init: { metaKey: true, shiftKey: true },
    sends: false,
  },
  {
    name: "Alt+Shift+Enter",
    width: 641,
    key: "Enter",
    init: { altKey: true, shiftKey: true },
    sends: false,
  },
];

for (const menu of ["slash", "at", "builtin"] as const) {
  describe(`${menu} keyboard dispatch`, () => {
    it.each([...boundaries, ...(menu === "builtin" ? modifiers : [])])(
      "$name follows the composer policy",
      async ({ width, key, init, sends }) => {
        const { submits, initial, menuElement } = await setup(menu, width);
        const complete = key === "Tab" || (sends && menu !== "builtin");
        const event = keydown(area(), key, init);
        expect(event.defaultPrevented).toBe(sends || complete);
        expect(submits).toHaveBeenCalledTimes(
          sends && menu === "builtin" ? 1 : 0,
        );
        expect(area().value).toBe(
          complete ? (menu === "at" ? "look @file.ts " : "/compact ") : initial,
        );
        expect(menuElement.hidden).toBe(sends || complete);
        expect(document.activeElement).toBe(area());
        // happy-dom does not insert native newlines; Chromium covers that default.
      },
    );

    it.each(
      menu === "builtin"
        ? ["composition flag", "isComposing", "keyCode 229"]
        : ["composition flag"],
    )("ignores %s before completing or submitting", async (mode) => {
      const { submits, initial, menuElement } = await setup(menu, 640);
      if (mode === "composition flag")
        area().dispatchEvent(new Event("compositionstart", { bubbles: true }));
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        isComposing: mode === "isComposing",
        bubbles: true,
        cancelable: true,
      });
      if (mode === "keyCode 229")
        Object.defineProperty(event, "keyCode", { value: 229 });
      area().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(area().value).toBe(initial);
      expect(menuElement.hidden).toBe(false);
      expect(submits).not.toHaveBeenCalled();
    });

    it("consumes Enter during composition grace and admits it at exactly 100ms", async () => {
      const { submits, initial, menuElement } = await setup(menu, 640);
      area().dispatchEvent(new Event("compositionend", { bubbles: true }));
      vi.advanceTimersByTime(99);
      expect(keydown(area(), "Enter", { ctrlKey: true }).defaultPrevented).toBe(
        true,
      );
      expect(submits).not.toHaveBeenCalled();
      expect(area().value).toBe(initial);
      expect(menuElement.hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(keydown(area(), "Enter", { ctrlKey: true }).defaultPrevented).toBe(
        true,
      );
      expect(submits).toHaveBeenCalledTimes(menu === "builtin" ? 1 : 0);
      expect(area().value).toBe(
        menu === "builtin"
          ? initial
          : menu === "at"
            ? "look @file.ts "
            : "/compact ",
      );
      expect(menuElement.hidden).toBe(true);
    });

    if (menu !== "builtin")
      it("keeps arrows and Escape focused on the open menu", async () => {
        const { submits, menuElement } = await setup(menu, 640);
        expect(keydown(area(), "ArrowDown").defaultPrevented).toBe(true);
        expect(keydown(area(), "ArrowUp").defaultPrevented).toBe(true);
        expect(
          menuElement
            .querySelector('[data-index="0"]')
            ?.getAttribute("data-active"),
        ).toBe("true");
        expect(keydown(area(), "Escape").defaultPrevented).toBe(true);
        expect(menuElement.hidden).toBe(true);
        expect(submits).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(area());
      });
  });
}
