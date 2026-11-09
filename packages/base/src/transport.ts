import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumEndpoint, type EthereumOptions } from "@smart-rpc/ethereum";

import { BASE_MAINNET_REGISTRY } from "./registry.js";

export const BASE_CHAIN_ID = 8453;
export const BASE_MAINNET_CAIP = "eip155:8453";
export const BASE_NATIVE_CURRENCY = { name: "Ether", symbol: "ETH", decimals: 18 } as const;

/** 200ms blocks (measured 2026-11-08: 1,000 blocks in 200s). Lag tolerance is five blocks, one second. */
const BASE_BLOCK_TIME_MS = 200;

export interface BaseOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/**
 * Base mainnet transport. The shared EVM adapter owns routing and failure policy.
 * `latest` is the unsafe L2 head; `safe` and `finalized` retain their requested
 * Ethereum settlement meaning. No preconfirmation feed enters this pool.
 */
export function base(options: BaseOptions = {}): RpcPool {
  const endpoints = options.endpoints ?? BASE_MAINNET_REGISTRY;
  for (const endpoint of endpoints) assertGeneralRpc(endpoint);
  return ethereum({
    ...options,
    chainId: BASE_CHAIN_ID,
    chainIds: [BASE_MAINNET_CAIP],
    endpoints,
    blockTimeMs: options.blockTimeMs ?? BASE_BLOCK_TIME_MS,
  });
}

function assertGeneralRpc(endpoint: EthereumEndpoint): void {
  const url = typeof endpoint === "string" ? endpoint : endpoint.url;
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  if (host === "mainnet-sequencer.base.org" || host === "sepolia-sequencer.base.org") {
    throw new Error(
      "Base sequencer endpoints accept transaction submissions only. Use a general Base RPC endpoint in base().",
    );
  }
}
