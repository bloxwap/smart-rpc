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
    reviewedAt: "2026-11-06",
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
