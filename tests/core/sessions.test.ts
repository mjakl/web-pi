import {
  recentProjects,
  relativeTime,
  sessionTitle,
  type SessionSummary,
} from "@core/sessions";
import { describe, expect, it } from "vitest";

function summary(
  id: string,
  extra: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    cwd: "/repo/one",
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    fileSize: 0,
    ...extra,
  };
}

describe("session titles", () => {
  it("prefers the name, then the first message, then the id", () => {
    const meta = {
      firstMessage: "  Explain   the   parser  ",
      messageCount: 2,
      starCount: 0,
      modifiedAt: "2026-01-01",
      fileSize: 1,
    };
    expect(sessionTitle(summary("abcdefghijklmnop"), meta)).toBe(
      "Explain the parser",
    );
    expect(
      sessionTitle(summary("abcdefghijklmnop"), { ...meta, name: "Parser" }),
    ).toBe("Parser");
    expect(
      sessionTitle(summary("abcdefghijklmnop"), { ...meta, firstMessage: "" }),
    ).toBe("abcdefghijkl");
    expect(
      sessionTitle(summary("x"), { ...meta, firstMessage: "y".repeat(80) }),
    ).toBe("y".repeat(80));
    expect(
      sessionTitle(summary("x"), { ...meta, firstMessage: "z".repeat(500) }),
    ).toBe("z".repeat(300));
  });
});

describe("sidebar project grouping", () => {
  it("keeps worktrees of one checkout in the same project", () => {
    const sessions = [
      summary("a", {
        cwd: "/repo/main",
        projectRoot: "/repo/main",
        modifiedAt: "2026-03-01T00:00:00.000Z",
      }),
      summary("b", {
        cwd: "/repo/wt",
        projectRoot: "/repo/main",
        modifiedAt: "2026-03-02T00:00:00.000Z",
      }),
      summary("c", { cwd: "/other", modifiedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const projects = recentProjects(sessions);
    expect(projects.map((project) => project.key)).toEqual([
      "/repo/main",
      "/other",
    ]);
  });

  it("lists the working folders a project's sessions were started in", () => {
    const projects = recentProjects([
      summary("a", {
        cwd: "/repo/wt",
        projectRoot: "/repo/main",
        branch: "feature",
      }),
      summary("b", { cwd: "/repo/main", projectRoot: "/repo/main" }),
      // A second session in a folder already listed adds nothing.
      summary("c", { cwd: "/repo/main", projectRoot: "/repo/main" }),
      summary("d", { cwd: "/other" }),
    ]);
    expect(projects.find((p) => p.key === "/repo/main")?.folders).toEqual([
      { path: "/repo/main", branch: null },
      { path: "/repo/wt", branch: "feature" },
    ]);
    expect(projects.find((p) => p.key === "/other")?.folders).toEqual([
      { path: "/other", branch: null },
    ]);
  });

  it("counts running sessions per project", () => {
    const projects = recentProjects([
      summary("a", { projectRoot: "/repo/one", running: true }),
      summary("b", { projectRoot: "/repo/one" }),
      summary("c", { projectRoot: "/repo/two" }),
    ]);
    expect(projects.find((p) => p.key === "/repo/one")?.running).toBe(1);
    expect(projects.find((p) => p.key === "/repo/two")?.running).toBe(0);
  });
});

describe("relative time", () => {
  it("spells the age out the way pi-web's rows do", () => {
    const now = Date.parse("2026-03-01T12:00:00.000Z");
    expect(relativeTime("2026-03-01T11:59:30.000Z", now)).toBe(
      "30 seconds ago",
    );
    expect(relativeTime("2026-03-01T11:30:00.000Z", now)).toBe(
      "30 minutes ago",
    );
    expect(relativeTime("2026-03-01T06:00:00.000Z", now)).toBe("6 hours ago");
    expect(relativeTime("2026-02-25T12:00:00.000Z", now)).toBe("4 days ago");
    // Nothing switches to a date: pi-web counts days however many there are.
    expect(relativeTime("2025-12-01T12:00:00.000Z", now)).toBe("90 days ago");
    expect(relativeTime("not a date", now)).toBe("");
  });
});
