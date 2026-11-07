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

export interface BscOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** BNB Smart Chain mainnet, using the canonical EVM adapter and shared pool policy. */
export function bsc(options: BscOptions = {}): RpcPool {
  return ethereum({
    ...options,
    chainId: BSC_CHAIN_ID,
    chainIds: [BSC_MAINNET_CAIP],
    endpoints: (options.endpoints ?? BSC_MAINNET_REGISTRY).map(configureEndpoint),
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
    // A dedicated provider may enable logs; the documented public dataseeds cannot.
    unsupportedMethods: [...new Set([
      ...(known ? ["eth_getLogs"] : []),
      ...undeclaredExtensions,
      ...(config.unsupportedMethods ?? []),
    ])],
  };
}
