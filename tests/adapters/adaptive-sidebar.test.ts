import { assistantEntry, createFakeWorld } from "@adapters/fake/index";
import { createPiSessionCatalog } from "@adapters/pi/session-catalog";
import { createWorkspace } from "@core/workspace";
import { DELEGATION_TYPE } from "@core/session-delegation";
import { sessionTree } from "@core/session-tree";
import { InspectionOnlySession } from "@core/workspace/views";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWebApp } from "@web/app";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  streamBytes: 0,
  headerBytes: 0,
  headerReads: 0,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: vi.fn((...args: Parameters<typeof actual.readSync>) => {
      const bytes = actual.readSync(...args);
      io.headerBytes += bytes;
      io.headerReads += 1;
      return bytes;
    }),
    createReadStream: vi.fn(
      (...args: Parameters<typeof actual.createReadStream>) => {
        const stream = actual.createReadStream(...args);
        stream.on("data", (chunk: string | Buffer) => {
          io.streamBytes += Buffer.byteLength(chunk);
        });
        return stream;
      },
    ),
  };
});
function resetReads() {
  vi.mocked(fs.createReadStream).mockClear();
  io.streamBytes = 0;
  io.headerBytes = 0;
  io.headerReads = 0;
}
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "web-pi-adaptive-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  resetReads();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function session(index: number) {
  const id = `archive-${String(index).padStart(5, "0")}`;
  const manager = SessionManager.create(root, join(root, "sessions", "demo"), {
    id,
  });
  manager.appendMessage({
    role: "user",
    content: "Saved question",
    timestamp: 1,
  });
  const answer = assistantEntry("ignored", null, "Saved answer", 2);
  if (answer.type !== "message" || answer.message.role !== "assistant")
    throw new Error("Missing answer");
  manager.appendMessage(answer.message);
  const file = manager.getSessionFile();
  if (!file) throw new Error("Missing file");
  const date = new Date(1700000000000 - index * 1000);
  fs.utimesSync(file, date, date);
  return { id, file, manager };
}

function creation(fixture: ReturnType<typeof session>, timestamp: string) {
  const content = fs.readFileSync(fixture.file, "utf8");
  fs.writeFileSync(
    fixture.file,
    JSON.stringify({ ...fixture.manager.getHeader(), timestamp }) +
      content.slice(content.indexOf("\n")),
  );
}
function delegate(
  fixture: ReturnType<typeof session>,
  parentSessionId: string,
) {
  fixture.manager.appendCustomEntry(DELEGATION_TYPE, {
    version: 1,
    childSessionId: fixture.id,
    parentSessionId,
    agent: "coder",
    handle: "task",
  });
}

it("initial sidebar and a direct link do not scan a whole archive beyond the metadata cache", async () => {
  const files = Array.from({ length: 4100 }, (_, index) => session(index));
  const world = createFakeWorld();
  world.sessions = createPiSessionCatalog({ agentDir: root });
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    defaultCwd: root,
    staticRoot: "static",
  });
  const first = await app.request("/");
  expect(first.status).toBe(200);
  expect(fs.createReadStream).toHaveBeenCalledTimes(51); // Classification and visible rows share EOF reads.
  vi.mocked(fs.createReadStream).mockClear();
  const refreshed = await workspace.sidebar();
  expect(refreshed.rows).toHaveLength(50);
  expect(refreshed.nextOffset).toBe(50);
  expect(fs.createReadStream).not.toHaveBeenCalled();
  vi.mocked(fs.createReadStream).mockClear();
  const oldest = files[4099];
  if (!oldest) throw new Error("Missing oldest session");
  const directApp = createWebApp({
    workspace: createWorkspace({
      ...world,
      sessions: createPiSessionCatalog({ agentDir: root }),
    }),
    defaultCwd: root,
    staticRoot: "static",
  });
  const direct = await directApp.request(`/sessions/${oldest.id}`);
  expect(direct.status).toBe(200);
  expect(fs.createReadStream).toHaveBeenCalledTimes(51);
});

it("shares cold direct-link inventory with its concurrent sidebar read", async () => {
  const files = Array.from({ length: 200 }, (_, index) => session(index));
  const target = files.at(-1);
  if (!target) throw new Error("Missing target");
  const world = createFakeWorld();
  world.sessions = createPiSessionCatalog({ agentDir: root });
  const app = createWebApp({
    workspace: createWorkspace(world),
    defaultCwd: root,
    staticRoot: "static",
  });
  resetReads();
  const response = await app.request(`/sessions/${target.id}`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Saved answer");
  // One inventory header per file, plus exact admission/row header reads.
  expect(io.headerReads).toBeLessThanOrEqual(files.length + 3);
  expect(fs.createReadStream).toHaveBeenCalledTimes(51);
});

it("uses adaptive discovery for lifecycle SSE updates and does not stream unchanged transcripts", async () => {
  const files = Array.from({ length: 200 }, (_, index) => session(index));
  const target = files[0];
  if (!target) throw new Error("Missing target");
  const world = createFakeWorld({
    sessions: [
      {
        summary: {
          id: target.id,
          cwd: root,
          createdAt: new Date(0).toISOString(),
          modifiedAt: new Date(0).toISOString(),
          fileSize: 0,
        },
        entries: [],
      },
    ],
  });
  world.sessions = createPiSessionCatalog({ agentDir: root });
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    defaultCwd: root,
    staticRoot: "static",
  });
  // Lifecycle updates follow a mounted page, which already resolved its paths.
  await world.sessions.folder(target.id);
  const response = await app.request("/events");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing event stream");
  const decoder = new TextDecoder();
  const frame = async () => {
    let received = "";
    while (!received.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Event stream ended");
      received += decoder.decode(chunk.value);
    }
    expect(received).toContain('hx-target="#session-list"');
    expect(received).toContain(`id="row-${target.id}"`);
    expect(received).not.toContain("Check sub-sessions");
  };
  try {
    resetReads();
    await workspace.activate(target.id);
    await frame();
    expect(io.headerReads).toBeLessThanOrEqual(files.length + 3);
    expect(fs.createReadStream).toHaveBeenCalledTimes(51);
    resetReads();
    await workspace.stop(target.id);
    await frame();
    expect(io.headerReads).toBeLessThanOrEqual(files.length + 3);
    expect(fs.createReadStream).not.toHaveBeenCalled();
  } finally {
    await reader.cancel();
  }
});

it("resolves an unknown authoritative header ID without streaming archive bodies", async () => {
  const files = Array.from({ length: 60 }, (_, index) => session(index));
  const target = files[59];
  if (!target) throw new Error("Missing target");
  const renamed = join(root, "sessions", "demo", "deceptive-name.jsonl");
  fs.renameSync(target.file, renamed);
  const catalog = createPiSessionCatalog({ agentDir: root });
  expect(await catalog.pathOf(target.id)).toBe(renamed);
  expect(fs.createReadStream).not.toHaveBeenCalled();
});

it("shows plain known-child counts without checking controls and retains exact child navigation", async () => {
  const files = Array.from({ length: 140 }, (_, index) => session(index));
  const parent = files[0],
    selected = files[139];
  if (!parent || !selected) throw new Error("Missing family");
  fs.renameSync(
    parent.file,
    join(root, "sessions", "demo", `renamed_${selected.id}.jsonl`),
  );
  for (const child of files.slice(70)) {
    child.manager.appendCustomEntry(DELEGATION_TYPE, {
      version: 1,
      childSessionId: child.id,
      parentSessionId: parent.id,
      agent: "coder",
      handle: "task",
    });
    const old = new Date(1600000000000);
    fs.utimesSync(child.file, old, old);
  }
  const world = createFakeWorld();
  world.sessions = createPiSessionCatalog({ agentDir: root });
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    defaultCwd: root,
    staticRoot: "static",
  });
  const initial = await workspace.sidebar();
  expect(initial.rows[0]?.summary.id).toBe(parent.id);
  expect(initial.rows[0]?.childCount).toBeUndefined();
  const html = await (await app.request("/sidebar/rows")).text();
  expect(html).not.toContain("Check sub-sessions");
  expect(html).not.toContain('class="session-children"');
  const linked = await workspace.sidebar({ selectedId: selected.id });
  expect(linked.rows[0]).toMatchObject({
    childCount: 1,
    children: { rows: [{ summary: { id: selected.id } }] },
  });
  const linkedHtml = await (
    await app.request(`/sidebar/rows?selected=${selected.id}`)
  ).text();
  expect(linkedHtml).toContain("1 sub-session");
  expect(linkedHtml).not.toContain("1+ sub-sessions");
  expect(linkedHtml).not.toContain("Load all sub-sessions");
  expect(linkedHtml).toContain(`href="/sessions/${selected.id}"`);
  resetReads();
  const expanded = await workspace.sidebar({ parentId: parent.id });
  expect(expanded.rows).toHaveLength(50);
  expect(expanded.nextOffset).toBe(50);
  // Expansion classifies the remaining inventory, sharing existing EOF reads.
  expect(fs.createReadStream).toHaveBeenCalledTimes(88);
  resetReads();
  const later = await workspace.sidebar({ parentId: parent.id, offset: 50 });
  expect(fs.createReadStream).not.toHaveBeenCalled();
  expect(later.rows).toHaveLength(20);
  expect(later.nextOffset).toBeUndefined();
  const emptyChildPage = await (
    await app.request(`/sidebar/rows?parent=${files[1]?.id ?? "missing"}`)
  ).text();
  expect(emptyChildPage).toContain("No more sub-sessions");
  const olderRoots = await workspace.sidebar({ offset: 50 });
  expect(olderRoots.rows).toHaveLength(20);
  expect(olderRoots.nextOffset).toBeUndefined();
});

it("bounds child routes by header creation while preserving exact counts, selected paths and numeric pages", async () => {
  const files = Array.from({ length: 86 }, (_, index) => session(index));
  const parent = files[10],
    selected = files[70],
    grandchild = files[81],
    nested = files[82];
  const equal = files[11],
    invalid = files[0],
    conflict = files[83],
    copied = files[84];
  if (
    !parent ||
    !selected ||
    !grandchild ||
    !nested ||
    !equal ||
    !invalid ||
    !conflict ||
    !copied
  )
    throw new Error("Missing family fixtures");
  const cutoff = "2026-06-01T00:00:00.000Z";
  for (const fixture of files) {
    creation(
      fixture,
      fixture.manager === parent.manager || files.indexOf(fixture) >= 11
        ? cutoff
        : "2020-01-01T00:00:00.000Z",
    );
  }
  // Recent mtime and large old bodies must not widen the creation window.
  for (const fixture of files.slice(0, 10)) {
    const resumed = SessionManager.open(fixture.file);
    resumed.appendMessage({
      role: "user",
      content: "old".repeat(20000),
      timestamp: Date.now(),
    });
  }
  for (const fixture of files.slice(11, 81)) delegate(fixture, parent.id);
  delegate(grandchild, selected.id);
  delegate(nested, grandchild.id);
  delegate(invalid, parent.id);
  delegate(conflict, parent.id);
  delegate(conflict, "conflicting-parent");
  // A copied claim and messages older than the header establish no ownership.
  copied.manager.appendCustomEntry(DELEGATION_TYPE, {
    version: 1,
    childSessionId: selected.id,
    parentSessionId: parent.id,
    agent: "coder",
    handle: "task",
  });
  const resumed = SessionManager.open(equal.file);
  resumed.appendMessage({
    role: "user",
    content: "Resumed child",
    timestamp: 1,
  });
  for (const fixture of files.slice(11, 83)) {
    const modified = new Date(1600000000000 - files.indexOf(fixture) * 1000);
    fs.utimesSync(fixture.file, modified, modified);
  }
  fs.renameSync(
    parent.file,
    join(root, "sessions", "demo", "unrelated-filename.jsonl"),
  );
  const world = createFakeWorld();
  const catalog = createPiSessionCatalog({ agentDir: root });
  world.sessions = catalog;
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    defaultCwd: root,
    staticRoot: "static",
  });
  resetReads();
  const first = await workspace.sidebar({
    parentId: parent.id,
    selectedId: nested.id,
  });
  expect(first.nextOffset).toBe(50);
  expect(first.rows).toHaveLength(51);
  expect(first.rows.at(-1)).toMatchObject({
    summary: { id: selected.id, inspectionOnly: true },
    childCount: 1,
    children: {
      rows: [
        {
          summary: { id: grandchild.id },
          childCount: 1,
          children: { rows: [{ summary: { id: nested.id } }] },
        },
      ],
    },
  });
  expect(fs.createReadStream).toHaveBeenCalledTimes(76);
  expect(
    vi
      .mocked(fs.createReadStream)
      .mock.calls.every(
        ([path]) =>
          !files.slice(0, 10).some((fixture) => fixture.file === String(path)),
      ),
  ).toBe(true);
  const coldBytes = io.streamBytes;
  resetReads();
  const response = await app.request(
    `/sidebar/rows?parent=${parent.id}&selected=${nested.id}&after=50`,
  );
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).not.toContain(`data-session-id="${selected.id}"`);
  expect(fs.createReadStream).not.toHaveBeenCalled();
  const later = await workspace.sidebar({
    parentId: parent.id,
    offset: 50,
    selectedId: nested.id,
  });
  expect(later.rows).toHaveLength(19);
  expect(later.nextOffset).toBeUndefined();
  expect(later.rows.some((row) => row.summary.id === selected.id)).toBe(false);
  // Missing parents have no creation bound and must not initiate an archive EOF scan.
  resetReads();
  expect((await app.request("/sidebar/rows?parent=missing")).status).toBe(200);
  expect(fs.createReadStream).not.toHaveBeenCalled();
  const full = await catalog.list();
  const tree = sessionTree(full);
  expect(tree.byId.get(parent.id)?.children).toHaveLength(70);
  expect(tree.byId.get(invalid.id)?.parentId).toBeUndefined();
  expect(tree.byId.get(conflict.id)?.parentId).toBeUndefined();
  expect(tree.byId.get(copied.id)?.summary.inspectionOnly).toBeUndefined();
  await expect(
    workspace.rename(invalid.id, "Must not write"),
  ).rejects.toBeInstanceOf(InspectionOnlySession);
  if (process.env["WEB_PI_REPORT_ADAPTIVE_IO"] === "1") {
    process.stdout.write(
      `Creation-bounded child I/O: ${JSON.stringify({ files: files.length, eligibleStreams: 76, coldBytes, olderExcluded: 10, warmStreams: 0 })}\n`,
    );
  }
});

it.each(["list", "discover"] as const)(
  "reuses a bounded scan-start cache for repeated necessary %s scans beyond 4096 files",
  async (method) => {
    const files = Array.from({ length: 4201 }, (_, index) => session(index));
    const parent = files[0];
    if (!parent) throw new Error("Missing parent");
    const catalog = createPiSessionCatalog({ agentDir: root });
    const scan = () =>
      method === "list"
        ? catalog.list()
        : catalog.discover({ runtime: [], parentId: parent.id });
    await scan();
    expect(fs.createReadStream).toHaveBeenCalledTimes(4201);
    resetReads();
    await scan();
    expect(fs.createReadStream).toHaveBeenCalledTimes(105);
    const repeatedBytes = io.streamBytes;
    expect(repeatedBytes).toBeLessThan(
      files.reduce((sum, f) => sum + fs.statSync(f.file).size, 0) / 20,
    );
    resetReads();
    await scan();
    expect(fs.createReadStream).toHaveBeenCalledTimes(105);
    const changed = files[2100];
    if (!changed) throw new Error("Missing changed session");
    delegate(changed, parent.id);
    resetReads();
    const refreshed = await scan();
    const summaries = Array.isArray(refreshed)
      ? refreshed
      : refreshed.summaries;
    expect(
      summaries.find((summary) => summary.id === changed.id)?.inspectionOnly,
    ).toBe(true);
    expect(fs.createReadStream).toHaveBeenCalledTimes(106);
    if (process.env["WEB_PI_REPORT_ADAPTIVE_IO"] === "1") {
      process.stdout.write(
        `Repeated ${method} I/O: ${JSON.stringify({ files: 4201, repeatStreams: 105, repeatedBytes })}\n`,
      );
    }
  },
  30000,
);

it("prioritizes old known running and idle sessions without classifying the rest of the archive", async () => {
  const files = Array.from({ length: 200 }, (_, index) => session(index));
  const running = files[199],
    idle = files[198];
  if (!running || !idle) throw new Error("Missing old runtime fixtures");
  const runtimeSessions = [running, idle].map((f) => ({
    summary: {
      id: f.id,
      cwd: root,
      createdAt: new Date(0).toISOString(),
      modifiedAt: new Date(0).toISOString(),
      fileSize: 0,
    },
    entries: [],
  }));
  const world = createFakeWorld({ sessions: runtimeSessions });
  const live = await world.runtime.open({ sessionId: running.id });
  await world.runtime.open({ sessionId: idle.id });
  const snapshot = live.snapshot();
  vi.spyOn(live, "snapshot").mockImplementation(() => ({
    ...snapshot,
    status: { ...snapshot.status, running: true },
  }));
  world.sessions = createPiSessionCatalog({ agentDir: root });
  const workspace = createWorkspace(world);
  resetReads();
  const first = await workspace.sidebar();
  expect(first.rows.slice(0, 2).map((row) => row.summary.id)).toEqual([
    running.id,
    idle.id,
  ]);
  expect(first.rows[0]?.summary.running).toBe(true);
  expect(first.rows[1]?.summary).toMatchObject({ live: true, running: false });
  expect(first.nextOffset).toBe(50);
  expect(fs.createReadStream).toHaveBeenCalledTimes(51);
});

it("classifies exact requested sessions independently and fails closed on unstable or unreadable files", async () => {
  const target = session(0);
  const world = createFakeWorld({
    sessions: [
      {
        summary: {
          id: target.id,
          cwd: root,
          createdAt: new Date(0).toISOString(),
          modifiedAt: new Date(0).toISOString(),
          fileSize: 0,
        },
        entries: [],
      },
    ],
  });
  const catalog = createPiSessionCatalog({ agentDir: root });
  world.sessions = catalog;
  const workspace = createWorkspace(world);
  await world.runtime.open({ sessionId: target.id });
  const source = fs.readFileSync(target.file);
  await catalog.pathOf(target.id);
  fs.writeFileSync(target.file, "unreadable header\n");
  expect(await catalog.classification(target.id)).toEqual({
    kind: "unavailable",
  });
  await expect(
    workspace.rename(target.id, "Must not write"),
  ).rejects.toBeInstanceOf(InspectionOnlySession);
  fs.writeFileSync(target.file, source);
  const originalStream = vi.mocked(fs.createReadStream).getMockImplementation();
  if (!originalStream) throw new Error("Missing instrumented stream");
  vi.mocked(fs.createReadStream).mockImplementationOnce((...args) => {
    const stream = originalStream(...args);
    stream.once("data", () => {
      target.manager.appendCustomEntry(DELEGATION_TYPE, {
        version: 1,
        childSessionId: target.id,
        parentSessionId: "missing-parent",
        agent: "coder",
        handle: "task",
      });
    });
    return stream;
  });
  expect(await catalog.classification(target.id)).toEqual({
    kind: "unavailable",
  });
  await expect(
    workspace.rename(target.id, "Must not write"),
  ).rejects.toBeInstanceOf(InspectionOnlySession);
  expect((await workspace.viewSession(target.id))?.summary.inspectionOnly).toBe(
    true,
  );
});

it("keeps a known unflushed runtime usable without treating arbitrary missing IDs as writable", async () => {
  const summary = {
    id: "unflushed",
    cwd: root,
    createdAt: new Date(0).toISOString(),
    modifiedAt: new Date(0).toISOString(),
    fileSize: 0,
  };
  const world = createFakeWorld({ sessions: [{ summary, entries: [] }] });
  const catalog = createPiSessionCatalog({ agentDir: root });
  catalog.remember(summary.id, join(root, "sessions", "not-written.jsonl"));
  world.sessions = catalog;
  const workspace = createWorkspace(world);
  await world.runtime.open({ sessionId: summary.id });
  const child = session(0);
  delegate(child, summary.id);
  expect(
    (await workspace.sidebar({ parentId: summary.id })).rows.map(
      (row) => row.summary.id,
    ),
  ).toEqual([child.id]);
  expect((await workspace.sidebar()).rows.map((row) => row.summary.id)).toEqual(
    [summary.id],
  );
  expect((await workspace.viewSession(summary.id))?.summary.live).toBe(true);
  await expect(
    workspace.rename(summary.id, "Known runtime"),
  ).resolves.toBeUndefined();
  await expect(
    workspace.rename("unknown", "Not admitted"),
  ).rejects.toBeInstanceOf(InspectionOnlySession);
});

it("measures cold, warm, changed and later-page discovery for 15000 real files with 8GB modeled transcript weights", async () => {
  const files = Array.from({ length: 15000 }, (_, index) => session(index));
  const oldest = files.at(-1);
  if (!oldest) throw new Error("Missing oldest");
  creation(oldest, new Date(0).toISOString());
  // Small real JSONL bodies exercise real directory/header/EOF I/O. A skewed
  // transcript-size distribution models archive cost without allocating 8GB.
  const raw = files.map((_, i) =>
    i % 25 === 0 ? 20000000 : i % 5 === 0 ? 1800000 : 180000,
  );
  const total = raw.reduce((sum, n) => sum + n, 0);
  const weights = raw.map((n) => Math.floor((n * 8000000000) / total));
  weights[weights.length - 1] =
    (weights.at(-1) ?? 0) + 8000000000 - weights.reduce((sum, n) => sum + n, 0);
  const byPath = new Map(files.map((f, i) => [f.file, weights[i] ?? 0]));
  const world = createFakeWorld();
  world.sessions = createPiSessionCatalog({ agentDir: root });
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    defaultCwd: root,
    staticRoot: "static",
  });
  const measured = () => ({
    headerReads: io.headerReads,
    actualHeaderBytes: io.headerBytes,
    streams: vi.mocked(fs.createReadStream).mock.calls.length,
    actualEofBytes: io.streamBytes,
    modeledHeaderBytes: io.headerReads * 8192,
    modeledEofBytes: vi
      .mocked(fs.createReadStream)
      .mock.calls.reduce(
        (sum, [path]) => sum + (byPath.get(String(path)) ?? 0),
        0,
      ),
  });
  resetReads();
  expect((await app.request("/")).status).toBe(200);
  const cold = measured();
  expect(cold.streams).toBe(51);
  expect(cold.modeledEofBytes + cold.modeledHeaderBytes).toBeLessThan(
    8000000000 * 0.05,
  );
  resetReads();
  expect((await workspace.sidebar()).rows).toHaveLength(50);
  const warm = measured();
  expect(warm.streams).toBe(0);
  resetReads();
  expect((await app.request(`/sessions/${oldest.id}`)).status).toBe(200);
  expect(vi.mocked(fs.createReadStream).mock.calls.length).toBeLessThan(5);
  resetReads();
  expect((await workspace.sidebar({ offset: 50 })).rows).toHaveLength(50);
  const later = measured();
  expect(later.streams).toBe(50);
  const changed = files[0];
  if (!changed) throw new Error("Missing changed");
  changed.manager.appendCustomEntry(DELEGATION_TYPE, {
    version: 1,
    childSessionId: changed.id,
    parentSessionId: oldest.id,
    agent: "coder",
    handle: "task",
  });
  resetReads();
  const refreshed = await workspace.sidebar();
  expect(refreshed.rows[0]?.summary.id).toBe(oldest.id);
  expect(refreshed.rows[0]?.childCount).toBe(1);
  const changedRefresh = measured();
  expect(changedRefresh.streams).toBeLessThan(5);
  expect(weights.reduce((sum, n) => sum + n, 0)).toBe(8000000000);
  expect(cold.actualEofBytes).toBeGreaterThan(0);
  expect(warm.actualEofBytes).toBe(0);
  expect(later.actualEofBytes).toBeGreaterThan(0);
  expect(changedRefresh.actualEofBytes).toBeLessThan(cold.actualEofBytes);
  expect(cold.headerReads).toBe(15000);
  expect(warm.headerReads).toBe(15000);
  if (process.env["WEB_PI_REPORT_ADAPTIVE_IO"] === "1") {
    process.stdout.write(
      `Adaptive sidebar I/O: ${JSON.stringify({
        files: files.length,
        modeledArchiveBytes: weights.reduce((sum, n) => sum + n, 0),
        scope:
          "Header reads and classification/row streams; excludes snapshot reads, stats and directory enumeration.",
        cold,
        warm,
        later,
        changedRefresh,
      })}\n`,
    );
  }
}, 30000);
