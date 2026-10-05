import { execFileSync } from "node:child_process";

// A fresh registry query is required even when the lockfile already satisfies
// the manifest. Freeze the result so a tarball installs the Pi it was built with.
const codingAgent = "@earendil-works/pi-coding-agent";
const packages = [
  codingAgent,
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
];

try {
  const version: unknown = JSON.parse(
    execFileSync("pnpm", ["view", codingAgent, "dist-tags.latest", "--json"], {
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
      ...packages.map((name) => `${name}@${version}`),
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
