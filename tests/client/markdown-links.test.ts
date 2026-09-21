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
    expect(anchor().rel).toBe("noopener noreferrer");
    expect(anchor().hasAttribute("data-session-link")).toBe(false);
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

  it("preserves filesystem, mailto, fragment and safety behavior", () => {
    mount(
      renderMarkdown(
        '[root](/sessions/abc) [relative](./src/main.ts) [mail](mailto:a@example.test) [hash](#heading) [bad](javascript:alert%281%29) <a href="https://evil.test">raw</a>',
        { cwd: "/repo" },
      ),
    );
    const before = document.body.innerHTML;
    setUpTranscript();
    expect(document.body.innerHTML).toBe(before);
    expect(query('[data-file-path="/sessions/abc"]').tagName).toBe("BUTTON");
    expect(query('[data-file-path="/repo/src/main.ts"]').tagName).toBe(
      "BUTTON",
    );
    expect(document.querySelectorAll("a")).toHaveLength(2);
    expect(
      query('a[href="mailto:a@example.test"]').getAttribute("target"),
    ).toBe("_blank");
    expect(
      query('a[href="#user-content-heading"]').hasAttribute("target"),
    ).toBe(false);
    expect(document.body.textContent).toContain(
      '<a href="https://evil.test">raw</a>',
    );
  });
});
