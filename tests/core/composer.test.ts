import {
  bashCommand,
  mergeQueue,
  useVisualViewport,
  BUILTIN_COMMANDS,
  buildAtInsertText,
  buildEntriesFromFiles,
  cycleHistory,
  exactBuiltin,
  extractAtQuery,
  filterFileEntries,
  imageLimitError,
  inputHistory,
  isFilePathQuery,
  rankCommands,
  slashQuery,
  type SlashCommand,
} from "@core/composer";
import { describe, expect, it } from "vitest";

describe("slash commands", () => {
  it("opens only while the value is one `/`-prefixed word", () => {
    expect(slashQuery("/comp")).toBe("comp");
    expect(slashQuery("/NAME")).toBe("name");
    expect(slashQuery("/name foo")).toBeNull();
    expect(slashQuery("hello /name")).toBeNull();
  });

  it("ranks exact names first, then prefixes, then descriptions", () => {
    const commands: SlashCommand[] = [
      { name: "compare", description: "", source: "prompt" },
      { name: "compact", description: "", source: "builtin" },
      { name: "notes", description: "compact the notes", source: "skill" },
      { name: "recompact", description: "", source: "extension" },
    ];
    expect(rankCommands(commands, "compact").map((c) => c.name)).toEqual([
      "compact",
      "recompact",
      "notes",
    ]);
  });

  it("hides built-ins that cannot run while a turn is streaming", () => {
    const names = rankCommands(BUILTIN_COMMANDS, "", { running: true }).map(
      (command) => command.name,
    );
    expect(names).toEqual(["copy", "session"]);
  });

  it("recognises a fully typed built-in so Enter runs it", () => {
    expect(exactBuiltin("/session")?.name).toBe("session");
    expect(exactBuiltin("/sess")).toBeUndefined();
    expect(exactBuiltin("/name Bob")).toBeUndefined();
  });
});

describe("@ file completion", () => {
  it("needs the @ at the start or after whitespace", () => {
    expect(extractAtQuery("see @src/ma")?.query).toBe("src/ma");
    expect(extractAtQuery("@")?.query).toBe("");
    expect(extractAtQuery("mail@example")).toBeNull();
  });

  it("prefers a quoted token so spaces stay inside it", () => {
    const token = extractAtQuery('open @"my dir/fi');
    expect(token).toEqual({ start: 5, query: "my dir/fi", quoted: true });
  });

  it("tells filesystem browsing apart from index search", () => {
    for (const path of [
      "~/",
      "~",
      "/etc",
      "./src",
      "../up",
      "C:\\x",
      "\\\\a",
    ]) {
      expect(isFilePathQuery(path)).toBe(true);
    }
    expect(isFilePathQuery("src/main")).toBe(false);
  });

  it("closes a file token and leaves a directory open for drilling down", () => {
    expect(buildAtInsertText({ path: "a/b.ts", isDir: false }, false)).toEqual({
      text: "@a/b.ts ",
      caret: 8,
    });
    expect(buildAtInsertText({ path: "a/b", isDir: true }, false)).toEqual({
      text: "@a/b/",
      caret: 5,
    });
    // A quoted directory keeps the caret inside the quotes.
    const quoted = buildAtInsertText({ path: "my dir", isDir: true }, false);
    expect(quoted.text).toBe('@"my dir/"');
    expect(quoted.caret).toBe(9);
  });

  it("derives directories from files, shallow first", () => {
    expect(buildEntriesFromFiles(["src/web/app.tsx", "README.md"])).toEqual([
      { path: "README.md", isDir: false },
      { path: "src", isDir: true },
      { path: "src/web", isDir: true },
      { path: "src/web/app.tsx", isDir: false },
    ]);
  });

  it("ranks exact, prefix, and substring matches, preferring a matching directory", () => {
    const entries = [
      { path: "myapp.tsx", isDir: false },
      { path: "apple.tsx", isDir: false },
      { path: "app", isDir: false },
      { path: "src/app", isDir: true },
      { path: "other.tsx", isDir: false },
    ];
    expect(
      filterFileEntries(entries, "app").map((entry) => entry.path),
    ).toEqual(["src/app", "app", "apple.tsx", "myapp.tsx"]);
  });

  it("matches a query with a slash against paths", () => {
    const entries = [
      { path: "src/web/app.tsx", isDir: false },
      { path: "web/app.tsx", isDir: false },
      { path: "src/app.tsx", isDir: false },
    ];
    expect(
      filterFileEntries(entries, "web/app").map((entry) => entry.path),
    ).toEqual(["web/app.tsx", "src/web/app.tsx"]);
  });

  it("caps the menu and returns the base order for an empty query", () => {
    const entries = buildEntriesFromFiles(
      Array.from({ length: 40 }, (_, index) => `f${String(index)}.ts`),
    );
    expect(filterFileEntries(entries, "")).toHaveLength(20);
    expect(filterFileEntries(entries, "f1")).toHaveLength(13);
  });
});

describe("input history", () => {
  it("keeps the last distinct texts, oldest first", () => {
    expect(inputHistory(["a", "b", "a", "  ", "c"])).toEqual(["b", "a", "c"]);
    expect(inputHistory(["a", "b", "c"], 2)).toEqual(["b", "c"]);
  });

  it("walks back on up and empties the composer past the newest", () => {
    const past = ["old", "mid", "new"];
    const first = cycleHistory(past, null, "up");
    expect(first).toEqual({ cycle: 0, text: "new" });
    expect(cycleHistory(past, first.cycle, "up")).toEqual({
      cycle: 1,
      text: "mid",
    });
    expect(cycleHistory(past, 2, "up")).toEqual({ cycle: 2, text: "old" });
    expect(cycleHistory(past, 1, "down")).toEqual({ cycle: 0, text: "new" });
    expect(cycleHistory(past, 0, "down")).toEqual({ cycle: null, text: "" });
  });
});

describe("shell commands and attachments", () => {
  it("splits `!` from `!!` and drops an empty command", () => {
    expect(bashCommand("  !ls -la")).toEqual({
      command: "ls -la",
      excluded: false,
    });
    expect(bashCommand("!!git status")).toEqual({
      command: "git status",
      excluded: true,
    });
    expect(bashCommand("!  ")).toBeNull();
    expect(bashCommand("no bang")).toBeNull();
  });

  it("rejects too many, too large, or non-image attachments", () => {
    const ok = { mimeType: "image/png", bytes: 10 };
    expect(imageLimitError([ok])).toBeUndefined();
    expect(imageLimitError(Array(11).fill(ok))).toContain("10 images");
    expect(imageLimitError([{ mimeType: "text/plain", bytes: 1 }])).toContain(
      "Only images",
    );
    expect(
      imageLimitError([{ mimeType: "image/png", bytes: 11 * 1024 * 1024 }]),
    ).toContain("10 MB");
  });
});

describe("mergeQueue", () => {
  it("keeps both halves and drops only exact repeats", () => {
    const sdk = [
      { text: "a", behavior: "steer" },
      { text: "b", behavior: "followUp" },
    ];
    const mirror = [
      { text: "b", behavior: "followUp" },
      { text: "c", behavior: "steer" },
    ];
    expect(mergeQueue(sdk, mirror)).toEqual([
      { text: "a", behavior: "steer" },
      { text: "b", behavior: "followUp" },
      { text: "c", behavior: "steer" },
    ]);
    // The same text queued both ways is two messages, not one.
    expect(
      mergeQueue(
        [{ text: "a", behavior: "steer" }],
        [{ text: "a", behavior: "followUp" }],
      ),
    ).toHaveLength(2);
  });
});

describe("useVisualViewport", () => {
  it("pins the height only while a keyboard covers an unzoomed page", () => {
    const covered = {
      focusedEditable: true,
      scale: 1,
      layoutHeight: 800,
      viewportHeight: 400,
    };
    expect(useVisualViewport(covered)).toBe(true);
    expect(useVisualViewport({ ...covered, focusedEditable: false })).toBe(
      false,
    );
    expect(useVisualViewport({ ...covered, scale: 1.4 })).toBe(false);
    expect(useVisualViewport({ ...covered, viewportHeight: 800 })).toBe(false);
  });
});
