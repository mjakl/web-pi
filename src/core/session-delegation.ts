import { isSessionId, type SessionSummary } from "@core/sessions";

export const DELEGATION_TYPE = "pi-subagent:delegation";

export type SessionDelegation = Pick<
  SessionSummary,
  "inspectionOnly" | "delegation"
>;

type Origin = NonNullable<SessionSummary["delegation"]>;

function normalizedText(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

/** Session-wide origin, folded without retaining transcript entries. */
export function delegationFold(sessionId: string): {
  add(entry: unknown): void;
  finish(): SessionDelegation;
} {
  let inspectionOnly = sessionId.startsWith("subagent.");
  let origin: Origin | undefined;
  let invalid = false;
  return {
    add(value) {
      if (typeof value !== "object" || value === null) return;
      const entry = value as Record<string, unknown>;
      if (entry["type"] !== "custom" || entry["customType"] !== DELEGATION_TYPE)
        return;
      const data = entry["data"];
      if (typeof data !== "object" || data === null) return;
      const record = data as Record<string, unknown>;
      // A fork or seeded child may carry another session's record. Only its
      // containing header can establish ownership; copied records say nothing.
      if (record["childSessionId"] !== sessionId) return;
      inspectionOnly = true;
      const parentSessionId = record["parentSessionId"];
      const agent = record["agent"];
      const handle = record["handle"];
      if (
        record["version"] !== 1 ||
        !isSessionId(parentSessionId) ||
        parentSessionId === sessionId ||
        !normalizedText(agent) ||
        !normalizedText(handle)
      ) {
        invalid = true;
        return;
      }
      if (
        origin &&
        (origin.parentSessionId !== parentSessionId ||
          origin.agent !== agent ||
          origin.handle !== handle)
      ) {
        invalid = true;
      }
      origin = { parentSessionId, agent, handle };
    },
    finish() {
      return {
        ...(inspectionOnly ? { inspectionOnly: true } : {}),
        ...(!invalid && origin ? { delegation: origin } : {}),
      };
    },
  };
}
