import { defineConfig } from "vitest/config";

/**
 * Workspace-wide run used for coverage. Each package keeps its own config for `pnpm test`;
 * this one merges them so shared core code is credited for the chain tests that exercise it.
 */
export default defineConfig({
  test: {
    projects: ["packages/*"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      reportOnFailure: true,
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
