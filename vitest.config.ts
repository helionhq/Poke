import { defineConfig } from "vitest/config";

// One vitest run covers every Node package. Workspace packages resolve to their TypeScript
// source through the "source" export condition, so tests need no build first.
export default defineConfig({
  resolve: { conditions: ["source", "node", "development"] },
  ssr: { resolve: { conditions: ["source", "node", "development"] } },
  test: {
    include: ["packages/**/src/**/*.test.ts", "apps/server/src/**/*.test.ts", "apps/cli/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    pool: "forks",
  },
});
