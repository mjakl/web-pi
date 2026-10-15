import { settledContent } from "./htmx.ts";

function updateLinks(root: Element): void {
  const selector = "a[data-markdown-link]";
  for (const link of [root, ...root.querySelectorAll(selector)]) {
    if (!(link instanceof HTMLAnchorElement) || !link.matches(selector))
      continue;
    // The browser's origin also covers deployments behind a reverse proxy.
    link.target = link.origin === location.origin ? "_self" : "_blank";
  }
}

/**
 * Remote images the reader loaded on this page. A settled run renders its
 * messages afresh, with their buttons, and these are shown again; a URL the
 * browser already requested reveals nothing new.
 */
const loadedImages = new Set<string>();

/**
 * Puts a remote image in place of the button that names it. Morphs leave the
 * loaded image alone: the message it belongs to does not change.
 */
function showImage(button: HTMLElement, holder: Element): void {
  const source = button.dataset["remoteImage"] ?? "";
  const image = document.createElement("img");
  image.src = source;
  image.alt = button.dataset["alt"] ?? "";
  const title = button.dataset["title"];
  if (title !== undefined) image.title = title;
  holder.setAttribute("hx-morph-skip", "");
  const link = holder.querySelector<HTMLElement>("[data-remote-image-link]");
  if (link) {
    const focused = document.activeElement === button;
    link.replaceChildren(image);
    link.hidden = false;
    button.remove();
    if (focused) link.focus();
  } else button.replaceWith(image);
  loadedImages.add(source);
}

/** The reader's click is the first request for a remote image. */
function loadRemoteImage(event: Event): void {
  const target = event.target;
  const button =
    target instanceof Element
      ? target.closest<HTMLElement>("[data-remote-image]")
      : null;
  const holder = button?.parentElement;
  if (!button || !holder) return;
  // Loading and navigation are sibling controls; this activation only loads.
  event.preventDefault();
  showImage(button, holder);
}

function restoreLoadedImages(): void {
  if (loadedImages.size === 0) return;
  for (const button of document.querySelectorAll<HTMLElement>(
    "[data-remote-image]",
  )) {
    const holder = button.parentElement;
    if (holder && loadedImages.has(button.dataset["remoteImage"] ?? ""))
      showImage(button, holder);
  }
}

export function setUpMarkdownLinks(): void {
  document.addEventListener("click", loadRemoteImage);
  updateLinks(document.body);
  document.addEventListener("htmx:after:process", (event) => {
    if (event.target instanceof Element) updateLinks(event.target);
  });
  document.addEventListener("htmx:after:settle", (event) => {
    if (event.target instanceof Element) updateLinks(event.target);
    for (const element of settledContent(event)) updateLinks(element);
    restoreLoadedImages();
  });
}
