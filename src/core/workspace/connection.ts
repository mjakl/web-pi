import type { Workspace } from "./index.ts";

// The same use cases are available locally and across a process boundary.
// Registration is acknowledged before a caller reads its initial snapshot.
type Awaitable<T> = T | Promise<T>;
type Calls = {
  [K in keyof Workspace]: (
    ...args: Parameters<Workspace[K]>
  ) => ReturnType<Workspace[K]> extends Promise<unknown>
    ? ReturnType<Workspace[K]>
    : Awaitable<ReturnType<Workspace[K]>>;
};
type Subscription<
  K extends "subscribe" | "subscribeActivity" | "subscribeSessions",
> = (
  ...args: [...Parameters<Workspace[K]>, onDisconnect?: (error: Error) => void]
) => Awaitable<Awaited<ReturnType<Workspace[K]>>>;

export type WorkspaceConnection = Omit<
  Calls,
  | "subscribe"
  | "subscribeActivity"
  | "subscribeSessions"
  | "fileBytes"
  | "watchFile"
> & {
  subscribe: Subscription<"subscribe">;
  subscribeActivity: Subscription<"subscribeActivity">;
  subscribeSessions: Subscription<"subscribeSessions">;
  fileBytes: (...args: Parameters<Workspace["fileBytes"]>) => Promise<{
    size: number;
    open: (range?: {
      start: number;
      end: number;
    }) => Awaitable<ReadableStream<Uint8Array>>;
  }>;
  watchFile: (
    ...args: Parameters<Workspace["watchFile"]>
  ) => Promise<
    (
      handlers: Parameters<Awaited<ReturnType<Workspace["watchFile"]>>>[0],
    ) => Awaitable<() => void>
  >;
};
