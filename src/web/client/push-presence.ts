import { PUSH_PRESENCE_REFRESH_MS } from "@core/push-suppression";

/** Presence belongs to the document, not a session, Settings, or enrollment. */
export function setUpPushPresence(): void {
  const clientId = Array.from(
    crypto.getRandomValues(new Uint32Array(4)),
    (part) => part.toString(16),
  ).join("-");
  let sequence = 0;
  let departed = false;
  let wasForeground = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function report(): void {
    const foreground =
      !departed &&
      document.visibilityState === "visible" &&
      document.hasFocus();
    if (!foreground && !wasForeground) return;
    wasForeground = foreground;
    // Keepalive also gives pagehide/blur a chance to release the lease. Delivery
    // is best effort; sequence numbers reject requests arriving out of order.
    void fetch("/push/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, sequence: ++sequence, foreground }),
      keepalive: true,
    }).catch(() => {});
    if (foreground && timer === undefined) {
      timer = setInterval(report, PUSH_PRESENCE_REFRESH_MS);
    } else if (!foreground && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  document.addEventListener("visibilitychange", report);
  window.addEventListener("focus", report);
  window.addEventListener("blur", report);
  window.addEventListener("online", report);
  window.addEventListener("pageshow", () => {
    departed = false;
    report();
  });
  window.addEventListener("pagehide", () => {
    departed = true;
    report();
  });
  report();
}
