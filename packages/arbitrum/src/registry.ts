/** Arbitrum One execution RPC, separate from the sequencer and its feed. */
export const ARBITRUM_RPC_URL = "https://arb1.arbitrum.io/rpc";
/** Write-only endpoint; it cannot verify chain identity or serve pool health probes. */
export const ARBITRUM_SEQUENCER_URL = "https://arb1-sequencer.arbitrum.io/rpc";
/** Nitro feed protocol, not a JSON-RPC WebSocket endpoint. */
export const ARBITRUM_SEQUENCER_FEED_URL = "wss://arb1-feed.arbitrum.io/feed";

/**
 * No provider rate or batch ceiling is asserted: the public service publishes none.
 * Unverified optional features are disabled; configure a tested provider to enable them.
 */
export const ARBITRUM_MAINNET_REGISTRY = Object.freeze([
  Object.freeze({
    id: "arbitrum-public",
    url: ARBITRUM_RPC_URL,
    provider: "Offchain Labs",
    sourceUrls: ["https://docs.arbitrum.io/chain-info"] as const,
    reviewedAt: "2026-11-07",
    ipv6: false,
    capabilities: Object.freeze({
      subscriptions: false,
      batch: false,
      archive: false,
      debug: false,
      trace: false,
      pinning: false,
      blockTags: ["latest", "pending"] as const,
    }),
  }),
  Object.freeze({
    id: "arbitrum-publicnode",
    url: "https://arbitrum-one-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: [
      "https://chainlist.org/chain/42161",
      "https://www.publicnode.com/",
    ] as const,
    reviewedAt: "2026-11-07",
    ipv6: false,
    capabilities: Object.freeze({
      subscriptions: false,
      batch: false,
      archive: false,
      debug: false,
      trace: false,
      pinning: false,
      blockTags: ["latest", "pending"] as const,
    }),
  }),
  Object.freeze({
    id: "arbitrum-drpc",
    url: "https://arbitrum.drpc.org",
    provider: "dRPC",
    sourceUrls: [
      "https://chainlist.org/chain/42161",
      "https://drpc.org/chainlist/arbitrum-mainnet-rpc",
    ] as const,
    reviewedAt: "2026-11-07",
    ipv6: false,
    unsupportedMethods: [
      "eth_newFilter",
      "eth_newBlockFilter",
      "eth_newPendingTransactionFilter",
      "eth_getFilterChanges",
      "eth_getFilterLogs",
      "eth_uninstallFilter",
    ],
    capabilities: Object.freeze({
      subscriptions: false,
      batch: false,
      archive: false,
      debug: false,
      trace: false,
      pinning: false,
      blockTags: ["latest", "pending"] as const,
    }),
  }),
  Object.freeze({
    id: "arbitrum-pocket",
    url: "https://arb-one.api.pocket.network",
    provider: "Pocket Network",
    sourceUrls: ["https://docs.pocket.network/developers/supported-chains/"] as const,
    reviewedAt: "2026-11-07",
    ipv6: false,
    capabilities: Object.freeze({
      subscriptions: false,
      batch: false,
      archive: false,
      debug: false,
      trace: false,
      pinning: false,
      blockTags: ["latest", "pending"] as const,
    }),
  }),
  Object.freeze({
    id: "arbitrum-tenderly",
    url: "https://arbitrum.gateway.tenderly.co",
    provider: "Tenderly",
    sourceUrls: [
      "https://chainlist.org/chain/42161",
      "https://docs.tenderly.co/node-rpc/rpc-reference",
    ] as const,
    reviewedAt: "2026-11-07",
    ipv6: false,
    capabilities: Object.freeze({
      subscriptions: false,
      batch: false,
      archive: false,
      debug: false,
      trace: false,
      pinning: false,
      blockTags: ["latest", "pending"] as const,
    }),
  }),
]);

export const ARBITRUM_MAINNET_ENDPOINTS: readonly string[] = Object.freeze(
  ARBITRUM_MAINNET_REGISTRY.map(({ url }) => url),
);
