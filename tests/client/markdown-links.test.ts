import { renderMarkdown } from "@web/markdown";
import { setUpTranscript } from "@web/client/transcript";
import { describe, expect, it } from "vitest";
import { htmxEvent, mount, query } from "./helpers.ts";

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
      "![chart](https://img.test/c.png) ![other](https://img.test/o.png)",
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
    // An image the reader did not load still waits for its own click.
    expect(document.querySelectorAll("#messages img")).toHaveLength(1);
    expect(query("#messages [data-remote-image]").dataset["remoteImage"]).toBe(
      "https://img.test/o.png",
    );
  });

  it("loads a linked image without following its link", () => {
    mount(
      renderMarkdown(
        `[![build](https://img.test/badge.png)](${location.origin}/elsewhere)`,
      ),
    );
    setUpTranscript();
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
  });
});
