import type { HeadLagOptions, RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumOptions } from "@smart-rpc/ethereum";

import { PLASMA_MAINNET_REGISTRY } from "./registry.js";

export const PLASMA_CHAIN_ID = 9745;
export const PLASMA_MAINNET_CAIP = "eip155:9745";

/**
 * Local routing policy for ~1s Plasma blocks, not a consensus or provider guarantee. `maxLag` comes from the block
 * time: about one second, one block.
 */
export const PLASMA_HEAD_LAG: Readonly<HeadLagOptions> = {
  staleMs: 12_000,
  maxAhead: 120,
};

/** 1s blocks (measured 2026-11-08: 1,000 blocks in 1,000s). */
const PLASMA_BLOCK_TIME_MS = 1_000;

export interface PlasmaOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** Plasma EVM transport. Scoring, retries, budgets and quarantine remain in the shared pool. */
export function plasma(options: PlasmaOptions = {}): RpcPool {
  return ethereum({
    ...options,
    chainId: PLASMA_CHAIN_ID,
    chainIds: [PLASMA_MAINNET_CAIP],
    endpoints: options.endpoints ?? PLASMA_MAINNET_REGISTRY,
    blockTimeMs: options.blockTimeMs ?? PLASMA_BLOCK_TIME_MS,
    headLag: options.headLag === false
      ? false
      : { ...PLASMA_HEAD_LAG, ...(typeof options.headLag === "object" ? options.headLag : {}) },
  });
}
