// The two anchored composer menus need the same five things: a rendered list,
// one active index, arrows, apply, and close. This is that, once.

export type Menu = {
  readonly element: HTMLElement;
  isOpen(): boolean;
  render(html: string): void;
  close(): void;
  move(delta: number): void;
  applyActive(): boolean;
};

/** The composer decides whether Enter means completion/send or a newline. */
export function handleMenuKey(
  menu: Menu,
  event: KeyboardEvent,
  completeOnEnter: boolean,
  dismiss: () => void,
): boolean {
  if (!menu.isOpen()) return false;
  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp":
      event.preventDefault();
      menu.move(event.key === "ArrowDown" ? 1 : -1);
      return true;
    case "Escape":
      event.preventDefault();
      dismiss();
      return true;
    case "Tab":
      event.preventDefault();
      menu.applyActive();
      return true;
    case "Enter":
      if (!completeOnEnter || !menu.applyActive()) return false;
      event.preventDefault();
      return true;
    default:
      return false;
  }
}

export function createMenu(
  id: string,
  apply: (item: HTMLElement) => void,
  owner: ParentNode = document,
  signal?: AbortSignal,
): Menu {
  const element = owner.querySelector<HTMLElement>(`#${id}`);
  if (!element) throw new Error(`Missing menu ${id}`);

  const items = (): HTMLElement[] => [
    ...element.querySelectorAll<HTMLElement>("[data-index]"),
  ];

  const paint = (index: number): void => {
    for (const item of items()) {
      const active = item.dataset["index"] === String(index);
      // `.menu-item[data-active="true"]` is what pi-web's CSS highlights.
      if (active) item.setAttribute("data-active", "true");
      else item.removeAttribute("data-active");
      if (active) item.scrollIntoView({ block: "nearest" });
    }
  };

  let index = 0;

  element.addEventListener(
    "mousedown",
    (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-index]",
      );
      if (!item) return;
      // Keep the caret in the textarea: the click must not move focus.
      event.preventDefault();
      apply(item);
    },
    { signal },
  );
  element.addEventListener(
    "mouseover",
    (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-index]",
      );
      if (!item) return;
      index = Number(item.dataset["index"] ?? 0);
      paint(index);
    },
    { signal },
  );

  return {
    element,
    isOpen: () => !element.hidden,
    render(html) {
      if (signal?.aborted) return;
      element.innerHTML = html;
      element.hidden = false;
      index = 0;
      paint(index);
    },
    close() {
      element.hidden = true;
    },
    move(delta) {
      const count = items().length;
      if (count === 0) return;
      index = Math.min(Math.max(index + delta, 0), count - 1);
      paint(index);
    },
    applyActive() {
      const item = items().find(
        (entry) => entry.dataset["index"] === String(index),
      );
      if (!item) return false;
      apply(item);
      return true;
    },
  };
}
