import { assistantEntry } from "@adapters/fake/index";
import { HTMX_SRC, HTMX_SSE_SRC } from "@web/HtmlLayout";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { bundledPiVersion, webPiVersion } from "@/pi-version";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { findPackageJSON } from "node:module";
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
let isolatedEnv: NodeJS.ProcessEnv;
let preservedFiles: Map<string, string>;
let installedBin = "";
let npmBin = "";

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
      packageManager: "pnpm@12.3.4",
      private: true,
      version: "0.0.0",
      dependencies: { "web-pi": `file:${tarball}` },
    }),
  );
  run("pnpm", ["install", "--prod", "--ignore-scripts"], consumer);
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
  const file = manager.getSessionFile();
  if (!file) throw new Error("fixture has no session file");
  preservedFiles.set(file, readFileSync(file, "utf8"));
  return manager.getSessionId();
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "web-pi-smoke-"));
  const consumer = join(base, "consumer");
  const tarball = installTarball(consumer);
  const npmPrefix = join(base, "npm-prefix");
  execFileSync(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      npmPrefix,
      "--cache",
      join(base, "npm-cache"),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    {
      cwd: consumer,
      encoding: "utf8",
      env: { ...process.env, MISE_SKIP_RESHIM: "1" },
    },
  );
  npmBin = join(npmPrefix, "lib", "node_modules", "web-pi", "bin", "web-pi.js");

  const home = join(base, "home");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  preservedFiles = new Map();
  for (const name of ["auth.json", "models.json", "settings.json"]) {
    const file = join(agentDir, name);
    writeFileSync(file, "{}\n");
    preservedFiles.set(file, readFileSync(file, "utf8"));
  }
  sessionId = writeFixture(agentDir, home);

  // Only Node and a deliberately unusable Pi are reachable on PATH. The app
  // and its export subprocess must use installed package modules, not this Pi.
  const path = join(base, "path");
  mkdirSync(path);
  symlinkSync(process.execPath, join(path, "node"));
  writeFileSync(
    join(path, "pi"),
    "#!/bin/sh\necho 'system Pi must not be used' >&2\nexit 99\n",
    { mode: 0o755 },
  );
  isolatedEnv = {
    PATH: path,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  };
  installedBin = join(consumer, "node_modules", "web-pi", "bin", "web-pi.js");

  const port = await freePort();
  origin = `http://127.0.0.1:${String(port)}`;
  child = spawn(
    process.execPath,
    [installedBin, "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: home,
      // A bare environment: no credentials, no loader hooks, no live Pi state.
      env: isolatedEnv,
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

it("uses its exact build-version Pi without a working system Pi", () => {
  const version = bundledPiVersion();
  expect(output).toContain(`(pi ${version}, pi runtime)`);
  const reported = execFileSync(process.execPath, [installedBin, "--version"], {
    env: isolatedEnv,
    encoding: "utf8",
  });
  expect(reported).toBe(`web-pi ${webPiVersion()}\npi ${version}\n`);
  const server = join(
    base,
    "consumer",
    "node_modules",
    "web-pi",
    "dist",
    "server.js",
  );
  for (const name of ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"]) {
    const manifest = findPackageJSON(
      `@earendil-works/${name}`,
      realpathSync(server),
    );
    expect(manifest).toContain(join(base, "consumer"));
    const installed = JSON.parse(readFileSync(manifest ?? "", "utf8")) as {
      version: string;
    };
    expect(installed.version).toBe(version);
  }
});

it("accepts the documented npm global tarball installation", () => {
  const reported = execFileSync(process.execPath, [npmBin, "--version"], {
    env: isolatedEnv,
    encoding: "utf8",
  });
  expect(reported).toBe(`web-pi ${webPiVersion()}\npi ${bundledPiVersion()}\n`);
});

it("fails rather than falling back to system Pi when local Pi is absent", () => {
  const globalModules = join(base, "global", "lib", "node_modules");
  const incomplete = join(globalModules, "web-pi");
  mkdirSync(incomplete, { recursive: true });
  for (const name of ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"]) {
    const sdk = join(globalModules, "@earendil-works", name);
    mkdirSync(sdk, { recursive: true });
    writeFileSync(
      join(sdk, "package.json"),
      JSON.stringify({
        name: `@earendil-works/${name}`,
        version: bundledPiVersion(),
        type: "module",
        main: "index.js",
      }),
    );
    writeFileSync(
      join(sdk, "index.js"),
      'throw new Error("ancestor SDK was loaded");\n',
    );
  }
  const installed = join(base, "consumer", "node_modules", "web-pi");
  cpSync(join(installed, "dist"), join(incomplete, "dist"), {
    recursive: true,
  });
  cpSync(join(installed, "bin"), join(incomplete, "bin"), { recursive: true });
  copyFileSync(
    join(installed, "package.json"),
    join(incomplete, "package.json"),
  );
  for (const args of [
    [join(incomplete, "bin", "web-pi.js"), "--version"],
    [
      join(incomplete, "bin", "web-pi.js"),
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ],
    [join(incomplete, "dist", "server.js")],
  ]) {
    expect(() =>
      execFileSync(process.execPath, args, { env: isolatedEnv, stdio: "pipe" }),
    ).toThrow(/not owned by web-pi/);
  }
});

it("exports through its packaged Pi CLI without changing user configuration or the saved session", async () => {
  const exported = await fetch(`${origin}/sessions/${sessionId}/export`);
  expect(exported.status).toBe(200);
  const encoded =
    /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(
      await exported.text(),
    )?.[1];
  expect(encoded).toBeDefined();
  expect(Buffer.from(encoded ?? "", "base64").toString("utf8")).toContain(
    "A packaged answer",
  );
  for (const [file, original] of preservedFiles)
    expect(readFileSync(file, "utf8")).toBe(original);
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
  for (const path of [HTMX_SRC, HTMX_SSE_SRC, "/static/client.js"]) {
    const script = await fetch(`${origin}${path}`);
    expect(script.status, path).toBe(200);
    expect(script.headers.get("content-type"), path).toContain("javascript");
    expect((await script.text()).length, path).toBeGreaterThan(1000);
  }
  const retired = await fetch(`${origin}/static/mermaid.js`);
  expect(retired.status).toBe(404);
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
