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
export const MANTLE_MAINNET_REGISTRY: readonly MantlePublicRpcEndpoint[] = [
  {
    id: "mantle-mainnet",
    url: MANTLE_RPC_URL,
    provider: "Mantle",
    sourceUrls: [
      "https://docs.mantle.xyz/network/for-developers/quick-access",
      "https://docs.mantle.xyz/network/for-developers/resources-and-tooling/mantle-api",
    ],
    reviewedAt: "2026-11-07",
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
  },
  {
    id: "mantle-publicnode",
    url: "https://mantle-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: [
      "https://chainlist.org/chain/5000",
      "https://mantle.publicnode.com/",
    ],
    reviewedAt: "2026-11-07",
    capabilities: {
      archive: false,
      blockTags: ["latest", "pending"],
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: false,
    },
  },
  {
    id: "mantle-drpc",
    url: "https://mantle.drpc.org",
    provider: "dRPC",
    sourceUrls: [
      "https://chainlist.org/chain/5000",
      "https://drpc.org/chainlist/mantle-mainnet-rpc",
      "https://drpc.org/docs/howitworks/ratelimiting",
    ],
    reviewedAt: "2026-11-07",
    unsupportedMethods: [
      "eth_newFilter",
      "eth_newBlockFilter",
      "eth_newPendingTransactionFilter",
      "eth_getFilterChanges",
      "eth_getFilterLogs",
      "eth_uninstallFilter",
    ],
    capabilities: {
      archive: false,
      blockTags: ["latest", "pending"],
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: false,
    },
  },
  {
    id: "mantle-pocket",
    url: "https://mantle.api.pocket.network",
    provider: "Pocket Network",
    sourceUrls: [
      "https://chainlist.org/chain/5000",
      "https://pocket.network/foundation-partnerships/",
    ],
    reviewedAt: "2026-11-07",
    capabilities: {
      archive: false,
      blockTags: ["latest", "pending"],
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: false,
    },
  },
  {
    id: "mantle-thirdweb",
    url: "https://5000.rpc.thirdweb.com",
    provider: "thirdweb",
    sourceUrls: [
      "https://chainlist.org/chain/5000",
      "https://portal.thirdweb.com/infrastructure/rpc-edge/overview",
    ],
    reviewedAt: "2026-11-07",
    capabilities: {
      archive: false,
      blockTags: ["latest", "pending"],
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: false,
    },
  },
];

export const MANTLE_MAINNET_ENDPOINTS: readonly string[] = MANTLE_MAINNET_REGISTRY.map(({ url }) => url);
