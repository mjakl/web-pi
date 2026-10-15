import { useVisualViewport } from "@core/composer";

// The phone keyboard. When it opens, the layout viewport stays the height of
// the screen and the page is simply covered; `--app-viewport-height` pins the
// app to what is still visible, so the composer sits above the keyboard
// instead of under it. Everything is rAF-coalesced because WebKit fires
// `resize` before `visualViewport.height` has settled.

const HEIGHT = "--app-viewport-height";
const SAFE_AREA = "--app-safe-area-bottom";

/** A field the keyboard types into: its keys are not the page's shortcuts. */
export function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement)
  );
}

export function setUpViewport(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  let scheduled = false;
  let pinned = false;

  const update = (): void => {
    const use = useVisualViewport({
      focusedEditable: isTextEntry(document.activeElement),
      scale: viewport.scale,
      layoutHeight: root.clientHeight,
      viewportHeight: viewport.height,
    });
    if (use) {
      root.style.setProperty(HEIGHT, `${String(viewport.height)}px`);
      // The keyboard already covers the inset; adding it would leave a gap.
      root.style.setProperty(SAFE_AREA, "0px");
    } else {
      root.style.removeProperty(HEIGHT);
      root.style.removeProperty(SAFE_AREA);
    }
    // iOS scrolls the whole page to reveal the field; with the app sized to
    // the visible box that offset is pure damage.
    if (use !== pinned && viewport.scale <= 1.01) scrollTo(0, 0);
    pinned = use;
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      update();
    });
  };

  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  for (const event of ["resize", "focusin", "focusout", "pageshow"] as const) {
    addEventListener(event, schedule);
  }
  // Removing a focused field need not emit blur. Reconcile the keyboard pin
  // when history brings in a new page, without reinstalling viewport hooks.
  document.addEventListener("htmx:after:process", (event) => {
    if (event.target instanceof Element && event.target.matches("body, main"))
      schedule();
  });
  update();
}
