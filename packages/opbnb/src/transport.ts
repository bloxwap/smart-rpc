import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumOptions } from "@smart-rpc/ethereum";

import { OPBNB_MAINNET_REGISTRY } from "./registry.js";

export const OPBNB_CHAIN_ID = 204;
export const OPBNB_MAINNET_CAIP = "eip155:204";
export const OPBNB_NATIVE_CURRENCY = { name: "BNB", symbol: "BNB", decimals: 18 } as const;
/** Settlement/data-publication parent, not a chain id accepted by this transport. */
export const OPBNB_PARENT_CHAIN_ID = 56;
export const OPBNB_PARENT_CAIP = "eip155:56";

export interface OpBnbOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** opBNB mainnet execution RPC; routing and resilience remain in the shared core. */
export function opbnb(options: OpBnbOptions = {}): RpcPool {
  return ethereum({
    ...options,
    chainId: OPBNB_CHAIN_ID,
    chainIds: [OPBNB_MAINNET_CAIP],
    endpoints: options.endpoints ?? OPBNB_MAINNET_REGISTRY,
  });
}
