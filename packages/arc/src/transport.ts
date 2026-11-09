import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumOptions } from "@smart-rpc/ethereum";

import { ARC_MAINNET_REGISTRY } from "./registry.js";

export const ARC_CHAIN_ID = 5042;
export const ARC_MAINNET_CAIP = "eip155:5042";
/** Native balances and gas are USDC at 18 decimals, not the ERC-20 view's 6. */
export const ARC_NATIVE_CURRENCY = { name: "USDC", symbol: "USDC", decimals: 18 } as const;
/** The ERC-20 interface represents the same balance as the native interface. */
export const ARC_USDC_ERC20_ADDRESS = "0x3600000000000000000000000000000000000000";
export const ARC_USDC_ERC20_DECIMALS = 6;
/** EIP-7708 Transfer logs use native 18-decimal units. */
export const ARC_NATIVE_TRANSFER_EMITTER = "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE";

/** 500ms blocks (measured 2026-11-08: 1,000 blocks in 507s). Lag tolerance is two blocks, one second. */
const ARC_BLOCK_TIME_MS = 500;

export interface ArcOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** Arc mainnet; raw EVM quantities, errors, system logs and extension fields pass through. */
export function arc(options: ArcOptions = {}): RpcPool {
  return ethereum({
    ...options,
    chainId: ARC_CHAIN_ID,
    chainIds: [ARC_MAINNET_CAIP],
    endpoints: options.endpoints ?? ARC_MAINNET_REGISTRY,
    blockTimeMs: options.blockTimeMs ?? ARC_BLOCK_TIME_MS,
  });
}
