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
  /** Documented WebSocket URLs; empty when the operator documents none. */
  readonly websocketUrls: readonly string[];
}

const sources = [
  "https://docs.inkonchain.com/general/network-information",
  "https://docs.inkonchain.com/tools/rpc",
] as const;

/**
 * HTTP defaults, re-verified live on 2026-11-08. Every listed provider served historical
 * state back to genesis (`archive: true`) and a 10-item JSON batch (`batch: true`).
 * `maxBatchSize: 10` is the largest size verified across them (Tenderly answered a 20-item
 * batch with 429), not a published maximum. Debug, trace, subscriptions, numeric pinning
 * and safe/finalized tags stay disabled: providers disagreed on the finalized head.
 * Only Pocket publishes a numeric keyless allowance; no other request quota is asserted.
 */
export const INK_MAINNET_REGISTRY = [
  {
    url: INK_RPC_URL,
    provider: "Gelato",
    sourceUrls: [...sources, "https://chainlist.org/chain/57073"],
    reviewedAt: "2026-11-08",
    // The RPC guide and network table document different Gelato WS hostnames.
    websocketUrls: ["wss://ws-gel.inkonchain.com", "wss://rpc-gel.inkonchain.com"],
    capabilities: {
      archive: true,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: true,
      maxBatchSize: 10,
      blockTags: ["latest", "pending"],
    },
  },
  {
    url: INK_SECONDARY_RPC_URL,
    provider: "QuickNode",
    sourceUrls: [...sources, "https://chainlist.org/chain/57073"],
    reviewedAt: "2026-11-08",
    websocketUrls: ["wss://rpc-qnd.inkonchain.com"],
    capabilities: {
      archive: true,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: true,
      maxBatchSize: 10,
      blockTags: ["latest", "pending"],
    },
  },
  {
    url: "https://rpc-ten.inkonchain.com",
    provider: "Tenderly",
    sourceUrls: [...sources, "https://docs.tenderly.co/node-rpc/overview#public-endpoint-limits"],
    reviewedAt: "2026-11-08",
    websocketUrls: ["wss://rpc-ten.inkonchain.com"],
    capabilities: {
      archive: true,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: true,
      maxBatchSize: 10,
      blockTags: ["latest", "pending"],
    },
  },
  {
    url: "https://ink-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: ["https://ink.publicnode.com/", "https://chainlist.org/chain/57073"],
    reviewedAt: "2026-11-08",
    websocketUrls: ["wss://ink-rpc.publicnode.com"],
    capabilities: {
      archive: true,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: true,
      maxBatchSize: 10,
      blockTags: ["latest", "pending"],
    },
  },
  {
    // Replaced ink.drpc.org on 2026-11-08: its keyless reads ran ~350 ms p50 and returned
    // HTTP 500 "Temporary internal error" on ~17% of plain reads and ~40% of eth_getLogs.
    url: "https://ink.api.pocket.network",
    provider: "Pocket Network",
    sourceUrls: ["https://docs.pocket.network/developers/supported-chains/", "https://chainlist.org/chain/57073"],
    reviewedAt: "2026-11-08",
    // Published: "2,000 requests per IP per minute" (about 33 per second).
    rps: 33,
    websocketUrls: [],
    capabilities: {
      archive: true,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: true,
      maxBatchSize: 10,
      blockTags: ["latest", "pending"],
    },
  },
] as const satisfies readonly InkPublicEndpoint[];

export const INK_MAINNET_ENDPOINTS: readonly string[] = INK_MAINNET_REGISTRY.map(({ url }) => url);
