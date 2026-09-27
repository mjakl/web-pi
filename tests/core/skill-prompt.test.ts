import { userEntry } from "@adapters/fake/index";
import {
  decodeSkillPrompt,
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
      expect(decodeSkillPrompt(encoded)).toEqual({
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
    expect(decodeSkillPrompt(text)).toEqual({ text });
  });

  it("keeps the legacy single-skill fallback without guessing originals from multiple envelopes", () => {
    expect(skillCommand(legacy)).toBe("/skill:legacy legacy args");
    expect(decodeSkillPrompt(legacy)).toEqual({
      text: "/skill:legacy legacy args",
    });
    expect(decodeSkillPrompt(`${legacy}\n\n${legacy}`)).toEqual({
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
      recallSkillPrompts([
        { ...queued(encoded), images: [image] },
        queued(another),
        queued(legacy),
      ]),
    ).toEqual({
      text: "  first draft  \n\nsecond draft\n\n/skill:legacy legacy args",
      skills: [first, second],
      images: [image],
    });
    expect(recallSkillPrompts([queued(legacy)])).toEqual({
      text: "/skill:legacy legacy args",
      images: [],
    });
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
      recallSkillPrompts([queued(firstPrompt), queued(secondPrompt)]),
    ).toEqual({
      text: `${firstText}\n\n${secondText}`,
      skills: [second, first],
      images: [],
    });
  });
});
