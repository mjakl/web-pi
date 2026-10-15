import { ConfigButton, ConfigSwitch } from "@web/views/ConfigControls";
import { html } from "hono/html";
import { describe, expect, it } from "vitest";

const render = async (node: unknown) => String(await html`${node}`);

describe("config controls", () => {
  it("stay plain buttons when a caller passes type as undefined", async () => {
    expect(
      await render(<ConfigButton type={undefined}>Save</ConfigButton>),
    ).toBe(
      '<button type="button" class="config-button config-button-secondary config-button-default">Save</button>',
    );
    expect(
      await render(<ConfigSwitch type={undefined} checked label="Sound" />),
    ).toContain('<button type="button"');
  });

  it("keep a type the caller asks for", async () => {
    expect(
      await render(<ConfigButton type="submit">Save</ConfigButton>),
    ).toContain('<button type="submit"');
  });
});
