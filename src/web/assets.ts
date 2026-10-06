import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Built assets are hashed once at boot so the browser can cache them hard and
// still pick up a rebuild; nothing rebuilds them while the server runs.

export type StaticAssets = { css: string; js: string };

function assetUrl(root: string, file: string): string {
  let version = "dev";
  try {
    version = createHash("sha256")
      .update(readFileSync(join(root, file)))
      .digest("hex")
      .slice(0, 8);
  } catch {
    // Nothing built yet: an unhashed URL still loads once it appears.
  }
  return `/static/${file}?v=${version}`;
}

export function staticAssets(root: string): StaticAssets {
  return {
    css: assetUrl(root, "app.css"),
    js: assetUrl(root, "client.js"),
  };
}
