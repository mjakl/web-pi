import { connectWorkspace } from "@/workspace-rpc";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const children: ChildProcess[] = [];
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  await exited;
}
afterEach(async () => {
  for (const child of children.reverse()) await stop(child);
  children.length = 0;
});
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  return port;
}
function child(args: string[], env = process.env) {
  const processChild = spawn(process.execPath, ["--import", "tsx", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(processChild);
  processChild.stderr?.on("data", (data: Buffer) => process.stderr.write(data));
  return processChild;
}
async function startWeb(socket: string, env: NodeJS.ProcessEnv) {
  const port = await freePort();
  const web = child(
    ["src/dev.ts", "--role", "web", "--socket", socket, "--port", String(port)],
    env,
  );
  await new Promise<void>((resolve, reject) => {
    web.stdout?.on("data", (data) => {
      if (String(data).includes("listening on")) resolve();
    });
    web.once("exit", (code) => {
      reject(new Error(`Web exited: ${String(code)}`));
    });
  });
  return { web, url: `http://127.0.0.1:${String(port)}` };
}
async function reads(backend: ChildProcess) {
  const message = once(backend, "message");
  backend.send("reads");
  return (await message)[0] as { reads: number };
}

it("keeps the SDK turn, real shell child and >4096-row starred cache across web SIGKILL; Stop still kills work", async () => {
  const backend = child(["tests/backend-fixture.ts"]);
  const [ready] = (await once(backend, "message")) as [
    { socket: string; root: string; cwd: string; agentDir: string },
  ];
  const env = {
    ...process.env,
    HOME: ready.root,
    PI_CODING_AGENT_DIR: ready.agentDir,
  };
  const client = connectWorkspace(ready.socket).workspace;
  let front = await startWeb(ready.socket, env);
  const warm = await fetch(`${front.url}/sidebar/rows?starred=1`);
  expect(warm.ok).toBe(true);
  await warm.text();
  const cold = await reads(backend);
  expect(cold.reads).toBeGreaterThan(4096);
  const created = await fetch(`${front.url}/sessions`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ cwd: ready.cwd, text: "survive" }),
  });
  expect(created.status).toBe(303);
  const location = created.headers.get("location");
  if (!location) throw new Error("Missing session location");
  const id = location.split("/").at(-1);
  if (!id) throw new Error("Missing session id");
  await expect
    .poll(async () =>
      readFile(join(ready.cwd, "tool-started"), "utf8").catch(() => ""),
    )
    .toBe("started");
  const stream = await fetch(`${front.url}${location}/events`);
  if (!stream.body) throw new Error("Missing stream body");
  const reader = stream.body.getReader();
  expect((await reader.read()).done).toBe(false);
  await stop(front.web, "SIGKILL");
  await reader.cancel().catch(() => {});
  expect(backend.exitCode).toBeNull();
  expect((await client.viewSession(id))?.status?.running).toBe(true);
  front = await startWeb(ready.socket, env);
  const again = await fetch(`${front.url}/sidebar/rows?starred=1`);
  await again.text();
  expect((await reads(backend)).reads).toBe(cold.reads);
  await writeFile(join(ready.cwd, "release-tool"), "go");
  await expect
    .poll(async () => (await client.viewSession(id))?.status?.running)
    .toBe(false);
  const page = await fetch(`${front.url}${location}`).then((response) =>
    response.text(),
  );
  expect(page).toContain("deterministic tool survived");
  // A new child launched by the still-running backend is stopped through web.
  await client.runBash(
    id,
    `printf $$ > '${ready.cwd}/bash-started'; exec sleep 60`,
    false,
  );
  await expect
    .poll(async () =>
      readFile(join(ready.cwd, "bash-started"), "utf8").catch(() => ""),
    )
    .not.toBe("");
  const shellPid = Number(
    await readFile(join(ready.cwd, "bash-started"), "utf8"),
  );
  const stopped = await fetch(`${front.url}/sessions/${id}/stop`, {
    method: "POST",
  });
  expect(stopped.ok).toBe(true);
  expect((await client.viewSession(id))?.summary.live).not.toBe(true);
  await expect
    .poll(() => {
      try {
        process.kill(shellPid, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
}, 30_000);
