import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const OPTIMISM_RPC_URL = "https://mainnet.optimism.io";
/** Write-only endpoint, deliberately excluded from the general RPC pool. */
export const OPTIMISM_SEQUENCER_URL = "https://mainnet-sequencer.optimism.io";
/** Preconfirmation stream, not an Ethereum JSON-RPC WebSocket endpoint. */
export const OPTIMISM_SUBBLOCKS_URL = "wss://op-mainnet-fb-ws-pub.optimism.io/ws";

export interface OptimismPublicRpcEndpoint extends EthereumEndpointConfig {
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
 * Unknown provider quotas are not inferred; Pocket's published per-IP allowance is the only budget.
 * Capabilities were re-verified live on 2026-11-08: `batch` where a 10-item JSON batch succeeded
 * (10 is the official endpoint's advertised ceiling and the largest size verified elsewhere; dRPC
 * documents 3), and `archive` where historical state answered. Tenderly's archive starts at Bedrock.
 */
export const OPTIMISM_MAINNET_REGISTRY: readonly OptimismPublicRpcEndpoint[] = [
  {
    id: "optimism-mainnet",
    url: OPTIMISM_RPC_URL,
    provider: "Optimism",
    sourceUrls: ["https://docs.optimism.io/op-mainnet/network-information/connecting-to-op"],
    reviewedAt: "2026-11-08",
    // An 11+ item batch returns 413 -32014 "To send batches over 10 items, consider using a dedicated API provider".
    capabilities: {
      archive: true,
      batch: true,
      maxBatchSize: 10,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
    },
  },
  {
    id: "optimism-publicnode",
    url: "https://optimism-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: [
      "https://chainlist.org/chain/10",
      "https://www.publicnode.com/",
    ],
    reviewedAt: "2026-11-08",
    // Historical state returns 403 "Archive requests require a personal token".
    capabilities: {
      archive: false,
      batch: true,
      maxBatchSize: 10,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
    },
  },
  {
    id: "optimism-drpc",
    url: "https://optimism.drpc.org",
    provider: "dRPC",
    sourceUrls: [
      "https://chainlist.org/chain/10",
      "https://drpc.org/chainlist/optimism-mainnet-rpc",
      "https://drpc.org/docs/howitworks/ratelimiting",
    ],
    reviewedAt: "2026-11-08",
    // The 2026-11-08 benchmark saw only 429s here; re-probes at 1-5 rps were clean, matching dRPC's
    // documented regional free-tier reductions. Kept; the pool's breaker handles such windows.
    unsupportedMethods: DRPC_FILTER_METHODS,
    // Documented 3-item batch limit; keyless eth_getLogs spans over ~101 blocks fail (code 35).
    capabilities: {
      archive: true,
      batch: true,
      maxBatchSize: 3,
      maxLogBlockRange: 100,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
    },
  },
  {
    id: "optimism-pocket",
    url: "https://op.api.pocket.network",
    provider: "Pocket Network",
    sourceUrls: ["https://docs.pocket.network/developers/supported-chains/"],
    reviewedAt: "2026-11-08",
    // Published: "2,000 requests per IP per minute" (about 33 per second).
    rps: 33,
    // Historical state is inconsistent across its backends ("insufficient changesets").
    capabilities: {
      archive: false,
      batch: true,
      maxBatchSize: 10,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
    },
  },
  {
    id: "optimism-tenderly",
    url: "https://optimism.gateway.tenderly.co",
    provider: "Tenderly",
    sourceUrls: [
      "https://chainlist.org/chain/10",
      "https://docs.tenderly.co/node-rpc/rpc-reference",
      "https://docs.tenderly.co/node-rpc/overview#public-endpoint-limits",
    ],
    reviewedAt: "2026-11-08",
    capabilities: {
      archive: true,
      batch: true,
      maxBatchSize: 10,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
    },
  },
];

export const OPTIMISM_MAINNET_ENDPOINTS: readonly string[] = OPTIMISM_MAINNET_REGISTRY.map(({ url }) => url);
