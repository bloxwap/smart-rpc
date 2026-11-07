import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const MANTLE_RPC_URL = "https://rpc.mantle.xyz";
/** Exact documented address; not a scheme rewrite of the HTTP endpoint. */
export const MANTLE_MAINNET_WS_URL = "wss://wss.mantle.xyz";

export interface MantlePublicRpcEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
}

/** Unknown numeric limits are omitted. Advanced capabilities require explicit opt-in. */
export const MANTLE_MAINNET_REGISTRY: readonly MantlePublicRpcEndpoint[] = [{
  id: "mantle-mainnet",
  url: MANTLE_RPC_URL,
  provider: "Mantle",
  sourceUrls: [
    "https://docs.mantle.xyz/network/for-developers/quick-access",
    "https://docs.mantle.xyz/network/for-developers/resources-and-tooling/mantle-api",
  ],
  reviewedAt: "2026-11-06",
  unsupportedMethods: ["eth_getBlockRange", "eth_sendTransaction"],
  capabilities: {
    archive: false,
    blockTags: ["latest", "pending"],
    debug: false,
    trace: false,
    subscriptions: false,
    pinning: false,
    batch: false,
  },
}];

export const MANTLE_MAINNET_ENDPOINTS: readonly string[] = MANTLE_MAINNET_REGISTRY.map(({ url }) => url);
