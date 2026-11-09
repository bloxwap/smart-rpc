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

const chainList = "https://chainlist.org/chain/56";
const networkDocs = "https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/";

/**
 * Source-backed public HTTPS defaults. Optional capabilities are not inferred from chain compatibility.
 * `archive` is enabled only where repeated live probes (2026-11-08: block 1 plus five spread
 * historical blocks, on separate runs) returned historical state. Pocket answered those on BSC
 * but not consistently on its other chains' supplier sets, so it stays disabled there.
 */
export const BSC_MAINNET_REGISTRY: readonly BscPublicRpcEndpoint[] = [
  ...[
    ["bnb-dataseed", BSC_RPC_URL],
    ["bnb-public-dataseed", "https://bsc-dataseed-public.bnbchain.org"],
  ].map(([id, url]) => ({
    id: id!,
    url: url!,
    provider: "BNB Chain public dataseeds",
    sourceUrls: [networkDocs, chainList],
    reviewedAt: "2026-11-08",
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
  })),
  {
    id: "bsc-publicnode",
    url: "https://bsc-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: [networkDocs, chainList, "https://bsc.publicnode.com/"],
    reviewedAt: "2026-11-08",
    unsupportedMethods: [...BSC_EXTENSION_METHODS],
    capabilities: {
      archive: false,
      pinning: false,
      blockTags: ["latest", "pending"] as const,
      debug: false,
      trace: false,
      subscriptions: false,
      batch: false,
    },
  },
  {
    id: "bsc-thirdweb",
    url: "https://56.rpc.thirdweb.com",
    provider: "thirdweb",
    sourceUrls: [networkDocs, chainList, "https://portal.thirdweb.com/infrastructure/rpc-edge/overview"],
    reviewedAt: "2026-11-08",
    unsupportedMethods: [...BSC_EXTENSION_METHODS],
    capabilities: {
      archive: true,
      pinning: false,
      blockTags: ["latest", "pending"] as const,
      debug: false,
      trace: false,
      subscriptions: false,
      batch: false,
    },
  },
  {
    id: "bsc-pocket",
    url: "https://bsc.api.pocket.network",
    provider: "Pocket Network",
    sourceUrls: [networkDocs, chainList, "https://api.pocket.network/"],
    reviewedAt: "2026-11-08",
    // eth_getLogs without an address returned -32602 "missing required field 'address'"
    // on 9/9 calls (1-50 blocks) across three 2026-11-08 runs. That code is terminal, so
    // it would reach the caller instead of failing over; thirdweb and PublicNode serve logs.
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
  },
];

export const BSC_MAINNET_ENDPOINTS: readonly string[] = BSC_MAINNET_REGISTRY.map(({ url }) => url);
