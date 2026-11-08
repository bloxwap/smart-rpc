import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const INK_RPC_URL = "https://rpc-gel.inkonchain.com";
export const INK_SECONDARY_RPC_URL = "https://rpc-qnd.inkonchain.com";
/** A preconfirmation stream, deliberately excluded from RPC pools. */
export const INK_SUBBLOCKS_URL = "wss://subblocks.inkonchain.com/ws";

/** Documented URLs, not a guarantee of subscription or archive service. */
export interface InkPublicEndpoint extends EthereumEndpointConfig {
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
  readonly websocketUrls: readonly string[];
}

const sources = [
  "https://docs.inkonchain.com/general/network-information",
  "https://docs.inkonchain.com/tools/rpc",
] as const;

/**
 * HTTP defaults. Advanced capabilities are opt-in after testing a provider.
 * No provider-wide numeric request or JSON batch maximum is documented here.
 */
export const INK_MAINNET_REGISTRY = [
  {
    url: INK_RPC_URL,
    provider: "Gelato",
    sourceUrls: [...sources, "https://chainlist.org/chain/57073"],
    reviewedAt: "2026-11-07",
    // The RPC guide and network table document different Gelato WS hostnames.
    websocketUrls: ["wss://ws-gel.inkonchain.com", "wss://rpc-gel.inkonchain.com"],
    capabilities: {
      archive: false,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: false,
      blockTags: ["latest", "pending"],
    },
  },
  {
    url: INK_SECONDARY_RPC_URL,
    provider: "QuickNode",
    sourceUrls: [...sources, "https://chainlist.org/chain/57073"],
    reviewedAt: "2026-11-07",
    websocketUrls: ["wss://rpc-qnd.inkonchain.com"],
    capabilities: {
      archive: false,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: false,
      blockTags: ["latest", "pending"],
    },
  },
  {
    url: "https://rpc-ten.inkonchain.com",
    provider: "Tenderly",
    sourceUrls: sources,
    reviewedAt: "2026-11-07",
    websocketUrls: ["wss://rpc-ten.inkonchain.com"],
    capabilities: {
      archive: false,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: false,
      blockTags: ["latest", "pending"],
    },
  },
  {
    url: "https://ink.drpc.org",
    provider: "dRPC",
    sourceUrls: [...sources, "https://chainlist.org/chain/57073"],
    reviewedAt: "2026-11-07",
    websocketUrls: ["wss://ink.drpc.org"],
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
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: false,
      blockTags: ["latest", "pending"],
    },
  },
  {
    url: "https://ink-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: ["https://ink.publicnode.com/", "https://chainlist.org/chain/57073"],
    reviewedAt: "2026-11-07",
    websocketUrls: ["wss://ink-rpc.publicnode.com"],
    capabilities: {
      archive: false,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: false,
      blockTags: ["latest", "pending"],
    },
  },
] as const satisfies readonly InkPublicEndpoint[];

export const INK_MAINNET_ENDPOINTS: readonly string[] = INK_MAINNET_REGISTRY.map(({ url }) => url);
