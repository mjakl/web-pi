import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Local JSON-RPC fixture: no network, credentials, or dependencies.
type Request = {
  id?: string | number;
  method: string;
  params: {
    protocolVersion: string;
    name: string;
    arguments: { text: string };
  };
};

const [logPath, mode] = process.argv.slice(2);
if (!logPath) throw new Error("Fixture log path is required");
const log = (event: string, data: Record<string, unknown> = {}) => {
  appendFileSync(
    logPath,
    `${JSON.stringify({ event, pid: process.pid, ...data })}\n`,
  );
};
log("start");
const input = createInterface({ input: process.stdin });
input.on("close", () => {
  log("close");
  process.exit(0);
});
input.on("line", (line) => {
  const request = JSON.parse(line) as Request;
  if (request.id === undefined) return;
  let result: unknown;
  switch (request.method) {
    case "initialize":
      if (mode === "hang") return;
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "web-pi-fixture", version: "1" },
        instructions: "Harmless echo tools for integration tests.",
      };
      break;
    case "tools/list":
      result = {
        tools: ["echo", "secret"].map((name) => ({
          name,
          description: `${name} returns the input text`,
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          annotations: { readOnlyHint: true },
        })),
      };
      break;
    case "tools/call":
      log("call", { name: request.params.name });
      result = {
        content: [
          { type: "text", text: `fixture: ${request.params.arguments.text}` },
        ],
      };
      break;
    case "ping":
      result = {};
      break;
    default:
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } })}\n`,
      );
      return;
  }
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
  );
});
