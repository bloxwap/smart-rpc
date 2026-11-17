import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumOptions } from "@smart-rpc/ethereum";

import { MONAD_MAINNET_REGISTRY } from "./registry.js";

export const MONAD_CHAIN_ID = 143;
export const MONAD_MAINNET_CAIP = "eip155:143";
export const MONAD_NATIVE_CURRENCY = { name: "Monad", symbol: "MON", decimals: 18 } as const;

/**
 * Local freshness settings for a sub-second chain; these are not finality guarantees. `maxLag` comes from the block
 * time: about one second, three blocks.
 */
export const MONAD_HEAD_LAG = { staleMs: 10_000, maxAhead: 200 } as const;

/** 300ms blocks (measured 2026-11-08: 1,000 blocks in 304s). */
const MONAD_BLOCK_TIME_MS = 300;

export interface MonadOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** Monad mainnet, using the shared EVM wire adapter and all routing from core. */
export function monad(options: MonadOptions = {}): RpcPool {
  return ethereum({
    ...options,
    chainId: MONAD_CHAIN_ID,
    chainIds: [MONAD_MAINNET_CAIP],
    endpoints: options.endpoints ?? MONAD_MAINNET_REGISTRY,
    blockTimeMs: options.blockTimeMs ?? MONAD_BLOCK_TIME_MS,
    headLag: options.headLag === false
      ? false
      : { ...MONAD_HEAD_LAG, ...(typeof options.headLag === "object" ? options.headLag : {}) },
  });
}
