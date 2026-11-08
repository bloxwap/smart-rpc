import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_MAINNET_CAIP = "eip155:4663";
export const ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const ROBINHOOD_NATIVE_CURRENCY = { name: "Ether", symbol: "ETH", decimals: 18 } as const;

/** Infrastructure roles from the official docs. Only `rpc` belongs in the read pool. */
export const ROBINHOOD_INFRASTRUCTURE = {
  rpc: ROBINHOOD_RPC_URL,
  sequencer: "https://sequencer.mainnet.chain.robinhood.com",
  feed: "wss://feed.mainnet.chain.robinhood.com",
  delayedFeed: "wss://delayed-feed.mainnet.chain.robinhood.com",
} as const;

export interface RobinhoodRpcEndpoint extends EthereumEndpointConfig {
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
}

/**
 * Public access is documented, but the official endpoint publishes no numeric quota or
 * archive/finality SLA. Only Pocket's gateway publishes a keyless allowance.
 * Capabilities were re-verified live on 2026-11-08: `batch` where a 20-item JSON batch
 * succeeded, capped at 10 for consistency with the other registries (dRPC documents 3);
 * `archive` only where historical state answered consistently across repeated probes.
 * safe/finalized stay disabled: Pocket's `safe` head trailed its `finalized` head during review.
 * False capabilities are conservative client restrictions, not claims about the whole chain.
 */
export const ROBINHOOD_MAINNET_REGISTRY = [
  {
    url: ROBINHOOD_RPC_URL,
    provider: "Robinhood Chain",
    sourceUrls: [
      "https://docs.robinhood.com/chain/connecting/",
      "https://chainlist.org/chain/4663",
    ],
    reviewedAt: "2026-11-08",
    // Full node: historical state returns "historical state ... is not available".
    capabilities: {
      archive: false,
      pinning: false,
      batch: true,
      maxBatchSize: 10,
      debug: false,
      trace: false,
      subscriptions: false,
      blockTags: ["latest", "pending"],
    },
  },
  {
    url: "https://robinhood-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: [
      "https://chainlist.org/chain/4663",
      "https://www.publicnode.com/",
    ],
    reviewedAt: "2026-11-08",
    // State or logs older than roughly 60-100 blocks return 403 "Archive requests require a personal token".
    capabilities: {
      archive: false,
      pinning: false,
      batch: true,
      maxBatchSize: 10,
      debug: false,
      trace: false,
      subscriptions: false,
      blockTags: ["latest", "pending"],
    },
  },
  {
    url: "https://robinhood.api.pocket.network",
    provider: "POKT Network",
    sourceUrls: [
      "https://chainlist.org/chain/4663",
      "https://www.pokt.network/",
      "https://docs.pocket.network/developers/supported-chains/",
    ],
    reviewedAt: "2026-11-08",
    // The api.pocket.network gateway publishes "2,000 requests per IP per minute" (about 33 per second).
    // That docs page states the gateway-wide limit but does not itself list Robinhood (Chainlist does).
    rps: 33,
    capabilities: {
      archive: true,
      pinning: false,
      batch: true,
      maxBatchSize: 10,
      debug: false,
      trace: false,
      subscriptions: false,
      blockTags: ["latest", "pending"],
    },
  },
  {
    // Replaced 4663.rpc.thirdweb.com on 2026-11-08: thirdweb trailed the head by ~7 blocks
    // (same as the official RPC), returned sporadic HTTP 429s at 4-5 rps, and ran ~150 ms p50.
    // GlobalStake answered at ~77 ms p50, usually within 1-2 blocks of the head, with no errors at 5 rps.
    url: "https://rpc-robinhood.globalstake.io",
    provider: "GlobalStake",
    sourceUrls: [
      "https://chainlist.org/chain/4663",
      "https://docs.robinhood.com/chain/connecting/",
    ],
    reviewedAt: "2026-11-08",
    capabilities: {
      archive: false,
      pinning: false,
      batch: true,
      maxBatchSize: 10,
      debug: false,
      trace: false,
      subscriptions: false,
      blockTags: ["latest", "pending"],
    },
  },
  {
    url: "https://robinhood.drpc.org",
    provider: "dRPC",
    sourceUrls: [
      "https://drpc.org/chainlist/robinhood-mainnet-rpc",
      "https://docs.robinhood.com/chain/connecting/",
      "https://drpc.org/docs/howitworks/ratelimiting",
    ],
    reviewedAt: "2026-11-08",
    unsupportedMethods: [
      "eth_newFilter",
      "eth_newBlockFilter",
      "eth_newPendingTransactionFilter",
      "eth_getFilterChanges",
      "eth_getFilterLogs",
      "eth_uninstallFilter",
    ],
    // Historical state alternated between answers and "Unknown state", so archive stays off.
    // Documented 3-item batch limit; keyless eth_getLogs spans over ~101 blocks fail (code 35).
    capabilities: {
      archive: false,
      pinning: false,
      batch: true,
      maxBatchSize: 3,
      maxLogBlockRange: 100,
      debug: false,
      trace: false,
      subscriptions: false,
      blockTags: ["latest", "pending"],
    },
  },
] as const satisfies readonly RobinhoodRpcEndpoint[];

export const ROBINHOOD_MAINNET_ENDPOINTS: readonly string[] = ROBINHOOD_MAINNET_REGISTRY.map(({ url }) => url);
