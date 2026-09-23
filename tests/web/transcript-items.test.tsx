import type { LiveStatus } from "@core/ports";
import type { AssistantItem, ToolCallView } from "@core/transcript";
import {
  EarlierPage,
  Item,
  type ItemActions,
  Items,
  StarButton,
  ToolBody,
  TurnFragment,
} from "@web/views/Items";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  answerItem,
  fixtureCalls,
  settledItems,
} from "./fixtures/transcript-items.ts";

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

const windows: Window[] = [];
function rendered(node: unknown) {
  const window = new Window();
  windows.push(window);
  window.document.body.innerHTML = html(node);
  return window.document;
}
afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});

describe("transcript items", () => {
  it.each([
    { label: "message", command: undefined },
    { label: "expanded skill", command: "/skill:deploy staging now" },
  ])("preserves $label source and attachment identities", ({ command }) => {
    const user = settledItems[0];
    if (user?.kind !== "user") throw new Error("Missing user fixture");
    const document = rendered(
      <Item
        item={{ ...user, ...(command ? { command } : {}) }}
        actions={actions}
      />,
    );
    const message = document.querySelector("#entry-u1");
    expect(message?.querySelector("[data-user-text]")?.textContent).toBe(
      command ?? user.text,
    );
    expect(message?.querySelector("[data-copy-source]")?.textContent).toBe(
      command ?? user.text,
    );
    const previews = [...document.querySelectorAll("[data-image-preview]")];
    expect(
      previews.map((button) => button.getAttribute("data-image-preview")),
    ).toEqual([
      "/sessions/s1/entries/u1/image/0",
      "/sessions/s1/entries/u1/image/1",
    ]);
    for (const button of previews) {
      expect(button.getAttribute("aria-haspopup")).toBe("dialog");
      expect(button.querySelector("img")?.getAttribute("src")).toBe(
        button.getAttribute("data-image-preview"),
      );
    }
    expect(message?.textContent).toContain("Fix the <b>bug</b>");
    expect(message?.querySelector("b, script")).toBeNull();
    if (command) {
      const disclosure = message?.querySelector("details");
      expect(disclosure?.open).toBe(false);
      expect(
        disclosure?.querySelector("summary [data-user-text]")?.textContent,
      ).toBe(command);
    }
  });

  it("shows provider errors and aborted empty answers without interpreting error text as HTML", () => {
    const document = rendered(
      <Items
        items={[
          {
            ...answerItem,
            entryId: "failed",
            blocks: [],
            stopReason: "error",
            errorMessage: '<img src=x onerror="alert(1)"> & denied',
          },
          {
            ...answerItem,
            entryId: "aborted",
            blocks: [],
            stopReason: "aborted",
          },
        ]}
        actions={actions}
      />,
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Error: <img src=x onerror="alert(1)"> & denied',
    );
    expect(document.querySelector("#entry-aborted")?.textContent).toContain(
      "Stopped",
    );
    expect(document.querySelector("img, script")).toBeNull();
  });

  it("keeps completed tools deferred and offers full output after the text budget", () => {
    const call = fixtureCalls.longTextCall;
    const document = rendered(
      <Item
        item={{ ...answerItem, blocks: [{ kind: "tool", call }] }}
        actions={actions}
      />,
    );
    const placeholder = document.querySelector("[hx-get]");
    expect(placeholder?.getAttribute("hx-get")).toBe(
      "/sessions/s1/entries/r7/tool-result/call-cat",
    );
    expect(placeholder?.getAttribute("hx-swap")).toBe("outerHTML");
    expect(placeholder?.getAttribute("hx-sync")).toBe("this:drop");
    expect(placeholder?.hasAttribute("hx-morph-skip")).toBe(true);
    expect(document.body.textContent).not.toContain("x".repeat(100));
    const cut = rendered(<ToolBody call={call} actions={actions} />);
    expect(cut.querySelector(".tool-output-text")?.textContent).toBe(
      "x".repeat(16 * 1024),
    );
    const more = cut.querySelector("button[hx-get]");
    expect(more?.getAttribute("hx-get")).toBe(
      "/sessions/s1/entries/r7/tool-result/call-cat?full=1",
    );
    expect(more?.getAttribute("hx-target")).toBe("closest .tool-result");
    expect(more?.getAttribute("hx-swap")).toBe("outerHTML");
    const full = rendered(<ToolBody call={call} actions={actions} full />);
    expect(full.querySelector(".tool-output-text")?.textContent).toBe(
      call.result?.text,
    );
    expect(full.querySelector("button[hx-get]")).toBeNull();
  });

  it("marks failed tools before and after body loading and escapes their input and output", () => {
    const input = '<img src=x onerror="alert(1)">';
    const call: ToolCallView = {
      ...fixtureCalls.longTextCall,
      arguments: { command: input },
      result: {
        entryId: "failed-tool",
        text: "denied <script>alert(1)</script> & retry",
        isError: true,
        images: [],
      },
    };
    const card = rendered(
      <Item
        item={{ ...answerItem, blocks: [{ kind: "tool", call }] }}
        actions={actions}
      />,
    );
    expect(
      card.querySelector(".tool-card")?.classList.contains("is-error"),
    ).toBe(true);
    expect(
      card
        .querySelector(".tool-deferred-output")
        ?.classList.contains("is-error"),
    ).toBe(true);
    const document = rendered(<ToolBody call={call} actions={actions} />);
    expect(
      document.querySelector(".tool-input")?.classList.contains("is-error"),
    ).toBe(true);
    expect(
      document.querySelector(".tool-output")?.classList.contains("is-error"),
    ).toBe(true);
    expect(document.querySelector(".tool-input")?.textContent).toBe(
      JSON.stringify({ command: input }, null, 2),
    );
    expect(document.querySelector(".tool-output-text")?.textContent).toBe(
      "denied <script>alert(1)</script> & retry",
    );
    expect(document.querySelector("script, img")).toBeNull();
  });

  it("reports mixed subagent outcomes and preserves failure diagnostics and capture warnings in the deferred body", () => {
    const error = 'boom <img src=x onerror="alert(1)"> & retry';
    const call: ToolCallView = {
      id: "mixed-subagents",
      name: "subagent",
      arguments: { agents: ["a", "b", "c"] },
      preview: "3 agents",
      result: {
        entryId: "mixed-result",
        text: "mixed",
        isError: false,
        images: [],
      },
      subagent: {
        calls: [
          { agent: "a", prompt: "one" },
          { agent: "b", prompt: "two" },
          { agent: "c", prompt: "three" },
        ],
        runs: [
          {
            status: "completed",
            output: "Captured tail",
            captureTruncated: true,
            handledWithoutAgent: false,
          },
          {
            status: "failed",
            output: "",
            error,
            captureTruncated: false,
            handledWithoutAgent: false,
          },
          {
            status: "cancelled",
            output: "",
            captureTruncated: false,
            handledWithoutAgent: false,
          },
        ],
        failed: false,
      },
    };
    const card = rendered(
      <Item
        item={{ ...answerItem, blocks: [{ kind: "tool", call }] }}
        actions={actions}
      />,
    );
    expect(card.querySelector(".subagent-counts")?.textContent).toBe(
      "1 completed · 1 failed · 1 cancelled",
    );
    expect(card.body.textContent).not.toContain(error);
    const body = rendered(<ToolBody call={call} actions={actions} />);
    expect(
      body.querySelector(".subagent-status-failed")?.textContent,
    ).toContain("Failed");
    expect(
      body.querySelector(".subagent-status-cancelled")?.textContent,
    ).toContain("Cancelled");
    expect(body.querySelector(".subagent-error")?.textContent).toBe(error);
    expect(body.querySelector(".subagent-notice")?.textContent).toBe(
      "Only the end of the output was captured.",
    );
    expect(body.querySelector("script, img")).toBeNull();
  });

  it("marks a nonzero shell exit as failed and preserves its escaped diagnostic", () => {
    const shell = settledItems.find((item) => item.kind === "bash");
    if (!shell) throw new Error("Missing shell fixture");
    const output = "build failed <script>alert(1)</script> & stopped";
    const document = rendered(
      <Item
        item={{
          ...shell,
          command: "make",
          exitCode: 2,
          output,
          truncated: false,
          excluded: true,
        }}
        actions={actions}
      />,
    );
    expect(
      document.querySelector(".tool-card")?.classList.contains("is-error"),
    ).toBe(true);
    expect(
      document.querySelector(".tool-output")?.classList.contains("is-error"),
    ).toBe(true);
    expect(document.querySelector(".tool-output-text")?.textContent).toBe(
      output,
    );
    expect(document.querySelector("script")).toBeNull();
  });

  it("keeps stars targeted at the answer and replaces only that button", () => {
    const document = rendered(<StarButton entryId="a2" actions={actions} />);
    const button = document.querySelector("button");
    expect(button?.getAttribute("hx-post")).toBe("/sessions/s1/star");
    expect(JSON.parse(button?.getAttribute("hx-vals") ?? "{}")).toEqual({
      entryId: "a2",
      starred: false,
    });
    expect(button?.getAttribute("hx-target")).toBe("this");
    expect(button?.getAttribute("hx-swap")).toBe("outerHTML");
    expect(button?.getAttribute("aria-label")).toBe("Unstar answer");
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

  it.each([false, true])(
    "renders source-copy beside assistant history actions (busy: %s)",
    (busy) => {
      const document = rendered(
        <Item
          item={answerItem}
          actions={{
            ...actions,
            busy,
            timestamps: new Set([answerItem.entryId]),
          }}
        />,
      );
      const row = document.querySelector(".history-actions");
      expect(row?.querySelector("[data-copy]")).not.toBeNull();
      expect(row?.querySelector("[data-copy-source]")?.textContent).toBe(
        answerItem.blocks
          .filter((block) => block.kind === "text")
          .map((block) => block.text)
          .join("\n"),
      );
      expect(
        row
          ?.querySelector('[hx-post="/sessions/s1/navigate"]')
          ?.hasAttribute("disabled"),
      ).toBe(busy);
      expect(
        row
          ?.querySelector('[hx-post="/sessions/s1/fork"]')
          ?.hasAttribute("disabled"),
      ).toBe(false);
      const message = document.querySelector(".message-row");
      expect(message?.textContent).toContain("1,200 in · 34 out · 500 cache R");
      expect(message?.querySelector(".transcript-time")).not.toBeNull();
      expect(message?.querySelector("[data-copy]")).toBeNull();
    },
  );

  it.each([{ readOnly: true }, { live: true }])(
    "retains source-copy without mutation controls for %j",
    (mode) => {
      const document = rendered(
        <Item item={answerItem} actions={{ ...actions, ...mode }} />,
      );
      expect(document.querySelector(".history-actions")).toBeNull();
      expect(document.querySelector(".message-row [data-copy]")).not.toBeNull();
    },
  );

  it("omits copy controls for streaming and textless answers", () => {
    for (const item of [
      { ...answerItem, entryId: "partial" },
      {
        ...answerItem,
        blocks: [
          { kind: "thinking", text: "private", index: 0, deferred: false },
        ],
      },
    ] satisfies AssistantItem[]) {
      const document = rendered(
        <Item
          item={item}
          actions={{
            ...actions,
            streaming: { tokens: 42, tokensPerSecond: 12 },
          }}
        />,
      );
      expect(document.querySelector("[data-copy]")).toBeNull();
    }
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

  it.each(["history", "earlier", "finished", "running", "read-only", "busy"])(
    "offers actions only on user-facing assistant content in %s rendering",
    (mode) => {
      const items = [
        ...settledItems,
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
