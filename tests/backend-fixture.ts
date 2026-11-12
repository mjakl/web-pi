import {
  createFakeWorld,
  assistantEntry,
  userEntry,
} from "@adapters/fake/index";
import { createFileTree } from "@adapters/fs/file-tree";
import { createWorkspace } from "@core/workspace";
import { workspaceServer } from "@/workspace-rpc";
import { listenBackend } from "@/backend-socket";
import { createHarness, reply } from "#/adapters/pi-harness";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const h = await createHarness({ localShell: true });
const gate = join(h.cwd, "release-tool");
h.script((turn) => {
  turn.toolCall("bash", {
    command: `printf started > '${h.cwd}/tool-started'; while [ ! -f '${gate}' ]; do sleep 0.05; done; printf survived`,
  });
  turn.done();
}, reply("The deterministic tool survived the web restart."));
const archive = join(h.agentDir, "sessions", "archive");
fs.mkdirSync(archive, { recursive: true });
for (let index = 0; index < 4201; index += 1) {
  const id = `archive-${String(index)}`;
  fs.writeFileSync(
    join(archive, `${id}.jsonl`),
    `${[
      {
        type: "session",
        version: 3,
        id,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: h.cwd,
      },
      userEntry("u", null, "question"),
      assistantEntry("a", "u", "answer", 1),
      {
        type: "custom",
        id: "s",
        parentId: "a",
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "web-pi:star",
        data: { targetId: "a", starred: true },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
}
let reads = 0;
const original = fs.createReadStream;
fs.createReadStream = (...args) => {
  if (String(args[0]).includes("/archive/")) reads += 1;
  return original(...args);
};
syncBuiltinESMExports();
const world = createFakeWorld();
const workspace = createWorkspace({
  ...world,
  sessions: h.catalog,
  runtime: h.runtime,
  models: h.runtime.models,
  resources: h.runtime.resources,
  webSettings: h.webSettings,
  files: createFileTree(),
});
const socket = join(h.root, "private/backend.sock");
const server = workspaceServer(workspace, {
  pi: "fixture-sdk",
  web: "fixture-backend",
});
await listenBackend(server, socket);
process.send?.({
  ready: true,
  socket,
  cwd: h.cwd,
  root: h.root,
  agentDir: h.agentDir,
});
process.on("message", (message) => {
  if (message === "reads") process.send?.({ reads });
});
async function close() {
  server.closeAllConnections();
  server.close();
  await h.dispose();
  process.exit(0);
}
process.on("SIGTERM", () => {
  void close();
});
