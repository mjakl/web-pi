import { execFileSync } from "node:child_process";

// The opt-in browser checks drive agent-browser against the isolated
// screenshot fixture, never against a real web-pi instance.

/** The fixture URL from the command line; the installed default is refused. */
export function fixtureUrl(): URL {
  const url = new URL(process.argv[2] ?? "http://invalid");
  if (url.hostname !== "127.0.0.1" || !url.port || url.port === "30142") {
    throw new Error(
      "Pass the ephemeral loopback URL printed by just screenshots",
    );
  }
  return url;
}

/** Commands for one dedicated agent-browser session. */
export function agentBrowser(name: string) {
  const session = `${name}-${String(process.pid)}`;
  function browser(...args: string[]): string {
    return execFileSync("agent-browser", ["--session", session, ...args], {
      encoding: "utf8",
      timeout: 30_000,
    });
  }
  function evaluate(code: string): string {
    return browser("eval", code);
  }
  /** Fails unless the control has a size, lies in the viewport and is on top. */
  function reachable(selector: string): void {
    evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (!rect.width || !rect.height || rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth || !element.contains(hit)) {
        throw new Error('Clipped or covered control: ' + ${JSON.stringify(selector)});
      }
      return true;
    })()`);
  }
  return { browser, evaluate, reachable };
}
