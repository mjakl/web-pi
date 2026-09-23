import { createWebPushNotifier } from "@adapters/pi/web-push";
import type { PushMessage, PushSubscription } from "@core/ports";
import {
  mkdtempSync,
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
} {
  return JSON.parse(
    readFileSync(join(directory, "web-pi", "push.json"), "utf8"),
  ) as ReturnType<typeof stored>;
}

function subscription(endpoint: string): PushSubscription {
  return { endpoint, keys: { p256dh: "p", auth: "a" } };
}

const MESSAGE: PushMessage = {
  title: "Session complete",
  body: "Task finished.",
  url: "/sessions/one",
  tag: "web-pi:session-complete:one",
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("web push store", () => {
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
    const before = readFileSync(join(directory, "web-pi", "push.json"), "utf8");
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
    expect(readFileSync(join(directory, "web-pi", "push.json"), "utf8")).toBe(
      before,
    );
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
      const before = readFileSync(
        join(directory, "web-pi", "push.json"),
        "utf8",
      );
      await notifier.send(MESSAGE);
      expect(report).toHaveBeenCalledExactlyOnceWith(
        typeof statusCode === "number"
          ? `[web-pi] push delivery failed (HTTP ${String(statusCode)}); subscription retained\n`
          : "[web-pi] push delivery failed (no HTTP status); subscription retained\n",
      );
      expect(readFileSync(join(directory, "web-pi", "push.json"), "utf8")).toBe(
        before,
      );
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
  });

  it("drops a subscription the push service has retired", async () => {
    const directory = agentDir();
    const notifier = createWebPushNotifier({
      agentDir: directory,
      send: (target) => {
        if (target.endpoint.endsWith("/gone")) {
          return Promise.reject(
            Object.assign(new Error("Gone"), {
              statusCode: 410,
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
