import { frontmatterCard, parseFrontmatter } from "@core/frontmatter";
import { describe, expect, it } from "vitest";

describe("parseFrontmatter", () => {
  it("reads scalars, inline lists, and block lists", () => {
    const parsed = parseFrontmatter(
      [
        "---",
        'title: "A note"',
        "tags: [one, two]",
        "authors:",
        "  - Ada",
        "  - Grace",
        "draft: true",
        "---",
        "# Body",
        "",
      ].join("\n"),
    );
    expect(parsed.fields).toEqual([
      ["title", "A note"],
      ["tags", ["one", "two"]],
      ["authors", ["Ada", "Grace"]],
      ["draft", "true"],
    ]);
    expect(parsed.body).toBe("# Body\n");
  });

  it("leaves a document without a block untouched", () => {
    expect(parseFrontmatter("# Just a heading").fields).toEqual([]);
    expect(parseFrontmatter("---\nnever closed\n").body).toBe(
      "---\nnever closed\n",
    );
  });

  it("says whether every line of the block became a field", () => {
    const complete = (block: string) =>
      parseFrontmatter(`---\n${block}\n---\nBody`).complete;
    expect(
      complete("title: A\ntags: [a, b]\nauthors:\n  - Ada\n\ndraft: true"),
    ).toBe(true);
    expect(complete("Plan: do X\nand then Y")).toBe(false);
    expect(complete("# a comment\ntitle: A")).toBe(false);
    expect(complete("draft:\ntitle: A")).toBe(false);
    expect(complete("meta:\n  nested: value")).toBe(false);
    expect(complete("tags: x\ntags: [a]")).toBe(false);
    expect(parseFrontmatter("# Just a heading").complete).toBe(false);
  });
});

describe("frontmatterCard", () => {
  it("promotes the title, takes the first list as chips, keeps the rest", () => {
    const card = frontmatterCard([
      ["title", "A note"],
      ["date", "2026-01-01"],
      ["tags", ["one", "two"]],
      ["keywords", ["ignored"]],
    ]);
    expect(card.title).toBe("A note");
    expect(card.chips).toEqual(["one", "two"]);
    expect(card.rest).toEqual([
      ["date", "2026-01-01"],
      ["keywords", "ignored"],
    ]);
  });
});
