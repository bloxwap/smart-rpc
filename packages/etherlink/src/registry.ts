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

/**
 * The 16 requests/second, burst 4 client budget stays below 1000/minute.
 * Unknown optional capabilities remain disabled until a provider is verified.
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
    reviewedAt: "2026-11-07",
    rps: 16,
    burst: 4,
    providerGroup: "etherlink-public",
    providerBudget: { rps: 16, burst: 4 },
    limits: ETHERLINK_PUBLIC_LIMITS,
    capabilities: {
      archive: false,
      blockTags: ["latest"],
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
    reviewedAt: "2026-11-07",
    rps: 16,
    burst: 4,
    providerGroup: "etherlink-ankr-public",
    providerBudget: { rps: 16, burst: 4 },
    limits: ETHERLINK_PUBLIC_LIMITS,
    capabilities: {
      archive: false,
      blockTags: ["latest"],
      pinning: false,
      batch: false,
      debug: false,
      trace: false,
      subscriptions: false,
      maxLogBlockRange: ETHERLINK_PUBLIC_LIMITS.maxLogBlockRange,
    },
  },
  {
    id: "etherlink-drpc-public",
    url: "https://etherlink.drpc.org",
    provider: "dRPC",
    sourceUrls: [
      "https://chainlist.org/chain/42793",
      "https://drpc.org/chainlist/etherlink-mainnet-rpc",
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
    rps: 16,
    burst: 4,
    providerGroup: "etherlink-drpc-public",
    providerBudget: { rps: 16, burst: 4 },
    limits: ETHERLINK_PUBLIC_LIMITS,
    capabilities: {
      archive: false,
      blockTags: ["latest"],
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
    reviewedAt: "2026-11-07",
    rps: 16,
    burst: 4,
    providerGroup: "etherlink-thirdweb-public",
    providerBudget: { rps: 16, burst: 4 },
    limits: ETHERLINK_PUBLIC_LIMITS,
    capabilities: {
      archive: false,
      blockTags: ["latest"],
      pinning: false,
      batch: false,
      debug: false,
      trace: false,
      subscriptions: false,
      maxLogBlockRange: ETHERLINK_PUBLIC_LIMITS.maxLogBlockRange,
    },
  },
];

export const ETHERLINK_MAINNET_ENDPOINTS: readonly string[] = ETHERLINK_MAINNET_REGISTRY.map(({ url }) => url);
