import { createWebApp } from "@web/app";
import { serve } from "@hono/node-server";
import { homedir } from "node:os";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";
import { loadConfig } from "./config.ts";
import { createDeps } from "./container.ts";
import { configureHttpDispatcher } from "./http.ts";
import { bundledPiVersion, webPiVersion } from "./pi-version.ts";
import { connectWorkspace, workspaceServer } from "./workspace-rpc.ts";
import { listenBackend } from "./backend-socket.ts";

const piVersion = bundledPiVersion();
configureHttpDispatcher();
const config = loadConfig();
let dispose: () => Promise<void> = async () => {};
let server: Server;

function ready(): void {
  // Type=notify makes systemctl report a failed bind/guard as a failed start,
  // rather than success as soon as the launcher process exists.
  if (!process.env["NOTIFY_SOCKET"]) return;
  try {
    execFileSync(
      "/usr/bin/systemd-notify",
      ["--ready", `--pid=${String(process.pid)}`],
      { timeout: 10_000 },
    );
  } catch (error) {
    shutdown(1);
    throw error;
  }
}

if (config.role === "backend") {
  const local = createDeps(config);
  dispose = local.dispose;
  server = workspaceServer(local.workspace, {
    pi: piVersion,
    web: webPiVersion(),
  });
  await listenBackend(server, config.socketPath);
  process.stdout.write(
    `web-pi backend ${webPiVersion()} listening on ${config.socketPath} (pi ${piVersion}, ${config.runtime} runtime, ${import.meta.dirname})\n`,
  );
  ready();
} else {
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(config.host)) {
    process.stderr.write(
      `Warning: web-pi is listening on ${config.host} without any authentication. Use it only on a trusted network or behind an external security layer.\n`,
    );
  }
  const remote =
    config.role === "web" ? connectWorkspace(config.socketPath) : undefined;
  const connection = remote ?? createDeps(config);
  if ("dispose" in connection) dispose = connection.dispose;
  const backend = remote
    ? await remote.info()
    : { pi: piVersion, web: webPiVersion() };
  const app = createWebApp({
    workspace: connection.workspace,
    staticRoot: config.staticRoot,
    defaultCwd: config.defaultCwd,
    home: homedir(),
  });
  server = serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    (info) => {
      process.stdout.write(
        `web-pi ${webPiVersion()} listening on http://${info.address}:${String(info.port)} (pi ${backend.pi}, ${config.runtime} runtime)${remote ? `; backend web-pi ${backend.web}` : ""}\n`,
      );
      ready();
    },
  ) as Server;
}

function shutdown(code: number): void {
  void dispose();
  server.close();
  server.closeAllConnections();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2000).unref();
}
server.on("error", (error: NodeJS.ErrnoException) => {
  const reason =
    error.code === "EADDRINUSE" && config.role !== "backend"
      ? `port ${String(config.port)} is already in use`
      : error.message;
  process.stderr.write(`web-pi: ${reason}\n`);
  shutdown(1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    shutdown(0);
  });
