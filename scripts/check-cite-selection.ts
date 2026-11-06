import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { agentBrowser, fixtureUrl } from "./agent-browser.ts";

// Native Selection text and Range geometry need a real browser, not happy-dom.
// Start `just screenshots`, then pass its ephemeral loopback URL here.
const url = fixtureUrl();
const output = resolve(process.argv[3] ?? "dist/cite-selection");
mkdirSync(output, { recursive: true });
const { browser, evaluate, reachable } = agentBrowser("cite-selection");

function select(code: string) {
  evaluate(`(() => {
    const answer = document.querySelector('[data-cite-answer]');
    const range = document.createRange();
    ${code}
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return true;
  })()`);
}

function quote(text: string, keyboard = false) {
  reachable(".transcript-cite");
  if (keyboard) {
    browser("press", "Tab");
    evaluate(`(() => {
      if (!document.activeElement.matches('.transcript-cite')) throw new Error('Cite did not receive keyboard focus');
      return true;
    })()`);
    browser("press", "Enter");
  } else {
    browser("click", ".transcript-cite");
  }
  const expected = `Draft\n\nRegarding\n${text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n\n`;
  evaluate(`(() => {
    const area = document.querySelector('#composer-text');
    if (area.value !== ${JSON.stringify(expected)}) throw new Error('Wrong quote: ' + JSON.stringify(area.value));
    if (document.activeElement !== area) throw new Error('Composer was not focused');
    if (window.citeSubmits !== 0) throw new Error('Citation submitted the draft');
    return true;
  })()`);
  browser("fill", "#composer-text", "Draft");
}

try {
  for (const theme of ["light", "dark"]) {
    for (const [width, height] of [
      [1440, 1000],
      [390, 844],
    ] as const) {
      browser("close");
      browser("open", "about:blank");
      browser("set", "viewport", String(width), String(height));
      browser("open", new URL("/sessions/cite", url).href);
      browser("wait", "#composer-text");
      browser(
        "wait",
        "--fn",
        "!document.querySelector('.sidebar-mobile-pending')",
      );
      browser("snapshot", "-i");
      evaluate(`(() => {
        document.documentElement.classList.toggle('dark', ${String(theme === "dark")});
        window.citeSubmits = 0;
        document.querySelector('#composer').addEventListener('submit', event => {
          event.preventDefault();
          window.citeSubmits++;
        });
        return document.fonts.ready.then(() => true);
      })()`);
      browser("fill", "#composer-text", "Draft");

      select(`range.setStart(answer.querySelector('h2').firstChild, 0);
        const end = answer.querySelector('li:last-child').firstChild;
        range.setEnd(end, end.length);`);
      quote(
        "Selection boundaries\nStart with bold and inline.\n\nFirst item\nSecond item",
        true,
      );

      select(`range.setStart(answer.querySelector('li').firstChild, 0);
        range.setEnd(answer.querySelectorAll('p')[1], 3);`);
      quote("First item\nSecond item\nAfter the list, open the helper.");

      select(
        "range.selectNodeContents(answer.querySelector('.markdown-file-ref'));",
      );
      quote("the helper");

      select(`range.setStart(answer.querySelector('[data-copy-code]').firstChild, 0);
        range.setEndAfter(answer.querySelector('pre'));`);
      quote("const first = 1;\nconst second = 2;");

      select(
        "range.selectNodeContents(answer.querySelector('[data-copy-code]'));",
      );
      evaluate(`(() => {
        if (!document.querySelector('.transcript-cite').hidden) throw new Error('Cite offered for a control-only selection');
        return true;
      })()`);

      // The parent endpoints contain the answer but are not inside its marker.
      select("range.selectNodeContents(answer.parentElement);");
      reachable(".transcript-cite");
      browser("screenshot", resolve(output, `${theme}-${String(width)}.png`));
      quote(
        "Selection boundaries\nStart with bold and inline.\n\nFirst item\nSecond item\nAfter the list, open the helper.\n\nconst first = 1;\nconst second = 2;\nFollowing paragraph.",
      );
      process.stdout.write(
        `PASS ${theme} ${String(width)}x${String(height)}: native boundaries, clean multiline quotes, file labels, pointer/keyboard activation\n`,
      );
    }
  }

  // A short viewport forces partial visibility and real scroll repositioning.
  browser("set", "viewport", "390", "420");
  select("range.selectNodeContents(answer.parentElement);");
  reachable(".transcript-cite");
  evaluate(`(() => {
    const log = document.querySelector('#log');
    if (log.scrollHeight <= log.clientHeight) throw new Error('Fixture does not scroll');
    log.scrollTop = log.scrollHeight;
    log.dispatchEvent(new Event('scroll'));
    return true;
  })()`);
  reachable(".transcript-cite");
  browser("screenshot", resolve(output, "dark-390-scrolled.png"));
  process.stdout.write(
    "PASS partially visible selection remains reachable after scrolling\n",
  );
} finally {
  browser("close");
}
