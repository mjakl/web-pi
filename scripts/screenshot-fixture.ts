import {
  assistantEntry,
  createFakeWorld,
  userEntry,
  type FakeStoredSession,
} from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { serve } from "@hono/node-server";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The real Hono app and file adapters, with fictional in-memory sessions.
// Nothing loads Pi resources, credentials, user sessions, or a model.
const root = mkdtempSync(join(tmpdir(), "web-pi-screenshots-"));
const cwd = join(root, "field-notes");
mkdirSync(join(cwd, "src"), { recursive: true });
const git = (...args: string[]) => execFileSync("git", args, { cwd });
git("init", "-b", "main");
writeFileSync(
  join(cwd, "README.md"),
  "# Field Notes\n\nA fictional release planner.\n",
);
writeFileSync(
  join(cwd, "src", "release.ts"),
  "export function releaseLabel(version: string) {\n  return version;\n}\n",
);
git("add", "README.md", "src/release.ts");
git(
  "-c",
  "user.name=Example Author",
  "-c",
  "user.email=author@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-m",
  "Start example project",
);
writeFileSync(
  join(cwd, "src", "release.ts"),
  'export function releaseLabel(version: string) {\n  const label = version.trim();\n  return label.startsWith("v") ? label : `v${label}`;\n}\n',
);

const timestamp = "2026-09-01T14:00:00.000Z";
function session(
  id: string,
  name: string,
  question: string,
  answer: string,
): FakeStoredSession {
  const entries = [
    userEntry(`${id}-u`, null, question),
    assistantEntry(`${id}-a`, `${id}-u`, answer, 4200),
  ];
  for (const entry of entries) {
    entry.timestamp = timestamp;
    if (entry.type === "message")
      entry.message.timestamp = Date.parse(timestamp);
  }
  return {
    summary: {
      id,
      name,
      cwd,
      createdAt: timestamp,
      modifiedAt: timestamp,
      fileSize: 1000,
    },
    entries,
  };
}
const release = session(
  "release",
  "Release checklist",
  "Review the release label helper and explain the change.",
  "## A consistent release label\n\nThe helper now trims surrounding whitespace and adds **v** only when it is missing. Existing labels stay unchanged.\n\n| Input | Label |\n| --- | --- |\n| `1.4.0` | `v1.4.0` |\n| `v1.4.0` | `v1.4.0` |\n\nThe working-tree diff is ready to inspect. Next, cover the whitespace case in a small test.",
);
release.entries.push({
  type: "custom",
  id: "release-star",
  parentId: "release-a",
  timestamp,
  customType: "web-pi:star",
  data: { targetId: "release-a", starred: true },
});
const navigation = session(
  "navigation",
  "Decisions worth keeping",
  "What belongs in the first release?",
  "## Keep the first release small\n\nShip the release planner, readable change summaries, and a clear rollback note. Leave team accounts for a later release.",
);
for (const [index, question, answer] of [
  [
    1,
    "How should we handle an unfinished checklist?",
    "Keep unfinished items visible. A release can be prepared without marking it ready.",
  ],
  [
    2,
    "Which decision should we record before shipping?",
    "## The release decision\n\n**Keep the checklist local and explicit.** No automatic publishing, no hidden deployment step.\n\nA maintainer reviews the changes and chooses when to ship. Save this answer as the release boundary.",
  ],
] as const) {
  const parent = navigation.entries.at(-1)?.id ?? null;
  navigation.entries.push(
    userEntry(`nav-u${String(index)}`, parent, question),
    assistantEntry(
      `nav-a${String(index)}`,
      `nav-u${String(index)}`,
      answer,
      6400,
    ),
  );
}
navigation.entries.push({
  type: "custom",
  id: "nav-star",
  parentId: "nav-a2",
  timestamp,
  customType: "web-pi:star",
  data: { targetId: "nav-a2", starred: true },
});
const tools = session(
  "tools",
  "Review the release helper",
  "Ask a reviewer to check the release label change.",
  "## Ready for a focused test\n\nThe review found no blocking issue. Add the whitespace case before committing.",
);
const call = assistantEntry("tools-call", "tools-u", "", 3200);
if (call.type !== "message" || call.message.role !== "assistant")
  throw new Error("Expected assistant");
call.message.content = [
  {
    type: "thinking",
    thinking: "Check the helper at its public input and output boundary.",
  },
  {
    type: "toolCall",
    id: "review-call",
    name: "subagent",
    arguments: {
      calls: [
        {
          agent: "reviewer",
          prompt:
            "Review the release label helper for correctness. Do not edit files.",
          model: "fake-1",
        },
      ],
    },
  },
];
const result: SessionEntry = {
  type: "message",
  id: "tools-result",
  parentId: "tools-call",
  timestamp,
  message: {
    role: "toolResult",
    toolCallId: "review-call",
    toolName: "subagent",
    content: [{ type: "text", text: "No blocking findings." }],
    isError: false,
    timestamp: Date.parse(timestamp),
    details: {
      kind: "pi-subagent",
      results: [
        {
          agent: "reviewer",
          exitCode: 0,
          model: "fake-1",
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "### Correctness check\n\nNo blocking findings. Existing **v** prefixes are preserved, and whitespace is removed before the prefix check.\n\nAdd a regression case for ` 1.4.0 ` → `v1.4.0`.",
                },
              ],
            },
          ],
        },
      ],
    },
  },
};
const answer = tools.entries[1];
if (!answer) throw new Error("Expected answer");
answer.parentId = "tools-result";
tools.entries.splice(1, 0, call, result);
const light = session(
  "light",
  "Plan the next release",
  "Show a small release plan with the path from draft to shipped.",
  "## A release in three steps\n\n| Step | Result |\n| --- | --- |\n| Prepare | A short checklist |\n| Review | A tested change |\n| Ship | A tagged release |\n\n```mermaid\nflowchart LR\n  Draft --> Review --> Shipped\n```\n\nKeep the checklist beside the change so the release decision is easy to revisit.",
);
const scale = session(
  "scale",
  "Style scale checks",
  "Keep the release summary readable on a narrow screen.",
  '## Release summary\n\nUse `releaseLabel(version)` for the displayed version.\n\n```ts\nconst label = releaseLabel("a-long-release-name-that-should-scroll-inside-the-code-block-not-the-page");\n```',
);
scale.entries.push({
  type: "compaction",
  id: "scale-compaction",
  parentId: "scale-a",
  timestamp,
  summary: "Keep the release label and the explicit maintainer review step.",
  tokensBefore: 40_000,
  firstKeptEntryId: "scale-u",
});
function delegate(child: FakeStoredSession, parent: string) {
  const origin = {
    version: 1,
    childSessionId: child.summary.id,
    parentSessionId: parent,
    agent: "reviewer",
    handle: "release-review",
  };
  child.summary.inspectionOnly = true;
  child.summary.delegation = {
    parentSessionId: parent,
    agent: origin.agent,
    handle: origin.handle,
  };
  child.entries.push({
    type: "custom",
    id: `${child.summary.id}-origin`,
    parentId: child.entries.at(-1)?.id ?? null,
    timestamp,
    customType: "pi-subagent:delegation",
    data: origin,
  });
}

const reviewCwd = join(root, "release-review-worktree-with-a-long-name");
mkdirSync(reviewCwd);
const delegated = Array.from({ length: 6 }, (_, index) => {
  const child = session(
    `review-${String(index + 1)}`,
    index === 5
      ? "Check the very long release compatibility title with nested conversations and useful own-folder metadata"
      : `Review detail ${String(index + 1)}`,
    "Inspect the saved release review. Do not change the source conversation.",
    '## Saved review\n\nThe release helper preserves existing labels. This is a saved conversation, not a live status report.\n\n```ts\nreleaseLabel("1.4.0");\n```',
  );
  child.summary.cwd = reviewCwd;
  delegate(child, index === 0 ? "tools" : `review-${String(index)}`);
  return child;
});
delegate(tools, "release");
const releaseNotes = session(
  "release-notes",
  "Check the release notes",
  "Read the release notes for accuracy.",
  "The release notes match the saved change.",
);
delegate(releaseNotes, "release");
const legacy = session(
  "subagent.legacy-fixture",
  "Earlier saved review",
  "Inspect this legacy conversation.",
  "No delegation ancestry is recorded for this older conversation.",
);
const sessions = [
  release,
  navigation,
  tools,
  light,
  scale,
  releaseNotes,
  legacy,
  ...delegated,
];
for (const stored of sessions) {
  for (const [index, entry] of stored.entries.entries()) {
    const time = Date.parse(timestamp) + index * 15_000;
    entry.timestamp = new Date(time).toISOString();
    if (entry.type === "message") entry.message.timestamp = time;
  }
}
const world = createFakeWorld({
  sessions,
  files: ["README.md", "src/release.ts"],
  projects: (folder) => ({
    root: cwd,
    branch: folder === reviewCwd ? "review/compatibility-long-branch" : "main",
    isWorktree: folder === reviewCwd,
    isTopLevel: true,
  }),
});
const app = createWebApp({
  workspace: createWorkspace(world),
  staticRoot: resolve("static"),
  defaultCwd: cwd,
  home: root,
});
const server = serve(
  { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
  (address) => {
    process.stdout.write(
      `Screenshot fixture listening on http://127.0.0.1:${String(address.port)}/sessions/release\n`,
    );
  },
);
function close() {
  server.close();
  if ("closeAllConnections" in server) server.closeAllConnections();
  rmSync(root, { recursive: true, force: true });
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
