import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumEndpoint, type EthereumOptions } from "@smart-rpc/ethereum";

import { OPTIMISM_MAINNET_REGISTRY } from "./registry.js";

export const OPTIMISM_CHAIN_ID = 10;
export const OPTIMISM_MAINNET_CAIP = "eip155:10";
export const OPTIMISM_NATIVE_CURRENCY = { name: "Ether", symbol: "ETH", decimals: 18 } as const;

/** 2s blocks (measured 2026-11-08: 1,000 blocks in 2,000s). Lag tolerance is one block. */
const OPTIMISM_BLOCK_TIME_MS = 2_000;

export interface OptimismOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** OP Mainnet adapter. Core owns retries, health, budgets, caching and routing. */
export function optimism(options: OptimismOptions = {}): RpcPool {
  const endpoints = (options.endpoints ?? OPTIMISM_MAINNET_REGISTRY).map(configureEndpoint);
  for (const endpoint of endpoints) assertGeneralRpc(endpoint);
  return ethereum({
    ...options,
    chainId: OPTIMISM_CHAIN_ID,
    chainIds: [OPTIMISM_MAINNET_CAIP],
    endpoints,
    blockTimeMs: options.blockTimeMs ?? OPTIMISM_BLOCK_TIME_MS,
  });
}

/** Keep conservative default capabilities when the public URL is supplied explicitly. */
function configureEndpoint(endpoint: EthereumEndpoint): EthereumEndpoint {
  const config = typeof endpoint === "string" ? { url: endpoint } : endpoint;
  const known = OPTIMISM_MAINNET_REGISTRY.find(({ url }) => new URL(url).href === new URL(config.url).href);
  if (!known) return endpoint;
  return { ...known, ...config, capabilities: { ...known.capabilities, ...config.capabilities } };
}

function assertGeneralRpc(endpoint: EthereumEndpoint): void {
  const url = new URL(typeof endpoint === "string" ? endpoint : endpoint.url);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "mainnet-sequencer.optimism.io" || host === "sepolia-sequencer.optimism.io") {
    throw new Error("OP Mainnet sequencer endpoints accept transaction submissions only. Use a general OP Mainnet RPC endpoint in optimism().");
  }
  if (host === "op-mainnet-fb-ws-pub.optimism.io" || host === "op-sepolia-fb-ws.optimism.io") {
    throw new Error("OP Subblocks is a preconfirmation stream, not a general JSON-RPC endpoint.");
  }
  if ((host === "mainnet.optimism.io" || host === "sepolia.optimism.io") &&
      (url.protocol === "ws:" || url.protocol === "wss:")) {
    throw new Error("The public OP Mainnet RPC does not support WebSocket. Configure a documented provider WebSocket URL.");
  }
}
