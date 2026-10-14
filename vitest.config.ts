import { defineConfig } from "vitest/config";

export default defineConfig({
  // Path aliases and JSX settings come from tsconfig.json.
  resolve: { tsconfigPaths: true },
  test: {
    globalSetup: ["tests/global-setup.ts"],
    // Two projects, one run: the server and core tests in Node, and the
    // client bundle's modules in a browser-like DOM. `vitest run` executes
    // both; `--project client` narrows to one.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "tests/client/**",
            // The smoke test packs and installs the package, so it runs only
            // when `just smoke` asks for it.
            ...(process.env["WEB_PI_SMOKE"] === undefined
              ? ["tests/smoke/**"]
              : []),
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "client",
          environment: "happy-dom",
          include: ["tests/client/**/*.test.ts"],
          setupFiles: ["tests/client/setup.ts"],
          environmentOptions: {
            happyDOM: {
              // `location.assign` must never fetch a page from a test.
              settings: { navigation: { disableMainFrameNavigation: true } },
            },
          },
        },
      },
    ],
    coverage: { provider: "v8" },
    sequence: { shuffle: true },
    pool: "threads",
    testTimeout: 20_000,
  },
});
