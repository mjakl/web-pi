import {
  readWebState,
  webStatePath,
  writeWebState,
} from "@adapters/fs/web-state";
import type {
  SessionActivityStore,
  UnreadActivity,
} from "@core/session-activity";
import { isSessionId } from "@core/sessions";

export function createSessionActivityStore(
  agentDir: string,
): SessionActivityStore {
  const path = webStatePath(agentDir, "unread.json");
  return {
    load: () =>
      readWebState(path, (value: unknown): UnreadActivity => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Expected unread activity map");
        for (const [id, version] of Object.entries(value)) {
          if (!isSessionId(id) || typeof version !== "string" || !version)
            throw new Error("Invalid unread activity");
        }
        return value as UnreadActivity;
      }) ?? {},
    save: (unread) => {
      try {
        writeWebState(path, unread);
      } catch (error) {
        process.stderr.write(
          `Cannot persist unread session activity: ${path}\n`,
        );
        throw error;
      }
    },
  };
}
