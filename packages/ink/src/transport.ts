import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumOptions } from "@smart-rpc/ethereum";

import { INK_MAINNET_REGISTRY } from "./registry.js";

export const INK_CHAIN_ID = 57073;
export const INK_MAINNET_CAIP = "eip155:57073";
export const INK_NATIVE_CURRENCY = { name: "Ether", symbol: "ETH", decimals: 18 } as const;

/** 1s blocks (measured 2026-11-08: 1,000 blocks in 1,000s). Lag tolerance is one block. */
const INK_BLOCK_TIME_MS = 1_000;

export interface InkOptions extends Omit<EthereumOptions, "chainId" | "chainIds" | "skipPrecompiles"> {}

/** Ink mainnet RPC; shared Ethereum/core code owns routing, retries and state. */
export function ink(options: InkOptions = {}): RpcPool {
  const endpoints = options.endpoints ?? INK_MAINNET_REGISTRY;
  for (const endpoint of endpoints) {
    const url = typeof endpoint === "string" ? endpoint : endpoint.url;
    const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "subblocks.inkonchain.com" || hostname === "subblocks-sepolia.inkonchain.com") {
      throw new Error("Ink Subblocks URLs are preconfirmation streams, not JSON-RPC endpoints.");
    }
  }
  return ethereum({
    ...options,
    chainId: INK_CHAIN_ID,
    chainIds: [INK_MAINNET_CAIP],
    endpoints,
    skipPrecompiles: false,
    blockTimeMs: options.blockTimeMs ?? INK_BLOCK_TIME_MS,
  });
}
