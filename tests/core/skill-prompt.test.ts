import { userEntry } from "@adapters/fake/index";
import {
  displaySkillPrompt,
  recoverSkillPrompt,
  encodeSkillPrompt,
  recallSkillPrompts,
  skillCommand,
} from "@core/skill-prompt";
import { editableUserMessage, userMessageText } from "@core/session-entries";
import { describe, expect, it } from "vitest";

const first = { id: '/skills/first "quoted"/SKILL.md', name: "first" };
const second = { id: "/skills/second/SKILL.md", name: "second" };
const legacy =
  '<skill name="legacy" location="/skills/legacy/SKILL.md">\nReferences are relative to /skills/legacy.\n\nPrivate instructions\n</skill>\n\nlegacy args';

function queued(text: string) {
  return { text, behavior: "steer" as const };
}

describe("skill prompt provenance", () => {
  it.each([
    "",
    '  exact\n\t🦉 % </skill> --> "quotes"  ',
    "\ud800",
    "<!-- web-pi:skill-selection:v1:literal -->\nrequest",
  ])(
    "round-trips the exact original text %j without interpreting its contents",
    (text) => {
      const encoded = encodeSkillPrompt(
        text,
        [first, second, first],
        "Instructions containing </skill> and <!-- web-pi:skill-selection:v1:fake -->\n",
      );
      expect(displaySkillPrompt(encoded)).toEqual({
        text,
        skills: [first, second],
      });
      expect(editableUserMessage(userEntry("u1", null, encoded))).toEqual({
        text,
        skills: [first, second],
        images: [],
      });
      expect(userMessageText(userEntry("u1", null, encoded))).toBe(
        text.replaceAll(/\s+/g, " ").trim(),
      );
    },
  );

  it.each([
    "plain request",
    "<!-- web-pi:skill-selection:v2:%7B%7D -->\nbody",
    "<!-- web-pi:skill-selection:v1:%broken -->\nbody",
    "<!-- web-pi:skill-selection:v1:%7B%7D -->\nbody",
    `<!-- web-pi:skill-selection:v1:${encodeURIComponent(JSON.stringify({ text: "hidden", skills: [{ id: 2, name: "first" }] }))} -->\nbody`,
  ])("leaves malformed and unsupported records literal", (text) => {
    expect(displaySkillPrompt(text)).toEqual({ text });
    expect(recoverSkillPrompt(text)).toEqual({ text });
  });

  it.each([
    ["Context note.\n", ""],
    ["", "\nHook suffix."],
    ["<request>\n", "\n</request>"],
  ])(
    "preserves text outside the retained expansion (%j, %j)",
    (prefix, suffix) => {
      const original = "/skill:first  exact 🦉 request\n";
      const encoded = encodeSkillPrompt(
        original,
        [first, second],
        `${legacy}\n\nMore 🦉 instructions`,
      );
      expect(displaySkillPrompt(`${prefix}${encoded}${suffix}`)).toEqual({
        text: `${prefix}${original}${suffix}`,
        skills: [first, second],
      });
      expect(recoverSkillPrompt(`${prefix}${encoded}${suffix}`)).toEqual({
        text: original,
        skills: [first, second],
      });
    },
  );

  it.each([undefined, null, "4", -1, 0.5, 1e100, 500])(
    "rejects a missing, invalid or out-of-range expansion boundary %j",
    (expandedLength) => {
      const marker = `<!-- web-pi:skill-selection:v1:${encodeURIComponent(JSON.stringify({ text: "hidden", skills: [first], expandedLength }))} -->\nbody`;
      expect(displaySkillPrompt(marker)).toEqual({ text: marker });
      expect(recoverSkillPrompt(marker)).toEqual({ text: marker });
    },
  );

  it("does not promote a record literal from skill instructions, even after losing the outer record", () => {
    const literal = encodeSkillPrompt(
      "not the draft",
      [second],
      "example expansion",
    );
    const instructions = legacy.replace(
      "Private instructions",
      `Example:\n${literal}`,
    );
    const encoded = encodeSkillPrompt("real draft", [first], instructions);
    expect(displaySkillPrompt(`Before\n${encoded}\nAfter`)).toEqual({
      text: "Before\nreal draft\nAfter",
      skills: [first],
    });
    const withoutRecord = `Before\n${instructions}\nAfter`;
    expect(displaySkillPrompt(withoutRecord)).toEqual({ text: withoutRecord });
    expect(recoverSkillPrompt(withoutRecord)).toEqual({ text: withoutRecord });
    expect(displaySkillPrompt(instructions)).toEqual({
      text: "/skill:legacy legacy args",
    });
    const damagedRecord = `<!-- web-pi:skill-selection:v1:%broken -->\n${instructions}`;
    expect(displaySkillPrompt(damagedRecord)).toEqual({ text: damagedRecord });
    expect(recoverSkillPrompt(damagedRecord)).toEqual({ text: damagedRecord });
  });

  it("does not recursively interpret a complete record literal restored from the original draft", () => {
    const original = encodeSkillPrompt(
      "literal draft",
      [second],
      "literal instructions",
    );
    const encoded = encodeSkillPrompt(original, [first], "actual instructions");
    expect(displaySkillPrompt(`Before\n${encoded}\nAfter`)).toEqual({
      text: `Before\n${original}\nAfter`,
      skills: [first],
    });
    expect(recoverSkillPrompt(`Before\n${encoded}\nAfter`)).toEqual({
      text: original,
      skills: [first],
    });
  });

  it("keeps the legacy single-skill fallback without guessing originals from multiple envelopes", () => {
    expect(skillCommand(legacy)).toBe("/skill:legacy legacy args");
    expect(displaySkillPrompt(legacy)).toEqual({
      text: "/skill:legacy legacy args",
    });
    expect(displaySkillPrompt(`${legacy}\n\n${legacy}`)).toEqual({
      text: `${legacy}\n\n${legacy}`,
    });
  });

  it("decodes every queue item before combining text, unions selections in order, and preserves images", () => {
    const encoded = encodeSkillPrompt(
      "  first draft  ",
      [first, second],
      "Never show these instructions",
    );
    const another = encodeSkillPrompt(
      "second draft",
      [second],
      "Nor these instructions",
    );
    const image = { data: "AAAA", mimeType: "image/png" };
    expect(
      recallSkillPrompts(
        [
          { ...queued(encoded), images: [image] },
          queued(another),
          queued(legacy),
        ],
        [first, second, { id: "/skills/legacy/SKILL.md", name: "legacy" }],
      ),
    ).toEqual({
      text: "  first draft  \n\nsecond draft\n\n/skill:legacy legacy args",
      skills: [first, second],
      images: [image],
      warning: expect.stringContaining("/skill:legacy") as string,
    });
    expect(recallSkillPrompts([queued(legacy)], [])).toEqual({
      text: "/skill:legacy legacy args",
      images: [],
    });
  });

  it.each([
    ["/skill:first one", "/skill:second two", [first], true],
    ["plain prose first", "/skill:second two", [first], true],
    ["/skill:first one", "/skill:second two", [second], false],
    ["/skill:second one", "/skill:second two", [first], false],
    ["", "/skill:second two", [first], false],
    ["  \n", "/skill:second two", [first], false],
    ["plain prose first", "please use /skill:second", [first], false],
    [
      "plain prose first",
      "/skill:second two",
      [{ id: "/other/second/SKILL.md", name: "second" }],
      true,
    ],
  ])(
    "warns only about newly inline, uncovered invocations (%j, %j)",
    (before, after, selections, warns) => {
      const result = recallSkillPrompts(
        [
          queued(
            `Prefix\n${encodeSkillPrompt(before, selections, "PRIVATE")}\nSuffix`,
          ),
          {
            ...queued(
              `Prefix\n${encodeSkillPrompt(after, [first], "PRIVATE")}\nSuffix`,
            ),
            behavior: "followUp",
          },
        ],
        [first, second],
      );
      expect(result.text).toBe([before, after].filter(Boolean).join("\n\n"));
      expect(result.skills).toEqual([
        ...selections,
        ...(selections.some((skill) => skill.id === first.id) ? [] : [first]),
      ]);
      expect(Boolean(result.warning)).toBe(warns);
      if (warns) {
        expect(result.warning).toContain("/skill:second will not invoke");
        expect(result.warning).toContain("Select second in Skills");
      }
    },
  );

  it("does not infer an invocation from a plain unexpanded command or inline prose", () => {
    expect(
      recallSkillPrompts(
        [queued("prose"), queued("/skill:second never expanded")],
        [second],
      ),
    ).toEqual({ text: "prose\n\n/skill:second never expanded", images: [] });
  });

  it("combines original text and only dropdown selections when selected prompts have different leading commands", () => {
    const firstText = "/skill:legacy  first args  ";
    const secondText = "/skill:other second\nargs";
    const firstPrompt = encodeSkillPrompt(firstText, [second], legacy);
    const secondPrompt = encodeSkillPrompt(
      secondText,
      [first, second],
      legacy.replaceAll("legacy", "other"),
    );
    expect(
      recallSkillPrompts(
        [queued(firstPrompt), queued(secondPrompt)],
        [first, second],
      ),
    ).toEqual({
      text: `${firstText}\n\n${secondText}`,
      skills: [second, first],
      images: [],
      warning: expect.stringContaining("/skill:other") as string,
    });
  });
});
