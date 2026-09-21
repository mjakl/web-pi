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

export function setUpMarkdownLinks(): void {
  updateLinks(document.body);
  document.addEventListener("htmx:after:process", (event) => {
    if (event.target instanceof Element) updateLinks(event.target);
  });
  document.addEventListener("htmx:after:settle", (event) => {
    if (event.target instanceof Element) updateLinks(event.target);
    for (const element of settledContent(event)) updateLinks(element);
  });
}
