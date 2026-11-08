import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const XLAYER_RPC_URL = "https://rpc.xlayer.tech";
export const XLAYER_ALTERNATE_RPC_URL = "https://xlayerrpc.okx.com";

/** Documented public ceiling shared by the official URLs, per IP address. */
export const XLAYER_PUBLIC_RPC_BUDGET = { rps: 100, burst: 100 } as const;
export const XLAYER_PUBLIC_PROVIDER_GROUP = "xlayer-public";

/** Published URLs, not automatic pool members or a subscription capability promise. */
export const XLAYER_MAINNET_WEBSOCKET_ENDPOINTS = [
  "wss://xlayerws.okx.com",
  "wss://ws.xlayer.tech",
] as const;

/** Documented EVM methods; debug requests also require the endpoint's debug capability. */
export const XLAYER_PUBLIC_METHODS: readonly string[] = [
  "web3_clientVersion", "web3_sha3", "net_version", "eth_protocolVersion", "eth_syncing",
  "eth_gasPrice", "eth_blockNumber", "eth_chainId", "eth_getBalance", "eth_getStorageAt",
  "eth_getTransactionCount", "eth_getBlockTransactionCountByNumber", "eth_getBlockTransactionCountByHash",
  "eth_getCode", "eth_sign", "eth_sendTransaction", "eth_sendRawTransaction", "eth_call", "eth_estimateGas",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionByHash",
  "eth_getTransactionByBlockHashAndIndex", "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionReceipt", "eth_newFilter", "eth_newBlockFilter", "eth_uninstallFilter",
  "eth_getFilterChanges", "eth_getLogs", "eth_getFilterLogs", "eth_getCompilers",
  "eth_getUncleCountByBlockHash", "eth_getUncleCountByBlockNumber", "eth_getUncleByBlockHashAndIndex",
  "eth_getUncleByBlockNumberAndIndex", "debug_traceBlockByHash", "debug_traceBlockByNumber",
  "debug_traceTransaction", "txpool_content",
];

export interface XLayerPublicEndpoint extends EthereumEndpointConfig {
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
}

/** Conservative client settings; unverified advanced features require explicit opt-in. */
export const XLAYER_MAINNET_REGISTRY: readonly XLayerPublicEndpoint[] = [
  ...[
    XLAYER_RPC_URL,
    XLAYER_ALTERNATE_RPC_URL,
  ].map((url) => ({
    url,
    provider: "OKX",
    sourceUrls: [
      "https://web3.okx.com/onchainos/dev-docs/xlayer/developer/build-on-xlayer/network-information",
      "https://web3.okx.com/onchainos/dev-docs/xlayer/developer/rpc-endpoints/rpc-endpoints",
    ],
    reviewedAt: "2026-11-07",
    // Local defaults leave room for probes and other users of the same public IP.
    rps: 2,
    burst: 3,
    providerGroup: XLAYER_PUBLIC_PROVIDER_GROUP,
    providerBudget: XLAYER_PUBLIC_RPC_BUDGET,
    supportedMethods: XLAYER_PUBLIC_METHODS,
    capabilities: {
      archive: false,
      blockTags: ["latest", "pending"] as const,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: false,
    },
  })),
  {
    url: "https://xlayer.drpc.org",
    provider: "dRPC",
    sourceUrls: [
      "https://chainlist.org/chain/196",
      "https://drpc.org/chainlist/xlayer-mainnet-rpc",
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
    rps: 2,
    burst: 3,
    capabilities: {
      archive: false,
      blockTags: ["latest", "pending"] as const,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: false,
    },
  },
  {
    url: "https://xlayer-mainnet.rpc.sentio.xyz",
    provider: "Sentio",
    sourceUrls: [
      "https://chainlist.org/chain/196",
      "https://docs.sentio.xyz/docs/supported-network",
    ],
    reviewedAt: "2026-11-07",
    rps: 2,
    burst: 3,
    capabilities: {
      archive: false,
      blockTags: ["latest", "pending"] as const,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: false,
    },
  },
  {
    url: "https://196.rpc.thirdweb.com",
    provider: "thirdweb",
    sourceUrls: [
      "https://chainlist.org/chain/196",
      "https://portal.thirdweb.com/infrastructure/rpc-edge/overview",
    ],
    reviewedAt: "2026-11-07",
    rps: 2,
    burst: 3,
    capabilities: {
      archive: false,
      blockTags: ["latest", "pending"] as const,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
      batch: false,
    },
  },
];

export const XLAYER_MAINNET_ENDPOINTS: readonly string[] = XLAYER_MAINNET_REGISTRY.map(({ url }) => url);
