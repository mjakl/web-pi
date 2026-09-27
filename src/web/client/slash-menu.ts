import { slashCompletionQuery } from "@core/composer";
import { type MenuEndpoints, replaceRange } from "./editor.ts";
import { createMenu, handleMenuKey, type Menu } from "./menu.ts";

// Typing `/` opens the command menu. The list and its ranking are rendered by
// the server; the browser owns only which key does what.

const DEBOUNCE_MS = 80;

export type SlashMenu = {
  refresh(): void;
  close(): void;
  handleKey(event: KeyboardEvent, completeOnEnter: boolean): boolean;
};

export function setUpSlashMenu(
  endpoints: MenuEndpoints | null,
  owner: ParentNode = document,
  signal?: AbortSignal,
): SlashMenu {
  const textarea = () =>
    owner.querySelector<HTMLTextAreaElement>("#composer-text");
  const menu: Menu = createMenu(
    "slash-menu",
    (item) => {
      const area = textarea();
      const name = item.dataset["command"];
      if (!area || name === undefined) return;
      if (slashCompletionQuery(area.value, area.selectionStart) === null) {
        menu.close();
        return;
      }
      const separator = area.value.search(/\s/);
      const end = separator < 0 ? area.value.length : separator;
      replaceRange(
        area,
        0,
        end,
        `/${name}${separator < 0 ? " " : ""}`,
        name.length + 2,
      );
      menu.close();
    },
    owner,
    signal,
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | undefined;

  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      inFlight?.abort();
      menu.close();
    },
    { once: true },
  );

  const load = (query: string): void => {
    if (signal?.aborted || endpoints === null) return;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    fetch(endpoints.commands(query), {
      signal: controller.signal,
    })
      .then((response) => response.text())
      .then((html) => {
        if (
          signal?.aborted ||
          controller.signal.aborted ||
          slashCompletionQuery(
            textarea()?.value ?? "",
            textarea()?.selectionStart ?? 0,
          ) !== query
        )
          return;
        menu.render(html);
      })
      .catch(() => {
        // A slow or failed lookup just leaves the menu as it was.
      });
  };

  return {
    refresh() {
      if (signal?.aborted) return;
      clearTimeout(timer);
      inFlight?.abort();
      const area = textarea();
      const query = slashCompletionQuery(
        area?.value ?? "",
        area?.selectionStart ?? 0,
      );
      if (query === null) {
        menu.close();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        load(query);
      }, DEBOUNCE_MS);
    },
    close: () => {
      menu.close();
    },
    handleKey(event, completeOnEnter) {
      return handleMenuKey(menu, event, completeOnEnter);
    },
  };
}
