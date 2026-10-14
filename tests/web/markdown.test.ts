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

  it("renders a mermaid fence as escaped code with only a Copy action", () => {
    const html = renderMarkdown(
      '```mermaid\ngraph TD;\nA["<script>alert(1)</script> & label"]\n```',
    );
    expect(html).toContain('<span class="markdown-code-lang">mermaid</span>');
    expect(html).toContain('<code class="language-mermaid">');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; label");
    expect(html).toContain("data-copy-code>Copy</button>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("data-mermaid");
    expect(html).not.toContain("Preview");
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

  it.each([
    {
      name: "a remote image in a file preview loads, quotes kept in its attributes",
      markdown: '![say "hi"](https://img.test/p.png "a \\"title\\"")',
      options: { filePreview: true },
      image: {
        src: "https://img.test/p.png",
        alt: 'say "hi"',
        title: 'a "title"',
      },
      button: null,
    },
    {
      name: "a remote image in a message waits behind a button, quotes kept in its attributes",
      markdown:
        '![say "hi"](https://img.test/p.png?data=secret "a \\"title\\"")',
      options: {},
      image: null,
      button: {
        remote: "https://img.test/p.png?data=secret",
        alt: 'say "hi"',
        title: 'a "title"',
        file: null,
        text: 'Load image say "hi" img.test',
      },
    },
    {
      name: "a javascript: image is its text",
      markdown: "![run](javascript:alert(1))",
      options: {},
      image: null,
      button: null,
    },
    {
      name: "a data: image is its text, in a file preview too",
      markdown: "![pixel](data:image/png;base64,AAAA)",
      options: { filePreview: true },
      image: null,
      button: null,
    },
    {
      name: "a local image with a session shows through the raw file route",
      markdown: "![shot](shot.png)",
      options: { cwd: "/repo", sessionId: "s1" },
      image: {
        src: "/files/raw?path=%2Frepo%2Fshot.png&session=s1",
        alt: "shot",
        title: null,
      },
      button: {
        remote: null,
        alt: null,
        title: null,
        file: "/repo/shot.png",
        text: "",
      },
    },
    {
      name: "a local image without a session is a file link",
      markdown: "![shot](shot.png)",
      options: { cwd: "/repo" },
      image: null,
      button: {
        remote: null,
        alt: null,
        title: null,
        file: "/repo/shot.png",
        text: "shot",
      },
    },
  ])("renders $name", async ({ markdown, options, image, button }) => {
    const window = new Window();
    try {
      const { body } = window.document;
      body.innerHTML = renderMarkdown(markdown, options);
      const img = body.querySelector("img");
      expect(
        img && {
          src: img.getAttribute("src"),
          alt: img.getAttribute("alt"),
          title: img.getAttribute("title"),
        },
      ).toEqual(image);
      const control = body.querySelector("button");
      expect(
        control && {
          remote: control.getAttribute("data-remote-image"),
          alt: control.getAttribute("data-alt"),
          title: control.getAttribute("data-title"),
          file: control.getAttribute("data-file-path"),
          text: control.textContent.replaceAll(/\s+/g, " ").trim(),
        },
      ).toEqual(button);
      if (!image && !button) {
        expect(body.textContent.trim()).toBe(markdown.slice(2).split("]")[0]);
      }
    } finally {
      await window.happyDOM.close();
    }
  });

  it("leaves a single tilde alone and keeps double-tilde strikethrough", () => {
    const html = renderMarkdown("~10~20 and ~~gone~~");
    expect(html).toContain("~10~20");
    expect(html).toContain("<del>gone</del>");
  });

  it("renders a leading --- block as Markdown, hiding nothing", () => {
    const html = renderMarkdown("---\ntitle: x\n---\n\nbody");
    expect(html).toContain("title: x");
    expect(html).toContain("<p>body</p>");
  });

  it("prints the source of a document too large to parse", () => {
    const html = renderMarkdown(`# head\n${"x".repeat(100_001)}`);
    expect(html).toContain("<details");
    // 100,008 characters, with one decimal like the file panel's sizes.
    expect(html).toContain("Message content is very large (97.7 KB).");
    expect(html).not.toContain("<h1");
  });
});
