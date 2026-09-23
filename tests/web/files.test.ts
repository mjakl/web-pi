import {
  assistantEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import { createPiSessionCatalog } from "@adapters/pi/session-catalog";
import { createWorkspace } from "@core/workspace";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWebApp } from "@web/app";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The file routes against a real checkout: a temporary Git repository is
// simpler than a fake file system, and it is the only way a diff means
// anything.

let repo = "";
let outside = "";
let pickable = "";
let app: ReturnType<typeof createWebApp>;
let streams = 0;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "web-pi-panel-"));
  // Never validated: it is what "outside every root" means in these tests.
  outside = await mkdtemp(join(tmpdir(), "web-pi-outside-"));
  pickable = await mkdtemp(join(tmpdir(), "web-pi-pickable-"));
  await writeFile(join(outside, "secret.txt"), "not yours\n");
  await writeFile(join(outside, "secret2.txt"), "nope\n");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "main.ts"), "const a = 1;\nexport {};\n");
  await writeFile(
    join(repo, "notes.md"),
    "---\ntitle: Notes\ntags: [one, two]\n---\n\n# Heading\n\ntext\n",
  );
  await writeFile(join(repo, "logo.png"), PNG);
  await writeFile(join(repo, "report.pdf"), "%PDF-1.7\n");
  await writeFile(join(repo, "a.svg"), "<svg xmlns='x'/>");
  await symlink(outside, join(repo, "escape"));
  await writeFile(
    join(repo, "large.ts"),
    `${`// ${"x".repeat(253)}\n`.repeat(1025)}const lastLine = true;`,
  );
  for (const length of [100_001, 262_145]) {
    await writeFile(
      join(repo, `large-${String(length)}.md`),
      `---\ntitle: Large preview\n---\n\n# Start\n\n${"x".repeat(length)}\n\n**End of file**\n`,
    );
  }
  await writeFile(
    join(repo, "large.html"),
    `<p>${"x".repeat(262_145)}</p><b>End of file</b>`,
  );
  await writeFile(join(repo, "large.png"), PNG);
  await truncate(join(repo, "large.png"), 10 * 1024 * 1024 + 1);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("add", "-A");
  git("commit", "-qm", "first");
  await writeFile(join(repo, "src", "main.ts"), "const a = 2;\nexport {};\n");
  await writeFile(join(repo, "fresh.txt"), "new\n");

  await writeFile(
    join(repo, "report.docx"),
    Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff]),
  );

  const world = createFakeWorld({
    delayMs: 1,
    sessions: [
      {
        summary: {
          id: "s1",
          cwd: repo,
          name: "Panel",
          createdAt: "2026-09-01T00:00:00.000Z",
          modifiedAt: "2026-09-02T00:00:00.000Z",
          fileSize: 10,
        },
        entries: [
          userEntry("u1", null, `look at ${join(outside, "secret.txt")}`),
          assistantEntry("a1", "u1", "done", 100),
        ],
      },
    ],
  });
  // Every stream this port hands out is a file descriptor; the raw route
  // must open exactly one per request, whatever the Range header says.
  const opened = world.files.stream.bind(world.files);
  world.files.stream = (path, range) => {
    streams += 1;
    return opened(path, range);
  };
  app = createWebApp({
    workspace: createWorkspace(world),
    staticRoot: "/nonexistent",
    defaultCwd: repo,
    renderIntervalMs: 1,
  });
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(pickable, { recursive: true, force: true });
});

describe("explorer", () => {
  it("lists the root on pi-web's tree rows", async () => {
    const html = await (await app.request("/files/explorer?session=s1")).text();
    expect(html).toContain('role="tree"');
    expect(html).toContain('data-name="src"');
    expect(html).toContain('data-name="notes.md"');
    // The hover actions: a mention button and a download link per row.
    expect(html).toContain('data-mention="notes.md"');
    expect(html).toContain("Insert path into chat");
    // The modified file sits under src/, so the folder carries the dot.
    expect(html).toContain("Contains changed files");
    // The count travels with the fragment: the sidebar toggle needs it.
    expect(html).toMatch(/data-changes="[1-9]/);
  });

  it("swaps the changes list in for the tree when asked", async () => {
    const html = await (
      await app.request("/files/explorer?session=s1&changes=1")
    ).text();
    expect(html).toContain("file-explorer-change-row");
    expect(html).toMatch(/>[1-9]\d* files</);
    expect(html).toContain(">+2<");
    expect(html).toContain(">-1<");
    expect(html).toContain(">src/main.ts<");
    expect(html).toContain('title="Modified"');
    expect(html).toContain('title="Untracked"');
    expect(html).toContain('data-file-mode="diff"');
    // pi-web shows one or the other, never both.
    expect(html).not.toContain('data-name="notes.md"');
  });

  it("expands one directory at a time", async () => {
    const url = `/files/tree?session=s1&depth=1&path=${encodeURIComponent(join(repo, "src"))}`;
    const html = await (await app.request(url)).text();
    expect(html).toContain('data-name="main.ts"');
    expect(html).toContain(">M<");
    expect(html).not.toContain('data-name="notes.md"');
  });

  it("searches the index and puts the tree back on an empty query", async () => {
    const found = await (
      await app.request("/files/search?session=s1&q=main")
    ).text();
    // Hits come back as a tree: the folder row, then the file inside it.
    expect(found).toContain('data-name="src"');
    expect(found).toContain('data-name="main.ts"');
    expect(found).toContain('aria-expanded="true"');
    expect(found).not.toContain('data-name="notes.md"');
    const missing = await (
      await app.request("/files/search?session=s1&q=zzzz")
    ).text();
    expect(missing).toContain("No matching files");
    const cleared = await (
      await app.request("/files/search?session=s1&q=")
    ).text();
    expect(cleared).toContain('data-name="notes.md"');
  });
});

describe("stored-session file requests", () => {
  let agentDir = "";
  let sessionId = "";
  let catalog: ReturnType<typeof createPiSessionCatalog>;
  let storedApp: ReturnType<typeof createWebApp>;

  beforeAll(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "web-pi-panel-agent-"));
    const manager = SessionManager.create(
      repo,
      join(agentDir, "sessions", "fixture"),
    );
    manager.appendMessage({
      role: "user",
      content: `look at ${join(outside, "secret.txt")}`,
      timestamp: 1,
    });
    const answer = assistantEntry("answer", null, "done", 100);
    if (answer.type !== "message" || answer.message.role !== "assistant") {
      throw new Error("Expected assistant message");
    }
    manager.appendMessage(answer.message);
    manager.appendSessionInfo("Stored panel");
    sessionId = manager.getSessionId();
    catalog = createPiSessionCatalog({ agentDir });
    const world = createFakeWorld();
    storedApp = createWebApp({
      workspace: createWorkspace({ ...world, sessions: catalog }),
      staticRoot: "/nonexistent",
      defaultCwd: repo,
    });
  });

  afterAll(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it.each([
    ["tree", "&path=", 'data-name="main.ts"'],
    ["explorer", "", 'data-name="src"'],
    ["explorer", "&changes=1", "file-explorer-change-row"],
    ["search", "&q=main", 'data-name="main.ts"'],
    ["search", "&q=", 'data-name="src"'],
    ["view", "&path=", "const"],
  ])(
    "resolves %s%s with one folder lookup, without opening the transcript",
    async (route, suffix, expected) => {
      const folder = vi.spyOn(catalog, "folder");
      const read = vi.spyOn(catalog, "read");
      const open = vi.spyOn(SessionManager, "open");
      try {
        const path =
          route === "view" ? join(repo, "src", "main.ts") : join(repo, "src");
        const query = suffix.endsWith("path=")
          ? suffix + encodeURIComponent(path)
          : suffix;
        const response = await storedApp.request(
          `/files/${route}?session=${sessionId}${query}`,
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain(expected);
        expect(folder).toHaveBeenCalledTimes(1);
        expect(read).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it("uses the live folder even when the session has no catalog file", async () => {
    const world = createFakeWorld();
    const live = await world.runtime.open({ cwd: repo });
    const liveApp = createWebApp({
      workspace: createWorkspace({ ...world, sessions: catalog }),
      staticRoot: "/nonexistent",
      defaultCwd: repo,
    });
    const folder = vi.spyOn(catalog, "folder");
    const read = vi.spyOn(catalog, "read");
    try {
      const response = await liveApp.request(
        `/files/tree?session=${live.id}&path=${encodeURIComponent(join(repo, "src"))}`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('data-name="main.ts"');
      expect(folder).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      await live.stop();
      vi.restoreAllMocks();
    }
  });

  it("still reads the transcript for an outside file, but never grants directory listings or symlink escapes", async () => {
    const read = vi.spyOn(catalog, "read");
    try {
      const request = (route: string, path: string) =>
        storedApp.request(
          `/files/${route}?session=${sessionId}&path=${encodeURIComponent(path)}`,
        );
      const referenced = await request("view", join(outside, "secret.txt"));
      expect(referenced.status).toBe(200);
      expect(await referenced.text()).toContain("not yours");
      expect(read).toHaveBeenCalledTimes(1);
      read.mockClear();
      expect((await request("tree", outside)).status).toBe(403);
      expect((await request("tree", join(repo, "escape"))).status).toBe(403);
      expect(read).not.toHaveBeenCalled();
      expect((await request("view", join(outside, "secret2.txt"))).status).toBe(
        403,
      );
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("viewer", () => {
  it("numbers the lines of a source file and colours it", async () => {
    const url = `/files/view?session=s1&mode=source&path=${encodeURIComponent(join(repo, "src", "main.ts"))}`;
    const html = await (await app.request(url)).text();
    expect(html).toContain('data-mode="source"');
    expect(html).toContain('class="file-source-line" data-line-number="1"');
    expect(html).toContain("hljs-keyword");
    // The gutter is separate from selectable source text.
    expect(html).toContain(
      'aria-hidden="true" class="file-line-number">1</span>',
    );
    expect(html).toContain("3 lines");
    expect(html).toContain("Enable word wrap");
  });

  it("renders all source above 256 KiB and keeps the line-based highlighting cutoff", async () => {
    const path = join(repo, "large.ts");
    const line = `// ${"x".repeat(253)}\n`;
    const res = await app.request(
      `/files/view?session=s1&mode=source&path=${encodeURIComponent(path)}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-line-number="1026"');
    expect(html).toContain("const lastLine = true;");
    expect(html.split(line.trimEnd()).length - 1).toBe(1025);
    expect(html).not.toContain("hljs-keyword");
  });

  it.each([100_001, 262_145])(
    "renders Markdown previews with %i characters in full",
    async (length) => {
      const path = join(repo, `large-${String(length)}.md`);
      const body = "x".repeat(length);
      const res = await app.request(
        `/files/view?session=s1&path=${encodeURIComponent(path)}`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("markdown-frontmatter-title");
      expect(html).toContain('<h1 id="user-content-start">Start</h1>');
      expect(html).toContain(`<p>${body}</p>`);
      expect(html).toContain("<strong>End of file</strong>");
      expect(html).not.toContain("markdown-oversized");
    },
  );

  it("renders HTML previews above 256 KiB in the existing sandbox", async () => {
    const path = join(repo, "large.html");
    const body = "x".repeat(262_145);
    const res = await app.request(
      `/files/view?session=s1&mode=preview&path=${encodeURIComponent(path)}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `srcdoc="&lt;p&gt;${body}&lt;/p&gt;&lt;b&gt;End of file&lt;/b&gt;"`,
    );
    expect(html).toContain('sandbox="allow-scripts"');
  });

  it("defaults markdown to the rendered preview with its frontmatter", async () => {
    const url = `/files/view?session=s1&path=${encodeURIComponent(join(repo, "notes.md"))}`;
    const html = await (await app.request(url)).text();
    expect(html).toContain('data-mode="preview"');
    expect(html).toContain("markdown-file-preview-shell");
    expect(html).toContain("markdown-frontmatter-tag");
    expect(html).toContain("markdown-frontmatter-title");
    expect(html).toContain("<h1 id=");
    // The block itself never reaches the rendered body.
    expect(html).not.toContain("tags: [one, two]");
  });

  it("shows the diff of a changed file", async () => {
    const url = `/files/view?session=s1&mode=diff&path=${encodeURIComponent(join(repo, "src", "main.ts"))}`;
    const html = await (await app.request(url)).text();
    expect(html).toContain('data-mode="diff"');
    expect(html).toContain("file-diff-view");
    expect(html).toContain('class="file-diff-line is-removed"');
    expect(html).toContain('class="file-diff-line is-added"');
    expect(html).toContain("const a = 2;");
    // pi-web renders no @@ headers; the collapsed spans say what was skipped.
    expect(html).not.toContain("@@");
  });

  it("falls back to source when the requested diff does not exist", async () => {
    const url = `/files/view?session=s1&mode=diff&path=${encodeURIComponent(join(repo, "notes.md"))}`;
    const html = await (await app.request(url)).text();
    expect(html).toContain('data-mode="source"');
  });

  it("reads a file against the picked folder when no session is open", async () => {
    const url =
      `/files/view?cwd=${encodeURIComponent(repo)}&mode=diff` +
      `&path=${encodeURIComponent(join(repo, "src", "main.ts"))}`;
    const html = await (await app.request(url)).text();
    // Without the folder there is no git status, so no diff and no relative
    // path: the toolbar would spell the whole absolute path instead.
    expect(html).toContain('data-mode="diff"');
    expect(html).toContain("file-diff-view");
    expect(html).toContain(">src/main.ts<");
    // Every mode button has to keep naming the folder, or the next switch
    // loses the diff again.
    expect(html).toContain(`cwd=${encodeURIComponent(repo)}&amp;mode=source`);
  });

  it("keeps the PDF iframe pointed at the raw file", async () => {
    const path = encodeURIComponent(join(repo, "report.pdf"));
    const res = await app.request(`/files/view?session=s1&path=${path}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `<iframe src="/files/raw?path=${path}&amp;session=s1"`,
    );
    expect(html).toContain(">pdf<");
    expect(html).not.toContain("sandbox=");
    const raw = await app.request(`/files/raw?session=s1&path=${path}`);
    expect(raw.headers.get("content-type")).toBe("application/pdf");
    expect(await raw.text()).toBe("%PDF-1.7\n");
  });

  it("renders an image on the checkerboard with its own toolbar", async () => {
    const url = `/files/view?session=s1&path=${encodeURIComponent(join(repo, "logo.png"))}`;
    const html = await (await app.request(url)).text();
    expect(html).toContain("file-viewer-media-body");
    expect(html).toContain('class="file-viewer-image"');
    expect(html).toContain("/files/raw?path=");
    expect(html).toContain(">png<");
    expect(html).toContain(">static<");
    // No mode switch or wrap toggle: an image has one way of being shown.
    expect(html).not.toContain("file-viewer-mode-switch");
  });
});

describe("raw bytes", () => {
  const url = (extra = "") =>
    `/files/raw?session=s1&path=${encodeURIComponent(join(repo, "logo.png"))}${extra}`;

  it("serves images above 10 MiB inline, as downloads, and as byte ranges", async () => {
    const path = join(repo, "large.png");
    const size = 10 * 1024 * 1024 + 1;
    const largeUrl = `/files/raw?session=s1&path=${encodeURIComponent(path)}`;
    for (const download of [false, true]) {
      const res = await app.request(
        `${largeUrl}${download ? "&download=1" : ""}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(
        download ? "application/octet-stream" : "image/png",
      );
      expect(res.headers.get("content-disposition")).toContain(
        download ? "attachment" : "inline",
      );
      expect((await res.arrayBuffer()).byteLength).toBe(size);
    }
    const res = await app.request(largeUrl, {
      headers: { Range: "bytes=0-3" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-3/${String(size)}`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG.subarray(0, 4));
  });

  it("opens one stream per request, whatever the range", async () => {
    streams = 0;
    await (await app.request(url())).arrayBuffer();
    expect(streams).toBe(1);
    await (
      await app.request(url(), { headers: { Range: "bytes=0-3" } })
    ).arrayBuffer();
    expect(streams).toBe(2);
    // An unsatisfiable range answers from the size alone.
    await app.request(url(), { headers: { Range: "bytes=99-1" } });
    expect(streams).toBe(2);
  });

  it("streams with range headers and the right type", async () => {
    const res = await app.request(url());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-disposition")).toContain(
      'inline; filename="logo.png"',
    );
    expect((await res.arrayBuffer()).byteLength).toBe(PNG.length);
  });

  it("answers a byte range with 206 and the slice", async () => {
    const res = await app.request(url(), {
      headers: { Range: "bytes=0-3" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(
      `bytes 0-3/${String(PNG.length)}`,
    );
    expect((await res.arrayBuffer()).byteLength).toBe(4);
  });

  it("rejects a range it cannot satisfy", async () => {
    const res = await app.request(url(), {
      headers: { Range: "bytes=99999-" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(
      `bytes */${String(PNG.length)}`,
    );
  });

  it("downloads as an attachment", async () => {
    const res = await app.request(url("&download=1"));
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("locks an SVG down so it cannot run in this origin", async () => {
    const res = await app.request(
      `/files/raw?session=s1&path=${encodeURIComponent(join(repo, "a.svg"))}`,
    );
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
  });
});

describe("meta and containment", () => {
  it("reports size, language, and kind", async () => {
    const res = await app.request(
      `/files/meta?session=s1&path=${encodeURIComponent(join(repo, "notes.md"))}`,
    );
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta["language"]).toBe("markdown");
    expect(meta["kind"]).toBe("text");
    expect(typeof meta["size"]).toBe("number");
  });

  it("maps a relative path to 400, a missing file to 404, and an outsider to 403", async () => {
    expect((await app.request("/files/view?session=s1&path=src")).status).toBe(
      400,
    );
    expect(
      (
        await app.request(
          `/files/view?session=s1&path=${encodeURIComponent(join(repo, "nope.ts"))}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/files/view?session=s1&path=${encodeURIComponent(join(outside, "other.txt"))}`,
        )
      ).status,
    ).toBe(403);
  });

  it("lets a file the transcript names be read, but never listed", async () => {
    const path = join(outside, "secret.txt");
    const view = await app.request(
      `/files/view?session=s1&path=${encodeURIComponent(path)}`,
    );
    expect(view.status).toBe(200);
    expect(await view.text()).toContain("not yours");
    const listed = await app.request(
      `/files/tree?session=s1&depth=1&path=${encodeURIComponent(outside)}`,
    );
    expect(listed.status).toBe(403);
  });

  it("refuses a path that escapes through a symlink", async () => {
    // Lexically inside the repository, but it resolves outside it.
    const res = await app.request(
      `/files/view?session=s1&path=${encodeURIComponent(join(repo, "escape", "secret2.txt"))}`,
    );
    expect(res.status).toBe(403);
  });
});

describe("unsupported documents", () => {
  it("uses the generic viewer and preserves the original download bytes", async () => {
    const path = encodeURIComponent(join(repo, "report.docx"));
    const view = await app.request(`/files/view?session=s1&path=${path}`);
    expect(view.status).toBe(200);
    const html = await view.text();
    expect(html).toContain('data-kind="text"');
    expect(html).toContain('data-mode="source"');
    expect(html).toContain('aria-label="Download file"');
    expect(html).not.toContain("<iframe");
    const download = await app.request(
      `/files/raw?session=s1&path=${path}&download=1`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(download.headers.get("content-disposition")).toContain(
      "attachment;",
    );
    expect(download.headers.get("content-disposition")).toContain(
      "report.docx",
    );
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(
      new Uint8Array([0x50, 0x4b, 3, 4, 0, 0xff]),
    );
  });
});

describe("watching", () => {
  it("opens a watch stream and announces itself", async () => {
    const res = await app.request(
      `/files/watch?session=s1&path=${encodeURIComponent(join(repo, "notes.md"))}`,
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    const chunk = await reader?.read();
    expect(new TextDecoder().decode(chunk?.value)).toContain(
      "event: connected",
    );
    await reader?.cancel();
  });

  it("tells the viewer when it may not watch a file", async () => {
    const res = await app.request(
      `/files/watch?session=s1&path=${encodeURIComponent(join(outside, "other.txt"))}`,
    );
    const reader = res.body?.getReader();
    const chunk = await reader?.read();
    expect(new TextDecoder().decode(chunk?.value)).toContain("event: error");
    await reader?.cancel();
  });
});

describe("workspace validation", () => {
  it("accepts a folder and refuses a file", async () => {
    const form = new FormData();
    form.set("cwd", pickable);
    const res = await app.request("/workspaces/validate", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cwd: pickable,
      projectRoot: pickable,
      projectKey: pickable,
    });
    // Validating it is what makes it reachable.
    const listed = await app.request(
      `/files/tree?session=s1&depth=1&path=${encodeURIComponent(pickable)}`,
    );
    expect(listed.status).toBe(200);
  });

  it("refuses a path that is not a folder", async () => {
    const form = new FormData();
    form.set("cwd", join(repo, "notes.md"));
    const res = await app.request("/workspaces/validate", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(400);
  });
});
