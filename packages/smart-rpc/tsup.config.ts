import { defineConfig } from "tsup";

/**
 * One published package. Workspace packages are compiled in.
 * `viem` stays external so it is the package dependency, not a second copy.
 * Splitting keeps a single copy of the core chunk across the root and the subpaths.
 * The root entry does not import a transport, so a bundler that only loads `.` omits them.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    ethereum: "src/ethereum.ts",
    hyperevm: "src/hyperevm.ts",
    solana: "src/solana.ts",
  },
  format: ["esm"],
  dts: {
    resolve: [/^@smart-rpc\//],
  },
  clean: true,
  sourcemap: true,
  treeshake: true,
  splitting: true,
  target: "es2022",
  external: ["viem"],
  noExternal: [/^@smart-rpc\//],
});
