import type { PushPresence, PushSubscription } from "@core/ports";

export function isPushPresence(value: unknown): value is PushPresence {
  if (typeof value !== "object" || value === null) return false;
  const { clientId, sequence, foreground } = value as Partial<PushPresence>;
  return (
    typeof clientId === "string" &&
    /^[a-zA-Z0-9-]{1,64}$/.test(clientId) &&
    typeof sequence === "number" &&
    Number.isSafeInteger(sequence) &&
    sequence > 0 &&
    typeof foreground === "boolean"
  );
}

export function isPushSubscription(value: unknown): value is PushSubscription {
  if (typeof value !== "object" || value === null) return false;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://"))
    return false;
  if (typeof keys !== "object" || keys === null) return false;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  return (
    typeof p256dh === "string" &&
    p256dh !== "" &&
    typeof auth === "string" &&
    auth !== ""
  );
}
