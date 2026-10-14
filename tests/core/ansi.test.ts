import { ansiToHtml, normalizeFrame, statusLine, stripAnsi } from "@core/ansi";
import { describe, expect, it } from "vitest";

const ESC = "\u001B";

describe("ansi to html", () => {
  it("turns colour and bold into spans and leaves the rest as text", () => {
    expect(ansiToHtml(`${ESC}[32mok${ESC}[0m done`)).toBe(
      '<span style="color:#13703a">ok</span> done',
    );
    expect(ansiToHtml(`${ESC}[1mloud${ESC}[22m quiet`)).toBe(
      '<span class="terminal-bold">loud</span> quiet',
    );
    expect(ansiToHtml(`${ESC}[38;2;10;20;30mrgb${ESC}[39m`)).toBe(
      '<span style="color:rgb(10,20,30)">rgb</span>',
    );
    expect(ansiToHtml(`${ESC}[48;5;21mbg${ESC}[0m`)).toBe(
      '<span style="background-color:rgb(0,0,255)">bg</span>',
    );
  });

  it("escapes everything an extension could put in the text", () => {
    const html = ansiToHtml(`${ESC}[31m<script>alert("x")&</script>`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;x&quot;");
    expect(html).toContain("&amp;");
  });

  it("drops cursor markers, OSC titles, and other escapes", () => {
    expect(ansiToHtml(`${ESC}_pi:c\u0007here`)).toBe("here");
    expect(ansiToHtml(`${ESC}]0;title\u0007here`)).toBe("here");
    expect(stripAnsi(`${ESC}[1mbold${ESC}[0m ${ESC}_pi:c\u0007x`)).toBe(
      "bold x",
    );
  });
});

describe("status line", () => {
  it("sorts by key, collapses each status, and separates items with middle dots", () => {
    expect(
      statusLine({
        zebra: "last",
        alpha: "first\r\nsecond   part",
        empty: "   ",
        tabs: "a\tb",
      }),
    ).toBe("first second part · a b · last");
  });

  it("adds no divider for empty or single-item status lines", () => {
    expect(statusLine({})).toBe("");
    expect(statusLine({ empty: " \t\r\n " })).toBe("");
    expect(statusLine({ before: " ", git: "main", after: "\n" })).toBe("main");
  });

  it("keeps the escapes for the converter", () => {
    expect(statusLine({ git: `${ESC}[32mmain${ESC}[0m` })).toBe(
      `${ESC}[32mmain${ESC}[0m`,
    );
  });
});

describe("normalizeFrame", () => {
  it("unwraps a bordered pi-tui panel", () => {
    expect(
      normalizeFrame([
        "\u250C\u2500\u2500\u2510",
        "\u2502 hi   \u2502",
        "\u2502 there\u2502",
        "\u2514\u2500\u2500\u2518",
      ]),
    ).toEqual(["hi", "there"]);
  });

  it("keeps colours while trimming the border around them", () => {
    expect(normalizeFrame(["\u2502 \u001B[31mred\u001B[0m \u2502"])).toEqual([
      "\u001B[31mred\u001B[0m",
    ]);
  });

  it("drops blank lines at either end but keeps the ones between", () => {
    expect(
      normalizeFrame(["", "\u2502 a\u2502", "", "\u2502 b\u2502", ""]),
    ).toEqual(["a", "", "b"]);
  });

  it("strips Pi's cursor marker with every other escape", () => {
    expect(normalizeFrame(["\u2502 a\u001B_pi:c\u0007\u2502"])).toEqual(["a"]);
  });

  it("leaves a frame that is not a box alone", () => {
    expect(normalizeFrame(["plain", "lines"])).toEqual(["plain", "lines"]);
  });

  it("returns the input when nothing is left after trimming", () => {
    expect(normalizeFrame(["   ", ""])).toEqual(["   ", ""]);
  });

  it("trims exactly as re-reading the line after every cut did", () => {
    // A fixed seed, so a failure reproduces.
    let seed = 20_261_014;
    const below = (count: number) => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return Math.floor((seed / 2 ** 32) * count);
    };
    const pick = (items: readonly string[]) => items[below(items.length)] ?? "";
    const run = (items: readonly string[], most: number) =>
      Array.from({ length: below(most + 1) }, () => pick(items)).join("");
    const rules = ["┌──┐", "├─┼─┤", "╰──╯", `${ESC}[2m╭─╮${ESC}[0m `];
    const borders = ["│", "┃", ""];
    const blanks = [" ", " ", " ", "\t", "\u00A0", "\u3000"];
    const escapes = [
      `${ESC}[31m`,
      `${ESC}[0m`,
      `${ESC}[1;38;5;200m`,
      `${ESC}]8;;https://example.com\u0007`,
      `${ESC}]0;title${ESC}\\`,
      `${ESC}_pi:c\u0007`,
      `${ESC}M`,
      `${ESC}[`,
      `${ESC}]`,
      ESC,
      "\u0007",
    ];
    const text = ["a", "word", "日本", "😀", "👩\u200D💻", "e\u0301", "│", "-"];
    // A box line: border, content, the padding pi-tui fills a frame with,
    // border, and whatever trails it.
    const line = () =>
      below(10) === 0
        ? pick(rules)
        : [
            pick(borders),
            run([...blanks, ...escapes], 2),
            run([...text, ...blanks, ...escapes], 8),
            run([...blanks, ...blanks, ...escapes], 8),
            pick(borders),
            run([...blanks, ...escapes], 3),
          ].join("");
    for (let frame = 0; frame < 2_000; frame += 1) {
      const lines = Array.from({ length: 1 + below(5) }, line);
      expect(normalizeFrame(lines)).toEqual(rescanningNormalizeFrame(lines));
    }
  });
});

// normalizeFrame as it was before it cut trailing blanks from one scan: it
// read the line again after every cut, which made a padded frame quadratic.
const AT_ESCAPE =
  // eslint-disable-next-line no-control-regex -- the escapes are the point
  /\u001B(?:\[[0-9;:?]*[ -/]*[@-~]|[\]_][\S\s]*?(?:\u0007|\u001B\\)|[@-Z\\-_])/y;

function rescanningNormalizeFrame(lines: readonly string[]): string[] {
  type Char = { start: number; end: number; char: string };
  const visibleChars = (text: string) => {
    const chars: Char[] = [];
    let index = 0;
    while (index < text.length) {
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
  };
  const cut = (text: string, char: Char) =>
    text.slice(0, char.start) + text.slice(char.end);
  const border = new Set(["│", "┃"]);
  const normalized: string[] = [];
  for (const line of lines) {
    if (/^[┌├└╭╰][─┬┴┼]+[┐┤┘╮╯]$/.test(stripAnsi(line).trimEnd())) continue;
    // eslint-disable-next-line no-control-regex -- Pi's cursor marker
    let text = line.replaceAll(/\u001B_pi:c\u0007/g, "");
    let chars = visibleChars(text);
    const first = chars[0];
    if (first && border.has(first.char)) {
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
    if (right && border.has(right.char)) {
      text = cut(text, right);
      chars = visibleChars(text);
    }
    while (chars.length > 0) {
      const last = chars.at(-1);
      if (!last || last.char.trim() !== "") break;
      text = cut(text, last);
      chars = visibleChars(text);
    }
    normalized.push(text);
  }
  const content = (line: string) => stripAnsi(line).trim() !== "";
  const first = normalized.findIndex(content);
  if (first === -1) return [...lines];
  return normalized.slice(first, normalized.findLastIndex(content) + 1);
}
