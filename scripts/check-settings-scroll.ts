import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { agentBrowser, fixtureUrl } from "./agent-browser.ts";

// Run against the isolated screenshot fixture, never a real settings store.
const url = fixtureUrl();
const output = resolve("dist/settings-scroll");
mkdirSync(output, { recursive: true });
const { browser, evaluate } = agentBrowser("settings-scroll");

try {
  browser("open", new URL("/settings", url).href);
  browser("wait", "#push-toggle");
  // Exercise the HTMX section replacement before measuring its layout.
  browser("click", '.settings-section-tab[href*="section=skills"]');
  browser("wait", ".config-split-view");
  browser("click", '.settings-section-tab[href*="section=general"]');
  browser("wait", "#push-toggle");
  for (const theme of ["light", "dark"]) {
    // Emulate appearance only; do not write settings or request push permission.
    evaluate(
      `document.documentElement.classList.toggle('dark', ${String(theme === "dark")})`,
    );
    for (const [width, height] of [
      [1440, 1000],
      [1024, 480],
      [641, 360],
      [640, 360],
      [390, 480],
      [320, 320],
    ]) {
      browser("set", "viewport", String(width), String(height));
      evaluate('document.querySelector(".settings-general").scrollTop = 0');
      browser("scroll", "down", "3000", "--selector", ".settings-general");
      evaluate(`(() => {
        const panel = document.querySelector('.settings-general');
        if (panel.scrollHeight > panel.clientHeight && panel.scrollTop === 0) {
          throw new Error('General settings cannot scroll');
        }
        for (const selector of ['#push-toggle', '.settings-dialog-close']) {
          const element = document.querySelector(selector);
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          if (rect.top < 0 || rect.bottom > innerHeight || !element.contains(hit)) {
            throw new Error(selector + ' is clipped or covered after scrolling');
          }
        }
        if (panel.scrollWidth > panel.clientWidth) throw new Error('Horizontal overflow');
        return true;
      })()`);
      // Browser focus must also reveal controls above the notification section.
      browser("focus", "#system-prompt-reset");
      evaluate(`(() => {
        const element = document.activeElement;
        const rect = element.getBoundingClientRect();
        if (!element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))) {
          throw new Error('Focused reset control is clipped or covered');
        }
        return true;
      })()`);
      browser(
        "screenshot",
        resolve(output, `${theme}-${String(width)}x${String(height)}.png`),
      );
      process.stdout.write(
        `PASS ${theme} ${String(width)}x${String(height)}: bottom controls reachable by scroll and focus\n`,
      );
    }
  }
} finally {
  browser("close");
}
