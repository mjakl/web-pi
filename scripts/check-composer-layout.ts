import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Opt-in Chromium layout check against the isolated, fictional screenshot fixture.
// Start `just screenshots`, then pass its ephemeral loopback URL here.
const url = new URL(process.argv[2] ?? "http://invalid");
if (url.hostname !== "127.0.0.1" || !url.port || url.port === "30141") {
  throw new Error(
    "Pass the ephemeral loopback URL printed by just screenshots",
  );
}
const output = resolve(process.argv[3] ?? "dist/composer-layout");
mkdirSync(output, { recursive: true });
const session = `composer-layout-${String(process.pid)}`;
function browser(...args: string[]) {
  return execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}
function evaluate(code: string) {
  return browser("eval", code);
}
function reachable(selector: string) {
  evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (!rect.width || !rect.height || rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth || !element.contains(hit)) {
      throw new Error('Clipped or covered control: ' + ${JSON.stringify(selector)});
    }
    return true;
  })()`);
}
function measure() {
  return Number(
    evaluate(
      "document.querySelector('#composer-text').getBoundingClientRect().height",
    ),
  );
}

try {
  for (const theme of ["light", "dark"]) {
    for (const [width, height] of [
      [390, 844],
      [640, 844],
      [641, 844],
      [1440, 1000],
    ] as const) {
      browser("close");
      browser("open", "about:blank");
      browser("set", "viewport", String(width), String(height));
      browser("open", new URL("/sessions/release", url).href);
      browser("wait", "#composer-text");
      browser(
        "wait",
        "--fn",
        "!document.querySelector('.sidebar-mobile-pending')",
      );
      browser("snapshot", "-i");
      evaluate(
        `document.documentElement.classList.toggle('dark', ${String(theme === "dark")})`,
      );
      evaluate("document.fonts.ready.then(() => true)");
      const empty = measure();
      if (width <= 640 ? empty >= 40 : empty < 70) {
        throw new Error(
          `${theme} ${String(width)}px: empty composer is not ${width <= 640 ? "compact" : "desktop-sized"} (${String(empty)}px)`,
        );
      }
      evaluate(`(() => {
        if (!document.querySelector('[data-action="send"]').disabled) throw new Error('Empty composer send must be disabled');
        return true;
      })()`);
      browser(
        "screenshot",
        resolve(output, `${theme}-${String(width)}-empty.png`),
      );

      browser("fill", "#composer-text", "A line\nB line\nC line\nD line");
      const growing = measure();
      if (!(growing > empty + 2 && growing < 199)) {
        throw new Error(
          `${theme} ${String(width)}px: textarea did not grow between empty and cap (${String(empty)} → ${String(growing)}px)`,
        );
      }
      browser(
        "fill",
        "#composer-text",
        Array.from({ length: 32 }, (_, i) => `Line ${String(i + 1)}`).join(
          "\n",
        ),
      );
      const capped = measure();
      if (Math.abs(capped - 200) > 1) {
        throw new Error(
          `${theme} ${String(width)}px: textarea did not cap at 200px (got ${String(capped)}px)`,
        );
      }
      evaluate(`(() => {
        const text = document.querySelector('#composer-text');
        const surface = document.querySelector('.composer-surface');
        const bounds = text.getBoundingClientRect();
        const owner = surface.getBoundingClientRect();
        if (text.scrollHeight <= text.clientHeight + 10) throw new Error('Long draft does not overflow inside textarea');
        text.scrollTop = text.scrollHeight;
        if (text.scrollTop <= 0) throw new Error('Long draft cannot scroll inside textarea');
        if (bounds.left < owner.left || bounds.right > owner.right) throw new Error('Textarea escapes composer surface');
        if (document.documentElement.scrollWidth > innerWidth) throw new Error('Page overflows horizontally');
        if (document.querySelector('[data-action="send"]').disabled) throw new Error('Draft send is disabled');
        return true;
      })()`);
      for (const selector of [
        "#composer-text",
        "#attach-image",
        "#model-trigger",
        '[data-action="send"]',
      ]) {
        reachable(selector);
      }
      // On phones the composer action menu is visible; at 641px the regular
      // toolbar must remain usable without it.
      if (width <= 640) reachable("#composer-controls-trigger");
      browser(
        "screenshot",
        resolve(output, `${theme}-${String(width)}-full.png`),
      );
      browser("focus", "#attach-image");
      evaluate(`(() => {
        if (document.activeElement?.id !== 'attach-image') throw new Error('Attachment control cannot receive focus');
        return true;
      })()`);
      browser("click", "#model-trigger");
      browser("wait", "#model-menu:popover-open");
      browser("press", "Escape");
      if (width <= 640) {
        browser("click", "#composer-controls-trigger");
        browser("wait", "#composer-controls:popover-open");
        browser("press", "Escape");
      }
      process.stdout.write(
        `PASS ${theme} ${String(width)}x${String(height)}: ${String(empty)} → ${String(growing)} → ${String(capped)}px; internal scroll and actions reachable\n`,
      );
    }
  }
} finally {
  browser("close");
}
