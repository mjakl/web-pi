import {
  createFakeWorld,
  assistantEntry,
  userEntry,
} from "@adapters/fake/index";
import { createPiSessionCatalog } from "@adapters/pi/session-catalog";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ streams: 0, bytes: 0, projects: 0 }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      io.streams += 1;
      const stream = actual.createReadStream(...args);
      stream.on("data", (chunk: string | Buffer) => {
        io.bytes += Buffer.byteLength(chunk);
      });
      return stream;
    },
  };
});
let root: string | undefined;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

it("filters an archive beyond the row cache without rereading unchanged bodies or decorating nonmatches", async () => {
  root = fs.mkdtempSync(join(tmpdir(), "web-pi-starred-"));
  const dir = join(root, "sessions", "fixture");
  fs.mkdirSync(dir, { recursive: true });
  const sizes: number[] = process.env["WEB_PI_STARRED_SIZES"]
    ? (JSON.parse(
        fs.readFileSync(process.env["WEB_PI_STARRED_SIZES"], "utf8"),
      ) as number[])
    : Array.from({ length: 4201 }, () => 2000);
  const timestamp = "2026-01-01T00:00:00.000Z";
  let changedFile = "";
  for (let i = 0; i < sizes.length; i += 1) {
    const id = `archive-${String(i).padStart(5, "0")}`;
    const entries = [
      { type: "session", version: 3, id, timestamp, cwd: root },
      userEntry("u", null, "Synthetic question"),
      assistantEntry("a", "u", "Synthetic answer", 1),
      ...(i % 100 === 0
        ? [
            {
              type: "custom",
              id: "star",
              parentId: "a",
              timestamp,
              customType: "web-pi:star",
              data: { targetId: "a", starred: true },
            },
          ]
        : []),
    ];
    const body = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
    // Real bytes, not modeled I/O: a tool-result-sized line that no row displays.
    const padding = JSON.stringify({ type: "custom", id: "padding", data: "" });
    const remaining = Math.max(
      0,
      (sizes[i] ?? 0) - Buffer.byteLength(body) - padding.length - 1,
    );
    const file = join(dir, `${id}.jsonl`);
    fs.writeFileSync(
      file,
      `${body + padding.replace('"data":""', `"data":"${"x".repeat(remaining)}"`)}\n`,
    );
    if (i === 0) changedFile = file;
  }
  const world = createFakeWorld();
  world.sessions = createPiSessionCatalog({ agentDir: root });
  const resolve = world.projects.resolve.bind(world.projects);
  world.projects.resolve = (...args) => {
    io.projects += 1;
    return resolve(...args);
  };
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    defaultCwd: root,
    staticRoot: "static",
  });
  const measurements: unknown[] = [];
  async function measure(label: string) {
    io.streams = 0;
    io.bytes = 0;
    io.projects = 0;
    const start = performance.now();
    const response = await app.request("/sidebar?starred=1", {
      headers: { "X-Web-Pi-Session": "archive-00000" },
    });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('id="row-archive-00000"');
    measurements.push({
      label,
      ms: Math.round(performance.now() - start),
      ...io,
    });
    return { ...io, html };
  }
  const cold = await measure("cold");
  const warm = await measure("warm");
  fs.appendFileSync(
    changedFile,
    `${JSON.stringify({ type: "custom", id: "unstar", parentId: "star", timestamp, customType: "web-pi:star", data: { targetId: "a", starred: false } })}\n`,
  );
  io.streams = 0;
  io.bytes = 0;
  io.projects = 0;
  const start = performance.now();
  const changed = await workspace.sidebar({
    starredOnly: true,
    selectedId: "archive-00000",
  });
  measurements.push({
    label: "one-changed",
    ms: Math.round(performance.now() - start),
    ...io,
  });
  expect(changed.rows.some((row) => row.summary.id === "archive-00000")).toBe(
    false,
  );
  if (
    process.env["WEB_PI_STARRED_SIZES"] ||
    process.env["WEB_PI_REPORT_ADAPTIVE_IO"] === "1"
  )
    process.stdout.write(
      `Starred archive ${String(sizes.length)} files: ${JSON.stringify(measurements)}\n`,
    );
  expect(cold.streams).toBe(sizes.length);
  expect(cold.projects).toBeLessThanOrEqual(51);
  expect(warm.streams).toBe(0);
  expect(warm.projects).toBeLessThanOrEqual(51);
  expect(io.streams).toBe(1);
}, 300000);
