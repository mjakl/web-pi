import { expect, it, vi } from "vitest";
import { streamingFixture } from "#/web/fixtures/streaming";
import { required } from "#/web/helpers";

it.each(["enrichment", "transport"] as const)(
  "bounds waiting activity renders behind blocked %s without dropping semantic delivery",
  async (phase) => {
    vi.useFakeTimers();
    const f = await streamingFixture(100);
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const list = f.world.models.list.bind(f.world.models);
    let first = true;
    f.world.models.list = async (...args) => {
      if (first) {
        first = false;
        entered.resolve(undefined);
        if (phase === "enrichment") await release.promise;
      }
      return list(...args);
    };
    f.injectPending("notice before blockage", "text before blockage");
    const response = await f.app.request(`/sessions/${f.id}/events?after=`);
    const reader = required(response.body?.getReader());
    const decoder = new TextDecoder();
    let frames = "";
    const receive = async () => {
      const chunk = await reader.read();
      if (!chunk.done) frames += decoder.decode(chunk.value, { stream: true });
      return chunk.done;
    };
    try {
      await entered.promise;
      // Not reading also blocks real transport writes once the first frame
      // fills the stream buffer. No artificial delay is needed in the writer.
      f.finish("answer after blockage", false);
      f.injectPending("notice during blockage", "text during blockage");
      for (let window = 0; window < 20; window += 1) {
        f.emit("activity");
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(f.snapshotReads).toBe(1);
      f.emit("turn_done");
      f.emit("completed");
      release.resolve(undefined);
      while (!frames.includes("event: done\n")) {
        expect(await receive()).toBe(false);
      }

      // The in-flight view, one waiting activity view and the explicit
      // settlement view; completion must follow all three.
      expect(f.snapshotReads).toBe(3);
      expect(frames.match(/^id: settled=/gm)).toHaveLength(3);
      expect(frames.match(/^event: settled$/gm)).toHaveLength(2);
      expect(frames.match(/^event: done$/gm)).toHaveLength(1);
      expect(frames.match(/id="entry-a1"/g)).toHaveLength(1);
      expect(frames).toContain("id: settled=a1");
      for (const text of [
        "notice before blockage",
        "notice during blockage",
        "text before blockage",
        "text during blockage",
      ]) {
        expect(frames.split(text)).toHaveLength(2);
        expect(frames.indexOf(text)).toBeLessThan(
          frames.indexOf("event: done"),
        );
      }

      f.world.store.set(f.id, {
        summary: { ...f.snapshot.summary, live: false },
        entries: [...f.snapshot.entries],
      });
      await f.live.stop();
      f.emit("stopped");
      while (!(await receive())) {
        /* Drain the final reconciliation and close. */
      }
      expect(frames.match(/^id: settled=/gm)).toHaveLength(4);
      expect(frames.match(/^event: settled$/gm)).toHaveLength(3);
      expect(frames.match(/^event: done$/gm)).toHaveLength(1);
      expect(frames.match(/id="entry-a1"/g)).toHaveLength(1);
      expect(frames).toContain("event: web-pi:saved");
      await vi.waitFor(() => {
        expect(f.subscribers).toBe(0);
      });
    } finally {
      release.resolve(undefined);
      await reader.cancel();
      await f.live.stop();
      vi.useRealTimers();
    }
  },
);
