// Terminal output as HTML. Extensions write their status lines and widgets
// for a terminal, so they arrive with SGR escapes in them. Only colour and
// bold are carried over; every other escape is dropped and every character of
// text is escaped, so extension output can never become markup.

import { escapeHtml } from "./html.ts";

/** Any escape sequence: CSI, OSC or APC (Pi's cursor marker), or a short one. */
const ESCAPE =
  // eslint-disable-next-line no-control-regex -- this module exists to match them
  /\u001B(?:\[[0-9;:?]*[ -/]*[@-~]|[\]_][\S\s]*?(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

/** The 16 terminal colours, in the shades pi-web's palette uses. */
const BASE = [
  "#1a1a1a",
  "#b91c1c",
  "#13703a",
  "#8a5a06",
  "#225bd8",
  "#8b3fa8",
  "#0b6c85",
  "#c8c8c8",
  "#6b7280",
  "#fb8a8a",
  "#4ade80",
  "#e5b163",
  "#60a5fa",
  "#d08bec",
  "#22d3ee",
  "#f5f5f5",
];

function cube(index: number): string {
  if (index < 16) return BASE[index] ?? "";
  if (index > 231) {
    const grey = 8 + (index - 232) * 10;
    return `rgb(${String(grey)},${String(grey)},${String(grey)})`;
  }
  const step = (value: number) => (value === 0 ? 0 : 55 + value * 40);
  const offset = index - 16;
  const red = step(Math.floor(offset / 36));
  const green = step(Math.floor(offset / 6) % 6);
  const blue = step(offset % 6);
  return `rgb(${String(red)},${String(green)},${String(blue)})`;
}

/** Terminal output as plain text: for titles, labels, and screen readers. */
export function stripAnsi(text: string): string {
  return text.replaceAll(ESCAPE, "").replaceAll("\u0007", "");
}

type Style = { bold: boolean; fg?: string; bg?: string };

/** Applies one `ESC[…m` parameter list; unknown codes are ignored. */
function applySgr(style: Style, parameters: string): void {
  const codes = (parameters === "" ? "0" : parameters).split(";").map(Number);
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === undefined || Number.isNaN(code)) continue;
    if (code === 0) {
      style.bold = false;
      delete style.fg;
      delete style.bg;
    } else if (code === 1) style.bold = true;
    else if (code === 22) style.bold = false;
    else if (code === 39) delete style.fg;
    else if (code === 49) delete style.bg;
    else if (code >= 30 && code <= 37) style.fg = BASE[code - 30];
    else if (code >= 90 && code <= 97) style.fg = BASE[code - 90 + 8];
    else if (code >= 40 && code <= 47) style.bg = BASE[code - 40];
    else if (code >= 100 && code <= 107) style.bg = BASE[code - 100 + 8];
    else if (code === 38 || code === 48) {
      const mode = codes[index + 1];
      let colour: string | undefined;
      if (mode === 5) {
        colour = cube(codes[index + 2] ?? 0);
        index += 2;
      } else if (mode === 2) {
        const [red, green, blue] = codes.slice(index + 2, index + 5);
        colour = `rgb(${String(red ?? 0)},${String(green ?? 0)},${String(blue ?? 0)})`;
        index += 4;
      }
      if (colour === undefined) continue;
      if (code === 38) style.fg = colour;
      else style.bg = colour;
    }
  }
}

function open(style: Style): string {
  const rules = [
    style.fg === undefined ? "" : `color:${style.fg}`,
    style.bg === undefined ? "" : `background-color:${style.bg}`,
  ].filter(Boolean);
  if (rules.length === 0 && !style.bold) return "";
  const weight = style.bold ? ' class="terminal-bold"' : "";
  const colors = rules.length === 0 ? "" : ` style="${rules.join(";")}"`;
  return `<span${weight}${colors}>`;
}

/**
 * Terminal output as HTML. The result is safe to insert as markup: text is
 * escaped, and spans carry only the bold class and colours this module wrote.
 */
export function ansiToHtml(text: string): string {
  const style: Style = { bold: false };
  let html = "";
  let cursor = 0;
  const write = (chunk: string) => {
    if (chunk === "") return;
    const tag = open(style);
    html +=
      tag === "" ? escapeHtml(chunk) : `${tag}${escapeHtml(chunk)}</span>`;
  };
  for (const match of text.matchAll(ESCAPE)) {
    write(text.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    // eslint-disable-next-line no-control-regex -- an SGR sequence starts with ESC
    const sgr = /^\u001B\[([0-9;:]*)m$/.exec(match[0]);
    if (sgr) applySgr(style, sgr[1] ?? "");
  }
  write(text.slice(cursor));
  return html.replaceAll("\u0007", "");
}

/**
 * The one status line an extension set of statuses becomes: sorted by key,
 * each collapsed to a single line, separated by middle dots. Escapes are kept,
 * so the caller still runs it through `ansiToHtml`.
 */
export function statusLine(statuses: Record<string, string>): string {
  return Object.keys(statuses)
    .sort()
    .map((key) =>
      (statuses[key] ?? "")
        .replaceAll("\r\n", "\n")
        .replaceAll("\t", " ")
        .split("\n")
        .map((line) => line.replaceAll(/ {2,}/g, " ").trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean)
    .join(" · ");
}

/** A sticky copy, for walking a line escape by escape. */
const AT_ESCAPE = new RegExp(ESCAPE.source, "gy");

/** Every visible character of a line, with where its escape-free slice sits. */
function visibleChars(
  text: string,
): { start: number; end: number; char: string }[] {
  const chars: { start: number; end: number; char: string }[] = [];
  let index = 0;
  while (index < text.length) {
    // Its own instance: `ESCAPE` is shared and this walk moves `lastIndex`.
    AT_ESCAPE.lastIndex = index;
    const match = AT_ESCAPE.exec(text);
    if (match) {
      index += match[0].length;
      continue;
    }
    const point = text.codePointAt(index);
    if (point === undefined) break;
    const char = String.fromCodePoint(point);
    chars.push({ start: index, end: index + char.length, char });
    index += char.length;
  }
  return chars;
}

function cut(text: string, char: { start: number; end: number }): string {
  return text.slice(0, char.start) + text.slice(char.end);
}

/** pi-tui marks where the hardware cursor would go; nothing draws it here. */
// eslint-disable-next-line no-control-regex -- this module exists to match them
const CURSOR_MARKER = /\u001B_pi:c\u0007/g;

const FRAME_LINE = /^[┌├└╭╰][─┬┴┼]+[┐┤┘╮╯]$/;
const BORDER = new Set(["│", "┃"]);

/**
 * A pi-tui frame as borderless content. Terminal components draw their own box
 * because a terminal has none; the browser panel does, so the box is unwrapped:
 * horizontal rules drop out, one vertical border is trimmed from each side
 * along with the space next to it, and blank lines at either end go. A frame
 * that does not look like a box is returned untouched.
 */
export function normalizeFrame(lines: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const line of lines) {
    if (FRAME_LINE.test(stripAnsi(line).trimEnd())) continue;
    let text = line.replaceAll(CURSOR_MARKER, "");
    let chars = visibleChars(text);
    const first = chars[0];
    if (first && BORDER.has(first.char)) {
      text = cut(text, first);
      chars = visibleChars(text);
      const space = chars[0];
      if (space?.char === " ") {
        text = cut(text, space);
        chars = visibleChars(text);
      }
    }
    const lastVisible = chars.findLastIndex((char) => char.char.trim() !== "");
    const right = chars[lastVisible];
    if (right && BORDER.has(right.char)) {
      text = cut(text, right);
      chars = visibleChars(text);
    }
    // Only escapes follow a trailing blank, so cutting one changes neither the
    // offsets nor the reading of anything before it: one scan serves every
    // cut, made right to left. Re-reading the line after each cut made a
    // padded frame quadratic.
    const kept = chars.findLastIndex((char) => char.char.trim() !== "");
    for (const blank of chars.slice(kept + 1).reverse())
      text = cut(text, blank);
    normalized.push(text);
  }
  const content = (line: string) => stripAnsi(line).trim() !== "";
  const first = normalized.findIndex(content);
  if (first === -1) return [...lines];
  return normalized.slice(first, normalized.findLastIndex(content) + 1);
}
