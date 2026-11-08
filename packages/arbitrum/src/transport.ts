import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumEndpoint, type EthereumOptions } from "@smart-rpc/ethereum";

import { ARBITRUM_MAINNET_REGISTRY } from "./registry.js";

export const ARBITRUM_CHAIN_ID = 42161;
export const ARBITRUM_MAINNET_CAIP = "eip155:42161";
export const ARBITRUM_NATIVE_CURRENCY = Object.freeze({ name: "Ether", symbol: "ETH", decimals: 18 });

/**
 * Nominal 250ms blocks (measured 2026-11-08: 1,000 blocks in 298s, timestamps in whole seconds). Lag tolerance is
 * about four blocks, one second.
 */
const ARBITRUM_BLOCK_TIME_MS = 250;

export interface ArbitrumOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** Arbitrum One uses the shared EVM adapter and core routing policy. */
export function arbitrum(options: ArbitrumOptions = {}): RpcPool {
  const endpoints = options.endpoints ?? ARBITRUM_MAINNET_REGISTRY;
  for (const endpoint of endpoints) validateEndpoint(endpoint);
  return ethereum({
    ...options,
    chainId: ARBITRUM_CHAIN_ID,
    chainIds: [ARBITRUM_MAINNET_CAIP],
    endpoints,
    blockTimeMs: options.blockTimeMs ?? ARBITRUM_BLOCK_TIME_MS,
    nonIdempotentMethods: [
      ...(options.nonIdempotentMethods ?? []),
      // Conditions are time/state sensitive; do not automatically replay them.
      "eth_sendRawTransactionConditional",
    ],
  });
}

function validateEndpoint(endpoint: EthereumEndpoint): void {
  const url = new URL(typeof endpoint === "string" ? endpoint : endpoint.url);
  if (url.hostname === "arb1-sequencer.arbitrum.io") {
    throw new Error("Arbitrum's direct sequencer is write-only. Use a general RPC in arbitrum() endpoints.");
  }
  if (url.hostname === "arb1-feed.arbitrum.io") {
    throw new Error("Arbitrum's sequencer feed is not a JSON-RPC endpoint.");
  }
  if (url.hostname === "arb1.arbitrum.io" && (url.protocol === "ws:" || url.protocol === "wss:")) {
    throw new Error("The Arbitrum public RPC does not support WebSocket. Supply a verified provider URL.");
  }
}
