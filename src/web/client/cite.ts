import { replaceRange, textarea } from "./editor.ts";
import { setUpRegion } from "./lifecycle.ts";

const ANSWER = ".assistant-blocks > [data-cite-answer]";
const CONTROL =
  "button, input, select, textarea, summary, [hidden], .linenumber";

function element(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/** Both endpoints and every selected text node must belong to one answer. */
function answerFor(range: Range, log: HTMLElement): Element | null {
  const start = element(range.startContainer);
  const end = element(range.endContainer);
  const reply = start?.closest(".assistant-message");
  if (
    !reply ||
    !log.contains(reply) ||
    reply !== end?.closest(".assistant-message")
  )
    return null;
  if (
    !start?.closest(ANSWER) ||
    !end?.closest(ANSWER) ||
    start.closest(CONTROL) ||
    end.closest(CONTROL)
  )
    return null;
  const walker = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node) || !node.textContent?.trim()) continue;
    const parent = node.parentElement;
    // Line-number gutters are presentation, not part of browser-selected text.
    if (parent?.closest(".linenumber")) continue;
    if (!parent?.closest(ANSWER) || parent.closest(CONTROL)) return null;
  }
  return reply;
}

export function setUpCite(): void {
  setUpRegion("#log", (log, signal) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "transcript-cite";
    button.textContent = "Cite";
    button.title = "Append selection to your draft";
    button.hidden = true;
    document.body.append(button);

    let pending: {
      range: Range;
      text: string;
      source: string;
      composer: Element;
      session: string | undefined;
    } | null = null;

    const clear = () => {
      pending = null;
      button.hidden = true;
    };
    const editable = () => {
      const area = textarea();
      return area && !area.readOnly && !area.matches(":disabled") ? area : null;
    };
    const valid = () => {
      const area = editable();
      return (
        pending &&
        log.isConnected &&
        area &&
        area.closest("#composer") === pending.composer &&
        (pending.composer as HTMLElement).dataset["sessionId"] ===
          pending.session &&
        answerFor(pending.range, log) &&
        pending.range.toString() === pending.source
      );
    };
    const position = () => {
      if (!pending) return;
      const rects = Array.from(pending.range.getClientRects());
      const bounds = log.getBoundingClientRect();
      const top = Math.max(0, bounds.top);
      const bottom = Math.min(innerHeight, bounds.bottom);
      const rect = rects.findLast(
        (rect) => rect.bottom > top && rect.top < bottom,
      );
      if (!rect) {
        button.hidden = true;
        return;
      }
      button.hidden = false;
      const width = button.offsetWidth;
      const height = button.offsetHeight;
      button.style.left = `${String(Math.max(8, Math.min(rect.right - width, innerWidth - width - 8)))}px`;
      const below = rect.bottom + 6;
      button.style.top = `${String(Math.max(8, below + height <= bottom ? below : Math.min(rect.top, bottom) - height - 6))}px`;
    };
    const refresh = () => {
      if (!valid()) clear();
      else position();
    };
    document.addEventListener(
      "selectionchange",
      () => {
        const selection = getSelection();
        // Focusing the action can collapse the browser selection. The captured
        // range remains valid until its content, composer or owner changes.
        if (
          (!selection || selection.isCollapsed) &&
          document.activeElement === button
        )
          return;
        clear();
        const area = editable();
        const composer = area?.closest<HTMLElement>("#composer");
        if (
          !selection ||
          selection.isCollapsed ||
          selection.rangeCount !== 1 ||
          !composer
        )
          return;
        const range = selection.getRangeAt(0).cloneRange();
        const text = selection.toString().trim();
        if (!text || !answerFor(range, log)) return;
        pending = {
          range,
          text,
          source: range.toString(),
          composer,
          session: composer.dataset["sessionId"],
        };
        position();
      },
      { signal },
    );
    button.addEventListener(
      "pointerdown",
      (event) => {
        event.preventDefault();
        button.focus({ preventScroll: true });
      },
      { signal },
    );
    button.addEventListener(
      "click",
      () => {
        const area = editable();
        if (!valid() || !pending || !area) {
          clear();
          return;
        }
        const separator =
          area.value === "" || area.value.endsWith("\n\n")
            ? ""
            : area.value.endsWith("\n")
              ? "\n"
              : "\n\n";
        const quote = pending.text
          .split(/\r?\n/)
          .map((line) => `> ${line}`)
          .join("\n");
        const text = `${separator}Regarding\n${quote}\n\n`;
        clear();
        getSelection()?.removeAllRanges();
        replaceRange(
          area,
          area.value.length,
          area.value.length,
          text,
          text.length,
        );
      },
      { signal },
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.target !== button) clear();
      },
      { signal },
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (!pending) return;
        if (event.key === "Escape") {
          clear();
          event.preventDefault();
        } else if (
          event.key === "Tab" &&
          !event.shiftKey &&
          document.activeElement !== button &&
          !button.hidden
        ) {
          event.preventDefault();
          button.focus({ preventScroll: true });
        }
      },
      { signal },
    );
    button.addEventListener("blur", clear, { signal });
    document.addEventListener("scroll", refresh, {
      capture: true,
      passive: true,
      signal,
    });
    addEventListener("resize", refresh, { signal });
    document.addEventListener("htmx:after:settle", refresh, { signal });
    const observer = new MutationObserver(refresh);
    observer.observe(log, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
        button.remove();
        pending = null;
      },
      { once: true },
    );
  });
}
