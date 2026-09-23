import { renderMarkdown } from "@web/markdown";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

describe("renderMarkdown", () => {
  it("shows raw HTML as text instead of running it", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n\n**bold**");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("gives a code block a language header and a copy button", () => {
    const html = renderMarkdown("```ts\nconst a = 1;\n```");
    expect(html).toContain('<span class="markdown-code-lang">ts</span>');
    expect(html).toContain("data-copy-code");
    expect(html).toContain('<code class="language-ts"');
    expect(html).toContain("const a = 1;");
  });

  it("marks a mermaid fence for the preview toggle, disabled while live", () => {
    expect(renderMarkdown("```mermaid\ngraph TD;\n```")).toContain(
      "data-mermaid-toggle",
    );
    expect(
      renderMarkdown("```mermaid\ngraph TD;\n```", { live: true }),
    ).toContain("disabled");
  });

  it("prefixes heading ids and rewrites anchors to match", () => {
    const html = renderMarkdown("# Some Heading\n\n[go](#some-heading)");
    expect(html).toContain('id="user-content-some-heading"');
    expect(html).toContain('href="#user-content-some-heading"');
  });

  it("renders safe web and mail links, local file actions, and no executable raw HTML", async () => {
    const window = new Window();
    try {
      const { document } = window;
      document.body.innerHTML = renderMarkdown(
        '[web](https://x.dev) [root](/sessions/abc) [relative](./src/main.ts) [mail](mailto:a@example.test) [hash](#heading) [bad](javascript:alert%281%29) <a href="https://evil.test">raw</a>',
        { cwd: "/repo" },
      );
      expect(
        document.querySelector('[data-file-path="/sessions/abc"]')?.tagName,
      ).toBe("BUTTON");
      expect(
        document.querySelector('[data-file-path="/repo/src/main.ts"]')?.tagName,
      ).toBe("BUTTON");
      for (const href of ["https://x.dev", "mailto:a@example.test"]) {
        const link = document.querySelector(`a[href="${href}"]`);
        expect(link?.getAttribute("target")).toBe("_blank");
        expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
        expect(link?.hasAttribute("data-session-link")).toBe(false);
      }
      expect(
        document
          .querySelector('a[href="#user-content-heading"]')
          ?.hasAttribute("target"),
      ).toBe(false);
      expect(
        [...document.querySelectorAll("a")].map((link) =>
          link.getAttribute("href"),
        ),
      ).toEqual([
        "https://x.dev",
        "mailto:a@example.test",
        "#user-content-heading",
      ]);
      expect(document.body.textContent).toContain(
        '<a href="https://evil.test">raw</a>',
      );
    } finally {
      await window.happyDOM.close();
    }
  });

  it("leaves a single tilde alone and keeps double-tilde strikethrough", () => {
    const html = renderMarkdown("~10~20 and ~~gone~~");
    expect(html).toContain("~10~20");
    expect(html).toContain("<del>gone</del>");
  });

  it("drops frontmatter instead of rendering it", () => {
    expect(renderMarkdown("---\ntitle: x\n---\n\nbody")).not.toContain("title");
  });

  it("prints the source of a document too large to parse", () => {
    const html = renderMarkdown(`# head\n${"x".repeat(100_001)}`);
    expect(html).toContain("<details");
    expect(html).toContain("Message content is very large");
    expect(html).not.toContain("<h1");
  });
});
