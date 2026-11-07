import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/solana.ts", "src/ethereum.ts", "src/hyperevm.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  target: "es2022",
  external: [/^@smart-rpc\//, "viem"],
  splitting: false,
});
