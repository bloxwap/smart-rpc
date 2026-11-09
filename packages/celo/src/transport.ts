import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumOptions } from "@smart-rpc/ethereum";

import { CELO_MAINNET_REGISTRY, CELO_SEPOLIA_REGISTRY } from "./registry.js";

export const CELO_CHAIN_ID = 42220;
export const CELO_MAINNET_CAIP = "eip155:42220";
export const CELO_SEPOLIA_CHAIN_ID = 11142220;
export const CELO_SEPOLIA_CAIP = "eip155:11142220";
export const CELO_NATIVE_CURRENCY = { name: "Celo", symbol: "CELO", decimals: 18 } as const;

export interface CeloOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {
  /** Mainnet by default; the supported developer testnet is Celo Sepolia. */
  chainId?: typeof CELO_CHAIN_ID | typeof CELO_SEPOLIA_CHAIN_ID | undefined;
}

/** Additional wire field for Celo transaction requests/results. It is never rewritten. */
export interface CeloFeeCurrencyFields {
  /** Fee currency adapter for non-18-decimal tokens, not necessarily the token's address. */
  feeCurrency?: `0x${string}` | null | undefined;
}

/** 1s blocks on mainnet (measured 2026-11-08: 1,000 blocks in 1,000s) and Celo Sepolia. Lag tolerance is one block. */
const CELO_BLOCK_TIME_MS = 1_000;

/** Celo uses the canonical EVM adapter; complete params remain in shared cache/coalescing keys. */
export function celo(options: CeloOptions = {}): RpcPool {
  const chainId = options.chainId ?? CELO_CHAIN_ID;
  if (chainId !== CELO_CHAIN_ID && chainId !== CELO_SEPOLIA_CHAIN_ID) {
    throw new Error("celo() supports mainnet 42220 and Celo Sepolia 11142220; Alfajores is retired.");
  }
  return ethereum({
    ...options,
    chainId,
    chainIds: [`eip155:${chainId}`],
    endpoints: options.endpoints ?? (chainId === CELO_CHAIN_ID ? CELO_MAINNET_REGISTRY : CELO_SEPOLIA_REGISTRY),
    blockTimeMs: options.blockTimeMs ?? CELO_BLOCK_TIME_MS,
  });
}
