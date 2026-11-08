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
 * Public access is documented, but no numeric quota or archive/finality SLA is published.
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
    reviewedAt: "2026-11-07",
    capabilities: {
      archive: false,
      pinning: false,
      batch: false,
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
    reviewedAt: "2026-11-07",
    capabilities: {
      archive: false,
      pinning: false,
      batch: false,
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
    ],
    reviewedAt: "2026-11-07",
    capabilities: {
      archive: false,
      pinning: false,
      batch: false,
      debug: false,
      trace: false,
      subscriptions: false,
      blockTags: ["latest", "pending"],
    },
  },
  {
    url: "https://4663.rpc.thirdweb.com",
    provider: "thirdweb",
    sourceUrls: [
      "https://chainlist.org/chain/4663",
      "https://thirdweb.com/robinhood-chain",
    ],
    reviewedAt: "2026-11-07",
    capabilities: {
      archive: false,
      pinning: false,
      batch: false,
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
      pinning: false,
      batch: false,
      debug: false,
      trace: false,
      subscriptions: false,
      blockTags: ["latest", "pending"],
    },
  },
] as const satisfies readonly RobinhoodRpcEndpoint[];

export const ROBINHOOD_MAINNET_ENDPOINTS: readonly string[] = ROBINHOOD_MAINNET_REGISTRY.map(({ url }) => url);
