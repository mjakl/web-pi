import { renderMarkdown } from "@web/markdown";
import { setUpTranscript } from "@web/client/transcript";
import { setUpFiles } from "@web/client/files";
import { describe, expect, it, vi } from "vitest";
import { flush, htmx, htmxEvent, mount, query } from "./helpers.ts";

function anchor(): HTMLAnchorElement {
  const link = query("a");
  if (!(link instanceof HTMLAnchorElement))
    throw new Error("Expected an anchor");
  return link;
}

describe("Markdown web links", () => {
  it.each([
    ["http://localhost:3000/path#destination", "_self"],
    ["https://localhost:3000/path#destination", "_blank"],
    ["http://other.test:3000/path", "_blank"],
    ["http://localhost:3001/path", "_blank"],
  ])("uses the browser origin for %s", (href, target) => {
    history.replaceState(null, "", "http://localhost:3000/current#source");
    mount(renderMarkdown(`[go](${href})`));
    setUpTranscript();
    expect(anchor().target).toBe(target);
    expect(anchor().getAttribute("href")).toBe(href);
  });

  it("updates processed anchors and all settled siblings, including morphed links", () => {
    mount('<div id="turn"></div>');
    setUpTranscript();
    const html = renderMarkdown(
      `[go](${location.origin}/sessions/other#answer)`,
    );
    query("#turn").innerHTML = html;
    htmxEvent(anchor(), "htmx:after:process");
    expect(anchor().target).toBe("_self");
    anchor().target = "_blank";
    htmxEvent(query("#turn"), "htmx:after:settle");
    expect(anchor().target).toBe("_self");
    document.body.insertAdjacentHTML("beforeend", html);
    const sibling = document.querySelectorAll("a")[1];
    if (!sibling) throw new Error("Expected a sibling anchor");
    htmxEvent(query("#turn"), "htmx:after:settle", { newContent: [sibling] });
    expect(sibling.target).toBe("_self");
  });

  it("leaves primary, modified, middle-click and context-menu handling to the browser", () => {
    mount(renderMarkdown(`[go](${location.origin}/elsewhere#answer)`));
    setUpTranscript();
    const current = location.href;
    for (const [type, init] of [
      ["click", {}],
      ["click", { ctrlKey: true }],
      ["click", { metaKey: true }],
      ["click", { shiftKey: true }],
      ["click", { altKey: true }],
      ["auxclick", { button: 1 }],
      ["contextmenu", { button: 2 }],
    ] as const) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      // Suppress happy-dom's simulated navigation only after application handlers.
      const observe = (received: Event) => {
        expect(received.defaultPrevented).toBe(false);
        received.preventDefault();
      };
      window.addEventListener(type, observe, { once: true });
      anchor().dispatchEvent(event);
      expect(location.href).toBe(current);
    }
  });

  it("does not rewrite file actions, mailto links or fragment anchors", () => {
    mount(
      renderMarkdown(
        "[root](/sessions/abc) [relative](./src/main.ts) [mail](mailto:a@example.test) [hash](#heading)",
        { cwd: "/repo" },
      ),
    );
    const before = document.body.innerHTML;
    setUpTranscript();
    expect(document.body.innerHTML).toBe(before);
  });
});

describe("remote Markdown images", () => {
  it("loads the image only when the reader clicks its button", () => {
    mount(
      renderMarkdown(
        '![say "hi"](https://img.test/p.png?data=secret "A title")',
      ),
    );
    setUpTranscript();
    expect(document.querySelector("img")).toBeNull();
    const holder = query(".markdown-remote-image");
    query("[data-remote-image]").click();
    const image = holder.querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "https://img.test/p.png?data=secret",
    );
    expect(image?.alt).toBe('say "hi"');
    expect(image?.title).toBe("A title");
    expect(holder.querySelector("button")).toBeNull();
    // The message is settled, so a later morph keeps what the reader loaded.
    expect(holder.hasAttribute("hx-morph-skip")).toBe(true);
  });

  it("shows an image the reader loaded again when its message renders anew", () => {
    const html = renderMarkdown(
      "[![chart](https://img.test/c.png)](./report.md) ![other](https://img.test/o.png)",
      { cwd: "/repo" },
    );
    mount(`<div id="turn">${html}</div><div id="messages"></div>`);
    setUpTranscript();
    query('[data-remote-image="https://img.test/c.png"]').click();
    // The run settles, and its messages are rendered afresh into history.
    query("#turn").replaceChildren();
    query("#messages").innerHTML = html;
    htmxEvent(query("#messages"), "htmx:after:settle");
    expect(query("#messages img").getAttribute("src")).toBe(
      "https://img.test/c.png",
    );
    expect(
      query("#messages img").closest<HTMLElement>("[data-file-path]")?.dataset[
        "filePath"
      ],
    ).toBe("/repo/report.md");
    expect(query("#messages [data-remote-image-link]").hidden).toBe(false);
    // An image the reader did not load still waits for its own click.
    expect(document.querySelectorAll("#messages img")).toHaveLength(1);
    expect(query("#messages [data-remote-image]").dataset["remoteImage"]).toBe(
      "https://img.test/o.png",
    );
  });

  it.each([
    "![chart](https://img.test/local-chart.png)",
    "before **![chart](https://img.test/local-chart.png)** after",
  ])(
    "loads a local-linked image independently, then opens its file: %s",
    async (content) => {
      vi.stubGlobal(
        "EventSource",
        class extends EventTarget {
          close() {}
        },
      );
      mount(
        `<main data-session-id="s1" data-cwd="/repo">${renderMarkdown(`[${content}](./report.md)`, { cwd: "/repo" })}<div id="file-panel"></div><div id="file-tabs"></div><div id="file-view"></div></main>`,
      );
      setUpFiles();
      setUpTranscript();
      const load = query("[data-remote-image]");
      expect(load).toBeInstanceOf(HTMLButtonElement);
      expect(load.closest("[data-file-path]")).toBeNull();
      expect(document.querySelector("img")).toBeNull();
      load.focus();
      load.click();
      await flush();
      expect(htmx().ajax).not.toHaveBeenCalled();
      const image = query(".markdown-remote-image img");
      const link = image.closest<HTMLButtonElement>("button[data-file-path]");
      expect(link).not.toBeNull();
      expect(link?.hidden).toBe(false);
      expect(document.activeElement).toBe(link);
      expect(
        image.parentElement?.parentElement?.hasAttribute("hx-morph-skip"),
      ).toBe(true);
      image.click();
      await flush();
      expect(htmx().ajax).toHaveBeenCalledOnce();
      expect(htmx().ajax.mock.calls[0]?.[1]).toContain(
        "path=%2Frepo%2Freport.md",
      );
    },
  );

  it("keeps multiple linked images independent and names an empty-alt destination", () => {
    mount(
      renderMarkdown(
        "[![](https://img.test/empty.png) ![other](https://img.test/other.png)](./report.md)",
        { cwd: "/repo" },
      ),
    );
    setUpTranscript();
    query("[data-remote-image]").click();
    expect(document.querySelectorAll("img")).toHaveLength(1);
    expect(document.querySelectorAll("[data-remote-image]")).toHaveLength(1);
    const link = query("img").closest<HTMLElement>("[data-file-path]");
    expect(link?.getAttribute("aria-label")).toBe("./report.md");
    expect(document.querySelectorAll("[data-file-path]")).toHaveLength(2);
    expect(document.activeElement).not.toBe(link);
  });

  it.each([
    ["http://localhost:3000/elsewhere", "_self"],
    ["https://docs.test/elsewhere", "_blank"],
  ])("loads an image linked to %s without navigating", (href, target) => {
    mount(renderMarkdown(`[![build](https://img.test/badge.png)](${href})`));
    setUpTranscript();
    expect(query("[data-remote-image]").closest("a")).toBeNull();
    let followed: boolean | undefined;
    // Suppress happy-dom's simulated navigation only after application handlers.
    window.addEventListener(
      "click",
      (event) => {
        followed = !event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );
    query("[data-remote-image]").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(followed).toBe(false);
    expect(query("a img").getAttribute("src")).toBe(
      "https://img.test/badge.png",
    );
    expect(anchor().target).toBe(target);
    expect(anchor().getAttribute("href")).toBe(href);
    window.addEventListener(
      "click",
      (event) => {
        expect(event.defaultPrevented).toBe(false);
        event.preventDefault();
      },
      { once: true },
    );
    query("a img").click();
  });
});
