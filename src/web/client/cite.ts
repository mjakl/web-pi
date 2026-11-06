import { replaceRange, textarea } from "./editor.ts";
import { setUpRegion } from "./lifecycle.ts";

const ANSWER = ".assistant-blocks > [data-cite-answer]";
const CONTROL =
  ".markdown-code-header, button:not(.markdown-file-ref), input, select, textarea, summary, [hidden], .linenumber";

function element(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/** Validate selected content, not the containers a browser uses as endpoints. */
function answerRange(range: Range, log: HTMLElement): Range | null {
  const root = element(range.commonAncestorContainer);
  if (!root) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let reply: Element | null = null;
  let content: Range | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const text = node.textContent ?? "";
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : text.length;
    if (!text.slice(start, end).trim()) continue;
    const parent = node.parentElement;
    const owner = parent?.closest(ANSWER)?.closest(".assistant-message");
    if (!owner || !log.contains(owner) || (reply && owner !== reply))
      return null;
    reply = owner;
    // These controls are also unselectable in CSS, so native Selection text
    // retains rendered line breaks without including incidental UI labels.
    if (parent?.closest(CONTROL)) continue;
    if (!content) {
      content = document.createRange();
      content.setStart(node, start);
    }
    content.setEnd(node, end);
  }
  return content;
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
        answerRange(pending.range, log) &&
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
        const range = answerRange(selection.getRangeAt(0), log);
        const text = selection.toString().trim();
        if (!text || !range) return;
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
