import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumOptions } from "@smart-rpc/ethereum";

import { POLYGON_MAINNET_REGISTRY } from "./registry.js";

export const POLYGON_CHAIN_ID = 137;
export const POLYGON_MAINNET_CAIP = "eip155:137";
export const POLYGON_NATIVE_CURRENCY = { name: "POL", symbol: "POL", decimals: 18 } as const;

export interface PolygonOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** Polygon PoS routing uses the shared Ethereum adapter and core policies. */
export function polygon(options: PolygonOptions = {}): RpcPool {
  return ethereum({
    ...options,
    chainId: POLYGON_CHAIN_ID,
    chainIds: [POLYGON_MAINNET_CAIP],
    endpoints: options.endpoints ?? POLYGON_MAINNET_REGISTRY,
  });
}
