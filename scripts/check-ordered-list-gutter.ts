import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Run after just build-css: pnpm exec tsx scripts/check-ordered-list-gutter.ts [output]
// A local fixture uses the shipped CSS and fonts without a server or agent store.
const output = resolve(process.argv[2] ?? "dist/ordered-list-gutter");
mkdirSync(output, { recursive: true });
const css = readFileSync(resolve("static/app.css"), "utf8").replaceAll(
  "/static/",
  pathToFileURL(`${resolve("static")}/`).href,
);
const wrapped =
  "Wrapped text keeps its hanging indentation while the marker stays outside the content. ".repeat(
    3,
  );
const fixture = resolve(output, "index.html");
writeFileSync(
  fixture,
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style>
<main style="padding:24px 16px">
<div class="chat-transcript"><div class="message-row assistant-message"><div class="assistant-blocks">
<div class="markdown-body markdown-assistant-message">
<h2>Ordered-list marker gutter</h2>
<ol>${Array.from({ length: 15 }, (_, i) => `<li>${i === 11 ? wrapped : `Item ${String(i + 1)}`}</li>`).join("")}</ol>
<ol start="998"><li>${wrapped}</li><li>Three-digit marker</li></ol>
<ol><li>Nested lists<ol start="12"><li>${wrapped}</li><li>Nested item<ul><li>Unordered spacing remains unchanged</li></ul></li></ol></li></ol>
<ul><li>${wrapped}</li></ul>
</div></div></div></div></main>`,
);
const session = `ordered-list-gutter-${String(process.pid)}`;
function browser(...args: string[]) {
  return execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}
const failures: string[] = [];
try {
  browser("open", pathToFileURL(fixture).href);
  browser("snapshot");
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1440]) {
      const name = `${theme}-${String(width)}`;
      browser("set", "viewport", String(width), "1000");
      browser(
        "eval",
        `document.documentElement.classList.toggle('dark', ${String(theme === "dark")})`,
      );
      browser("eval", "document.fonts.ready.then(() => true)");
      browser("screenshot", "--full", resolve(output, `${name}.png`));
      try {
        const evidence = browser(
          "eval",
          `(() => {
          const body = document.querySelector('.markdown-body');
          const errors = [];
          const assert = (condition, message) => { if (!condition) errors.push(message); };
          assert(getComputedStyle(body).fontSize === (innerWidth > 640 ? '15px' : '13px'), 'Fixture must use assistant typography');
          assert(getComputedStyle(body).overflowX === 'hidden', 'Markdown overflow changed');
          assert(document.documentElement.scrollWidth <= innerWidth, 'Page overflows horizontally');
          const canvas = document.createElement('canvas').getContext('2d');
          const lists = [...body.querySelectorAll('ol, ul')].map(list => {
            const style = getComputedStyle(list);
            const padding = parseFloat(style.paddingLeft);
            assert(style.listStylePosition === 'outside', 'Markers must remain outside');
            if (list.tagName === 'UL') assert(padding === 22, 'Unordered-list gutter changed');
            const items = [...list.children].map((item, index) => {
              const marker = getComputedStyle(item, '::marker');
              const number = (list.start || 1) + index;
              canvas.font = marker.fontWeight + ' ' + marker.fontSize + ' ' + marker.fontFamily;
              // Native marker boxes are not exposed by DOM geometry. Measure the
              // marker text plus its separating space using the actual font.
              const markerWidth = canvas.measureText(number + '. ').width;
              if (list.tagName === 'OL') assert(padding >= markerWidth, 'Insufficient gutter for marker ' + number);
              const text = item.firstChild;
              const range = document.createRange();
              range.selectNodeContents(text);
              const lines = [...range.getClientRects()];
              if (text.textContent.startsWith('Wrapped')) {
                assert(lines.length > 1, 'Fixture must exercise wrapped text');
                assert(lines.every(line => Math.abs(line.left - lines[0].left) < 1), 'Wrapped lines lost hanging indentation');
              }
              assert(item.getBoundingClientRect().right <= body.getBoundingClientRect().right + 1, 'List item overflows');
              return { number, markerWidth, lines: lines.length };
            });
            return { type: list.tagName, padding, items };
          });
          return { errors, lists };
        })()`,
        );
        writeFileSync(resolve(output, `${name}.json`), evidence);
        const result = JSON.parse(evidence) as { errors: string[] };
        if (result.errors.length) throw new Error(result.errors.join("; "));
        process.stdout.write(`PASS ${name}\n`);
      } catch (error) {
        failures.push(`${name}: ${String(error)}`);
      }
    }
  }
} finally {
  browser("close");
}
if (failures.length) throw new Error(failures.join("\n"));
