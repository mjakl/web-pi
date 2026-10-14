import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("gives every test a temporary home instead of the developer's", () => {
  expect(homedir()).not.toBe(userInfo().homedir);
  expect(process.env["PI_CODING_AGENT_DIR"]).toBe(
    join(homedir(), ".pi", "agent"),
  );
  expect(process.env["XDG_CONFIG_HOME"]).toBe(join(homedir(), ".config"));
  expect(process.env["XDG_STATE_HOME"]).toBe(
    join(homedir(), ".local", "state"),
  );
});
