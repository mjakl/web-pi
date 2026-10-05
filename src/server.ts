import { bundledPiVersion } from "./pi-version.ts";

// Keep SDK imports behind ownership validation, including direct server starts.
bundledPiVersion();
await import(new URL("./server-runtime.js", import.meta.url).href);
