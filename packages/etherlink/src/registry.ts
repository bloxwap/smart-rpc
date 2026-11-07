import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const ETHERLINK_RPC_URL = "https://node.mainnet.etherlink.com";
/** Restricted to eth_sendRawTransaction and eth_blockNumber; not a pool endpoint. */
export const ETHERLINK_RELAY_URL = "https://relay.mainnet.etherlink.com";

/** Documented public-provider ceilings, not network-wide rules. */
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
    ],
    reviewedAt: "2026-11-06",
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
];

export const ETHERLINK_MAINNET_ENDPOINTS: readonly string[] = ETHERLINK_MAINNET_REGISTRY.map(({ url }) => url);
