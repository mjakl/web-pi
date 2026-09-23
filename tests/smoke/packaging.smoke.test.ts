import { assistantEntry } from "@adapters/fake/index";
import { HTMX_SRC, HTMX_SSE_SRC } from "@web/HtmlLayout";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

// The packaged artefact, not the checkout: `pnpm pack`, install the tarball
// with runtime dependencies only, and serve a session from the result. It
// catches what unit tests cannot see — a missing `files` entry, a bundled
// import that only resolves in the checkout, a bin that cannot find Pi.
// Reading is all it does: no prompt, no model, no provider call.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

let base = "";
let child: ChildProcess | undefined;
let closed: Promise<unknown> | undefined;
let origin = "";
let sessionId = "";
let output = "";

/** A port the OS picked, so a developer's own server is never disturbed. */
async function freePort(): Promise<number> {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return port;
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

/** Install the packed tarball into a throwaway consumer project. */
function installTarball(consumer: string): string {
  const packed = run("pnpm", ["pack", "--pack-destination", base], repoRoot);
  const tarball = packed.trim().split("\n").at(-1)?.trim() ?? "";
  expect(tarball).toMatch(/web-pi-.*\.tgz$/);
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "web-pi-smoke-consumer",
      private: true,
      version: "0.0.0",
      dependencies: { "web-pi": `file:${tarball}` },
    }),
  );
  run("pnpm", ["install", "--prod"], consumer);
  return tarball;
}

/**
 * One stored session, written by Pi's own SessionManager. It needs an answer:
 * the SDK keeps a session with no assistant reply out of the file entirely.
 */
function writeFixture(agentDir: string, cwd: string): string {
  const reply = assistantEntry("ignored", null, "A packaged answer", 1000);
  if (reply.type !== "message" || reply.message.role !== "assistant") {
    throw new Error("unreachable");
  }
  const manager = SessionManager.create(
    cwd,
    join(agentDir, "sessions", "smoke"),
  );
  manager.appendMessage({
    role: "user",
    content: "Packaged fixture session",
    timestamp: 1,
  });
  manager.appendMessage(reply.message);
  return manager.getSessionId();
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "web-pi-smoke-"));
  const consumer = join(base, "consumer");
  installTarball(consumer);

  const home = join(base, "home");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  sessionId = writeFixture(agentDir, home);

  const port = await freePort();
  origin = `http://127.0.0.1:${String(port)}`;
  child = spawn(
    join(consumer, "node_modules", ".bin", "web-pi"),
    ["--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: home,
      // A bare environment: no credentials, no loader hooks, no live Pi state.
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  closed = once(child, "close");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(new Error(`web-pi never started:\n${output}`));
    }, 60_000);
    const onOutput = (chunk: Buffer) => {
      output += String(chunk);
      if (output.includes("listening on")) finish();
    };
    const onExit = () => {
      finish(new Error(`web-pi exited:\n${output}`));
    };
    function finish(error?: Error) {
      clearTimeout(timer);
      child?.stdout?.off("data", onOutput);
      child?.stderr?.off("data", onOutput);
      child?.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    }
    child?.stdout?.on("data", onOutput);
    child?.stderr?.on("data", onOutput);
    child?.once("exit", onExit);
  });
}, 180_000);

afterAll(async () => {
  if (child?.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  if (closed) await closed;
  if (base) rmSync(base, { recursive: true, force: true });
});

it("ships documentation link targets and both product license notices", () => {
  const installed = join(base, "consumer", "node_modules", "web-pi");
  const docs = join(installed, "docs");
  const markdown = [
    join(installed, "README.md"),
    ...readdirSync(docs, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".md"))
      .map((path) => join(docs, path)),
  ];
  for (const file of markdown) {
    const text = readFileSync(file, "utf8");
    const targets = [
      ...text.matchAll(/\]\(([^)]+)\)|<img\s[^>]*src="([^"]+)"/g),
    ];
    for (const match of targets) {
      const target = match[1] ?? match[2] ?? "";
      if (/^(?:https?:|#)/.test(target)) continue;
      const path = target.split("#")[0] ?? "";
      expect(
        existsSync(resolve(dirname(file), path)),
        `${file}: ${target}`,
      ).toBe(true);
    }
  }
  expect(readFileSync(join(installed, "LICENSE"), "utf8")).toContain(
    "Copyright (c) 2026 Michael Jakl",
  );
  expect(readFileSync(join(installed, "LICENSE.pi-web"), "utf8")).toContain(
    "Copyright (c) 2026 agegr",
  );
});

it("reports its own version and the Pi it linked", () => {
  expect(output).toMatch(/web-pi \d+\.\d+\.\d+ listening on .*\(pi \d+\./);
});

it("serves the index and the stored session", async () => {
  const index = await fetch(origin);
  expect(index.status).toBe(200);
  expect(await index.text()).toContain("<html");
  const session = await fetch(`${origin}/sessions/${sessionId}`);
  expect(session.status).toBe(200);
  expect(await session.text()).toContain("Packaged fixture session");
});

it("serves the built assets and the manifest", async () => {
  const css = await fetch(`${origin}/static/app.css`);
  expect(css.status).toBe(200);
  const stylesheet = await css.text();
  // pi-web's tokens and the self-hosted font the mono stack names.
  expect(stylesheet).toContain("--bg-panel");
  expect(stylesheet).toContain("noto-sans-mono-latin-wght-normal.woff2");
  const font = await fetch(
    `${origin}/static/fonts/noto-sans-mono-latin-wght-normal.woff2`,
  );
  expect(font.status).toBe(200);
  const icon = await fetch(`${origin}/static/icons/catppuccin/latte/rust.svg`);
  expect(icon.status).toBe(200);
  const manifest = await fetch(`${origin}/manifest.webmanifest`);
  expect(manifest.status).toBe(200);
  const described = (await manifest.json()) as { name?: string };
  expect(described.name).toBe("web-pi");
  for (const path of [
    HTMX_SRC,
    HTMX_SSE_SRC,
    "/static/client.js",
    "/static/mermaid.js",
  ]) {
    const script = await fetch(`${origin}${path}`);
    expect(script.status, path).toBe(200);
    expect(script.headers.get("content-type"), path).toContain("javascript");
    expect((await script.text()).length, path).toBeGreaterThan(1000);
  }
  const worker = await fetch(`${origin}/sw.js`);
  expect(worker.status).toBe(200);
  expect(worker.headers.get("content-type")).toContain("javascript");
});

it("opens the session stream without starting a turn", async () => {
  const controller = new AbortController();
  const stream = await fetch(`${origin}/sessions/${sessionId}/events`, {
    signal: controller.signal,
  });
  expect(stream.status).toBe(200);
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  controller.abort();
});
