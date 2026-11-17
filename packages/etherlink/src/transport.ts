import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumEndpoint, type EthereumOptions } from "@smart-rpc/ethereum";

import { ETHERLINK_MAINNET_REGISTRY, ETHERLINK_PUBLIC_LIMITS } from "./registry.js";

export const ETHERLINK_CHAIN_ID = 42793;
export const ETHERLINK_MAINNET_CAIP = "eip155:42793";
export const ETHERLINK_NATIVE_CURRENCY = { name: "Tez", symbol: "XTZ", decimals: 18 } as const;

/** EVM destinations, not Tezos RPC URLs or a promise of bridge execution. */
export const ETHERLINK_PRECOMPILES = {
  xtzBridge: "0xff00000000000000000000000000000000000001",
  faBridge: "0xff00000000000000000000000000000000000002",
  nativeAtomicGateway: "0xff00000000000000000000000000000000000007",
} as const;

/**
 * About 1.2s blocks (measured 2026-11-08: 1,000 blocks in 1,186-1,192s, 100 in 125-132s). Lag tolerance is one
 * block, so a frozen head is caught within a couple of seconds.
 */
const ETHERLINK_BLOCK_TIME_MS = 1_200;

export interface EtherlinkOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** Etherlink's EVM interface. All routing, budgets and retries remain in the shared core. */
export function etherlink(options: EtherlinkOptions = {}): RpcPool {
  return ethereum({
    ...options,
    chainId: ETHERLINK_CHAIN_ID,
    chainIds: [ETHERLINK_MAINNET_CAIP],
    endpoints: (options.endpoints ?? ETHERLINK_MAINNET_REGISTRY).map(configureEndpoint),
    blockTimeMs: options.blockTimeMs ?? ETHERLINK_BLOCK_TIME_MS,
  });
}

function configureEndpoint(endpoint: EthereumEndpoint): EthereumEndpoint {
  const config = typeof endpoint === "string" ? { url: endpoint } : endpoint;
  const url = new URL(config.url);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "relay.mainnet.etherlink.com" || host === "relay.shadownet.etherlink.com") {
    throw new Error("Etherlink relay endpoints expose only eth_sendRawTransaction and eth_blockNumber. Use a full EVM RPC endpoint in etherlink().");
  }
  if (host === "michelson.etherlink.mainnet.octez.io" || host === "michelson.etherlink.shadownet.octez.io" || /^\/(?:tezlink|michelson)(?:\/|$)/i.test(url.pathname)) {
    throw new Error("etherlink() accepts the EVM interface only; Michelson/Tezos RPC needs a separate client.");
  }
  if (host !== "node.mainnet.etherlink.com") return endpoint;
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    throw new Error("Etherlink has no public WebSocket endpoint on node.mainnet.etherlink.com. Supply a verified dedicated WebSocket URL.");
  }
  const known = ETHERLINK_MAINNET_REGISTRY[0]!;
  return {
    ...known,
    ...config,
    capabilities: {
      ...known.capabilities,
      ...config.capabilities,
      maxLogBlockRange: Math.min(config.capabilities?.maxLogBlockRange ?? ETHERLINK_PUBLIC_LIMITS.maxLogBlockRange, ETHERLINK_PUBLIC_LIMITS.maxLogBlockRange),
    },
  };
}
