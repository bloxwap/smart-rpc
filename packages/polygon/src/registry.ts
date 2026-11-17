import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const POLYGON_RPC_URL = "https://polygon.drpc.org";
/** Documented address, never synthesized from an HTTP URL. Opt in after testing the provider. */
export const POLYGON_WS_URL = "wss://polygon.drpc.org";
export const POLYGON_GAS_STATION_URL = "https://gasstation.polygon.technology/v2";

/** Standard public methods; Bor extensions require an explicit provider allowlist. */
export const POLYGON_PUBLIC_METHODS: readonly string[] = [
  "eth_chainId", "eth_blockNumber", "eth_syncing", "net_version", "web3_clientVersion",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount",
  "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
  "eth_getBlockByHash", "eth_getBlockByNumber", "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber", "eth_getTransactionByHash",
  "eth_getTransactionByBlockHashAndIndex", "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionReceipt", "eth_getLogs", "eth_sendRawTransaction",
];

export interface PolygonPublicEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
  readonly websocketUrl?: string;
}

/**
 * Officially listed public providers. Unverified advanced features are disabled;
 * numeric quotas and batch ceilings are deliberately absent until documented.
 * `archive` is enabled only where repeated live probes (2026-11-08: block 1 plus
 * five spread historical blocks, on separate runs) returned historical state.
 * ZAN (api.zan.top/polygon-mainnet) was removed on 2026-11-08: unregistered
 * callers receive HTTP 429 for every eth_getLogs and for ~25% of calls at 2 rps.
 */
export const POLYGON_MAINNET_REGISTRY: readonly PolygonPublicEndpoint[] = [
  {
    id: "polygon-drpc",
    provider: "dRPC",
    url: POLYGON_RPC_URL,
    websocketUrl: POLYGON_WS_URL,
    sourceUrls: ["https://drpc.org/chainlist/polygon-mainnet-rpc", "https://chainlist.org/chain/137"],
    reviewedAt: "2026-11-08",
    supportedMethods: POLYGON_PUBLIC_METHODS,
    unsupportedMethods: ["eth_newFilter", "eth_newBlockFilter", "eth_newPendingTransactionFilter", "eth_getFilterChanges", "eth_getFilterLogs", "eth_uninstallFilter"],
    capabilities: {
      archive: true, debug: false, trace: false, subscriptions: false,
      pinning: false, batch: false, blockTags: ["latest", "pending"],
    },
  },
  {
    id: "polygon-publicnode",
    provider: "Allnodes / PublicNode",
    url: "https://polygon-bor-rpc.publicnode.com",
    sourceUrls: ["https://polygon.publicnode.com/", "https://chainlist.org/chain/137"],
    reviewedAt: "2026-11-08",
    supportedMethods: POLYGON_PUBLIC_METHODS,
    capabilities: {
      archive: false, debug: false, trace: false, subscriptions: false,
      pinning: false, batch: false, blockTags: ["latest", "pending"],
    },
  },
  {
    id: "polygon-tenderly",
    provider: "Tenderly",
    url: "https://polygon.gateway.tenderly.co",
    sourceUrls: ["https://docs.tenderly.co/node-rpc/rpc-reference", "https://chainlist.org/chain/137"],
    reviewedAt: "2026-11-08",
    supportedMethods: POLYGON_PUBLIC_METHODS,
    capabilities: {
      archive: true, debug: false, trace: false, subscriptions: false,
      pinning: false, batch: false, blockTags: ["latest", "pending"],
    },
  },
  {
    id: "polygon-pocket",
    provider: "Pocket Network",
    url: "https://poly.api.pocket.network",
    sourceUrls: ["https://api.pocket.network/docs/polygon", "https://chainlist.org/chain/137"],
    reviewedAt: "2026-11-08",
    supportedMethods: POLYGON_PUBLIC_METHODS,
    capabilities: {
      archive: false, debug: false, trace: false, subscriptions: false,
      pinning: false, batch: false, blockTags: ["latest", "pending"],
    },
  },
  {
    id: "polygon-quicknode",
    provider: "QuickNode",
    url: "https://rpc-mainnet.matic.quiknode.pro",
    sourceUrls: ["https://docs.polygon.technology/pos/reference/rpc-endpoints/", "https://chainlist.org/chain/137"],
    reviewedAt: "2026-11-08",
    supportedMethods: POLYGON_PUBLIC_METHODS,
    capabilities: {
      archive: true, debug: false, trace: false, subscriptions: false,
      pinning: false, batch: false, blockTags: ["latest", "pending"],
    },
  },
];

export const POLYGON_MAINNET_ENDPOINTS: readonly string[] = POLYGON_MAINNET_REGISTRY.map(({ url }) => url);
