import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumEndpoint, type EthereumOptions } from "@smart-rpc/ethereum";

import { MANTLE_MAINNET_REGISTRY, MANTLE_MAINNET_WS_URL } from "./registry.js";

export const MANTLE_CHAIN_ID = 5000;
export const MANTLE_MAINNET_CAIP = "eip155:5000";
export const MANTLE_NATIVE_CURRENCY = { name: "Mantle", symbol: "MNT", decimals: 18 } as const;
export const MANTLE_GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";

export interface MantleOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** Mantle mainnet; all routing, retry, budget and breaker policy remains in the shared core. */
export function mantle(options: MantleOptions = {}): RpcPool {
  return ethereum({
    ...options,
    chainId: MANTLE_CHAIN_ID,
    chainIds: [MANTLE_MAINNET_CAIP],
    endpoints: (options.endpoints ?? MANTLE_MAINNET_REGISTRY).map(configurePublic),
  });
}

function configurePublic(endpoint: EthereumEndpoint): EthereumEndpoint {
  const config = typeof endpoint === "string" ? { url: endpoint } : endpoint;
  const parsed = new URL(config.url);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host !== "rpc.mantle.xyz" && host !== new URL(MANTLE_MAINNET_WS_URL).hostname) return endpoint;
  const known = MANTLE_MAINNET_REGISTRY[0]!;
  return {
    ...known,
    ...config,
    capabilities: { ...known.capabilities, ...config.capabilities },
    // These restrictions are documented for the public provider, even if passed explicitly.
    unsupportedMethods: [...new Set([...known.unsupportedMethods!, ...(config.unsupportedMethods ?? [])])],
  };
}
