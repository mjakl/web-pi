import { resolveBundledPi } from "@/pi-version.ts";

try {
  const pi = resolveBundledPi();
  process.stdout.write(
    `Bundled Pi ${pi.version}\nSDK: ${pi.codingAgentManifest}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
