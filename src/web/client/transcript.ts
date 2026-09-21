import { requestContext, settledContent, swapTasks } from "./htmx.ts";
import { codeText, highlightIn } from "./highlight.ts";
import { setUpImagePreview } from "./images.ts";
import { setUpMermaid } from "./mermaid.ts";
import { setUpMarkdownLinks } from "./markdown-links.ts";
import { setUpRegion } from "./lifecycle.ts";
import { setUpRail } from "./rail.ts";
import { setUpSavedSession } from "./saved-session.ts";

// Everything the transcript needs from the browser: staying at the tail while
// a turn streams, keeping the reading position when an older page is
// prepended, colouring settled code, and the copy buttons.

/** Within this many pixels of the bottom counts as "at the end". */
const TAIL_TOLERANCE = 8;
const COPIED_MS = 1500;

export function isAtTail(
  top: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  return scrollHeight - top - clientHeight <= TAIL_TOLERANCE;
}

/**
 * pi-web's `getLiveFollowAttached` (lib/chat-lazy-load.ts): only a scroll
 * upwards lets go of the tail. Asking "is it at the tail" alone would let go
 * halfway through a jump that chases a still-growing transcript - the file
 * panel narrowing the column, an image loading - and leave the reader a
 * screenful short of the end with the jump button showing.
 */
export function followsTail(
  wasFollowing: boolean,
  previousTop: number,
  top: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  if (isAtTail(top, clientHeight, scrollHeight)) return true;
  if (top < previousTop) return false;
  return wasFollowing;
}

function atTail(view: HTMLElement): boolean {
  return isAtTail(view.scrollTop, view.clientHeight, view.scrollHeight);
}

/**
 * pi-web swaps the label and the icon for 1.5s and turns the button accent.
 * The message button carries both states in the markup, a code-block button
 * only a label; `data-copied` is what the stylesheet keys the colour on.
 */
async function copyText(button: HTMLElement, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
  const label = button.querySelector("[data-copy-idle]") === null;
  const previous = button.textContent;
  if (label) button.textContent = "Copied";
  button.dataset["copied"] = "1";
  setTimeout(() => {
    if (label) button.textContent = previous;
    delete button.dataset["copied"];
  }, COPIED_MS);
}

function setUpCopy(): void {
  document.body.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const message = target.closest<HTMLElement>("[data-copy]");
    if (message) {
      // The extension card copies from inside its disclosure's summary row;
      // copying there must not open the panel underneath.
      if (message.closest("summary")) event.preventDefault();
      const source =
        message.parentElement?.querySelector<HTMLElement>("[data-copy-source]");
      void copyText(message, source?.textContent ?? "");
      return;
    }
    const code = target.closest<HTMLElement>("[data-copy-code]");
    if (!code) return;
    void copyText(code, codeText(code.closest(".markdown-code-block")));
  });
}

export function setUpTranscript(): void {
  setUpRail();
  setUpImagePreview();
  setUpCopy();
  setUpMermaid();
  setUpMarkdownLinks();
  // Native cleanup removes triggers, but does not abort ordinary requests.
  // A rewritten transcript must not keep fetching or accept a late old page.
  // Body-targeted history actions belong to navigation: their response restores
  // the composer even when their own SSE update has already removed the button.
  document.addEventListener("htmx:before:cleanup", (event) => {
    const owner = event.target;
    if (
      owner instanceof Element &&
      owner.closest("#log") &&
      owner.getAttribute("hx-target") !== "body"
    )
      owner.dispatchEvent(new Event("htmx:abort"));
  });
  document.addEventListener("htmx:before:response", (event) => {
    const { sourceElement, request, target } = requestContext(event);
    if (
      target !== document.body &&
      sourceElement.closest("#log") &&
      (!sourceElement.isConnected || request.signal.aborted)
    )
      event.preventDefault();
  });
  setUpRegion("#log", mountTranscript);
  setUpSavedSession();
}

function mountTranscript(view: HTMLElement, signal: AbortSignal): void {
  const jump = document.getElementById("jump-to-latest");
  let follow = true;
  let previousTop = 0;
  let newMessages = false;
  const sync = () => {
    const top = view.scrollTop;
    follow = followsTail(
      follow,
      previousTop,
      top,
      view.clientHeight,
      view.scrollHeight,
    );
    previousTop = top;
    if (atTail(view)) newMessages = false;
    if (jump) {
      jump.hidden = atTail(view);
      jump.classList.toggle("has-new-messages", newMessages);
      jump.setAttribute(
        "aria-label",
        newMessages ? "New messages — jump to latest" : "Jump to latest",
      );
      jump.title = newMessages
        ? "New messages — jump to latest"
        : "Jump to latest";
      const label = jump.querySelector<HTMLElement>("[data-new-messages]");
      if (label) label.hidden = !newMessages;
    }
  };
  view.addEventListener("scroll", sync, { passive: true, signal });
  jump?.addEventListener(
    "click",
    () => {
      newMessages = false;
      follow = true;
      view.scrollTo({
        top: view.scrollHeight,
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    },
    { signal },
  );

  // A saved tool result can resize an existing card above the viewport. Keep
  // the first visible entry at the same offset, rather than anchoring the tail.
  let savedAnchor: { entry: Element; top: number } | undefined;
  view.addEventListener(
    "web-pi:saved-before",
    () => {
      if (follow) return;
      const top = view.getBoundingClientRect().top;
      const entry = [...view.querySelectorAll('[id^="entry-"]')].find(
        (item) => item.getBoundingClientRect().bottom > top,
      );
      savedAnchor = entry
        ? { entry, top: entry.getBoundingClientRect().top }
        : undefined;
    },
    { signal },
  );
  view.addEventListener(
    "web-pi:saved-after",
    () => {
      if (!follow) {
        if (savedAnchor?.entry.isConnected)
          view.scrollTop +=
            savedAnchor.entry.getBoundingClientRect().top - savedAnchor.top;
        newMessages = true;
      } else view.scrollTop = view.scrollHeight;
      savedAnchor = undefined;
      sync();
    },
    { signal },
  );

  // A prepended page must not move the text under the reader's eyes: keep the
  // distance to the bottom, which the new content does not change.
  let anchor: number | null = null;
  document.addEventListener(
    "htmx:before:swap",
    (event) => {
      if (signal.aborted || !view.isConnected) return;
      const tasks = swapTasks(event) as { target: Element | string }[];
      if (
        tasks.some(({ target }) => {
          const element =
            typeof target === "string"
              ? document.querySelector(target)
              : target;
          return (
            element instanceof Element &&
            view.contains(element) &&
            element.classList.contains("load-earlier")
          );
        })
      ) {
        anchor = view.scrollHeight - view.scrollTop;
      }
    },
    { signal },
  );
  document.addEventListener(
    "htmx:after:settle",
    (event) => {
      if (signal.aborted || !view.isConnected) return;
      const target = event.target;
      // Only the log and the running turn move the reader to the tail. A tool
      // card fetching its own body must leave the scroll position alone.
      const appended =
        target instanceof Element &&
        view.contains(target) &&
        (target.id === "messages" || target.id === "turn");
      if (anchor !== null) {
        view.scrollTop = Math.max(0, view.scrollHeight - anchor);
        anchor = null;
      } else if (follow && appended) {
        view.scrollTop = view.scrollHeight;
      }
      if (target instanceof Element) highlightIn(target);
      for (const element of settledContent(event)) highlightIn(element);
      sync();
    },
    { signal },
  );

  view.scrollTop = view.scrollHeight;
  // Images, mermaid diagrams and the highlighter all resize the transcript
  // after this first jump, which would leave the page a screenful short of
  // the tail with the jump button showing. Follow the growth until the
  // reader scrolls away from the bottom themselves.
  const content = view.firstElementChild;
  if (content) {
    const resize = new ResizeObserver(() => {
      if (!signal.aborted && view.isConnected && follow)
        view.scrollTop = view.scrollHeight;
    });
    resize.observe(content);
    signal.addEventListener(
      "abort",
      () => {
        resize.disconnect();
      },
      { once: true },
    );
  }
  sync();
  highlightIn(view);
}
