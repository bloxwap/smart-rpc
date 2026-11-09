/** Arbitrum One execution RPC, separate from the sequencer and its feed. */
export const ARBITRUM_RPC_URL = "https://arb1.arbitrum.io/rpc";
/** Write-only endpoint; it cannot verify chain identity or serve pool health probes. */
export const ARBITRUM_SEQUENCER_URL = "https://arb1-sequencer.arbitrum.io/rpc";
/** Nitro feed protocol, not a JSON-RPC WebSocket endpoint. */
export const ARBITRUM_SEQUENCER_FEED_URL = "wss://arb1-feed.arbitrum.io/feed";

const DRPC_FILTER_METHODS = Object.freeze([
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
] as const);

/**
 * Numeric rate limits appear only where an operator publishes a keyless allowance (Pocket).
 * Capabilities were re-verified live on 2026-11-08: `batch` where a 10-item JSON batch
 * succeeded (10 is the largest size verified across providers, not a published maximum,
 * except dRPC's documented 3-item limit), and `archive` where post-Nitro historical state
 * answered. Pre-Nitro (classic) state is unavailable from every public endpoint here.
 * safe/finalized stay disabled: providers disagreed on the `safe` head during review.
 */
export const ARBITRUM_MAINNET_REGISTRY = Object.freeze([
  Object.freeze({
    id: "arbitrum-public",
    url: ARBITRUM_RPC_URL,
    provider: "Offchain Labs",
    sourceUrls: ["https://docs.arbitrum.io/chain-info"] as const,
    reviewedAt: "2026-11-08",
    ipv6: false,
    // Full node: historical state returns "missing trie node".
    capabilities: Object.freeze({
      subscriptions: false,
      batch: true,
      maxBatchSize: 10,
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
    reviewedAt: "2026-11-08",
    ipv6: false,
    // State or logs older than roughly 60-100 blocks return 403 "Archive requests require a personal token".
    capabilities: Object.freeze({
      subscriptions: false,
      batch: true,
      maxBatchSize: 10,
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
      "https://drpc.org/docs/howitworks/ratelimiting",
    ] as const,
    reviewedAt: "2026-11-08",
    ipv6: false,
    unsupportedMethods: DRPC_FILTER_METHODS,
    // Numeric-block state returned "Unknown state" even 1,000 blocks back, so archive stays off.
    capabilities: Object.freeze({
      subscriptions: false,
      batch: true,
      maxBatchSize: 3,
      maxLogBlockRange: 100,
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
    reviewedAt: "2026-11-08",
    ipv6: false,
    // Published: "2,000 requests per IP per minute" (about 33 per second).
    rps: 33,
    capabilities: Object.freeze({
      subscriptions: false,
      batch: true,
      maxBatchSize: 10,
      archive: true,
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
      "https://docs.tenderly.co/node-rpc/overview#public-endpoint-limits",
    ] as const,
    reviewedAt: "2026-11-08",
    ipv6: false,
    capabilities: Object.freeze({
      subscriptions: false,
      batch: true,
      maxBatchSize: 10,
      archive: true,
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
