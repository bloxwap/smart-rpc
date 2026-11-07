import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumEndpoint, type EthereumOptions } from "@smart-rpc/ethereum";

import { XLAYER_MAINNET_REGISTRY } from "./registry.js";

export const XLAYER_CHAIN_ID = 196;
export const XLAYER_MAINNET_CAIP = "eip155:196";
export const XLAYER_NATIVE_CURRENCY = { name: "OKB", symbol: "OKB", decimals: 18 } as const;

export interface XLayerOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** X Layer mainnet. Shared Ethereum/core code owns identity checks, routing and retries. */
export function xlayer(options: XLayerOptions = {}): RpcPool {
  return ethereum({
    ...options,
    chainId: XLAYER_CHAIN_ID,
    chainIds: [XLAYER_MAINNET_CAIP],
    endpoints: (options.endpoints ?? XLAYER_MAINNET_REGISTRY).map(withPublicDefaults),
  });
}

/** Reusing a public URL keeps its shared quota and capability defaults; explicit options win. */
function withPublicDefaults(endpoint: EthereumEndpoint): EthereumEndpoint {
  const config = typeof endpoint === "string" ? { url: endpoint } : endpoint;
  const known = XLAYER_MAINNET_REGISTRY.find(({ url }) => config.url.replace(/\/$/, "") === url);
  if (!known) return endpoint;
  return {
    ...known,
    ...config,
    capabilities: { ...known.capabilities, ...config.capabilities },
  };
}
