import { escapeHtml } from "@core/html";
import { localFilePath } from "@core/path-access";
import { Marked, type Tokens } from "marked";

// Model output is untrusted. Raw HTML inside Markdown is shown as text rather
// than sanitised, which needs no allowlist and cannot leak a script.

/** Past this the page prints the source instead of parsing it (§3.2). */
const MAX_MARKDOWN_CHARS = 100_000;

export type MarkdownOptions = {
  /** Resolves relative file links; the session's working folder. */
  cwd?: string;
  /** Opens local paths in the file panel and serves local images. */
  sessionId?: string;
  /** Inside the live turn: no diagram preview until the text settles. */
  live?: boolean;
  /** File previews render fully; messages retain the oversized-source fallback. */
  filePreview?: boolean;
};

/** The route the file panel reads bytes from; also used for local images. */
export function rawFileUrl(path: string, sessionId?: string): string {
  const query = new URLSearchParams({ path });
  if (sessionId !== undefined) query.set("session", sessionId);
  return `/files/raw?${query.toString()}`;
}

export { escapeHtml };

function attribute(value: string): string {
  return escapeHtml(value);
}

/** GitHub's own id shape, so `#heading` links keep working. */
function headingId(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replaceAll(/[^\p{L}\p{N}\s-]/gu, "")
    .replaceAll(/\s+/g, "-");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${String(bytes)} B`;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;

/**
 * pi-web's CodeBlock (§4.5): a header carrying the language and a copy
 * button, then the code on a tinted body. A mermaid fence gets the extra
 * Preview/Source action and the `.mermaid-block` the client renders into.
 */
function codeBlock(code: string, language: string, live: boolean): string {
  const label = language === "" ? "text" : language;
  const body =
    `<pre class="markdown-code-body">` +
    `<code class="language-${attribute(label)}">${escapeHtml(code)}</code></pre>`;
  const copy = `<button type="button" class="markdown-code-action" data-copy-code>Copy</button>`;
  const header = (actions: string) =>
    `<div class="markdown-code-header"><span class="markdown-code-lang">${escapeHtml(label)}</span>` +
    `<div class="markdown-code-actions">${actions}</div></div>`;
  if (label !== "mermaid") {
    return `<div class="markdown-code-block">${header(copy)}${body}</div>`;
  }
  const toggle = `<button type="button" class="markdown-code-action" data-mermaid-toggle${
    live ? ' disabled title="Preview available after streaming"' : ""
  }>Preview</button>`;
  return `<div class="markdown-code-block" data-mermaid>${header(`${toggle}${copy}`)}${body}<div class="mermaid-block" hidden></div></div>`;
}

/**
 * A single `~` is ordinary text: CJK ranges use it, and GitHub's strikethrough
 * needs `~~`. Matching it here keeps marked's own `del` rule from seeing it.
 */
const literalTilde = {
  name: "literalTilde",
  level: "inline" as const,
  start: (source: string) => source.indexOf("~"),
  tokenizer(source: string) {
    return /^~(?!~)/.test(source)
      ? { type: "literalTilde", raw: "~", text: "~" }
      : undefined;
  },
  renderer: () => "~",
};

function markedFor(options: MarkdownOptions): Marked {
  const seenHeadings = new Set<string>();
  const marked = new Marked({
    gfm: true,
    breaks: false,
    extensions: [literalTilde],
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
      code({ text, lang }: Tokens.Code) {
        const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
        return codeBlock(text, language.toLowerCase(), options.live === true);
      },
      codespan({ text }: Tokens.Codespan) {
        return `<code class="markdown-inline-code">${escapeHtml(text)}</code>`;
      },
      heading(
        this: { parser: { parseInline(tokens: unknown[]): string } },
        token: Tokens.Heading,
      ) {
        const content = this.parser.parseInline(token.tokens);
        const base = headingId(token.text);
        let id = base;
        for (let n = 1; seenHeadings.has(id); n += 1)
          id = `${base}-${String(n)}`;
        seenHeadings.add(id);
        const depth = String(token.depth);
        return `<h${depth} id="user-content-${attribute(id)}">${content}</h${depth}>`;
      },
      table(
        this: { parser: { parseInline(tokens: unknown[]): string } },
        token: Tokens.Table,
      ) {
        const cell = (item: Tokens.TableCell, tag: "th" | "td") => {
          const align = item.align ? ` align="${item.align}"` : "";
          return `<${tag}${align}>${this.parser.parseInline(item.tokens)}</${tag}>`;
        };
        const head = token.header.map((item) => cell(item, "th")).join("");
        const body = token.rows
          .map(
            (row) => `<tr>${row.map((item) => cell(item, "td")).join("")}</tr>`,
          )
          .join("");
        return `<div class="markdown-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
      },
      link(
        this: { parser: { parseInline(tokens: unknown[]): string } },
        token: Tokens.Link,
      ) {
        const content = this.parser.parseInline(token.tokens);
        const href = token.href;
        if (href.startsWith("#")) {
          return `<a href="#user-content-${attribute(href.slice(1))}">${content}</a>`;
        }
        if (/^(https?:|mailto:)/i.test(href)) {
          return `<a href="${attribute(href)}" target="_blank" rel="noopener noreferrer">${content}</a>`;
        }
        const file = localFilePath(href, options.cwd);
        if (file !== null) {
          return `<button type="button" class="markdown-file-ref" data-file-path="${attribute(file)}" title="${attribute(file)}">${content}</button>`;
        }
        return content;
      },
      image({ href, text, title }: Tokens.Image) {
        const alt = attribute(text);
        if (/^https?:/i.test(href)) {
          const titleAttribute =
            title === null || title === undefined
              ? ""
              : ` title="${attribute(title)}"`;
          return `<img src="${attribute(href)}" alt="${alt}"${titleAttribute} loading="lazy">`;
        }
        const file = localFilePath(href, options.cwd);
        if (file === null) return alt;
        const label = alt === "" ? attribute(file) : alt;
        if (options.sessionId === undefined) {
          return `<button type="button" class="markdown-file-ref" data-file-path="${attribute(file)}" title="${attribute(file)}">${label}</button>`;
        }
        return `<button type="button" class="markdown-file-image" data-file-path="${attribute(file)}" title="${attribute(file)}"><img src="${attribute(rawFileUrl(file, options.sessionId))}" alt="${label}" loading="lazy"></button>`;
      },
    },
  });
  return marked;
}

export function renderMarkdown(
  source: string,
  options: MarkdownOptions = {},
): string {
  if (options.filePreview !== true && source.length > MAX_MARKDOWN_CHARS) {
    // pi-web's SafeMarkdownBody reveal (§4.4.2), as a disclosure.
    const size = escapeHtml(formatBytes(source.length));
    return (
      `<details class="markdown-oversized"><summary class="markdown-oversized-summary">⚠ Message content is very large (${size}).` +
      ` Click to view as plain text — markdown rendering is disabled to keep the page responsive.</summary>` +
      `<div class="markdown-oversized-body"><pre class="markdown-oversized-text">${escapeHtml(source)}</pre></div></details>`
    );
  }
  const text = source.replace(FRONTMATTER, "");
  return markedFor(options).parse(text, { async: false });
}
