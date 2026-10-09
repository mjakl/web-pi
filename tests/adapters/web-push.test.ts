import {
  createWebPushNotifier as createNotifier,
  type WebPushOptions,
} from "@adapters/pi/web-push";
import type { PushMessage, PushSubscription } from "@core/ports";
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";

const directories: string[] = [];

function agentDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "web-pi-push-"));
  directories.push(directory);
  return directory;
}

function stored(directory: string): {
  vapidKeys: { publicKey: string; privateKey: string };
  subscriptions: PushSubscription[];
  awayConsumed?: boolean;
} {
  return JSON.parse(
    readFileSync(join(directory, "web-pi", "push.json"), "utf8"),
  ) as ReturnType<typeof stored>;
}

function subscription(endpoint: string): PushSubscription {
  return { endpoint, keys: { p256dh: "p", auth: "a" } };
}

// Exercise the real atomic replacement, without permissions that root could bypass.
function blockReplacement(path: string): () => void {
  renameSync(path, `${path}.backup`);
  mkdirSync(path);
  return () => {
    rmSync(path, { recursive: true });
    renameSync(`${path}.backup`, path);
  };
}

const MESSAGE: PushMessage = {
  title: "Session complete",
  body: "Task finished.",
  url: "/sessions/one",
  tag: "web-pi:session-complete:one",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("web push grace period", () => {
  it("waits fifteen minutes from completion by default without spending the allowance", async () => {
    vi.useFakeTimers();
    const directory = agentDir();
    const send = vi.fn().mockResolvedValue(undefined);
    const notifier = createNotifier({ agentDir: directory, send });
    notifier.subscribe(subscription("https://push.example/a"));
    await notifier.send(MESSAGE);
    expect(send).not.toHaveBeenCalled();
    expect(stored(directory).awayConsumed).not.toBe(true);
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      subscription("https://push.example/a"),
      JSON.stringify(MESSAGE),
      stored(directory).vapidKeys,
    );
    expect(stored(directory).awayConsumed).toBe(true);
  });
});

describe("web push grace behavior", () => {
  const create = (send: WebPushOptions["send"], gracePeriodMs = 1_000) => {
    const directory = agentDir();
    const notifier = createNotifier({
      agentDir: directory,
      send,
      gracePeriodMs,
    });
    notifier.subscribe(subscription("https://push.example/a"));
    return { directory, notifier };
  };

  it("coalesces tasks, including repeated sessions, at the first fixed deadline", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<NonNullable<WebPushOptions["send"]>>()
      .mockResolvedValue(undefined);
    const { directory, notifier } = create(send);
    notifier.subscribe(subscription("https://push.example/b"));
    await notifier.send(MESSAGE);
    await vi.advanceTimersByTimeAsync(500);
    await notifier.send(MESSAGE);
    await vi.advanceTimersByTimeAsync(499);
    await notifier.send({
      ...MESSAGE,
      url: "/sessions/two",
      tag: "other-session",
    });
    expect(send).not.toHaveBeenCalled();
    expect(stored(directory).awayConsumed).not.toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const plural: PushMessage = {
      title: "3 tasks completed",
      body: "3 tasks finished while you were away.",
      url: "/",
      tag: "web-pi:session-complete",
    };
    expect(
      send.mock.calls.map(([target, payload]) => [
        target.endpoint,
        JSON.parse(payload) as PushMessage,
      ]),
    ).toEqual([
      ["https://push.example/a", plural],
      ["https://push.example/b", plural],
    ]);
    expect(stored(directory).awayConsumed).toBe(true);
    await notifier.send(MESSAGE);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels permanently on another device's return and starts fresh only after departure", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<NonNullable<WebPushOptions["send"]>>()
      .mockResolvedValue(undefined);
    const { directory, notifier } = create(send);
    await notifier.send(MESSAGE);
    await vi.advanceTimersByTimeAsync(999);
    notifier.reportPresence({
      clientId: "unenrolled-device",
      sequence: 1,
      foreground: true,
    });
    await notifier.send({ ...MESSAGE, title: "Completion while foreground" });
    // Cancellation must survive both the deadline and eventual lease expiry.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).not.toHaveBeenCalled();
    expect(stored(directory).awayConsumed).not.toBe(true);
    notifier.reportPresence({
      clientId: "unenrolled-device",
      sequence: 2,
      foreground: false,
    });
    await vi.advanceTimersByTimeAsync(500);
    await notifier.send({ ...MESSAGE, title: "Fresh completion" });
    await vi.advanceTimersByTimeAsync(999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledOnce();
    expect(
      send.mock.calls.map(([, payload]) => JSON.parse(payload) as PushMessage),
    ).toEqual([{ ...MESSAGE, title: "Fresh completion" }]);
  });

  it("does not cancel for stale or duplicate foreground reports", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const { notifier } = create(send);
    notifier.reportPresence({
      clientId: "page",
      sequence: 2,
      foreground: false,
    });
    await notifier.send(MESSAGE);
    notifier.reportPresence({
      clientId: "page",
      sequence: 1,
      foreground: true,
    });
    notifier.reportPresence({
      clientId: "page",
      sequence: 2,
      foreground: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledOnce();
  });

  it("requires a new completion after a quick foreground return and departure", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const { notifier } = create(send);
    await notifier.send(MESSAGE);
    await vi.advanceTimersByTimeAsync(500);
    notifier.reportPresence({
      clientId: "page",
      sequence: 1,
      foreground: true,
    });
    notifier.reportPresence({
      clientId: "page",
      sequence: 2,
      foreground: false,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).not.toHaveBeenCalled();
    await notifier.send(MESSAGE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledOnce();
  });

  it("loses pending scheduling on restart without spending the durable allowance", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const { directory, notifier } = create(send);
    await notifier.send(MESSAGE);
    await vi.advanceTimersByTimeAsync(500);
    notifier.dispose();
    const restarted = createNotifier({
      agentDir: directory,
      send,
      gracePeriodMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).not.toHaveBeenCalled();
    expect(stored(directory).awayConsumed).not.toBe(true);
    await restarted.send(MESSAGE);
    await vi.advanceTimersByTimeAsync(999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledOnce();
  });

  it("disposal cancels pending timers and permanently closes completion admission", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const { directory, notifier } = create(send);
    await notifier.send(MESSAGE);
    notifier.dispose();
    notifier.dispose();
    expect(vi.getTimerCount()).toBe(0);
    notifier.reportPresence({
      clientId: "page",
      sequence: 1,
      foreground: true,
    });
    notifier.reportPresence({
      clientId: "page",
      sequence: 2,
      foreground: false,
    });
    await notifier.send(MESSAGE);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(stored(directory).awayConsumed).not.toBe(true);
  });

  it.each([0, 1_000])(
    "disposal does not recall an admitted broadcast with %s ms grace",
    async (gracePeriodMs) => {
      vi.useFakeTimers();
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const send = vi
        .fn<NonNullable<WebPushOptions["send"]>>()
        .mockImplementationOnce(() => pending)
        .mockResolvedValue(undefined);
      const { directory, notifier } = create(send, gracePeriodMs);
      notifier.subscribe(subscription("https://push.example/b"));
      const completion = notifier.send(MESSAGE);
      await vi.advanceTimersByTimeAsync(gracePeriodMs);
      expect(send).toHaveBeenCalledOnce();
      expect(stored(directory).awayConsumed).toBe(true);
      notifier.dispose();
      await notifier.send(MESSAGE);
      release();
      await completion;
      await vi.advanceTimersByTimeAsync(0);
      expect(send.mock.calls.map(([target]) => target.endpoint)).toEqual([
        "https://push.example/a",
        "https://push.example/b",
      ]);
    },
  );

  it.each(["claim", "prune"])(
    "handles asynchronous %s persistence failure without retry or unsafe diagnostics",
    async (failure) => {
      vi.useFakeTimers();
      const report = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      let restore: (() => void) | undefined;
      const send = vi.fn().mockImplementation(() => {
        if (failure === "prune") {
          restore = blockReplacement(join(directory, "web-pi", "push.json"));
          return Promise.reject(
            Object.assign(new Error("secret endpoint and auth"), {
              statusCode: 410,
            }),
          );
        }
        return Promise.resolve();
      });
      const { directory, notifier } = create(send);
      await notifier.send(MESSAGE);
      if (failure === "claim")
        restore = blockReplacement(join(directory, "web-pi", "push.json"));
      await vi.advanceTimersByTimeAsync(1_000);
      restore?.();
      const diagnostics = report.mock.calls.map(([message]) => message);
      expect(diagnostics).toEqual(
        failure === "claim"
          ? [
              "[web-pi] push allowance persistence failed; pushes suppressed until foreground persistence succeeds\n",
              "[web-pi] push grace-period delivery failed; no retry scheduled\n",
            ]
          : [
              "[web-pi] push grace-period delivery failed; no retry scheduled\n",
            ],
      );
      await notifier.send(MESSAGE);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(send).toHaveBeenCalledTimes(failure === "claim" ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
      // Enrollment must not revive an allowance consumed by a failed write.
      notifier.subscribe(subscription("https://push.example/b"));
      expect(stored(directory).awayConsumed).toBe(true);
    },
  );
});

describe("web push store", () => {
  // These tests retain the original immediate delivery and persistence boundaries.
  const createWebPushNotifier = (options: WebPushOptions) =>
    createNotifier({ ...options, gracePeriodMs: 0 });

  it("broadcasts once while away and keeps the consumed allowance across restarts", async () => {
    const directory = agentDir();
    const send = vi.fn().mockResolvedValue(undefined);
    const notifier = createWebPushNotifier({ agentDir: directory, send });
    notifier.subscribe(subscription("https://push.example/a"));
    notifier.subscribe(subscription("https://push.example/b"));
    await notifier.send(MESSAGE);
    await notifier.send(MESSAGE);
    await createWebPushNotifier({ agentDir: directory, send }).send(MESSAGE);
    expect(
      send.mock.calls.map(([target]) => (target as PushSubscription).endpoint),
    ).toEqual(["https://push.example/a", "https://push.example/b"]);
  });
  it("aggregates foreground pages across tabs and devices independently of enrollment", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const notifier = createWebPushNotifier({ agentDir: agentDir(), send });
    notifier.subscribe(subscription("https://push.example/enrolled"));
    const report = (
      clientId: string,
      sequence: number,
      foreground: boolean,
    ) => {
      notifier.reportPresence({ clientId, sequence, foreground });
    };
    report("tab-one", 1, true);
    report("tab-two", 1, true);
    report("other-device-without-push", 1, true);
    await notifier.send(MESSAGE);
    report("tab-one", 2, false);
    report("tab-two", 2, false);
    await notifier.send(MESSAGE);
    expect(send).not.toHaveBeenCalled();
    report("other-device-without-push", 2, false);
    // A delayed active request cannot resurrect a departed page.
    report("tab-one", 1, true);
    await notifier.send(MESSAGE);
    expect(send).toHaveBeenCalledOnce();
    report("background-load", 1, false);
    await notifier.send(MESSAGE);
    expect(send).toHaveBeenCalledOnce();
    report("settings-on-other-device", 1, true);
    await notifier.send(MESSAGE);
    expect(send).toHaveBeenCalledOnce();
    report("settings-on-other-device", 2, false);
    await notifier.send(MESSAGE);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("refreshes leases and expires stale foreground at exactly 60 seconds", async () => {
    vi.useFakeTimers();
    const directory = agentDir();
    const send = vi.fn().mockResolvedValue(undefined);
    const notifier = createWebPushNotifier({ agentDir: directory, send });
    notifier.subscribe(subscription("https://push.example/one"));
    notifier.reportPresence({
      clientId: "phone",
      sequence: 1,
      foreground: true,
    });
    vi.advanceTimersByTime(40_000);
    notifier.reportPresence({
      clientId: "phone",
      sequence: 2,
      foreground: true,
    });
    vi.advanceTimersByTime(59_999);
    await notifier.send(MESSAGE);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await notifier.send(MESSAGE);
    await notifier.send(MESSAGE);
    expect(send).toHaveBeenCalledOnce();
    // A still-focused page resuming heartbeats after suspension confirms return.
    notifier.reportPresence({
      clientId: "phone",
      sequence: 3,
      foreground: true,
    });
    expect(stored(directory).awayConsumed).toBe(false);
    const restore = blockReplacement(join(directory, "web-pi", "push.json"));
    // Refreshing an already armed foreground lease does not rewrite the latch.
    expect(() => {
      notifier.reportPresence({
        clientId: "phone",
        sequence: 4,
        foreground: true,
      });
    }).not.toThrow();
    restore();
    await notifier.send(MESSAGE);
    expect(send).toHaveBeenCalledOnce();
    notifier.reportPresence({
      clientId: "phone",
      sequence: 5,
      foreground: false,
    });
    await notifier.send(MESSAGE);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("persists foreground rearming but does not persist live leases", async () => {
    const directory = agentDir();
    const send = vi.fn().mockResolvedValue(undefined);
    const first = createWebPushNotifier({ agentDir: directory, send });
    first.subscribe(subscription("https://push.example/one"));
    await first.send(MESSAGE);
    const restarted = createWebPushNotifier({ agentDir: directory, send });
    restarted.reportPresence({
      clientId: "restored-page",
      sequence: 1,
      foreground: false,
    });
    await restarted.send(MESSAGE);
    expect(send).toHaveBeenCalledOnce();
    restarted.reportPresence({
      clientId: "restored-page",
      sequence: 2,
      foreground: true,
    });
    await restarted.send(MESSAGE);
    expect(send).toHaveBeenCalledOnce();
    await createWebPushNotifier({ agentDir: directory, send }).send(MESSAGE);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("durably claims the allowance before sending and excludes concurrent completions", async () => {
    const directory = agentDir();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn().mockImplementation(() => {
      expect(stored(directory).awayConsumed).toBe(true);
      return pending;
    });
    const notifier = createWebPushNotifier({ agentDir: directory, send });
    notifier.subscribe(subscription("https://push.example/a"));
    notifier.subscribe(subscription("https://push.example/b"));
    const first = notifier.send(MESSAGE);
    await notifier.send({ ...MESSAGE, title: "Concurrent completion" });
    await createWebPushNotifier({ agentDir: directory, send }).send(MESSAGE);
    expect(send).toHaveBeenCalledOnce();
    release();
    await first;
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a return during in-flight delivery rearms without recalling or narrowing that broadcast", async () => {
    const directory = agentDir();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi
      .fn()
      .mockImplementationOnce(() => pending)
      .mockResolvedValue(undefined);
    const notifier = createWebPushNotifier({ agentDir: directory, send });
    notifier.subscribe(subscription("https://push.example/a"));
    notifier.subscribe(subscription("https://push.example/b"));
    const first = notifier.send(MESSAGE);
    notifier.reportPresence({
      clientId: "return",
      sequence: 1,
      foreground: true,
    });
    release();
    await first;
    expect(send).toHaveBeenCalledTimes(2);
    expect(stored(directory).awayConsumed).toBe(false);
    await notifier.send(MESSAGE);
    expect(send).toHaveBeenCalledTimes(2);
    notifier.reportPresence({
      clientId: "return",
      sequence: 2,
      foreground: false,
    });
    await notifier.send(MESSAGE);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("attempts every enrolled subscription even when all sends fail, with no retry until return", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const directory = agentDir();
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    const notifier = createWebPushNotifier({ agentDir: directory, send });
    notifier.subscribe(subscription("https://push.example/a"));
    notifier.subscribe(subscription("https://push.example/b"));
    await notifier.send(MESSAGE);
    await notifier.send(MESSAGE);
    await createWebPushNotifier({ agentDir: directory, send }).send(MESSAGE);
    expect(send).toHaveBeenCalledTimes(2);
    notifier.reportPresence({
      clientId: "return",
      sequence: 1,
      foreground: true,
    });
    notifier.reportPresence({
      clientId: "return",
      sequence: 2,
      foreground: false,
    });
    await notifier.send(MESSAGE);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("suppresses after a consume write failure, including later enrollment writes, until durable foreground return", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const directory = agentDir();
    const send = vi.fn().mockResolvedValue(undefined);
    const notifier = createWebPushNotifier({ agentDir: directory, send });
    notifier.subscribe(subscription("https://push.example/a"));
    const path = join(directory, "web-pi", "push.json");
    const restore = blockReplacement(path);
    await expect(notifier.send(MESSAGE)).rejects.toThrow(
      "Cannot persist push allowance",
    );
    restore();
    await notifier.send(MESSAGE);
    expect(send).not.toHaveBeenCalled();
    notifier.subscribe(subscription("https://push.example/b"));
    expect(stored(directory).awayConsumed).toBe(true);
    await createWebPushNotifier({ agentDir: directory, send }).send(MESSAGE);
    expect(send).not.toHaveBeenCalled();
    notifier.reportPresence({
      clientId: "return",
      sequence: 1,
      foreground: true,
    });
    notifier.reportPresence({
      clientId: "return",
      sequence: 2,
      foreground: false,
    });
    await notifier.send(MESSAGE);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a failed rearm stays consumed across restarts and retries on an active refresh", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const directory = agentDir();
    const send = vi.fn().mockResolvedValue(undefined);
    const notifier = createWebPushNotifier({ agentDir: directory, send });
    notifier.subscribe(subscription("https://push.example/a"));
    await notifier.send(MESSAGE);
    const restore = blockReplacement(join(directory, "web-pi", "push.json"));
    expect(() => {
      notifier.reportPresence({
        clientId: "return",
        sequence: 1,
        foreground: true,
      });
    }).toThrow("Cannot persist push allowance");
    restore();
    expect(stored(directory).awayConsumed).toBe(true);
    await createWebPushNotifier({ agentDir: directory, send }).send(MESSAGE);
    expect(send).toHaveBeenCalledOnce();
    notifier.reportPresence({
      clientId: "return",
      sequence: 2,
      foreground: true,
    });
    expect(stored(directory).awayConsumed).toBe(false);
    notifier.reportPresence({
      clientId: "return",
      sequence: 3,
      foreground: false,
    });
    await notifier.send(MESSAGE);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("persists VAPID keys privately and keeps them across restarts", () => {
    const directory = agentDir();
    const first = createWebPushNotifier({ agentDir: directory }).publicKey();
    expect(first).not.toBe("");
    expect(stored(directory).vapidKeys.publicKey).toBe(first);
    expect(statSync(join(directory, "web-pi", "push.json")).mode & 0o777).toBe(
      0o600,
    );
    // A second process reads the same keys rather than minting new ones.
    expect(createWebPushNotifier({ agentDir: directory }).publicKey()).toBe(
      first,
    );
  });

  it("upserts a subscription by endpoint", () => {
    const directory = agentDir();
    const notifier = createWebPushNotifier({ agentDir: directory });
    notifier.subscribe(subscription("https://push.example/a"));
    notifier.subscribe(subscription("https://push.example/b"));
    notifier.subscribe({
      endpoint: "https://push.example/a",
      keys: { p256dh: "new", auth: "new" },
    });
    const { subscriptions } = stored(directory);
    expect(
      subscriptions.sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
    ).toEqual([
      {
        endpoint: "https://push.example/a",
        keys: { p256dh: "new", auth: "new" },
      },
      subscription("https://push.example/b"),
    ]);
  });

  it("checks complete enrollment and removes only the matching browser record", () => {
    const directory = agentDir();
    const notifier = createWebPushNotifier({ agentDir: directory });
    const first = subscription("https://push.example/a");
    const second = subscription("https://push.example/b");
    notifier.subscribe(first);
    notifier.subscribe(second);
    const key = notifier.publicKey();
    expect(notifier.has(first)).toBe(true);
    const stale = { ...first, keys: { p256dh: "old", auth: "old" } };
    expect(notifier.has(stale)).toBe(false);
    notifier.unsubscribe(stale);
    expect(notifier.has(first)).toBe(true);
    notifier.unsubscribe(first);
    expect(notifier.has(first)).toBe(false);
    expect(notifier.has(second)).toBe(true);
    expect(notifier.publicKey()).toBe(key);
    expect(createWebPushNotifier({ agentDir: directory }).has(second)).toBe(
      true,
    );
  });

  it("uses the project HTTPS identity with existing keys in the default sender", async () => {
    const directory = agentDir();
    const notifier = createWebPushNotifier({ agentDir: directory });
    const target = subscription("https://push.example/a");
    notifier.subscribe(target);
    const before = stored(directory);
    const send = vi.spyOn(webpush, "sendNotification").mockResolvedValue({
      statusCode: 201,
      body: "",
      headers: {},
    });
    await createWebPushNotifier({ agentDir: directory }).send(MESSAGE);
    expect(send).toHaveBeenCalledWith(target, JSON.stringify(MESSAGE), {
      vapidDetails: {
        subject: "https://github.com/mjakl/web-pi",
        ...stored(directory).vapidKeys,
      },
    });
    expect(stored(directory)).toEqual({ ...before, awayConsumed: true });
  });

  it.each([403, 503, undefined, "secret-token"])(
    "reports only a safe delivery status for %s and preserves enrollment",
    async (statusCode) => {
      const directory = agentDir();
      const report = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const notifier = createWebPushNotifier({
        agentDir: directory,
        send: () =>
          Promise.reject(
            Object.assign(new Error("secret endpoint and auth"), {
              statusCode,
              body: "private response",
              endpoint: "secret-token",
            }),
          ),
      });
      notifier.subscribe(subscription("https://push.example/secret-token"));
      const before = stored(directory);
      await notifier.send(MESSAGE);
      expect(report).toHaveBeenCalledExactlyOnceWith(
        typeof statusCode === "number"
          ? `[web-pi] push delivery failed (HTTP ${String(statusCode)}); subscription retained\n`
          : "[web-pi] push delivery failed (no HTTP status); subscription retained\n",
      );
      expect(stored(directory)).toEqual({ ...before, awayConsumed: true });
      await notifier.send(MESSAGE);
      expect(report).toHaveBeenCalledOnce();
    },
  );

  it("sends the payload to every subscription", async () => {
    const sent: string[] = [];
    const notifier = createWebPushNotifier({
      agentDir: agentDir(),
      send: (target, payload) => {
        sent.push(`${target.endpoint}:${payload}`);
        return Promise.resolve();
      },
    });
    notifier.subscribe(subscription("https://push.example/a"));
    notifier.subscribe(subscription("https://push.example/b"));
    await notifier.send(MESSAGE);
    expect(sent.sort()).toEqual([
      `https://push.example/a:${JSON.stringify(MESSAGE)}`,
      `https://push.example/b:${JSON.stringify(MESSAGE)}`,
    ]);
  });

  it("does nothing when nobody is subscribed", async () => {
    const sent: string[] = [];
    const notifier = createWebPushNotifier({
      agentDir: agentDir(),
      send: (target) => {
        sent.push(target.endpoint);
        return Promise.resolve();
      },
    });
    await notifier.send(MESSAGE);
    expect(sent).toEqual([]);
    notifier.subscribe(subscription("https://push.example/first"));
    await notifier.send(MESSAGE);
    await notifier.send(MESSAGE);
    expect(sent).toEqual(["https://push.example/first"]);
  });

  it.each([404, 410])(
    "drops a subscription the push service has retired with HTTP %s",
    async (statusCode) => {
      const directory = agentDir();
      const notifier = createWebPushNotifier({
        agentDir: directory,
        send: (target) => {
          if (target.endpoint.endsWith("/gone")) {
            return Promise.reject(
              Object.assign(new Error("Gone"), {
                statusCode,
              }),
            );
          }
          return Promise.resolve();
        },
      });
      notifier.subscribe(subscription("https://push.example/gone"));
      notifier.subscribe(subscription("https://push.example/live"));
      await notifier.send(MESSAGE);
      expect(stored(directory).subscriptions.map((s) => s.endpoint)).toEqual([
        "https://push.example/live",
      ]);
    },
  );

  it("keeps the allowance consumed when persisting retired-subscription pruning fails", async () => {
    const directory = agentDir();
    let restore: (() => void) | undefined;
    const send = vi.fn().mockImplementation(() => {
      restore = blockReplacement(join(directory, "web-pi", "push.json"));
      return Promise.reject(
        Object.assign(new Error("Gone"), { statusCode: 404 }),
      );
    });
    const notifier = createWebPushNotifier({ agentDir: directory, send });
    notifier.subscribe(subscription("https://push.example/gone"));
    await expect(notifier.send(MESSAGE)).rejects.toThrow();
    restore?.();
    expect(stored(directory).awayConsumed).toBe(true);
    await createWebPushNotifier({ agentDir: directory, send }).send(MESSAGE);
    await notifier.send(MESSAGE);
    expect(send).toHaveBeenCalledOnce();
  });

  it("accepts legacy enrollment with one initial allowance, but rejects a malformed latch", async () => {
    const directory = agentDir();
    const send = vi.fn().mockResolvedValue(undefined);
    const notifier = createWebPushNotifier({ agentDir: directory, send });
    notifier.subscribe(subscription("https://push.example/one"));
    const path = join(directory, "web-pi", "push.json");
    const legacy = stored(directory);
    delete legacy.awayConsumed;
    writeFileSync(path, JSON.stringify(legacy));
    await createWebPushNotifier({ agentDir: directory, send }).send(MESSAGE);
    expect(send).toHaveBeenCalledOnce();
    const malformed = JSON.stringify({
      ...stored(directory),
      awayConsumed: "true",
    });
    writeFileSync(path, malformed);
    expect(() => createWebPushNotifier({ agentDir: directory, send })).toThrow(
      "Invalid web state",
    );
    expect(readFileSync(path, "utf8")).toBe(malformed);
  });

  it("refuses malformed state without rotating keys or overwriting it", () => {
    const directory = agentDir();
    createWebPushNotifier({ agentDir: directory }).publicKey();
    const path = join(directory, "web-pi", "push.json");
    writeFileSync(path, "not json", "utf8");
    expect(() => createWebPushNotifier({ agentDir: directory })).toThrow(
      "Invalid web state",
    );
    expect(readFileSync(path, "utf8")).toBe("not json");
  });
});
