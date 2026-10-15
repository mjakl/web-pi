import { describe, expect, it } from "vitest";
import { byId, htmxEvent, mount } from "./helpers.ts";

async function configure(
  fields?: string,
): Promise<{ body: FormData; source: HTMLElement }> {
  mount(
    `<form id="composer"><input name="prompt" value="draft"><button id="pick" ${fields ? `data-request-fields="${fields}"` : ""} hx-vals='{"mode":"followUp"}'></button></form>`,
  );
  const { setUpRequestFields } = await import("@web/client/htmx");
  setUpRequestFields();
  const body = new FormData();
  body.append("prompt", "draft");
  body.append("thinking", "high");
  body.append("mode", "followUp");
  body.append("images", new File(["one"], "one.png"));
  body.append("images", new File(["two"], "two.png"));
  const source = byId("pick");
  htmxEvent(source, "htmx:config:request", {
    ctx: {
      sourceElement: source,
      request: { action: "/sessions/s1/model", body },
    },
  });
  return { body, source };
}

describe("HTMX request field selection", () => {
  it("removes incidental composer fields while retaining explicit hx-vals", async () => {
    const { body } = await configure("none");
    expect([...body.entries()]).toEqual([["mode", "followUp"]]);
  });

  it("retains thinking as well as explicit values", async () => {
    const { body } = await configure("thinking");
    expect([...body.entries()]).toEqual([
      ["thinking", "high"],
      ["mode", "followUp"],
    ]);
  });

  it("retains every field the control names", async () => {
    const { body } = await configure("prompt thinking");
    expect([...body.entries()]).toEqual([
      ["prompt", "draft"],
      ["thinking", "high"],
      ["mode", "followUp"],
    ]);
  });

  it("leaves unmarked submissions, repeated uploads and submitter values untouched", async () => {
    const { body } = await configure();
    expect(body.get("prompt")).toBe("draft");
    expect(body.get("mode")).toBe("followUp");
    expect(body.getAll("images").map((file) => (file as File).name)).toEqual([
      "one.png",
      "two.png",
    ]);
  });
});

it("applies each partial's editor effect at settle, never at the source batch event", async () => {
  mount(
    '<main data-session-id="s1"><div id="stream"></div><textarea id="composer-text"></textarea><div id="editor-insert"><span data-insert="hello"></span></div><div id="status"><span id="extension-title" data-title="New title"></span></div></main>',
  );
  const { setUpExtensions } = await import("@web/client/extensions");
  setUpExtensions();
  const area = byId("composer-text") as HTMLTextAreaElement;
  const ctx = { sourceElement: byId("stream"), target: byId("stream") };
  htmxEvent(byId("stream"), "htmx:after:swap", { ctx });
  expect(area.value).toBe("");
  for (const id of ["editor-insert", "status"]) {
    const target = byId(id);
    htmxEvent(target, "htmx:after:settle", {
      task: { target },
      newContent: [...target.children],
      settleTasks: [],
    });
  }
  expect(area.value).toBe("hello");
  expect(document.title).toBe("New title");
  htmxEvent(byId("editor-insert"), "htmx:after:settle", {
    task: { target: byId("editor-insert") },
    newContent: [],
    settleTasks: [],
  });
  expect(area.value).toBe("hello");
});
