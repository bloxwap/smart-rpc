import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      "@smart-rpc/core": new URL("../core/src/index.ts", import.meta.url).pathname,
    },
  },
});
