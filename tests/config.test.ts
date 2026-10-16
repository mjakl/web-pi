import { loadConfig } from "@/config";
import { describe, expect, it } from "vitest";

describe("notification grace configuration", () => {
  it("defaults to fifteen minutes", () => {
    expect(loadConfig({}).notificationGracePeriodMs).toBe(15 * 60_000);
  });

  it.each([
    ["0", 0],
    ["1", 60_000],
    [" 30 ", 30 * 60_000],
    ["35791", 35791 * 60_000],
  ])("converts %s whole minutes to milliseconds", (value, expected) => {
    expect(
      loadConfig({ WEB_PI_NOTIFICATION_GRACE_PERIOD: value })
        .notificationGracePeriodMs,
    ).toBe(expected);
  });

  it.each([
    "",
    " ",
    "-1",
    "0.5",
    "NaN",
    "Infinity",
    "1e2",
    "0x10",
    "15min",
    "35792",
    "99999999999999999999",
  ])("rejects invalid input %j instead of removing the delay", (value) => {
    expect(() =>
      loadConfig({ WEB_PI_NOTIFICATION_GRACE_PERIOD: value }),
    ).toThrow(
      "WEB_PI_NOTIFICATION_GRACE_PERIOD must be a whole number of minutes from 0 to 35791",
    );
  });
});

describe("dictation credentials", () => {
  it("reads the optional OpenAI key only from the server environment", () => {
    expect(loadConfig({}).openaiApiKey).toBeUndefined();
    expect(loadConfig({ OPENAI_API_KEY: "   " }).openaiApiKey).toBeUndefined();
    expect(
      loadConfig({ OPENAI_API_KEY: "  server-secret  " }).openaiApiKey,
    ).toBe("server-secret");
  });
});

describe("host configuration", () => {
  it("defaults to the loopback address", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
  });

  it.each(["", " ", "\t"])(
    "rejects the empty host %j instead of binding every interface",
    (value) => {
      expect(() => loadConfig({ WEB_PI_HOST: value })).toThrow(
        "WEB_PI_HOST must not be empty",
      );
    },
  );
});
