import type { RpcPool } from "@smart-rpc/core";
import {
  ethereum,
  type EthereumEndpoint,
  type EthereumEndpointConfig,
  type EthereumOptions,
} from "@smart-rpc/ethereum";

import { BSC_EXTENSION_METHODS, BSC_MAINNET_REGISTRY } from "./registry.js";

export const BSC_CHAIN_ID = 56;
export const BSC_MAINNET_CAIP = "eip155:56";
export const BSC_NATIVE_CURRENCY = { name: "BNB", symbol: "BNB", decimals: 18 } as const;

/** 450ms blocks (measured 2026-11-08: 1,000 blocks in 450s). Lag tolerance is two blocks, 0.9 seconds. */
const BSC_BLOCK_TIME_MS = 450;

export interface BscOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** BNB Smart Chain mainnet, using the canonical EVM adapter and shared pool policy. */
export function bsc(options: BscOptions = {}): RpcPool {
  return ethereum({
    ...options,
    chainId: BSC_CHAIN_ID,
    chainIds: [BSC_MAINNET_CAIP],
    endpoints: (options.endpoints ?? BSC_MAINNET_REGISTRY).map(configureEndpoint),
    blockTimeMs: options.blockTimeMs ?? BSC_BLOCK_TIME_MS,
    nonIdempotentMethods: ["eth_newFinalizedHeaderFilter", ...(options.nonIdempotentMethods ?? [])],
  });
}

/** Preserve documented restrictions/budgets when a public default is supplied as a URL. */
function configureEndpoint(endpoint: EthereumEndpoint): EthereumEndpoint {
  const config: EthereumEndpointConfig = typeof endpoint === "string" ? { url: endpoint } : endpoint;
  const known = BSC_MAINNET_REGISTRY.find(({ url }) => url.replace(/\/$/, "") === config.url.replace(/\/$/, ""));
  const undeclaredExtensions = BSC_EXTENSION_METHODS.filter((method) => !config.supportedMethods?.includes(method));
  return {
    ...known,
    ...config,
    capabilities: { ...known?.capabilities, ...config.capabilities },
    // Keep each known default's own restrictions (the documented dataseeds disable
    // eth_getLogs) without extending them to registry peers that serve logs.
    unsupportedMethods: [...new Set([
      ...(known?.unsupportedMethods ?? []),
      ...undeclaredExtensions,
      ...(config.unsupportedMethods ?? []),
    ])],
  };
}
