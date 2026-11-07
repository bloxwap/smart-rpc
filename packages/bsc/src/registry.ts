import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

/** Official BNB Smart Chain mainnet dataseed. */
export const BSC_RPC_URL = "https://bsc-dataseed.bnbchain.org";

/** Published public allowance; this is shared by a provider/IP, not multiplied by URL. */
export const BSC_PUBLIC_RATE_LIMIT = { requests: 10_000, windowMs: 300_000 } as const;

/** Conservative local allowance below the documented public ceiling. */
export const BSC_PROVIDER_BUDGET = { rps: 10, burst: 20 } as const;

/** BSC-specific APIs require an explicitly configured capable provider. */
export const BSC_EXTENSION_METHODS: readonly string[] = [
  "eth_getHeaderByNumber",
  "eth_newFinalizedHeaderFilter",
  "eth_getFinalizedHeader",
  "eth_getFinalizedBlock",
  "eth_getBlobSidecarByTxHash",
  "eth_getBlobSidecars",
  "eth_health",
  "eth_getTransactionsByBlockNumber",
  "eth_getTransactionDataAndReceipt",
];

export interface BscPublicRpcEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
}

/**
 * Source-backed public dataseeds. No logs, archive, debug/trace, WebSocket,
 * batch, or safe/finalized-tag guarantee is inferred from chain compatibility.
 */
export const BSC_MAINNET_REGISTRY: readonly BscPublicRpcEndpoint[] = [
  ["bnb-dataseed", BSC_RPC_URL],
  ["bnb-public-dataseed", "https://bsc-dataseed-public.bnbchain.org"],
].map(([id, url]) => ({
  id: id!,
  url: url!,
  provider: "BNB Chain public dataseeds",
  sourceUrls: ["https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/"],
  reviewedAt: "2026-11-06",
  rps: 5,
  burst: 10,
  providerGroup: "bnb-public-dataseeds",
  providerBudget: BSC_PROVIDER_BUDGET,
  unsupportedMethods: ["eth_getLogs", ...BSC_EXTENSION_METHODS],
  capabilities: {
    archive: false,
    pinning: false,
    blockTags: ["latest", "pending"] as const,
    debug: false,
    trace: false,
    subscriptions: false,
    batch: false,
  },
}));

export const BSC_MAINNET_ENDPOINTS: readonly string[] = BSC_MAINNET_REGISTRY.map(({ url }) => url);
