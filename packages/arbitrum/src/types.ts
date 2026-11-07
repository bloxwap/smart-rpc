/** Hex-encoded wire values are kept intact by the transport. */
export type ArbitrumHex = `0x${string}`;

/** Nitro fields added to an execution receipt; parent-chain gas is denominated in L2 gas units. */
export interface ArbitrumReceiptFields {
  l1BlockNumber: ArbitrumHex;
  gasUsedForL1: ArbitrumHex;
}

/** Nitro block fields; L1 block numbers are distinct from the block's L2 number. */
export interface ArbitrumBlockFields {
  l1BlockNumber: ArbitrumHex;
  sendCount: ArbitrumHex;
  sendRoot: ArbitrumHex;
}

/** Addresses from the official Nitro precompile reference. */
export const ARBITRUM_PRECOMPILES = Object.freeze({
  arbSys: "0x0000000000000000000000000000000000000064",
  arbGasInfo: "0x000000000000000000000000000000000000006c",
  arbWasm: "0x0000000000000000000000000000000000000071",
  nodeInterface: "0x00000000000000000000000000000000000000c8",
} as const);
