import type { PushMessage, PushNotifier, PushSubscription } from "@core/ports";
import {
  migrateWebState,
  readWebState,
  webStatePath,
  writeWebState,
} from "@adapters/fs/web-state";
import { isPushSubscription } from "@core/push";
import { createPushSuppression } from "@core/push-suppression";
import { createECDH } from "node:crypto";
import webpush from "web-push";

const FILE = "push.json";

/** Apple rejects localhost VAPID subjects, even with valid keys. */
const SUBJECT = "https://github.com/mjakl/web-pi";

type Keys = { publicKey: string; privateKey: string };

type State = {
  vapidKeys: Keys;
  subscriptions: PushSubscription[];
  /** Absent in legacy files: one initial away broadcast is allowed. */
  awayConsumed?: boolean;
};

function parseState(value: unknown): State {
  if (!value || typeof value !== "object")
    throw new Error("Invalid push state");
  const state = value as State;
  if (
    typeof state.vapidKeys?.publicKey !== "string" ||
    typeof state.vapidKeys.privateKey !== "string" ||
    !Array.isArray(state.subscriptions) ||
    !state.subscriptions.every(isPushSubscription) ||
    (state.awayConsumed !== undefined &&
      typeof state.awayConsumed !== "boolean")
  ) {
    throw new Error("Invalid push state");
  }
  const key = createECDH("prime256v1");
  key.setPrivateKey(Buffer.from(state.vapidKeys.privateKey, "base64url"));
  if (
    !key
      .getPublicKey()
      .equals(Buffer.from(state.vapidKeys.publicKey, "base64url"))
  )
    throw new Error("Invalid VAPID pair");
  return state;
}

/** Never include provider bodies, endpoints, or credentials in diagnostics. */
function httpStatus(error: unknown): number | undefined {
  const status =
    typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
  return typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : undefined;
}

export type WebPushOptions = {
  agentDir: string;
  /** Fixed delay from the first eligible completion; defaults to fifteen minutes. */
  gracePeriodMs?: number;
  /** Injected by the tests; the real one talks to the browser's push service. */
  send?: (
    subscription: PushSubscription,
    payload: string,
    keys: Keys,
  ) => Promise<void>;
};

export function createWebPushNotifier(options: WebPushOptions): PushNotifier {
  migrateWebState(options.agentDir, "web-push.json", FILE, parseState);
  const path = webStatePath(options.agentDir, FILE);
  let state: State = readWebState(path, parseState) ?? {
    vapidKeys: webpush.generateVAPIDKeys(),
    subscriptions: [],
  };
  const send =
    options.send ??
    (async (subscription, payload, keys) => {
      await webpush.sendNotification(subscription, payload, {
        vapidDetails: {
          subject: SUBJECT,
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
      });
    });
  const save = (next: State = state) => {
    writeWebState(path, next);
    state = next;
  };

  const gracePeriodMs = options.gracePeriodMs ?? 15 * 60_000;
  let disposed = false;
  let pending:
    | {
        message: PushMessage;
        count: number;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  function cancelPending(): void {
    if (pending) clearTimeout(pending.timer);
    pending = undefined;
  }

  const suppression = createPushSuppression({
    consumed: state.awayConsumed ?? false,
    onForeground: cancelPending,
    persist: (awayConsumed) => {
      const next = { ...state, awayConsumed };
      try {
        save(next);
      } catch {
        // Never let a later enrollment write revive an unsuccessfully claimed
        // allowance. Rearming, in contrast, takes effect only after a good save.
        if (awayConsumed) state = next;
        process.stderr.write(
          "[web-pi] push allowance persistence failed; pushes suppressed until foreground persistence succeeds\n",
        );
        throw new Error("Cannot persist push allowance");
      }
    },
  });

  async function broadcast(message: PushMessage): Promise<void> {
    if (disposed || state.subscriptions.length === 0 || !suppression.claim())
      return;
    const payload = JSON.stringify(message);
    let pruned = false;
    for (const subscription of [...state.subscriptions]) {
      try {
        await send(subscription, payload, state.vapidKeys);
      } catch (error) {
        const status = httpStatus(error);
        if (status !== 404 && status !== 410) {
          process.stderr.write(
            `[web-pi] push delivery failed (${status === undefined ? "no HTTP status" : `HTTP ${String(status)}`}); subscription retained\n`,
          );
          continue;
        }
        state.subscriptions = state.subscriptions.filter(
          (known) => known.endpoint !== subscription.endpoint,
        );
        pruned = true;
      }
    }
    if (pruned) save();
  }

  return {
    reportPresence: suppression.report,
    dispose(): void {
      disposed = true;
      cancelPending();
    },
    publicKey(): string {
      // Reading the key is what first persists a freshly generated pair: a
      // browser cannot subscribe to keys the next restart would throw away.
      save();
      return state.vapidKeys.publicKey;
    },
    subscribe(subscription): void {
      const subscriptions = [
        ...state.subscriptions.filter(
          (known) => known.endpoint !== subscription.endpoint,
        ),
        {
          endpoint: subscription.endpoint,
          keys: { ...subscription.keys },
        },
      ];
      save({ ...state, subscriptions });
    },
    has(subscription): boolean {
      return state.subscriptions.some(
        (known) =>
          known.endpoint === subscription.endpoint &&
          known.keys.p256dh === subscription.keys.p256dh &&
          known.keys.auth === subscription.keys.auth,
      );
    },
    unsubscribe(subscription): void {
      save({
        ...state,
        subscriptions: state.subscriptions.filter(
          (known) =>
            !(
              known.endpoint === subscription.endpoint &&
              known.keys.p256dh === subscription.keys.p256dh &&
              known.keys.auth === subscription.keys.auth
            ),
        ),
      });
    },
    async send(message: PushMessage): Promise<void> {
      if (
        disposed ||
        state.subscriptions.length === 0 ||
        !suppression.available()
      )
        return;
      if (gracePeriodMs === 0) {
        await broadcast(message);
        return;
      }
      if (pending) {
        pending.count++;
        return;
      }
      const timer = setTimeout(() => {
        const completed = pending;
        pending = undefined;
        if (!completed) return;
        const notification =
          completed.count === 1
            ? completed.message
            : {
                title: `${String(completed.count)} tasks completed`,
                body: `${String(completed.count)} tasks finished while you were away.`,
                url: "/",
                tag: "web-pi:session-complete",
              };
        // The scheduled caller has already returned; never leave failures unhandled.
        void broadcast(notification).catch(() => {
          process.stderr.write(
            "[web-pi] push grace-period delivery failed; no retry scheduled\n",
          );
        });
      }, gracePeriodMs);
      timer.unref();
      pending = { message: { ...message }, count: 1, timer };
    },
  };
}
