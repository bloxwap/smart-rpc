import { defineConfig } from "tsup";

export default defineConfig({
  entry: [".dev/rank.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: false,
  target: "node22",
  outDir: ".dev-dist",
});
