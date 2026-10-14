import { createWebApp } from "@web/app";
import { serve } from "@hono/node-server";
import { homedir } from "node:os";
import { loadConfig } from "./config.ts";
import { createDeps } from "./container.ts";
import { configureHttpDispatcher } from "./http.ts";
import { bundledPiVersion, webPiVersion } from "./pi-version.ts";

const piVersion = bundledPiVersion();
configureHttpDispatcher();

const config = loadConfig();
const { workspace, dispose } = createDeps(config);
const app = createWebApp({
  workspace,
  staticRoot: config.staticRoot,
  defaultCwd: config.defaultCwd,
  home: homedir(),
});

const server = serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  (info) => {
    process.stdout.write(
      `web-pi ${webPiVersion()} listening on http://${info.address}:${String(info.port)} (pi ${piVersion}, ${config.runtime} runtime)\n`,
    );
  },
);

function shutdown(code: number): void {
  dispose();
  server.close();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2000).unref();
}

// Unhandled, a failed listen (a busy port, say) crashes with a stack trace.
server.on("error", (error: NodeJS.ErrnoException) => {
  const reason =
    error.code === "EADDRINUSE"
      ? `port ${String(config.port)} is already in use`
      : error.message;
  process.stderr.write(`web-pi: ${reason}\n`);
  shutdown(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdown(0);
  });
}
