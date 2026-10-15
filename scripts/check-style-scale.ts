import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { agentBrowser, fixtureUrl } from "./agent-browser.ts";

// Like settings-scroll, this exercises the real app against fictional state.
const url = fixtureUrl();
const output = resolve(process.argv[3] ?? "dist/style-scale");
mkdirSync(output, { recursive: true });
const { browser, evaluate, reachable } = agentBrowser("style-scale");
function settle() {
  evaluate(
    "Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))).then(() => document.fonts.ready).then(() => true)",
  );
}
function capture(name: string) {
  settle();
  evaluate(`(() => {
    if (document.documentElement.scrollWidth > innerWidth) throw new Error('Page overflows horizontally');
    return true;
  })()`);
  browser("screenshot", resolve(output, `${name}.png`));
  process.stdout.write(`PASS ${name}\n`);
}
function open(path: string, theme: string, width: number, height = 844) {
  // Each surface starts independently, without drafts, panel state or streams
  // from an earlier capture. Resize checks within a surface reuse its page.
  browser("close");
  browser("open", "about:blank");
  browser("set", "viewport", String(width), String(height));
  browser("open", new URL(path, url).href);
  browser("wait", "#composer-text");
  browser("wait", "--fn", "!document.querySelector('.sidebar-mobile-pending')");
  evaluate(
    `document.documentElement.classList.toggle('dark', ${String(theme === "dark")})`,
  );
  settle();
}

try {
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1440]) {
      open("/sessions/release", theme, width, width === 1440 ? 1000 : 844);
      browser("focus", "#composer-text");
      reachable("#composer-text");
      evaluate(`(() => {
        if (!document.querySelector('[data-action="send"]').disabled) throw new Error('Empty composer send must be disabled');
        if (innerWidth <= 640 && getComputedStyle(document.querySelector('#composer-text')).fontSize !== '16px') throw new Error('Mobile input must remain 16px');
        return true;
      })()`);
      capture(`${theme}-${String(width)}-conversation`);
      browser("click", "#model-trigger");
      browser("wait", "#model-menu:popover-open");
      reachable("#model-menu");
      capture(`${theme}-${String(width)}-model-menu`);
      browser("press", "Escape");
    }
    // Compact toolbar and structural panel boundaries, including the old edges.
    open("/sessions/release", theme, 1440, 1000);
    browser("click", "#explorer-changes-toggle");
    browser("wait", '[data-file-path$="/src/release.ts"]');
    browser("click", '[data-file-path$="/src/release.ts"]');
    browser("wait", ".file-viewer-toolbar");
    for (const width of [320, 380, 381, 480, 481, 640, 641, 959, 960, 1440]) {
      browser("set", "viewport", String(width), "844");
      settle();
      reachable(".file-viewer-mode-button");
      reachable('[aria-label="Download file"]');
      capture(`${theme}-${String(width)}-file-panel`);
    }
    browser("click", ".right-panel-container [aria-label='Hide file panel']");
    for (const width of [320, 480, 481, 520, 521, 640, 641]) {
      open("/sessions/scale", theme, width);
      browser("wait", ".compaction-header");
      browser("scrollintoview", ".compaction-header");
      reachable(".compaction-header");
      capture(`${theme}-${String(width)}-compaction`);
    }
    open("/sessions/release", theme, 390);
    browser("click", "#sidebar-toggle");
    settle();
    browser("click", '[aria-label="Session actions for Release checklist"]');
    browser("wait", "#row-menu-release:popover-open");
    reachable("#row-menu-release button");
    capture(`${theme}-390-sidebar-menu`);
    browser("press", "Escape");
    evaluate(`(() => {
      if (!document.elementFromPoint(380, 400)?.classList.contains('sidebar-overlay-backdrop')) throw new Error('Sidebar backdrop is not reachable');
      return true;
    })()`);
    browser("mouse", "move", "380", "400");
    browser("mouse", "down");
    browser("mouse", "up");
    settle();
    browser("click", "#mobile-toolbar-more");
    settle();
    reachable("#mobile-toolbar-more");
    capture(`${theme}-390-toolbar`);
    // The moved directory picker must leave Custom path reachable even when
    // its session-derived menu is long. The fixture has only one repository;
    // repeat that rendered group to exercise overflow, not a second menu view.
    for (const [width, height] of [
      [1440, 1000],
      [390, 844],
      [320, 320],
    ] as const) {
      open("/new", theme, width, height);
      browser("focus", "#project-select");
      reachable("#project-select");
      evaluate(`(() => {
        if (document.querySelector('#sidebar #project-select')) throw new Error('Directory picker still in sidebar');
        if (!document.querySelector('[data-action="send"]').disabled) throw new Error('Empty new session must not send');
        return true;
      })()`);
      browser("click", "#project-select");
      browser("wait", ".project-folder-group");
      evaluate(`(() => {
        const list = document.querySelector('.sidebar-project-list');
        const group = list.querySelector('.project-folder-group');
        for (let i = 0; i < 25; i++) {
          const copy = group.cloneNode(true);
          copy.querySelector('.project-folder-label').textContent = 'A-long-working-directory-name-' + i;
          list.append(copy);
        }
        const filter = document.createElement('div');
        filter.className = 'menu-filter-row';
        filter.innerHTML = '<input class="menu-filter" placeholder="Filter projects…">';
        list.before(filter);
        return true;
      })()`);
      settle();
      reachable("#sidebar-project-menu");
      reachable('[hx-get="/workspaces/picker"]');
      browser("focus", '[hx-get="/workspaces/picker"]');
      capture(`${theme}-${String(width)}-directory-menu`);
    }
    open("/sessions/tools", theme, 1440, 1000);
    browser("click", ".process-details > summary");
    browser("click", ".subagent-card > summary");
    browser("wait", ".subagent-body");
    settle();
    capture(`${theme}-1440-subagent`);
  }
  // One fictional turn exercises the SSE-rendered transcript and composer.
  open("/sessions/scale", "dark", 390);
  browser("fill", "#composer-text", "Style scale streaming check.");
  browser("click", '[data-action="send"]');
  browser("wait", "--text", "You said: Style scale streaming check.");
  browser(
    "wait",
    "--fn",
    "document.querySelector('[data-action=send]').disabled",
  );
  capture("dark-390-streamed");
} finally {
  browser("close");
}
