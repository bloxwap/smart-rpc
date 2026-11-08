import type { HeadLagOptions, RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumEndpoint, type EthereumOptions } from "@smart-rpc/ethereum";

import { FLARE_MAINNET_REGISTRY } from "./registry.js";

export const FLARE_CHAIN_ID = 14;
export const FLARE_MAINNET_CAIP = "eip155:14";
export const FLARE_NATIVE_CURRENCY = { name: "Flare", symbol: "FLR", decimals: 18 } as const;
/**
 * Local freshness policy, not a finality guarantee: heads older than 18s stop counting. `maxLag` comes from the
 * block time: about one second, one block.
 */
export const FLARE_HEAD_LAG: Readonly<HeadLagOptions> = { staleMs: 18_000 };

/** About 1s blocks (measured 2026-11-08: 1,000 blocks in 1,066s, 100 in 101s). */
const FLARE_BLOCK_TIME_MS = 1_000;

export interface FlareOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** Flare execution JSON-RPC. FTSO/FDC/DA services are separate APIs. */
export function flare(options: FlareOptions = {}): RpcPool {
  const endpoints = (options.endpoints ?? FLARE_MAINNET_REGISTRY).map(checkEndpoint);
  return ethereum({
    ...options,
    chainId: FLARE_CHAIN_ID,
    chainIds: [FLARE_MAINNET_CAIP],
    endpoints,
    blockTimeMs: options.blockTimeMs ?? FLARE_BLOCK_TIME_MS,
    headLag: options.headLag === false ? false : {
      ...FLARE_HEAD_LAG,
      ...(typeof options.headLag === "object" ? options.headLag : {}),
    },
  });
}

function checkEndpoint(endpoint: EthereumEndpoint): EthereumEndpoint {
  const url = new URL(typeof endpoint === "string" ? endpoint : endpoint.url);
  const separateService = /^(?:(?:flr|ctn2?|sgb)-data-availability|fdc-verifiers-(?:mainnet|testnet))\.flare\.network$/i.test(url.hostname);
  const wrongOfficialPath = url.hostname === "flare-api.flare.network" &&
    !["/ext/C/rpc", "/ext/C/ws"].includes(url.pathname.replace(/\/$/, ""));
  if (separateService || wrongOfficialPath) {
    throw new Error("flare() requires an execution JSON-RPC endpoint; DA/FDC verifier and other-chain APIs are separate services.");
  }
  const known = FLARE_MAINNET_REGISTRY.find((entry) => entry.url.replace(/\/$/, "") === url.href.replace(/\/$/, ""));
  if (!known) return endpoint;
  if (typeof endpoint === "string") return known;
  return { ...known, ...endpoint, capabilities: { ...known.capabilities, ...endpoint.capabilities } };
}
