import type { PushPresence } from "@core/ports";

export const PUSH_PRESENCE_REFRESH_MS = 20_000;
export const PUSH_PRESENCE_LEASE_MS = 60_000;

/** One server's foreground leases and durable allowance for an away broadcast. */
export function createPushSuppression(options: {
  consumed: boolean;
  persist: (consumed: boolean) => void;
}) {
  const clients = new Map<string, PushPresence & { expires: number }>();
  let consumed = options.consumed;

  function expire(): void {
    const time = Date.now();
    for (const [id, client] of clients) {
      if (client.expires <= time) clients.delete(id);
    }
  }

  return {
    report: (presence: PushPresence): void => {
      expire();
      const previous = clients.get(presence.clientId);
      if (previous && previous.sequence >= presence.sequence) return;
      // Keep inactive reports for one lease too, so a delayed foreground
      // request cannot undo a newer departure.
      clients.set(presence.clientId, {
        ...presence,
        expires: Date.now() + PUSH_PRESENCE_LEASE_MS,
      });
      if (presence.foreground && consumed) {
        options.persist(false);
        consumed = false;
      }
    },
    claim: (): boolean => {
      expire();
      if (consumed || [...clients.values()].some((client) => client.foreground))
        return false;
      // No await between checking and consuming: concurrent completions cannot
      // share an allowance. A failed write still suppresses this runtime.
      consumed = true;
      options.persist(true);
      return true;
    },
  };
}
