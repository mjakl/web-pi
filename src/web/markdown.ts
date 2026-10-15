import { formatBytes } from "@core/file-types";
import { escapeHtml } from "@core/html";
import { localFilePath } from "@core/path-access";
import { Marked, type Token, type Tokens } from "marked";

// Model output is untrusted. Raw HTML inside Markdown is shown as text rather
// than sanitised, which needs no allowlist and cannot leak a script.

/** Past this the page prints the source instead of parsing it. */
const MAX_MARKDOWN_CHARS = 100_000;

export type MarkdownOptions = {
  /** Resolves relative file links; the session's working folder. */
  cwd?: string;
  /** Opens local paths in the file panel and serves local images. */
  sessionId?: string;
  /**
   * File previews render fully and load remote images; messages keep the
   * oversized-source fallback and load a remote image only on a click.
   */
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

type Navigation = (content: string, attributes?: string) => string;

/**
 * A remote image in a message waits for the reader. A prompt injection can
 * put data into an image URL, and drawing the message would send it; the
 * button names the host instead, and client/markdown-links.ts loads the
 * image on a click.
 */
function remoteImage(
  href: string,
  alt: string,
  title: string | undefined,
  navigate?: Navigation,
): string {
  let host: string;
  try {
    host = new URL(href).host;
  } catch {
    return escapeHtml(alt);
  }
  const titled = title === undefined ? "" : ` data-title="${attribute(title)}"`;
  const named =
    alt === ""
      ? ""
      : ` <span class="markdown-remote-image-alt">${escapeHtml(alt)}</span>`;
  return (
    `<span class="markdown-remote-image"><button type="button" class="markdown-remote-image-load" data-remote-image="${attribute(href)}" data-alt="${attribute(alt)}"${titled} title="${attribute(href)}">` +
    `<span class="markdown-remote-image-action">Load image</span>${named}` +
    ` <span class="markdown-remote-image-host">${escapeHtml(host)}</span></button>${navigate?.("", " hidden data-remote-image-link") ?? ""}</span>`
  );
}

function navigation(
  href: string,
  options: MarkdownOptions,
): Navigation | undefined {
  if (href.startsWith("#"))
    return (content, attributes = "") =>
      `<a href="#user-content-${attribute(href.slice(1))}"${attributes}>${content}</a>`;
  if (/^(https?:|mailto:)/i.test(href)) {
    const webLink = /^https?:\/\//i.test(href) ? " data-markdown-link" : "";
    return (content, attributes = "") =>
      `<a href="${attribute(href)}"${webLink} target="_blank" rel="noopener noreferrer"${attributes}>${content}</a>`;
  }
  const file = localFilePath(href, options.cwd);
  if (file === null) return undefined;
  return (content, attributes = "") =>
    `<button type="button" class="markdown-file-ref" data-file-path="${attribute(file)}" title="${attribute(file)}"${attributes}>${content}</button>`;
}

function renderImage(
  { href, text, title }: Tokens.Image,
  options: MarkdownOptions,
  navigate?: Navigation,
): string {
  const alt = attribute(text);
  if (/^https?:/i.test(href)) {
    if (options.filePreview !== true)
      return remoteImage(href, text, title ?? undefined, navigate);
    const titleAttribute = title == null ? "" : ` title="${attribute(title)}"`;
    const image = `<img src="${attribute(href)}" alt="${alt}"${titleAttribute} loading="lazy">`;
    return navigate?.(image) ?? image;
  }
  const file = localFilePath(href, options.cwd);
  if (file === null) return navigate?.(alt) ?? alt;
  const label = alt === "" ? attribute(file) : alt;
  if (options.sessionId === undefined) {
    return (
      navigate?.(label) ??
      `<button type="button" class="markdown-file-ref" data-file-path="${attribute(file)}" title="${attribute(file)}">${label}</button>`
    );
  }
  const image = `<img src="${attribute(rawFileUrl(file, options.sessionId))}" alt="${label}" loading="lazy">`;
  return (
    navigate?.(image) ??
    `<button type="button" class="markdown-file-image" data-file-path="${attribute(file)}" title="${attribute(file)}">${image}</button>`
  );
}

function hasImage(tokens: Token[]): boolean {
  return tokens.some(
    (token) =>
      token.type === "image" ||
      ("tokens" in token &&
        Array.isArray(token.tokens) &&
        hasImage(token.tokens)),
  );
}

/** pi-web's CodeBlock: a language header, copy button and tinted body. */
function codeBlock(code: string, language: string): string {
  const label = language === "" ? "text" : language;
  const body =
    `<pre class="markdown-code-body">` +
    `<code class="language-${attribute(label)}">${escapeHtml(code)}</code></pre>`;
  const copy = `<button type="button" class="markdown-code-action" data-copy-code>Copy</button>`;
  const header =
    `<div class="markdown-code-header"><span class="markdown-code-lang">${escapeHtml(label)}</span>` +
    `<div class="markdown-code-actions">${copy}</div></div>`;
  return `<div class="markdown-code-block">${header}${body}</div>`;
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
        return codeBlock(text, language.toLowerCase());
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
        const navigate = navigation(token.href, options);
        if (!navigate) return this.parser.parseInline(token.tokens);
        // Split at images, including those inside emphasis, so their loading
        // buttons never sit inside an interactive navigation control.
        const linked = (tokens: Token[]): string => {
          let content = "";
          let run: Token[] = [];
          const flush = () => {
            if (run.length) {
              const text = this.parser.parseInline(run);
              content += text.trim() === "" ? text : navigate(text);
            }
            run = [];
          };
          for (const child of tokens) {
            if (child.type === "image") {
              flush();
              const image = child as Tokens.Image;
              content += renderImage(
                image,
                options,
                (content, attributes = "") =>
                  navigate(
                    content,
                    attributes +
                      (image.text === ""
                        ? ` aria-label="${attribute(token.href)}"`
                        : ""),
                  ),
              );
            } else if (
              ["strong", "em", "del", "text"].includes(child.type) &&
              "tokens" in child &&
              Array.isArray(child.tokens) &&
              hasImage(child.tokens)
            ) {
              flush();
              const tag = child.type === "text" ? "" : child.type;
              content += tag
                ? `<${tag}>${linked(child.tokens)}</${tag}>`
                : linked(child.tokens);
            } else run.push(child);
          }
          flush();
          return content;
        };
        return linked(token.tokens);
      },
      image(token: Tokens.Image) {
        return renderImage(token, options);
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
    // pi-web's SafeMarkdownBody reveal, as a disclosure.
    const size = escapeHtml(formatBytes(source.length));
    return (
      `<details class="markdown-oversized"><summary class="markdown-oversized-summary">⚠ Message content is very large (${size}).` +
      ` Click to view as plain text — markdown rendering is disabled to keep the page responsive.</summary>` +
      `<div class="markdown-oversized-body"><pre class="markdown-oversized-text">${escapeHtml(source)}</pre></div></details>`
    );
  }
  return markedFor(options).parse(source, { async: false });
}
