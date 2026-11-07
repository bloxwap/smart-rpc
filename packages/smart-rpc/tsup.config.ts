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
    bsc: "src/bsc.ts",
    polygon: "src/polygon.ts",
    base: "src/base.ts",
    arbitrum: "src/arbitrum.ts",
    monad: "src/monad.ts",
    xlayer: "src/xlayer.ts",
    robinhood: "src/robinhood.ts",
    plasma: "src/plasma.ts",
    ink: "src/ink.ts",
    optimism: "src/optimism.ts",
    opbnb: "src/opbnb.ts",
    arc: "src/arc.ts",
    etherlink: "src/etherlink.ts",
    avalanche: "src/avalanche.ts",
    celo: "src/celo.ts",
    gnosis: "src/gnosis.ts",
    mantle: "src/mantle.ts",
    flare: "src/flare.ts",
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
