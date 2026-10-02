import { delegationFold, DELEGATION_TYPE } from "@core/session-delegation";
import {
  discoverSessionRoots,
  type SessionDiscoveryOptions,
} from "@core/session-discovery";
import { sessionTree, sessionTreePage } from "@core/session-tree";
import { isSubagentSession, type SessionSummary } from "@core/sessions";
import { describe, expect, it } from "vitest";

function header(id: string, time: number): SessionSummary {
  return {
    id,
    cwd: "/repo",
    createdAt: new Date(0).toISOString(),
    modifiedAt: new Date(time).toISOString(),
    fileSize: 100,
  };
}
function claim(id: string, parent: string, extra = {}) {
  return {
    type: "custom",
    customType: DELEGATION_TYPE,
    data: {
      version: 1,
      childSessionId: id,
      parentSessionId: parent,
      agent: "coder",
      handle: "task",
      ...extra,
    },
  };
}
function file(
  id: string,
  time: number,
  parent?: string,
  live?: "running" | "idle",
  records?: unknown[],
) {
  const summary = header(id, time);
  const fold = delegationFold(id);
  for (const entry of records ?? (parent ? [claim(id, parent)] : []))
    fold.add(entry);
  return {
    header: summary,
    summary: {
      ...summary,
      ...fold.finish(),
      ...(live ? { live: true, running: live === "running" } : {}),
    },
  };
}
const roots = (n: number, time = 1000) =>
  Array.from({ length: n }, (_, i) =>
    file(`root-${String(i).padStart(3, "0")}`, time - i),
  );
async function check(
  files: ReturnType<typeof file>[],
  options: Partial<SessionDiscoveryOptions> = {},
) {
  const classified = files.map((f) =>
    isSubagentSession(f.summary)
      ? { ...f.summary, live: false, running: false }
      : f.summary,
  );
  const summaries = new Map(files.map((f, i) => [f.header, classified[i]]));
  const visits: string[] = [];
  const result = await discoverSessionRoots(
    files.map((f) => f.header),
    (h) => {
      visits.push(h.id);
      return Promise.resolve(summaries.get(h));
    },
    {
      runtime: files.filter((f) => f.summary.live).map((f) => f.summary),
      ...options,
    },
  );
  const actual = sessionTree(result.summaries);
  const full = sessionTree(classified);
  const k = (options.offset ?? 0) + 50;
  const ids = (tree: ReturnType<typeof sessionTree>) =>
    tree.roots.slice(0, k).map((n) => n.summary.id);
  expect(ids(actual)).toEqual(ids(full));
  const actualPage = sessionTreePage(actual, options),
    fullPage = sessionTreePage(full, options);
  expect(actualPage.nodes.map((n) => n.summary.id)).toEqual(
    fullPage.nodes.map((n) => n.summary.id),
  );
  expect(actualPage.nextOffset).toBe(fullPage.nextOffset);
  expect([...actualPage.selectedPath]).toEqual([...fullPage.selectedPath]);
  return { result, visits, actual, full };
}

describe("priority interval root discovery", () => {
  it("separates runtime priority from time and cursor existence from extra-root order", async () => {
    const files = [
      file("old-running", 1, undefined, "running"),
      file("old-idle", 2, undefined, "idle"),
      ...roots(200),
    ];
    expect((await check(files)).visits).toHaveLength(51);
    const selected = await check([...roots(200), file("old-selected", 1)], {
      selectedId: "old-selected",
    });
    expect(selected.visits).toHaveLength(51);
    expect(selected.actual.roots[50]?.summary.id).toBe("old-selected");
    expect(selected.full.roots[50]?.summary.id).not.toBe("old-selected");
    expect((await check(files, { offset: 50 })).visits).toHaveLength(101);
  });
  it("must exhaust ambiguous same-priority live intervals but stops after a separating child", async () => {
    const live = [
      file("a", 1, undefined, "running"),
      file("b", 2, undefined, "running"),
    ];
    expect((await check([...live, ...roots(200)])).result.complete).toBe(true);
    const separated = await check([
      ...live,
      file("new-child", 2000, "a"),
      ...roots(200),
    ]);
    expect(separated.visits).toHaveLength(52);
    expect(separated.result.complete).toBe(false);
  });
  it("compares known boundary rivals and actual root IDs on timestamp ties", async () => {
    const live = Array.from({ length: 49 }, (_, i) =>
      file(`high-${String(i)}`, 2000 - i, undefined, "running"),
    );
    const rival = await check([
      ...live,
      file("last", 100, undefined, "running"),
      file("rival", 99, undefined, "running"),
      file("rival-child", 150, "rival"),
      ...roots(100, 140),
    ]);
    expect(rival.visits).toHaveLength(52);
    const equal = Array.from({ length: 60 }, (_, i) =>
      file(`id-${String(i).padStart(3, "0")}`, 100),
    );
    expect((await check(equal.slice().reverse())).visits).toHaveLength(51);
    const tied = await check([
      ...roots(49, 1000),
      file("z", 10),
      file("a-child", 10, "z"),
      file("b", 10),
    ]);
    expect(tied.actual.roots.at(-1)?.summary.id).toBe("z");
  });
  it("closes selected missing-parent and cyclic ancestry, including copied/conflicting/malformed claims", async () => {
    const families = [
      [
        file("p", 1, "missing"),
        file("middle", 2, "p"),
        file("selected", 3, "middle"),
      ],
      [
        file("a", 1, "b"),
        file("b", 2, "c"),
        file("c", 3, "a"),
        file("selected", 4, "b"),
      ],
      [
        file("p", 1),
        file("selected", 3, undefined, undefined, [
          claim("other", "p"),
          claim("selected", "p"),
          claim("selected", "other"),
        ]),
        file("malformed", 2000, undefined, undefined, [
          claim("malformed", "p", { handle: null }),
        ]),
      ],
    ];
    for (const family of families)
      await check([...roots(150), ...family], { selectedId: "selected" });
    const duplicated = await check([
      ...roots(60),
      file("root-000", 1, "root-001"),
    ]);
    expect(duplicated.result.complete).toBe(true);
    expect(duplicated.visits).toHaveLength(61);
    const short = await check([
      file("p", 1),
      ...Array.from({ length: 70 }, (_, i) =>
        file(`c-${String(i)}`, 100 - i, "p"),
      ),
    ]);
    expect(short.result.complete).toBe(true);
  });
  it("matches complete trees across dense and sparse activity, ties, cycles and later pages", async () => {
    let seed = 0x1a7e2a1;
    const random = (n: number) => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % n;
    };
    for (let trial = 0; trial < 180; trial += 1) {
      const n = random(181);
      const files = Array.from({ length: n }, (_, i) => {
        const id = `id-${String((i * 37) % 181).padStart(3, "0")}`;
        const parent =
          random(3) === 0
            ? `id-${String((random(n + 3) * 37) % 181).padStart(3, "0")}`
            : undefined;
        const records = parent ? [claim(id, parent)] : [];
        if (random(20) === 0) records.push(claim(id, "missing-other"));
        if (random(12) === 0) records.push(claim("copied", "other"));
        if (random(40) === 0) records.push(claim(id, "other", { version: 2 }));
        return file(
          id,
          random(trial % 2 ? 3 : 60),
          undefined,
          random(4) === 0 ? (random(2) ? "running" : "idle") : undefined,
          records,
        );
      });
      for (const offset of [0, 50])
        await check(files, { offset, selectedId: files[random(n)]?.header.id });
    }
  });
});
