import type { Workspace } from "@core/workspace";
import type { WorkspaceConnection } from "@core/workspace/connection";
import { InspectionOnlySession } from "@core/workspace";
import { FileAccessError } from "@core/path-access";
import { DictationError } from "@core/dictation";
import {
  createServer,
  request,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { serialize, deserialize } from "node:v8";
import { Readable } from "node:stream";

// A closed, local protocol, not arbitrary object-method dispatch. V8's value
// format preserves undefined, Sets and upload bytes without a second schema.
// Both processes must use a compatible Node runtime; no version negotiation.
const calls = [
  "requireWritableSession",
  "viewSession",
  "observeSavedSession",
  "row",
  "stop",
  "setStar",
  "lastAssistantText",
  "projects",
  "sidebar",
  "sessionStats",
  "sessionFolder",
  "rename",
  "clearStars",
  "remove",
  "fork",
  "clone",
  "rewind",
  "navigateTree",
  "exportHtml",
  "unreadActivity",
  "acknowledgeActivity",
  "createSession",
  "send",
  "abort",
  "commands",
  "compact",
  "abortCompaction",
  "reload",
  "answerDialog",
  "customInput",
  "pushKey",
  "reportPushPresence",
  "subscribePush",
  "hasPush",
  "unsubscribePush",
  "recallQueue",
  "runBash",
  "entryImage",
  "entryThinking",
  "bashOutput",
  "toolCall",
  "toolDefinitions",
  "systemPrompt",
  "setModel",
  "activate",
  "fileIndex",
  "fileCompletion",
  "fileTree",
  "fileView",
  "searchFiles",
  "validateFolder",
  "folderAvailable",
  "modelSettings",
  "saveModelSettings",
  "webSettings",
  "updateWebSettings",
  "browse",
  "newSession",
  "folderCommands",
  "trustStatus",
  "trustProject",
  "skills",
  "toggleSkill",
  "searchSkills",
  "installSkill",
  "checkSkills",
  "updateSkill",
  "plugins",
  "runPluginAction",
  "reloadFolder",
] as const satisfies readonly (keyof Workspace)[];
type Call = (typeof calls)[number];
type Special =
  | "subscribe"
  | "subscribeActivity"
  | "subscribeSessions"
  | "fileBytes"
  | "watchFile"
  | "bashOutputDownload"
  | "transcribe"
  | "refreshModelCatalogs";
// A newly added use case must be deliberately assigned a transport.
const exhaustive: Exclude<keyof Workspace, Call | Special> extends never
  ? true
  : never = true;
void exhaustive;

type Failure = {
  kind: "inspection" | "file" | "dictation" | "range" | "error";
  message: string;
  status?: number;
};
function failure(error: unknown): Failure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof InspectionOnlySession)
    return { kind: "inspection", message };
  if (error instanceof FileAccessError)
    return { kind: "file", message, status: error.status };
  if (error instanceof DictationError)
    return { kind: "dictation", message, status: error.status };
  return { kind: error instanceof RangeError ? "range" : "error", message };
}
function raise(error: Failure): never {
  switch (error.kind) {
    case "inspection":
      throw new InspectionOnlySession();
    case "file":
      throw new FileAccessError(
        error.message,
        error.status as FileAccessError["status"],
      );
    case "dictation":
      throw new DictationError(
        error.message,
        error.status as DictationError["status"],
      );
    case "range":
      throw new RangeError(error.message);
    default:
      throw new Error(error.message);
  }
}
async function bytes(
  stream: IncomingMessage,
  maxBytes = Infinity,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const data = Buffer.from(chunk as Uint8Array);
    size += data.length;
    if (size > maxBytes) throw new Error("Backend request exceeds 150 MiB");
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}
function reply(res: ServerResponse, value: unknown): void {
  res.end(serialize(value));
}

export function workspaceServer(
  workspace: Workspace,
  info: { pi: string; web: string },
) {
  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent || res.destroyed) res.destroy();
      else {
        res.statusCode = 500;
        reply(res, failure(error));
      }
    });
  });
  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const method = req.url?.slice(1) ?? "";
    const args = deserialize(await bytes(req, 150 * 1024 * 1024)) as unknown[];
    if (!Array.isArray(args)) throw new Error("Invalid backend arguments");
    if (method === "info") {
      reply(res, info);
      return;
    }
    if (calls.includes(method as Call)) {
      const invoke = workspace[method as Call] as (
        ...values: unknown[]
      ) => unknown;
      reply(res, await invoke(...args));
      return;
    }
    if (method === "transcribe" || method === "refreshModelCatalogs") {
      const controller = new AbortController();
      const abort = () => {
        controller.abort();
      };
      res.on("close", abort);
      if (res.destroyed) controller.abort();
      try {
        const value =
          method === "transcribe"
            ? await workspace.transcribe(
                new File(
                  [args[0] as Uint8Array<ArrayBuffer>],
                  args[1] as string,
                  { type: args[2] as string },
                ),
                controller.signal,
              )
            : await workspace.refreshModelCatalogs(
                args[0] as string,
                controller.signal,
                args[1] as string | undefined,
              );
        reply(res, value);
      } finally {
        res.off("close", abort);
      }
      return;
    }
    if (method === "fileBytes") {
      const file = await workspace.fileBytes(
        args[0] as string | undefined,
        args[1] as string,
      );
      reply(res, { size: file.size });
      return;
    }
    if (method === "fileStream" || method === "bashOutputDownload") {
      const stream =
        method === "fileStream"
          ? (
              await workspace.fileBytes(
                args[0] as string | undefined,
                args[1] as string,
              )
            ).open(args[2] as { start: number; end: number } | undefined)
          : await workspace.bashOutputDownload(
              args[0] as string,
              args[1] as string,
            );
      const source = Readable.fromWeb(
        stream as import("node:stream/web").ReadableStream<Uint8Array>,
      );
      res.on("close", () => source.destroy());
      source.on("error", () => res.destroy());
      if (res.destroyed) {
        source.destroy();
        return;
      }
      res.writeHead(200);
      source.pipe(res);
      return;
    }
    if (method === "watchFile") {
      await workspace.watchFile(
        args[0] as string | undefined,
        args[1] as string,
      );
      reply(res, undefined);
      return;
    }
    if (
      ["subscribe", "subscribeActivity", "subscribeSessions", "watch"].includes(
        method,
      )
    ) {
      let closed = res.destroyed;
      let stop: (() => void) | undefined;
      let ready = false;
      const pending: string[] = [];
      let pendingBytes = 0;
      const send = (event: unknown) => {
        if (closed) return;
        const line = `${JSON.stringify(event)}\n`;
        // Never let a disconnected/slow renderer retain model output forever.
        if (
          res.writableLength + pendingBytes + Buffer.byteLength(line) >
          Math.max(64 * 1024, Buffer.byteLength(line))
        ) {
          res.destroy();
          return;
        }
        if (ready) res.write(line);
        else {
          pending.push(line);
          pendingBytes += Buffer.byteLength(line);
        }
      };
      res.on("close", () => {
        closed = true;
        stop?.();
      });
      switch (method) {
        case "subscribe":
          stop = await workspace.subscribe(args[0] as string, send);
          break;
        case "subscribeActivity":
          stop = workspace.subscribeActivity(send);
          break;
        case "subscribeSessions":
          stop = workspace.subscribeSessions(send);
          break;
        default:
          stop = (
            await workspace.watchFile(
              args[0] as string | undefined,
              args[1] as string,
            )
          )({
            change: (change) => {
              send({ change });
            },
            error: () => {
              send({ error: true });
            },
          });
      }
      if (closed) {
        stop?.();
        return;
      }
      if (!stop) {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.flushHeaders();
      ready = true;
      for (const line of pending) res.write(line);
      pending.length = 0;
      pendingBytes = 0;
      return;
    }
    throw new Error(`Unknown backend operation: ${method}`);
  }
}

function requiredSubscription(stop: (() => void) | undefined): () => void {
  if (!stop) throw new Error("Backend did not register subscription");
  return stop;
}

export function connectWorkspace(socketPath: string): {
  workspace: WorkspaceConnection;
  info: () => Promise<{ pi: string; web: string }>;
} {
  async function open(
    method: string,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<IncomingMessage> {
    const body = serialize(args);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path: `/${method}`,
          method: "POST",
          signal,
          headers: { "Content-Length": String(body.length) },
        },
        resolve,
      );
      req.on("error", reject);
      req.end(body);
    });
    if (response.statusCode !== 200 && response.statusCode !== 204)
      raise(deserialize(await bytes(response)) as Failure);
    return response;
  }
  async function call(
    method: string,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    return deserialize(
      await bytes(await open(method, args, signal)),
    ) as unknown;
  }
  async function subscribe(
    method: string,
    args: unknown[],
    listener: (event: never) => void,
    disconnect?: (error: Error) => void,
  ) {
    const response = await open(method, args);
    if (response.statusCode === 204) {
      response.resume();
      return undefined;
    }
    let stopped = false;
    void (async () => {
      let tail = "";
      for await (const chunk of response) {
        tail += String(chunk);
        let newline: number;
        while ((newline = tail.indexOf("\n")) !== -1) {
          listener(JSON.parse(tail.slice(0, newline)) as never);
          tail = tail.slice(newline + 1);
        }
      }
      if (!stopped) throw new Error("Backend subscription closed");
    })().catch((error: unknown) => {
      if (!stopped)
        disconnect?.(error instanceof Error ? error : new Error(String(error)));
    });
    return () => {
      stopped = true;
      response.destroy();
    };
  }
  const ordinary = Object.fromEntries(
    calls.map((method) => [method, (...args: unknown[]) => call(method, args)]),
  ) as Pick<WorkspaceConnection, Call>;
  const workspace: WorkspaceConnection = {
    ...ordinary,
    subscribe: (id, listener, disconnect) =>
      subscribe("subscribe", [id], listener, disconnect),
    subscribeActivity: async (listener, disconnect) =>
      requiredSubscription(
        await subscribe("subscribeActivity", [], listener, disconnect),
      ),
    subscribeSessions: async (listener, disconnect) =>
      requiredSubscription(
        await subscribe("subscribeSessions", [], listener, disconnect),
      ),
    fileBytes: async (...args) => {
      const metadata = (await call("fileBytes", args)) as { size: number };
      return {
        ...metadata,
        open: async (range) =>
          Readable.toWeb(
            await open("fileStream", [...args, range]),
          ) as ReadableStream<Uint8Array>,
      };
    },
    bashOutputDownload: async (...args) =>
      Readable.toWeb(
        await open("bashOutputDownload", args),
      ) as ReadableStream<Uint8Array>,
    watchFile: async (...args) => {
      await call("watchFile", args);
      return async (handlers) =>
        requiredSubscription(
          await subscribe(
            "watch",
            args,
            (event: {
              change?: Parameters<typeof handlers.change>[0];
              error?: boolean;
            }) => {
              if (event.change) handlers.change(event.change);
              if (event.error) handlers.error();
            },
            () => {
              handlers.error();
            },
          ),
        );
    },
    transcribe: async (file, signal) =>
      (await call(
        "transcribe",
        [new Uint8Array(await file.arrayBuffer()), file.name, file.type],
        signal,
      )) as string,
    refreshModelCatalogs: async (cwd, signal, id) =>
      (await call("refreshModelCatalogs", [cwd, id], signal)) as Awaited<
        ReturnType<Workspace["refreshModelCatalogs"]>
      >,
  };
  return {
    workspace,
    info: async () => (await call("info", [])) as { pi: string; web: string },
  };
}
