import type { LiveSession } from "@core/ports";
import { getCurrentTools, type JsonObject } from "@earendil-works/pi-ai";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHarness,
  gate,
  type Harness,
  next,
  reply,
} from "./pi-harness.ts";

let h: Harness | undefined;

afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

async function callTool(session: LiveSession, name: string, args: JsonObject) {
  if (!h) throw new Error("Harness is missing");
  h.script((turn) => {
    turn.toolCall(name, args);
    turn.done();
  }, reply("done"));
  const done = next(session, "turn_done");
  await session.prompt("Run the scripted tool call.");
  await done;
  const result = session
    .snapshot()
    .branch.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult"
        ? [entry.message]
        : [],
    )
    .findLast((message) => message.toolName === name);
  if (!result) throw new Error(`No result for ${name}`);
  return result;
}

function resultText(result: Awaited<ReturnType<typeof callTool>>) {
  return result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

function fixtureServer(name: string, config: Record<string, unknown> = {}) {
  if (!h) throw new Error("Harness is missing");
  return {
    command: process.execPath,
    args: [
      join(import.meta.dirname, "fixtures/mcp-server.ts"),
      join(h.root, `${name}.jsonl`),
    ],
    ...config,
  };
}

async function fixtureEvents(
  name: string,
): Promise<{ event: string; pid: number; name?: string }[]> {
  if (!h) throw new Error("Harness is missing");
  const path = join(h.root, `${name}.jsonl`);
  return existsSync(path)
    ? (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { event: string; pid: number; name?: string },
        )
    : [];
}

async function configureMcp(
  servers: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  if (!h) throw new Error("Harness is missing");
  await writeFile(
    join(h.agentDir, "mcp.json"),
    JSON.stringify({ mcpServers: servers, ...extra }),
  );
}

describe("SDK built-ins", () => {
  it("registers discovery tools inactive and exposes the MCP command without a model call", async () => {
    h = await createHarness();
    const session = await h.open();
    expect(session.toolDefinitions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "codemode", active: false }),
        expect.objectContaining({ name: "tool_search", active: false }),
      ]),
    );
    expect(session.commands()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "mcp" })]),
    );
    expect(h.calls).toHaveLength(0);
  });

  it("executes codemode with configured defaults and retains its store on resume", async () => {
    h = await createHarness({
      settings: { defaultTools: ["+codemode", "+tool_search"] },
    });
    await writeFile(join(h.cwd, "hello.txt"), "hello from a real tool");
    const session = await h.open();
    expect(
      session
        .toolDefinitions()
        .filter((tool) => tool.active)
        .map((tool) => tool.name),
    ).toEqual(
      expect.arrayContaining([
        "read",
        "bash",
        "edit",
        "write",
        "codemode",
        "tool_search",
      ]),
    );
    const result = await callTool(session, "codemode", {
      code: 'store("marker", "saved"); text(await tools.read({path:"hello.txt"}));',
    });
    expect(result.isError).toBe(false);
    expect(resultText(result)).toContain("hello from a real tool");
    await session.stop();
    const resumed = await h.open({ sessionId: session.id });
    const restored = await callTool(resumed, "codemode", {
      code: 'text(load("marker"));',
    });
    expect(restored.isError).toBe(false);
    expect(resultText(restored)).toContain("saved");
    await resumed.reload();
    expect(
      resultText(
        await callTool(resumed, "codemode", { code: 'text(load("marker"));' }),
      ),
    ).toContain("saved");
    const other = await h.open();
    expect(
      resultText(
        await callTool(other, "codemode", {
          code: 'text(load("marker") ?? "empty");',
        }),
      ),
    ).toContain("empty");
  });

  it("honors codemode presentation settings and the configured callable tool set", async () => {
    h = await createHarness({
      settings: {
        defaultTools: ["read", "+codemode"],
        codemode: { mode: "only", inlineBudget: 0 },
      },
    });
    await writeFile(join(h.cwd, "hello.txt"), "allowed read");
    const session = await h.open();
    expect(
      resultText(
        await callTool(session, "codemode", {
          code: 'text(await tools.read({path:"hello.txt"}));',
        }),
      ),
    ).toContain("allowed read");
    const declarations = getCurrentTools(h.calls[0]?.context.messages ?? []);
    expect(declarations.map((tool) => tool.name)).toEqual(["codemode"]);
    expect(declarations[0]?.description).not.toContain(
      "Read the contents of a file",
    );
    const denied = await callTool(session, "codemode", {
      code: 'await tools.write({path:"not-created.txt",content:"denied"});',
    });
    expect(resultText(denied)).toContain("Script failed");
    expect(existsSync(join(h.cwd, "not-created.txt"))).toBe(false);
  });

  it.each(["codemode", "deferred", "direct"])(
    "calls a real MCP server with %s exposure",
    async (exposure) => {
      h = await createHarness();
      await configureMcp({
        local: fixtureServer("local", {
          exposure,
          toolExposure: { secret: "hidden" },
        }),
      });
      const session = await h.open();
      await expect
        .poll(() =>
          session
            .toolDefinitions()
            .some((tool) => tool.name === "mcp__local__echo"),
        )
        .toBe(true);
      if (exposure === "codemode") {
        expect(
          session.toolDefinitions().find((tool) => tool.name === "codemode")
            ?.active,
        ).toBe(true);
        expect(
          session
            .toolDefinitions()
            .find((tool) => tool.name === "mcp__local__echo")?.active,
        ).toBe(false);
        const result = await callTool(session, "codemode", {
          code: 'const found = await searchTools("echo"); text(found); const result = await tools.mcp__local__echo({text:"hello"}); text(result.content);',
        });
        expect(result.isError).toBe(false);
        expect(resultText(result)).toContain("mcp__local__echo");
        expect(resultText(result)).toContain("fixture: hello");
        expect(resultText(result)).not.toContain("mcp__local__secret");
      } else {
        if (exposure === "deferred") {
          expect(
            session
              .toolDefinitions()
              .find((tool) => tool.name === "tool_search")?.active,
          ).toBe(true);
          expect(
            session
              .toolDefinitions()
              .find((tool) => tool.name === "mcp__local__echo")?.active,
          ).toBe(false);
          const search = await callTool(session, "tool_search", {
            query: "echo",
          });
          expect(search.isError).toBe(false);
          expect(resultText(search)).toContain("mcp__local__echo");
          expect(resultText(search)).not.toContain("mcp__local__secret");
        }
        expect(
          session
            .toolDefinitions()
            .find((tool) => tool.name === "mcp__local__echo")?.active,
        ).toBe(true);
        const result = await callTool(session, "mcp__local__echo", {
          text: "hello",
        });
        expect(result.isError).toBe(false);
        expect(resultText(result)).toBe("fixture: hello");
      }
      expect(
        (await fixtureEvents("local")).filter(
          (event) => event.event === "call",
        ),
      ).toHaveLength(1);
    },
  );

  it("keeps nested MCP calls behind permission hooks and hidden tools unreachable", async () => {
    const nested: string[] = [];
    h = await createHarness({
      extensions: [
        (pi) => {
          pi.on("tool_call", (event) => {
            if (event.toolName === "mcp__local__echo") {
              nested.push(event.parentToolCallId ?? "missing");
              return { block: true, reason: "fixture permission denied" };
            }
            return undefined;
          });
        },
      ],
    });
    await configureMcp({
      local: fixtureServer("local", { toolExposure: { secret: "hidden" } }),
    });
    const session = await h.open();
    const denied = await callTool(session, "codemode", {
      code: 'await tools.mcp__local__echo({text:"blocked"});',
    });
    expect(resultText(denied)).toContain("fixture permission denied");
    expect(nested).toHaveLength(1);
    expect(nested[0]).not.toBe("missing");
    const hidden = await callTool(session, "codemode", {
      code: 'await tools.mcp__local__secret({text:"blocked"});',
    });
    expect(resultText(hidden)).toContain("Script failed");
    expect(
      (await fixtureEvents("local")).filter((event) => event.event === "call"),
    ).toEqual([]);
  });

  it("honors automatic activation and server opt-outs", async () => {
    h = await createHarness();
    await configureMcp(
      {
        local: fixtureServer("local"),
        disabled: fixtureServer("disabled", { enabled: false }),
      },
      { autoEnableCodemode: false },
    );
    const session = await h.open();
    await expect
      .poll(() =>
        session
          .toolDefinitions()
          .some((tool) => tool.name === "mcp__local__echo"),
      )
      .toBe(true);
    expect(
      session.toolDefinitions().find((tool) => tool.name === "codemode")
        ?.active,
    ).toBe(false);
    expect(
      session.toolDefinitions().find((tool) => tool.name === "tool_search")
        ?.active,
    ).toBe(false);
    expect(await fixtureEvents("disabled")).toEqual([]);
    expect(
      session
        .toolDefinitions()
        .some((tool) => tool.name.startsWith("mcp__disabled__")),
    ).toBe(false);
  });

  it("honors all three built-in extension exclusions without connecting servers", async () => {
    h = await createHarness({
      settings: {
        extensions: [
          "-builtin:mcp",
          "-builtin:codemode",
          "-builtin:tool-search",
        ],
        defaultTools: ["+codemode", "+tool_search"],
      },
    });
    await configureMcp({ local: fixtureServer("local") });
    const session = await h.open();
    expect(
      session
        .toolDefinitions()
        .some((tool) => ["codemode", "tool_search"].includes(tool.name)),
    ).toBe(false);
    expect(session.commands().some((command) => command.name === "mcp")).toBe(
      false,
    );
    await session.reload();
    expect(await fixtureEvents("local")).toEqual([]);
  });

  it("fails closed on a directory mismatch before MCP startup but permits disabled MCP", async () => {
    h = await createHarness();
    const selected = process.env["PI_CODING_AGENT_DIR"];
    const other = join(h.root, "other-agent");
    await mkdir(other);
    await writeFile(
      join(other, "mcp.json"),
      JSON.stringify({ mcpServers: { wrong: fixtureServer("wrong") } }),
    );
    process.env["PI_CODING_AGENT_DIR"] = other;
    try {
      await expect(h.open()).rejects.toThrow("Set PI_CODING_AGENT_DIR");
      expect(await fixtureEvents("wrong")).toEqual([]);
      expect(h.calls).toHaveLength(0);
      await writeFile(
        join(h.agentDir, "settings.json"),
        JSON.stringify({ extensions: ["-builtin:mcp"] }),
      );
      const session = await h.open();
      expect(session.commands().some((command) => command.name === "mcp")).toBe(
        false,
      );
      // Enabling on reload must run the same check before the new MCP starts.
      await writeFile(join(h.agentDir, "settings.json"), "{}");
      await expect(session.reload()).rejects.toThrow("Set PI_CODING_AGENT_DIR");
      expect(await fixtureEvents("wrong")).toEqual([]);
    } finally {
      process.env["PI_CODING_AGENT_DIR"] = selected;
    }
  });

  it("lets user extensions replace the tools and MCP without a duplicate or directory guard", async () => {
    h = await createHarness();
    const extensions = join(h.agentDir, "extensions");
    await mkdir(extensions);
    await writeFile(
      join(extensions, "replacement.js"),
      `export default function(pi) {
      for (const name of ["codemode", "tool_search"]) pi.registerTool({
        name, label: name, description: "User replacement",
        parameters: { type: "object", properties: {} },
        async execute() { return { content: [{ type: "text", text: "user replacement" }], details: {} }; }
      });
      pi.registerCommand("mcp", { handler: async (_args, ctx) => ctx.ui.notify("User MCP") });
    }`,
    );
    await configureMcp({ local: fixtureServer("local") });
    const selected = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = join(h.root, "unused");
    try {
      const session = await h.open();
      expect(
        session.toolDefinitions().filter((tool) => tool.name === "codemode"),
      ).toHaveLength(1);
      expect(
        session.toolDefinitions().filter((tool) => tool.name === "tool_search"),
      ).toHaveLength(1);
      expect(resultText(await callTool(session, "codemode", {}))).toBe(
        "user replacement",
      );
      await session.prompt("/mcp");
      expect(
        session.snapshot().status.notices.map((notice) => notice.message),
      ).toContain("User MCP");
      expect(
        session
          .snapshot()
          .status.notices.some((notice) => notice.message.includes("conflict")),
      ).toBe(false);
      expect(await fixtureEvents("local")).toEqual([]);
    } finally {
      process.env["PI_CODING_AGENT_DIR"] = selected;
    }
  });

  it("loads project MCP and project built-in overrides only after trust", async () => {
    h = await createHarness({
      settings: { extensions: ["-builtin:codemode"] },
    });
    const projectConfig = join(h.cwd, ".pi");
    await mkdir(projectConfig);
    await writeFile(
      join(projectConfig, "settings.json"),
      JSON.stringify({ extensions: ["+builtin:codemode"] }),
    );
    await writeFile(
      join(projectConfig, "mcp.json"),
      JSON.stringify({ mcpServers: { project: fixtureServer("project") } }),
    );
    const untrusted = await h.open();
    expect(
      untrusted.toolDefinitions().some((tool) => tool.name === "codemode"),
    ).toBe(false);
    await untrusted.prompt("/mcp");
    expect(await fixtureEvents("project")).toEqual([]);
    await untrusted.stop();
    new ProjectTrustStore(h.agentDir).set(h.cwd, true);
    const trusted = await h.open();
    const result = await callTool(trusted, "codemode", {
      code: 'text((await tools.mcp__project__echo({text:"trusted"})).content);',
    });
    expect(resultText(result)).toContain("fixture: trusted");
  });

  it("closes per-session MCP connections on reload and concurrent stops, then reconnects on resume", async () => {
    let shutdowns = 0;
    h = await createHarness({
      extensions: [
        (pi) => {
          pi.on("session_shutdown", () => {
            shutdowns++;
          });
        },
      ],
    });
    await configureMcp({
      local: fixtureServer("local", { exposure: "direct" }),
    });
    const session = await h.open();
    expect(
      resultText(
        await callTool(session, "mcp__local__echo", { text: "first" }),
      ),
    ).toBe("fixture: first");
    await session.reload();
    expect(
      (await fixtureEvents("local")).filter((event) => event.event === "close"),
    ).toHaveLength(1);
    expect(
      resultText(
        await callTool(session, "mcp__local__echo", { text: "reloaded" }),
      ),
    ).toBe("fixture: reloaded");
    await Promise.all([session.stop(), session.stop()]);
    expect(shutdowns).toBe(2);
    expect(
      (await fixtureEvents("local")).filter((event) => event.event === "close"),
    ).toHaveLength(2);
    const resumed = await h.open({ sessionId: session.id });
    expect(
      resultText(
        await callTool(resumed, "mcp__local__echo", { text: "resumed" }),
      ),
    ).toBe("fixture: resumed");
    await resumed.stop();
    const events = await fixtureEvents("local");
    expect(events.filter((event) => event.event === "start")).toHaveLength(3);
    expect(events.filter((event) => event.event === "close")).toHaveLength(3);
  });

  it("serializes admitted reloads before final shutdown and refuses later reloads", async () => {
    const entered = gate();
    const release = gate();
    const lifecycle: string[] = [];
    h = await createHarness({
      extensions: [
        (pi) => {
          pi.on("session_start", () => {
            lifecycle.push("start");
          });
          pi.on("session_shutdown", async (event) => {
            lifecycle.push(event.reason);
            if (event.reason === "reload") {
              entered.open();
              await release.wait;
            }
          });
        },
      ],
    });
    const session = await h.open();
    const reloading = session.reload();
    await entered.wait;
    const queuedReload = session.reload();
    const stopping = session.stop();
    // Let stop reach its awaits while reload is held in an SDK lifecycle hook.
    await Promise.race([
      stopping,
      new Promise<void>((resolve) => setImmediate(resolve)),
    ]);
    release.open();
    await Promise.all([reloading, queuedReload, stopping]);
    expect(lifecycle).toEqual([
      "start",
      "reload",
      "start",
      "reload",
      "start",
      "quit",
    ]);
    expect(h.runtime.get(session.id)).toBeUndefined();
    await expect(session.reload()).rejects.toThrow("stopping or stopped");
  });

  it("leaves no MCP connection open when stop overlaps a resource reload", async () => {
    const entered = gate();
    const release = gate();
    h = await createHarness({
      extensions: [
        (pi) => {
          pi.on("session_shutdown", async (event) => {
            if (event.reason === "reload") {
              entered.open();
              await release.wait;
            }
          });
        },
      ],
    });
    await configureMcp({
      local: fixtureServer("local", { exposure: "direct" }),
    });
    const session = await h.open();
    expect(
      resultText(
        await callTool(session, "mcp__local__echo", { text: "connected" }),
      ),
    ).toBe("fixture: connected");
    const reloading = session.reload();
    await entered.wait;
    const stopping = session.stop();
    release.open();
    await Promise.all([reloading, stopping]);
    // Flush the SDK's deferred connection startup after final shutdown.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const events = await fixtureEvents("local");
    const started = events
      .filter((event) => event.event === "start")
      .map((event) => event.pid);
    const closed = events
      .filter((event) => event.event === "close")
      .map((event) => event.pid);
    expect(started.length).toBeGreaterThan(0);
    expect(closed).toEqual(started);
    expect(h.runtime.live()).toEqual([]);
  });

  it("closes an MCP transport whose initialization has not finished", async () => {
    h = await createHarness();
    const config = fixtureServer("pending");
    config.args.push("hang");
    await configureMcp({ pending: config });
    const session = await h.open();
    await expect
      .poll(async () =>
        (await fixtureEvents("pending")).some(
          (event) => event.event === "start",
        ),
      )
      .toBe(true);
    await session.stop();
    expect(
      (await fixtureEvents("pending")).map((event) => event.event),
    ).toEqual(["start", "close"]);
  });
});
