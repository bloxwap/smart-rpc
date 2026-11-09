import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumOptions } from "@smart-rpc/ethereum";
import { GNOSIS_MAINNET_REGISTRY } from "./registry.js";

export const GNOSIS_CHAIN_ID = 100;
export const GNOSIS_MAINNET_CAIP = "eip155:100";
export const GNOSIS_NATIVE_CURRENCY = { name: "xDAI", symbol: "xDAI", decimals: 18 } as const;
/** Consensus cadence metadata, not a promise that a particular head is finalized. */
export const GNOSIS_CONSENSUS = { slotSeconds: 5, slotsPerEpoch: 16, approximateFinalizationSeconds: 162 } as const;

export interface GnosisOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** Gnosis execution JSON-RPC using the canonical adapter and shared pool policies. */
export function gnosis(options: GnosisOptions = {}): RpcPool {
  const endpoints = options.endpoints ?? GNOSIS_MAINNET_REGISTRY;
  for (const endpoint of endpoints) {
    const url = new URL(typeof endpoint === "string" ? endpoint : endpoint.url);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "rpc-gbc.gnosischain.com" || /\/eth\/v[12](?:\/|$)/.test(url.pathname)) {
      throw new Error("Gnosis beacon/consensus REST endpoints cannot serve execution JSON-RPC.");
    }
    if ((url.protocol === "ws:" || url.protocol === "wss:") && hostname === "rpc.gnosischain.com" && url.pathname !== "/wss") {
      throw new Error("Use the documented Gnosis WebSocket endpoint wss://rpc.gnosischain.com/wss.");
    }
  }
  return ethereum({
    ...options,
    chainId: GNOSIS_CHAIN_ID,
    chainIds: [GNOSIS_MAINNET_CAIP],
    endpoints,
    // 5s slots (measured 2026-11-08: 1,000 blocks in 5,070s, the gap being missed slots). Lag tolerance is one
    // block, the minimum, and the head-growth ceiling 0.25 blocks/s: the slot rate plus the shared 25% headroom.
    blockTimeMs: options.blockTimeMs ?? GNOSIS_CONSENSUS.slotSeconds * 1_000,
    headLag: options.headLag === false ? false : { staleMs: 30_000, ...(typeof options.headLag === "object" ? options.headLag : {}) },
  });
}
