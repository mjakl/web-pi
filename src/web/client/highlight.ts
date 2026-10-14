import { escapeHtml } from "@core/html";
import hljs from "highlight.js/lib/core";
import {
  knownLanguage,
  registerLanguages,
  splitHighlighted,
} from "@web/syntax";

/** A fence's own text, without the line numbers the gutter added to it. */
export function codeText(block: Element | null | undefined): string {
  const code = block?.querySelector("code")?.cloneNode(true);
  if (!(code instanceof HTMLElement)) return "";
  for (const number of code.querySelectorAll(".linenumber")) number.remove();
  return code.textContent ?? "";
}

/**
 * Colour every settled code block and number its lines, as pi-web's
 * `SyntaxHighlighter showLineNumbers` does (§4.5). What is still in flight in
 * the running turn is left plain: it changes on every frame, and tokenising
 * half a line is wasted work. The file viewer is coloured on the server
 * instead, where a whole file can be split into numbered rows.
 */
export function highlightIn(root: ParentNode): void {
  const blocks = root.querySelectorAll<HTMLElement>(
    "pre > code[class*='language-']",
  );
  if (blocks.length === 0) return;
  registerLanguages();
  for (const block of blocks) {
    if (block.dataset["highlighted"] === "1") continue;
    if (block.closest("#turn-live")) continue;
    const language = /language-([\w+#-]+)/.exec(block.className)?.[1] ?? "";
    block.dataset["highlighted"] = "1";
    // Settled code never changes, yet every morph of a saved window would put
    // the plain source back to be coloured again. The morph pairs this element
    // with whatever code sits in its place, which is the same code as long as
    // its message renders the same blocks.
    block.setAttribute("hx-morph-skip", "");
    const text = block.textContent ?? "";
    const lines =
      language !== "" && knownLanguage(language)
        ? splitHighlighted(
            hljs.highlight(text, { language, ignoreIllegals: true }).value,
          )
        : text.split("\n").map((line) => escapeHtml(line));
    // A trailing newline is a line break, not an extra numbered line.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    // react-syntax-highlighter widens the gutter for the highest line number
    // it will print ("<digits>.25em"); a two-line fence gets 1.25em.
    const digits = String(lines.length).length;
    block.style.setProperty("--linenumber-width", `${String(digits)}.25em`);
    block.innerHTML = lines
      .map(
        (line, index) =>
          `<span class="linenumber">${String(index + 1)}</span>${line}`,
      )
      .join("\n");
  }
}
