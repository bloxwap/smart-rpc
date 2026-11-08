import { SAFE_EVM_METHODS } from "@smart-rpc/core";
import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

/** Exact URLs from Flare's network overview. Paths are provider-specific. */
export const FLARE_RPC_URL = "https://flare-api.flare.network/ext/C/rpc";
export const FLARE_WS_URL = "wss://flare-api.flare.network/ext/C/ws";
export const FLARE_QUICKNODE_RPC_URL = "https://stylish-light-theorem.flare-mainnet.quiknode.pro/ext/bc/C/rpc";
export const FLARE_QUICKNODE_WS_URL = "wss://stylish-light-theorem.flare-mainnet.quiknode.pro/ext/bc/C/ws";

export interface FlarePublicRpcEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
  /** Documentation only; choose this URL explicitly for a dedicated WS session. */
  readonly websocketUrl: string;
}

const supportedMethods = [
  ...SAFE_EVM_METHODS,
  "eth_sendRawTransaction", "eth_newFilter", "eth_newBlockFilter",
  "eth_newPendingTransactionFilter", "eth_getFilterChanges", "eth_getFilterLogs", "eth_uninstallFilter",
] as const;

const drpcUnsupportedMethods: readonly string[] = [
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
];
const drpcSupportedMethods = supportedMethods.filter((method) => !drpcUnsupportedMethods.includes(method));

/**
 * No numeric provider quota or batch ceiling was documented. Optional capabilities
 * stay disabled until explicitly configured and tested for the chosen endpoint.
 */
export const FLARE_MAINNET_REGISTRY: readonly FlarePublicRpcEndpoint[] = [
  {
    id: "flare-public",
    provider: "Flare",
    url: FLARE_RPC_URL,
    websocketUrl: FLARE_WS_URL,
    sourceUrls: [
      "https://dev.flare.network/network/overview",
      "https://chainlist.org/chain/14",
    ],
  },
  {
    id: "flare-quicknode-public",
    provider: "QuickNode",
    url: FLARE_QUICKNODE_RPC_URL,
    websocketUrl: FLARE_QUICKNODE_WS_URL,
    sourceUrls: ["https://dev.flare.network/network/overview"],
  },
  {
    id: "flare-drpc-public",
    provider: "dRPC",
    url: "https://flare.drpc.org",
    websocketUrl: "wss://flare.drpc.org",
    sourceUrls: [
      "https://chainlist.org/chain/14",
      "https://drpc.org/chainlist/flare-mainnet-rpc",
      "https://drpc.org/docs/howitworks/ratelimiting",
    ],
    unsupportedMethods: drpcUnsupportedMethods,
  },
  {
    id: "flare-tenderly-public",
    provider: "Tenderly",
    url: "https://flare.gateway.tenderly.co",
    websocketUrl: "wss://flare.gateway.tenderly.co",
    sourceUrls: [
      "https://docs.tenderly.co/node-rpc/rpc-reference",
      "https://docs.tenderly.co/node-rpc/overview#public-endpoint-limits",
    ],
  },
].map((entry): FlarePublicRpcEndpoint => ({
  ...entry,
  reviewedAt: "2026-11-07",
  supportedMethods: entry.id === "flare-drpc-public" ? drpcSupportedMethods : supportedMethods,
  capabilities: {
    archive: false, debug: false, trace: false, batch: false,
    subscriptions: false, pinning: false, blockTags: ["latest", "pending"],
  },
}));

export const FLARE_MAINNET_ENDPOINTS: readonly string[] = FLARE_MAINNET_REGISTRY.map(({ url }) => url);
