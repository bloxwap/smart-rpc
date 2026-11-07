import { evmCachePolicy, type RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumEndpoint, type EthereumEndpointConfig, type EthereumOptions } from "@smart-rpc/ethereum";

import { AVALANCHE_MAINNET_REGISTRY, AVALANCHE_READ_METHODS, AVALANCHE_RPC_METHODS } from "./registry.js";

export const AVALANCHE_CHAIN_ID = 43114;
export const AVALANCHE_MAINNET_CAIP = "eip155:43114";
export const AVALANCHE_NATIVE_CURRENCY = { name: "Avalanche", symbol: "AVAX", decimals: 18 } as const;

export interface AvalancheOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** Avalanche C-Chain execution RPC; routing and retry policy remain in the shared core. */
export function avalanche(options: AvalancheOptions = {}): RpcPool {
  return ethereum({
    ...options,
    chainId: AVALANCHE_CHAIN_ID,
    chainIds: [AVALANCHE_MAINNET_CAIP],
    endpoints: (options.endpoints ?? AVALANCHE_MAINNET_REGISTRY).map(endpointConfig),
    cachePolicy: options.cachePolicy ?? evmCachePolicy({ logs: false }),
    safeMethods: [...AVALANCHE_READ_METHODS, ...(options.safeMethods ?? [])],
  });
}

function endpointConfig(input: EthereumEndpoint): EthereumEndpointConfig {
  const config = typeof input === "string" ? { url: input } : input;
  const url = new URL(config.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (/^\/ext\/bc\/(?:P|X)(?:\/|$)/i.test(path) || /^\/ext\/bc\/[^/]+\/avax$/i.test(path) ||
      (/^(?:api\.avax\.network|api\.avax-test\.network)\.?$/i.test(url.hostname) &&
       path !== (url.protocol.startsWith("ws") ? "/ext/bc/C/ws" : "/ext/bc/C/rpc"))) {
    throw new Error("avalanche() requires a C-Chain execution RPC endpoint; atomic, P-Chain and X-Chain APIs are separate.");
  }
  const known = AVALANCHE_MAINNET_REGISTRY.find(({ url: endpoint }) => endpoint.replace(/\/+$/, "") === config.url.replace(/\/+$/, ""));
  const supportedMethods = config.supportedMethods ?? known?.supportedMethods ?? AVALANCHE_RPC_METHODS;
  if (supportedMethods.some((method) => !/^(?:eth_|net_|web3_|debug_|trace_|txpool_)/.test(method))) {
    throw new Error("avalanche() only accepts C-Chain execution methods; use a separate client for Avalanche atomic and consensus APIs.");
  }
  return {
    ...known,
    ...config,
    supportedMethods,
    ...(known ? { unsupportedMethods: [...new Set([...(known.unsupportedMethods ?? []), ...(config.unsupportedMethods ?? [])])] } : {}),
  };
}
