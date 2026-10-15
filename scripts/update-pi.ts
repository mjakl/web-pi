import { execFileSync } from "node:child_process";
import { CODING_AGENT, PI_PACKAGES } from "../src/pi-version.ts";

// A fresh registry query is required even when the lockfile already satisfies
// the manifest. Freeze the result so a tarball installs the Pi it was built with.
try {
  const version: unknown = JSON.parse(
    execFileSync("pnpm", ["view", CODING_AGENT, "dist-tags.latest", "--json"], {
      encoding: "utf8",
    }),
  );
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Pi's latest tag must name a stable release");
  }
  execFileSync(
    "pnpm",
    [
      "add",
      "--save-exact",
      "--ignore-scripts",
      "--config.minimumReleaseAgeStrict=true",
      ...PI_PACKAGES.map((name) => `${name}@${version}`),
    ],
    { stdio: "inherit" },
  );
  process.stdout.write(`Bundled Pi ${version}\n`);
} catch (error) {
  process.stderr.write(
    `Cannot update bundled Pi: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
