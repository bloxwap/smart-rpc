import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const ETHERLINK_RPC_URL = "https://node.mainnet.etherlink.com";
/** Restricted to eth_sendRawTransaction and eth_blockNumber; not a pool endpoint. */
export const ETHERLINK_RELAY_URL = "https://relay.mainnet.etherlink.com";

/** Documented Etherlink ceilings, reused as conservative default-pool limits. */
export const ETHERLINK_PUBLIC_LIMITS = {
  requestsPerMinute: 1_000,
  maxLogBlockRange: 500,
  maxLogResults: 5_000,
} as const;

export interface EtherlinkPublicRpcEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
  readonly limits: typeof ETHERLINK_PUBLIC_LIMITS;
}

/** Disabled (-32075 "Method disabled") on every keyless endpoint in live probes. */
const DISABLED_FILTER_METHODS = [
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
] as const;

/** Filters plus eth_getProof, which returns -32004 "Method not supported" everywhere. */
const UNSUPPORTED_METHODS: readonly string[] = [...DISABLED_FILTER_METHODS, "eth_getProof"];

/**
 * Etherlink nodes reject `safe` with terminal -32600, and answer `finalized`,
 * `pending` and `earliest` for blocks and state (live probes 2026-11-08).
 */
const VERIFIED_BLOCK_TAGS = ["latest", "pending", "finalized", "earliest"] as const;

/**
 * The 16 requests/second, burst 4 client budget stays below 1000/minute.
 * `archive` is true only where state at block 1 was served in live probes.
 * Other optional capabilities stay disabled until a provider is verified.
 *
 * dRPC (`etherlink.drpc.org`) was removed on 2026-11-08. Its reported head froze
 * for about 25 seconds at a time, reaching 21 blocks behind, in three separate
 * runs. Its free tier also rejects batches larger than 3 and log ranges over
 * about 100 blocks.
 */
export const ETHERLINK_MAINNET_REGISTRY: readonly EtherlinkPublicRpcEndpoint[] = [
  {
    id: "etherlink-mainnet",
    url: ETHERLINK_RPC_URL,
    provider: "Etherlink",
    sourceUrls: [
      "https://docs.etherlink.com/evm/get-started/network-information/",
      "https://docs.etherlink.com/evm/tools/node-providers/",
      "https://chainlist.org/chain/42793",
    ],
    reviewedAt: "2026-11-08",
    unsupportedMethods: UNSUPPORTED_METHODS,
    rps: 16,
    burst: 4,
    providerGroup: "etherlink-public",
    providerBudget: { rps: 16, burst: 4 },
    limits: ETHERLINK_PUBLIC_LIMITS,
    capabilities: {
      archive: true,
      blockTags: VERIFIED_BLOCK_TAGS,
      pinning: false,
      batch: false,
      debug: false,
      trace: false,
      subscriptions: false,
      maxLogBlockRange: ETHERLINK_PUBLIC_LIMITS.maxLogBlockRange,
    },
  },
  {
    id: "etherlink-ankr-public",
    url: "https://rpc.ankr.com/etherlink_mainnet",
    provider: "Ankr",
    sourceUrls: [
      "https://chainlist.org/chain/42793",
      "https://www.ankr.com/docs/rpc-service/chains/chains-api/etherlink/",
    ],
    reviewedAt: "2026-11-08",
    unsupportedMethods: UNSUPPORTED_METHODS,
    rps: 16,
    burst: 4,
    providerGroup: "etherlink-ankr-public",
    providerBudget: { rps: 16, burst: 4 },
    limits: ETHERLINK_PUBLIC_LIMITS,
    capabilities: {
      archive: true,
      blockTags: VERIFIED_BLOCK_TAGS,
      pinning: false,
      batch: false,
      debug: false,
      trace: false,
      subscriptions: false,
      maxLogBlockRange: ETHERLINK_PUBLIC_LIMITS.maxLogBlockRange,
    },
  },
  {
    id: "etherlink-thirdweb-public",
    url: "https://42793.rpc.thirdweb.com",
    provider: "thirdweb",
    sourceUrls: [
      "https://thirdweb.com/etherlink",
      "https://portal.thirdweb.com/infrastructure/rpc-edge/overview",
    ],
    reviewedAt: "2026-11-08",
    unsupportedMethods: UNSUPPORTED_METHODS,
    rps: 16,
    burst: 4,
    providerGroup: "etherlink-thirdweb-public",
    providerBudget: { rps: 16, burst: 4 },
    limits: ETHERLINK_PUBLIC_LIMITS,
    capabilities: {
      // Historical state calls hit its public-good rate limit, so archive is unverified.
      archive: false,
      blockTags: VERIFIED_BLOCK_TAGS,
      pinning: false,
      batch: false,
      debug: false,
      trace: false,
      subscriptions: false,
      // Its own -32005 reply: "Maximum allowed number of requested blocks is 112".
      maxLogBlockRange: 100,
    },
  },
];

export const ETHERLINK_MAINNET_ENDPOINTS: readonly string[] = ETHERLINK_MAINNET_REGISTRY.map(({ url }) => url);
