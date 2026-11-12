import {
  createFakeWorld,
  assistantEntry,
  userEntry,
} from "@adapters/fake/index";
import { createWorkspace, InspectionOnlySession } from "@core/workspace";
import { FileAccessError } from "@core/path-access";
import { DictationError } from "@core/dictation";
import { connectWorkspace, workspaceServer } from "@/workspace-rpc";
import { listenBackend } from "@/backend-socket";
import { mkdtemp, rm, writeFile, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "web-pi-rpc-"));
  const world = createFakeWorld({
    sessions: [
      {
        summary: {
          id: "rpc-session",
          cwd: root,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          fileSize: 1,
        },
        entries: [
          userEntry("u", null, "question"),
          assistantEntry("a", "u", "answer", 1),
        ],
      },
    ],
  });
  const local = createWorkspace(world);
  const socket = join(root, "private", "backend.sock");
  const server = workspaceServer(local, { pi: "test-pi", web: "test-web" });
  await listenBackend(server, socket);
  cleanups.push(async () => {
    server.closeAllConnections();
    await Promise.all(world.runtime.live().map((session) => session.stop()));
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    world,
    local,
    remote: connectWorkspace(socket),
    socket,
    server,
  };
}

it("round-trips settings, undefined, Sets, typed refusals and upload bytes over a private socket", async () => {
  const { remote, local, socket, root, world } = await fixture();
  const client = remote.workspace;
  expect(await remote.info()).toEqual({ pi: "test-pi", web: "test-web" });
  expect((await stat(socket)).mode & 0o777).toBe(0o600);
  expect(await client.updateWebSettings({ theme: "light" })).toEqual(
    local.webSettings(),
  );
  expect(await client.row("missing")).toBeUndefined();
  await client.setStar("rpc-session", "a", true);
  expect((await client.viewSession("rpc-session"))?.starred).toEqual(
    new Set(["a"]),
  );
  await expect(
    client.fileBytes(undefined, "/unknown/outside.txt"),
  ).rejects.toBeInstanceOf(FileAccessError);
  local.requireWritableSession = () =>
    Promise.reject(new InspectionOnlySession());
  await expect(
    client.requireWritableSession("rpc-session"),
  ).rejects.toBeInstanceOf(InspectionOnlySession);
  local.transcribe = () => Promise.reject(new DictationError("busy", 503));
  await expect(
    client.transcribe(
      new File(["audio"], "clip.wav"),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 503, name: "DictationError" });
  local.viewSession = () =>
    Promise.reject(new RangeError("Unknown entry for this branch"));
  await expect(client.viewSession("rpc-session")).rejects.toBeInstanceOf(
    RangeError,
  );
  let uploaded: Uint8Array | undefined;
  world.uploads.save = (files) => {
    uploaded = files[0]?.data;
    return Promise.resolve([join(root, "upload")]);
  };
  await client.send("rpc-session", "", {
    files: [{ name: "bytes.bin", data: new Uint8Array([0, 255, 128, 1]) }],
  });
  expect(uploaded).toEqual(new Uint8Array([0, 255, 128, 1]));
  await local.stop("rpc-session");
});

it("streams ranges lazily and cancels transcription without cancelling ordinary mutations", async () => {
  const { remote, local } = await fixture();
  let opened = 0;
  local.fileBytes = () =>
    Promise.resolve({
      size: 4,
      open: (range) => {
        opened += 1;
        return new ReadableStream({
          start(controller) {
            controller.enqueue(
              new Uint8Array([0, 255, 128, 1]).slice(
                range?.start,
                range ? range.end + 1 : undefined,
              ),
            );
            controller.close();
          },
        });
      },
    });
  const file = await remote.workspace.fileBytes(undefined, "test");
  expect(opened).toBe(0);
  expect(
    new Uint8Array(
      await new Response(await file.open({ start: 1, end: 2 })).arrayBuffer(),
    ),
  ).toEqual(new Uint8Array([255, 128]));
  let cancelled!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const entered = Promise.withResolvers<undefined>();
  local.transcribe = async (file, signal) => {
    expect(file.name).toBe("test.wav");
    expect(file.type).toBe("audio/wav");
    expect(await file.text()).toBe("recording");
    entered.resolve(undefined);
    return await new Promise<string>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          cancelled();
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
  };
  const controller = new AbortController();
  const result = remote.workspace.transcribe(
    new File(["recording"], "test.wav", { type: "audio/wav" }),
    controller.signal,
  );
  const rejected = expect(result).rejects.toThrow();
  await entered.promise;
  controller.abort();
  await rejected;
  await cancellation;
});

it("acknowledges subscriptions before snapshots and releases them on disconnect", async () => {
  const { remote, local, server } = await fixture();
  const events: unknown[] = [];
  let removed = false;
  local.subscribeSessions = (listener) => {
    listener({ type: "opened", sessionId: "rpc-session" });
    return () => {
      removed = true;
    };
  };
  const disconnected = Promise.withResolvers<undefined>();
  const stop = await remote.workspace.subscribeSessions(
    (event) => events.push(event),
    () => {
      disconnected.resolve(undefined);
    },
  );
  await expect.poll(() => events.length).toBe(1);
  server.closeAllConnections();
  await disconnected.promise;
  await expect.poll(() => removed).toBe(true);
  stop();
  expect(await local.subscribe("rpc-session", () => {})).toBeUndefined();
});

it("delivers authorized file changes and full binary downloads", async () => {
  const { remote, root, local } = await fixture();
  await local.validateFolder(root);
  const path = join(root, "bytes.bin");
  await writeFile(path, new Uint8Array([0, 255, 13, 10]));
  const file = await remote.workspace.fileBytes(undefined, path);
  expect(
    new Uint8Array(await new Response(await file.open()).arrayBuffer()),
  ).toEqual(new Uint8Array([0, 255, 13, 10]));
  const changed = Promise.withResolvers<undefined>();
  const watch = await remote.workspace.watchFile(undefined, path);
  const stop = await watch({
    change: () => {
      changed.resolve(undefined);
    },
    error: () => {
      changed.reject(new Error("watch failed"));
    },
  });
  try {
    await writeFile(path, "changed");
    await changed.promise;
  } finally {
    stop();
  }
});

it("refuses shared socket directories and a second live backend", async () => {
  const { root, local, socket } = await fixture();
  const second = workspaceServer(local, { pi: "x", web: "x" });
  await expect(listenBackend(second, socket)).rejects.toThrow(
    "already listening",
  );
  await writeFile(join(root, "not-socket"), "keep");
  await expect(listenBackend(second, join(root, "not-socket"))).rejects.toThrow(
    "Refusing",
  );
  await chmod(root, 0o755);
  await expect(listenBackend(second, join(root, "other.sock"))).rejects.toThrow(
    "private",
  );
});
