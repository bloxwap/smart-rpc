import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

/** Official public Base mainnet JSON-RPC endpoint. */
export const BASE_RPC_URL = "https://mainnet.base.org";

/** Submission only. This URL must not be used as a general-purpose pool endpoint. */
export const BASE_SEQUENCER_URL = "https://mainnet-sequencer.base.org";

/** Documentation-backed endpoint configuration; absent limits are unverified. */
export interface BasePublicRpcEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
}

const DRPC_FILTER_METHODS = [
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
] as const;

/**
 * Numeric `rps`/`burst` appear only where the operator publishes a keyless allowance
 * (Pocket); elsewhere supply your own traffic policy. Neither a quota nor an SLA is inferred.
 *
 * Capabilities were re-verified live on 2026-11-08. `archive: true` means historical state
 * back to genesis answered; `batch` was enabled where a 10-item JSON batch succeeded.
 * `maxBatchSize: 10` is the largest size verified across these providers (a 20-item batch
 * drew 429s from Tenderly on other chains), not a published provider maximum, except dRPC's
 * documented 3-item limit. Debug, trace, subscriptions and pinning remain disabled.
 */
export const BASE_MAINNET_REGISTRY: readonly BasePublicRpcEndpoint[] = [
  {
    id: "base-mainnet",
    url: BASE_RPC_URL,
    provider: "Base",
    sourceUrls: ["https://docs.base.org/get-started/connect-to-base", "https://chainlist.org/chain/8453"],
    reviewedAt: "2026-11-08",
    // Every eth_getLogs (including single-block queries) returned 429 -32011 "request limit
    // reached" across repeated runs, while other reads succeeded at 5 rps.
    unsupportedMethods: ["eth_getLogs"],
    capabilities: {
      batch: true,
      maxBatchSize: 10,
      archive: true,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
    },
  },
  {
    id: "base-publicnode",
    url: "https://base-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: ["https://base.publicnode.com/", "https://chainlist.org/chain/8453"],
    reviewedAt: "2026-11-08",
    // Deep historical state returns 403 "Archive requests require a personal token".
    capabilities: {
      batch: true,
      maxBatchSize: 10,
      archive: false,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
    },
  },
  {
    id: "base-drpc",
    url: "https://base.drpc.org",
    provider: "dRPC",
    sourceUrls: [
      "https://drpc.org/chainlist/base-mainnet-rpc",
      "https://drpc.org/docs/howitworks/ratelimiting",
      "https://chainlist.org/chain/8453",
    ],
    reviewedAt: "2026-11-08",
    unsupportedMethods: DRPC_FILTER_METHODS,
    // Documented 3-item batch limit; keyless eth_getLogs spans over ~101 blocks fail (code 35).
    capabilities: {
      batch: true,
      maxBatchSize: 3,
      maxLogBlockRange: 100,
      archive: true,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
    },
  },
  {
    id: "base-tenderly",
    url: "https://base.gateway.tenderly.co",
    provider: "Tenderly",
    sourceUrls: [
      "https://docs.tenderly.co/node-rpc/rpc-reference",
      "https://docs.tenderly.co/node-rpc/overview#public-endpoint-limits",
      "https://chainlist.org/chain/8453",
    ],
    reviewedAt: "2026-11-08",
    capabilities: {
      batch: true,
      maxBatchSize: 10,
      archive: true,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
    },
  },
  {
    id: "base-pocket",
    url: "https://base.api.pocket.network",
    provider: "Pocket Network",
    sourceUrls: ["https://docs.pocket.network/developers/supported-chains/", "https://chainlist.org/chain/8453"],
    reviewedAt: "2026-11-08",
    // Published: "2,000 requests per IP per minute" (about 33 per second).
    rps: 33,
    capabilities: {
      batch: true,
      maxBatchSize: 10,
      archive: true,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
    },
  },
];

export const BASE_MAINNET_ENDPOINTS: readonly string[] = BASE_MAINNET_REGISTRY.map(({ url }) => url);
