import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";

const execute = promisify(execFile);
const releaseTool = resolve("bin/web-pi-release.js");
let root = "";
let running: ChildProcess | undefined;
afterEach(async () => {
  if (running && running.exitCode === null && running.signalCode === null) {
    const closed = once(running, "exit");
    running.kill();
    await closed;
  }
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  root = await mkdtemp(join(tmpdir(), "web-pi-releases-"));
  await mkdir(join(root, "releases"));
}
async function release(name: string) {
  const target = join(root, "releases", name);
  const pkg = join(target, "node_modules", "web-pi");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await mkdir(join(pkg, "bin"));
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "web-pi", type: "module" }),
  );
  await writeFile(join(pkg, "dist/server.js"), "");
  await writeFile(join(pkg, "dist/server-runtime.js"), "");
  await writeFile(join(pkg, "resource"), name);
  await writeFile(
    join(pkg, "bin/child.js"),
    `import {readFileSync} from 'node:fs'; console.log(readFileSync(new URL('../resource', import.meta.url), 'utf8'));`,
  );
  await writeFile(
    join(pkg, "bin/web-pi.js"),
    `import {execFileSync} from 'node:child_process'; console.log('ready ' + JSON.stringify(process.argv.slice(2))); process.stdin.once('data', () => { process.stdout.write(execFileSync(process.execPath, [new URL('./child.js', import.meta.url).pathname])); }); process.stdin.resume();`,
  );
  return target;
}
async function tool(action: string, value: string) {
  return (
    await execute(process.execPath, [releaseTool, action, root, value])
  ).stdout.trim();
}

it("replaces pending deployment, promotes only at backend startup and retains a resolved running release for lazy child execution", async () => {
  await fixture();
  const first = await release("first");
  const second = await release("second");
  const latest = await release("latest");
  await tool("publish", first);
  expect(await readlink(join(root, "web-current"))).toBe(first);
  running = spawn(
    "sh",
    ["bin/web-pi-service", "backend", "--socket", "/fixture/backend.sock"],
    {
      env: { ...process.env, WEB_PI_RELEASE_ROOT: root },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (!running.stdout || !running.stdin)
    throw new Error("Missing process pipes");
  expect(String((await once(running.stdout, "data"))[0])).toContain(
    '"--socket","/fixture/backend.sock"',
  );
  expect(await readlink(join(root, "backend-current"))).toBe(first);
  await tool("publish", second);
  await expect(
    execute("sh", ["bin/web-pi-service", "backend"], {
      env: { ...process.env, WEB_PI_RELEASE_ROOT: root },
    }),
  ).rejects.toThrow("a backend already owns");
  expect(await readlink(join(root, "backend-next"))).toBe(second);
  await tool("publish", latest);
  expect(await readlink(join(root, "backend-next"))).toBe(latest);
  expect(await readlink(join(root, "backend-current"))).toBe(first);
  const childOutput = once(running.stdout, "data");
  running.stdin.write("launch subprocess now\n");
  expect(String((await childOutput)[0]).trim()).toBe("first");
  const exited = once(running, "exit");
  running.kill("SIGKILL");
  await exited;
  running = spawn("sh", ["bin/web-pi-service", "backend"], {
    env: { ...process.env, WEB_PI_RELEASE_ROOT: root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!running.stdout) throw new Error("Missing restart pipe");
  expect(String((await once(running.stdout, "data"))[0])).toContain("ready");
  expect(await readlink(join(root, "backend-current"))).toBe(latest);
  await expect(readlink(join(root, "backend-next"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await tool("select", "backend")).toBe(
    join(latest, "node_modules/web-pi"),
  );
});

it("leaves selected releases intact when publication or pending selection is invalid", async () => {
  await fixture();
  const first = await release("first");
  await tool("publish", first);
  await tool("select", "backend");
  const bad = join(root, "releases", "incomplete");
  await mkdir(bad);
  const linkedTool = join(root, "release-tool.js");
  await symlink(releaseTool, linkedTool);
  await expect(
    execute(process.execPath, [linkedTool, "publish", root, bad]),
  ).rejects.toThrow();
  expect(await readlink(join(root, "web-current"))).toBe(first);
  expect(await readlink(join(root, "backend-current"))).toBe(first);
  await symlink(bad, join(root, "backend-next"));
  await expect(tool("select", "backend")).rejects.toThrow();
  expect(await readlink(join(root, "backend-current"))).toBe(first);
  expect(await readlink(join(root, "backend-next"))).toBe(bad);
});

it("a failed complete build leaves pointers unchanged and does not reach service restart", async () => {
  await fixture();
  const first = await release("first");
  await tool("publish", first);
  const commands = join(root, "commands");
  await mkdir(commands);
  await writeFile(join(commands, "just"), "#!/bin/sh\nexit 23\n", {
    mode: 0o755,
  });
  await writeFile(
    join(commands, "systemctl"),
    `#!/bin/sh\ntouch '${root}/restarted'\n`,
    { mode: 0o755 },
  );
  const linkedRelease = join(root, "release.ts");
  await symlink(resolve("scripts/release.ts"), linkedRelease);
  const env = {
    ...process.env,
    WEB_PI_RELEASE_ROOT: root,
    PATH: `${commands}:${process.env["PATH"] ?? ""}`,
  };
  for (const entry of [linkedRelease, resolve("scripts/deploy.ts")])
    await expect(execute(process.execPath, [entry], { env })).rejects.toThrow(
      "just build failed (23)",
    );
  expect(await readlink(join(root, "web-current"))).toBe(first);
  expect(await readlink(join(root, "backend-next"))).toBe(first);
  await expect(stat(join(root, "restarted"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
