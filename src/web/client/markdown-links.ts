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
 * Puts a message's remote image in place of the button that names it, which
 * is the first request for it. Morphs leave the loaded image alone: the
 * message it belongs to does not change.
 */
function loadRemoteImage(event: Event): void {
  const target = event.target;
  const button =
    target instanceof Element
      ? target.closest<HTMLElement>("[data-remote-image]")
      : null;
  const holder = button?.parentElement;
  if (!button || !holder) return;
  // A linked image, such as a badge, puts the button inside the link: the
  // click loads the image and must not follow the link as well.
  event.preventDefault();
  const image = document.createElement("img");
  image.src = button.dataset["remoteImage"] ?? "";
  image.alt = button.dataset["alt"] ?? "";
  const title = button.dataset["title"];
  if (title !== undefined) image.title = title;
  holder.setAttribute("hx-morph-skip", "");
  button.replaceWith(image);
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
  });
}
