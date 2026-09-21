import type { LiveStatus } from "@core/ports";
import type { AssistantItem } from "@core/transcript";
import {
  EarlierPage,
  Item,
  type ItemActions,
  Items,
  LoadEarlier,
  StarButton,
  ToolBody,
  TurnFragment,
} from "@web/views/Items";
import { HistoryActionButtons } from "@web/views/transcript/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  answerItem,
  fixtureCalls,
  liveItems,
  settledItems,
} from "./fixtures/transcript-items.ts";

// Pin the full rendered item inventory alongside focused behavior tests.
// Update markup deliberately with `vitest -u`; browser comparisons verify CSS.

const actions: ItemActions = {
  sessionId: "s1",
  cwd: "/repo/one",
  starred: new Set(["a2"]),
};

const status: LiveStatus = {
  running: true,
  compacting: false,
  bashRunning: false,
  streaming: { tokens: 42, tokensPerSecond: 12.34 },
  model: null,
  thinkingLevel: "off",
  thinkingLevels: [],
  contextTokens: null,
  contextTokensEstimated: false,
  queue: [],
  compaction: null,
  compactionError: null,
  tools: [
    { id: "call-running", name: "grep", progress: "3 files" },
    { id: "call-sub4", name: "subagent", progress: "reading" },
  ],
  retry: null,
  hasSystemPrompt: false,
  hasActiveTools: false,
  statuses: {},
  widgets: [],
  dialog: null,
  custom: null,
  title: null,
  editorText: [],
  notices: [],
};

const html = (node: unknown) => String(node);

function render(label: string, node: unknown): string {
  return `<!-- ${label} -->\n${html(node)}\n`;
}

describe("transcript items", () => {
  beforeAll(() => {
    // Times render in the reader's zone and say "today" relative to now;
    // both are pinned so the fixture reads the same on every machine.
    vi.useFakeTimers({
      now: new Date("2026-01-05T15:00:00.000Z"),
      toFake: ["Date"],
    });
    // Pin the calendar-day comparison as well as the displayed text. A UTC
    // timestamp near midnight can otherwise be "today" only on this host.
    vi.spyOn(Date.prototype, "getFullYear").mockImplementation(
      function (this: Date) {
        return this.getUTCFullYear();
      },
    );
    vi.spyOn(Date.prototype, "getMonth").mockImplementation(
      function (this: Date) {
        return this.getUTCMonth();
      },
    );
    vi.spyOn(Date.prototype, "getDate").mockImplementation(
      function (this: Date) {
        return this.getUTCDate();
      },
    );
    // The options the views pass name every component, so Intl's format is
    // what the locale methods return, minus the reader's zone.
    const utc = (locale: unknown, options: unknown) =>
      new Intl.DateTimeFormat(locale as string, {
        ...(options as Intl.DateTimeFormatOptions),
        timeZone: "UTC",
      });
    vi.spyOn(Date.prototype, "toLocaleTimeString").mockImplementation(
      function (this: Date, locale, options) {
        return utc(locale, options).format(this);
      },
    );
    vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(
      function (this: Date, locale, options) {
        return utc(locale, options).format(this);
      },
    );
  });

  afterAll(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders every view of the fixture exactly as pinned", async () => {
    const html = [
      render(
        "settled, grouped",
        <Items items={settledItems} actions={actions} />,
      ),
      render(
        "settled, read-only",
        <Items items={settledItems} actions={{ ...actions, readOnly: true }} />,
      ),
      render("settled, no actions", <Items items={settledItems} />),
      render(
        "running turn",
        <TurnFragment items={liveItems} actions={actions} status={status} />,
      ),
      render(
        "finished turn",
        <TurnFragment
          items={liveItems}
          actions={actions}
          status={{ ...status, running: false, tools: [], streaming: null }}
        />,
      ),
      render(
        "shell running",
        <TurnFragment
          items={liveItems}
          actions={actions}
          status={{ ...status, running: false, bashRunning: true, tools: [] }}
        />,
      ),
      render(
        "no status",
        <TurnFragment items={liveItems} actions={actions} status={null} />,
      ),
      render(
        "earlier page, busy",
        <EarlierPage
          items={settledItems.slice(0, 3)}
          actions={{ ...actions, busy: true }}
          hasMore
          oldestId="u1"
          leaf="a5"
        />,
      ),
      render(
        "last page",
        <EarlierPage
          items={settledItems.slice(0, 1)}
          actions={actions}
          hasMore={false}
        />,
      ),
      render("load earlier", <LoadEarlier sessionId="s1" before="u1" />),
      render("star", <StarButton entryId="a2" actions={actions} />),
      render("unstarred", <StarButton entryId="a1" actions={actions} />),
      render(
        "tool body, budgeted",
        <ToolBody call={fixtureCalls.longTextCall} actions={actions} />,
      ),
      render(
        "tool body, full",
        <ToolBody call={fixtureCalls.longTextCall} actions={actions} full />,
      ),
      render(
        "diff body, no actions",
        <ToolBody call={fixtureCalls.editCall} />,
      ),
      render(
        "lone item, starrable with written files",
        <Item
          item={answerItem}
          actions={actions}
          starrable
          written={["/repo/one/src/app.ts"]}
        />,
      ),
    ].join("");
    await expect(html).toMatchFileSnapshot("./fixtures/transcript-items.html");
  });

  it("keeps turn and disclosure keys stable when a saved turn gains an answer", () => {
    const boundary = settledItems[0];
    if (!boundary) throw new Error("Missing fixture boundary");
    const thinking: AssistantItem = {
      ...answerItem,
      entryId: "reasoning",
      blocks: [{ kind: "thinking", text: "", index: 2, deferred: true }],
    };
    const before = html(
      <Items items={[boundary, thinking]} actions={actions} />,
    );
    const after = html(
      <Items
        items={[
          boundary,
          {
            ...thinking,
            blocks: [...thinking.blocks, { kind: "text", text: "Done" }],
          },
        ]}
        actions={actions}
      />,
    );
    for (const rendered of [before, after]) {
      expect(rendered).toContain('<section id="turn-u1"');
      expect(rendered).toContain('id="process-u1"');
      expect(rendered).toContain('id="thinking-reasoning-2"');
      expect(rendered).toContain('id="entry-reasoning-process"');
      expect(rendered).toContain(
        'id="thinking-body-reasoning-2" class="thinking-body" hx-morph-skip=""',
      );
      expect(rendered).toContain(
        'hx-trigger="toggle[this.closest(&#39;details&#39;).open] once from:&lt;closest details/&gt;" hx-swap="innerHTML"',
      );
      const ids = [...rendered.matchAll(/\bid="([^"]+)"/g)].map(
        (match) => match[1],
      );
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(after).toContain('id="entry-reasoning"');
    expect(html(<Items items={[thinking]} actions={actions} />)).toContain(
      '<section id="turn-reasoning"',
    );
  });

  it.each([false, true])(
    "preserves persisted thinking bodies across refresh with deferred=%s",
    (deferred) => {
      const rendered = html(
        <Item
          item={{
            ...answerItem,
            blocks: [
              {
                kind: "thinking",
                text: deferred ? "" : "Loaded reasoning",
                index: 0,
                deferred,
              },
            ],
          }}
          actions={actions}
        />,
      );
      expect(rendered).toContain(
        'id="thinking-body-a2-0" class="thinking-body" hx-morph-skip=""',
      );
      expect(rendered).toContain(
        deferred ? "Loading thinking..." : "Loaded reasoning",
      );
    },
  );

  it("keys thinking by block and partial timestamp without freezing streamed bodies", () => {
    const renderThinking = (timestamp: string) =>
      html(
        <Item
          item={{
            ...answerItem,
            entryId: "partial",
            timestamp,
            blocks: [0, 1].map((index) => ({
              kind: "thinking",
              text: "Working",
              index,
              deferred: false,
            })),
          }}
          actions={actions}
        />,
      );
    const first = renderThinking("2026-01-05T00:00:00.000Z");
    const second = renderThinking("2026-01-05T00:00:01.000Z");
    expect(first).toContain('id="thinking-partial-1767571200000-0"');
    expect(first).toContain('id="thinking-partial-1767571200000-1"');
    expect(second).toContain('id="thinking-partial-1767571201000-0"');
    expect(first).not.toContain("hx-morph-skip");
  });

  it("uses concise labels and a light plus for history actions", () => {
    const buttons = html(
      <HistoryActionButtons entryId="a1" actions={actions} />,
    );

    expect(buttons).toMatch(
      /aria-label="New branch"[\s\S]*?<path d="M6 3v12M18 9a9 9 0 0 1-9 9"><\/path>[\s\S]*?<\/svg>Branch<\/button>/,
    );
    expect(buttons).toMatch(
      /title="New session[^>]*>[\s\S]*?<svg width="11" height="11" viewBox="0 0 12 12"[^>]*stroke-width="1.2"[\s\S]*?<line x1="6" y1="1" x2="6" y2="11"><\/line>[\s\S]*?<\/svg>Clone<\/button>/,
    );
  });

  it.each([
    ["empty", []],
    ["whitespace", [{ kind: "text", text: " \n\t " }]],
    [
      "thinking",
      [
        {
          kind: "thinking",
          text: "Private reasoning",
          index: 0,
          deferred: false,
        },
      ],
    ],
    ["tool result", [{ kind: "tool", call: fixtureCalls.editCall }]],
    [
      "tool call",
      [
        {
          kind: "tool",
          call: {
            id: "pending",
            name: "process",
            arguments: {},
            preview: "Starting",
          },
        },
      ],
    ],
  ] satisfies [string, AssistantItem["blocks"]][])(
    "hides history actions on %s assistant output",
    (_label, blocks) => {
      const rendered = html(
        <Item item={{ ...answerItem, blocks }} actions={actions} />,
      );
      expect(rendered).not.toContain('class="history-action"');
    },
  );

  it.each(["", " \n\t"])(
    "shows blank thinking %j only as non-clickable activity while streaming",
    (text) => {
      const item: AssistantItem = {
        ...answerItem,
        entryId: "partial",
        blocks: [{ kind: "thinking", text, index: 0, deferred: false }],
      };
      const streaming = html(
        <TurnFragment items={[item]} actions={actions} status={status} />,
      );
      expect(streaming).toContain("Thinking");
      expect(streaming).not.toContain("<details");
      expect(streaming).not.toContain("<summary");
      expect(streaming).not.toContain("card-chevron");
      for (const running of [true, false]) {
        const finished = html(
          <TurnFragment
            items={[{ ...item, entryId: "finished" }]}
            actions={actions}
            status={{ ...status, running, streaming: null }}
          />,
        );
        expect(finished).not.toContain("Thinking");
        expect(finished).not.toContain("<details");
      }
    },
  );

  it.each([false, true])(
    "keeps substantive and deferred thinking controls with live=%s",
    (live) => {
      for (const deferred of [false, true]) {
        const rendered = html(
          <Items
            items={[
              {
                ...answerItem,
                entryId: "partial",
                blocks: [
                  {
                    kind: "thinking",
                    text: deferred ? "" : "Real reasoning",
                    index: 0,
                    deferred,
                  },
                ],
              },
            ]}
            actions={{
              ...actions,
              live,
              streaming: status.streaming ?? undefined,
            }}
          />,
        );
        expect(rendered).toContain("<details");
        expect(rendered).toContain("<summary");
        expect(rendered).toContain("card-chevron");
        expect(rendered).toContain(
          deferred
            ? 'hx-get="/sessions/s1/entries/partial/thinking/0"'
            : "Real reasoning",
        );
      }
    },
  );

  it("hides history actions on user, shell, and metadata entries", () => {
    for (const item of settledItems.filter(
      (item) => item.kind !== "assistant",
    )) {
      expect(html(<Item item={item} actions={actions} />)).not.toContain(
        'class="history-action"',
      );
    }
  });

  it.each(["history", "earlier", "finished", "running", "read-only", "busy"])(
    "offers actions only on user-facing assistant content in %s rendering",
    (mode) => {
      const items = [
        ...settledItems.filter((item) => item.kind !== "assistant"),
        { ...answerItem, entryId: "empty", blocks: [] },
        {
          ...answerItem,
          entryId: "thinking",
          blocks: [
            { kind: "thinking", text: "Private", index: 0, deferred: true },
          ],
        },
        {
          ...answerItem,
          entryId: "mixed",
          blocks: [
            { kind: "thinking", text: "Private", index: 0, deferred: false },
            { kind: "tool", call: fixtureCalls.editCall },
            { kind: "text", text: "Here is the result." },
          ],
        },
        {
          ...answerItem,
          entryId: "image",
          blocks: [{ kind: "image", index: 0 }],
        },
        answerItem,
      ] satisfies Parameters<typeof Items>[0]["items"];
      const context = {
        ...actions,
        readOnly: mode === "read-only",
        busy: mode === "busy",
      };
      const rendered = html(
        mode === "earlier" ? (
          <EarlierPage items={items} actions={context} hasMore={false} />
        ) : mode === "finished" || mode === "running" ? (
          <TurnFragment
            items={items}
            actions={context}
            status={{ ...status, running: mode === "running", streaming: null }}
          />
        ) : (
          <Items items={items} actions={context} />
        ),
      );
      for (const operation of ["navigate", "fork"]) {
        const buttons =
          rendered.match(
            new RegExp(
              `<button[^>]*hx-post="/sessions/s1/${operation}"[^>]*>`,
              "g",
            ),
          ) ?? [];
        expect(buttons).toHaveLength(
          mode === "running" || mode === "read-only" ? 0 : 3,
        );
        if (buttons.length > 0) {
          expect(
            buttons.map((button) => /hx-vals="([^"]*)"/.exec(button)?.[1]),
          ).toEqual(
            ["mixed", "image", "a2"].map(
              (id) => `{&quot;entryId&quot;:&quot;${id}&quot;}`,
            ),
          );
          for (const button of buttons) {
            expect(button.includes('disabled=""')).toBe(
              mode === "busy" && operation === "navigate",
            );
          }
        }
      }
    },
  );

  it("cuts a long diff to the row budget, whole files first", () => {
    const cut = html(
      <ToolBody call={fixtureCalls.longDiffCall} actions={actions} />,
    );
    // 210 rows in the first file: 200 kept, and the second file is dropped
    // rather than shown as a torso.
    expect(cut.match(/class="tool-diff-row"/g)).toHaveLength(200);
    expect(cut).not.toContain("src/tail.ts");
    expect(cut).toContain("view full output");
    const full = html(
      <ToolBody call={fixtureCalls.longDiffCall} actions={actions} full />,
    );
    expect(full.match(/class="tool-diff-row"/g)).toHaveLength(211);
    expect(full).toContain("src/tail.ts");
    expect(full).not.toContain("view full output");
  });
});
