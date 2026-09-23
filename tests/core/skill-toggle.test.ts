import {
  hasDisableModelInvocation,
  SkillFrontmatterError,
  setDisableModelInvocation,
} from "@core/skill-toggle";
import { describe, expect, it } from "vitest";

const KEY = "disable-model-invocation";

describe("the disable-model-invocation toggle", () => {
  it("inserts the key right after the opening fence", () => {
    const source = `---\nname: testing\ndescription: how we test\n---\n\nBody\n`;
    expect(setDisableModelInvocation(source, true)).toBe(
      `---\n${KEY}: true\nname: testing\ndescription: how we test\n---\n\nBody\n`,
    );
  });

  it("rewrites an explicit false in place instead of duplicating the key", () => {
    // A duplicate key would make the frontmatter unparseable and drop the
    // skill entirely, so presence is tested, not truthiness.
    const source = `---\nname: x\n${KEY}: false\ntags: [a, b]\n---\nBody\n`;
    expect(setDisableModelInvocation(source, true)).toBe(
      `---\nname: x\n${KEY}: true\ntags: [a, b]\n---\nBody\n`,
    );
  });

  it("keeps quoting, indentation and every unrelated field", () => {
    const source = `---\n  "${KEY}":   false\nname: x\n---\nBody\n`;
    expect(setDisableModelInvocation(source, true)).toBe(
      `---\n  "${KEY}": true\nname: x\n---\nBody\n`,
    );
  });

  it("preserves CRLF line endings when inserting", () => {
    const source = `---\r\nname: x\r\n---\r\nBody\r\n`;
    expect(setDisableModelInvocation(source, true)).toBe(
      `---\r\n${KEY}: true\r\nname: x\r\n---\r\nBody\r\n`,
    );
  });

  it("removes the line without leaving a blank one", () => {
    const source = `---\nname: x\n${KEY}: true\ndescription: d\n---\nBody\n`;
    expect(setDisableModelInvocation(source, false)).toBe(
      `---\nname: x\ndescription: d\n---\nBody\n`,
    );
  });

  it("leaves a file that never had the key untouched when enabling the model", () => {
    const source = `---\nname: x\n---\nBody\n`;
    expect(setDisableModelInvocation(source, false)).toBe(source);
  });

  it("writes a fresh block when the file has no frontmatter at all", () => {
    expect(setDisableModelInvocation("Just prose\n", true)).toBe(
      `---\n${KEY}: true\n---\nJust prose\n`,
    );
  });

  it("ignores a body line that only looks like the key", () => {
    const source = `---\nname: x\n---\nSet ${KEY}: true to hide it.\n`;
    expect(hasDisableModelInvocation(source)).toBe(false);
    expect(setDisableModelInvocation(source, false)).toBe(source);
    expect(setDisableModelInvocation(source, true)).toBe(
      `---\n${KEY}: true\nname: x\n---\nSet ${KEY}: true to hide it.\n`,
    );
  });

  it("removes a CRLF key line without disturbing the rest", () => {
    const source = `---\r\n${KEY}: true\r\nname: x\r\n---\r\nBody\r\n`;
    expect(setDisableModelInvocation(source, false)).toBe(
      `---\r\nname: x\r\n---\r\nBody\r\n`,
    );
  });

  it("refuses to switch a flow-mapping skill to Manual", () => {
    const source = `---\n{ name: testing, description: how we test, "${KEY}": false }\n---\nBody\n`;
    expect(() => setDisableModelInvocation(source, true)).toThrow(
      SkillFrontmatterError,
    );
  });

  it.each([true, false])(
    "refuses a multiline flow mapping with comments when disable=%s",
    (disable) => {
      const source = `---\r\n# Skill metadata\r\n\r\n{\r\n  name: testing,\r\n  description: how we test,\r\n  "${KEY}": true\r\n}\r\n---\r\nBody\r\n`;
      expect(() => setDisableModelInvocation(source, disable)).toThrow(
        SkillFrontmatterError,
      );
    },
  );

  it("refuses insertion into a flow mapping without the key", () => {
    const source = `---\n{ name: testing, description: how we test }\n---\nBody\n`;
    expect(() => setDisableModelInvocation(source, true)).toThrow(
      SkillFrontmatterError,
    );
  });
});
