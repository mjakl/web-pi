/** Only pending unread activity is retained; versions identify observed completions. */
export type UnreadActivity = Readonly<Record<string, string>>;

export type SessionActivityStore = {
  load(): UnreadActivity;
  save(unread: UnreadActivity): void;
};

export function sessionActivity(store: SessionActivityStore) {
  let unread = store.load();
  const listeners = new Set<(unread: UnreadActivity) => void>();
  const version = (id: string) =>
    Object.hasOwn(unread, id) ? unread[id] : undefined;

  function publish(next: UnreadActivity): void {
    unread = next;
    for (const listener of listeners) listener(unread);
  }

  function clear(id: string): void {
    const next = Object.fromEntries(
      Object.entries(unread).filter(([key]) => key !== id),
    );
    store.save(next);
    publish(next);
  }

  return {
    snapshot: () => unread,
    version,
    acknowledge: (id: string, version: string): void => {
      if (version && Object.hasOwn(unread, id) && unread[id] === version)
        clear(id);
    },
    changed: (id: string, finished: boolean): void => {
      if (!finished && version(id) === undefined) return;
      const next = finished
        ? { ...unread, [id]: crypto.randomUUID() }
        : Object.fromEntries(
            Object.entries(unread).filter(([key]) => key !== id),
          );
      try {
        store.save(next);
      } catch {
        // The adapter reports storage failures. Runtime delivery must continue,
        // with in-memory state but without a restart-durability guarantee.
      }
      publish(next);
    },
    subscribe: (listener: (unread: UnreadActivity) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
