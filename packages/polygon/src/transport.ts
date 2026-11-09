import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumOptions } from "@smart-rpc/ethereum";

import { POLYGON_MAINNET_REGISTRY } from "./registry.js";

export const POLYGON_CHAIN_ID = 137;
export const POLYGON_MAINNET_CAIP = "eip155:137";
export const POLYGON_NATIVE_CURRENCY = { name: "POL", symbol: "POL", decimals: 18 } as const;

/**
 * 1.5s blocks (measured 2026-11-08: 100 blocks in 150s and 1,000 in 1,500s), faster than the older 2s figure. Lag
 * tolerance is one block, the minimum.
 */
const POLYGON_BLOCK_TIME_MS = 1_500;

export interface PolygonOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** Polygon PoS routing uses the shared Ethereum adapter and core policies. */
export function polygon(options: PolygonOptions = {}): RpcPool {
  return ethereum({
    ...options,
    chainId: POLYGON_CHAIN_ID,
    chainIds: [POLYGON_MAINNET_CAIP],
    endpoints: options.endpoints ?? POLYGON_MAINNET_REGISTRY,
    blockTimeMs: options.blockTimeMs ?? POLYGON_BLOCK_TIME_MS,
  });
}
