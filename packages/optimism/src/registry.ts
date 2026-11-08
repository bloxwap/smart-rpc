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

/** Unknown provider quotas and optional capabilities are not inferred. */
export const OPTIMISM_MAINNET_REGISTRY: readonly OptimismPublicRpcEndpoint[] = [
  {
    id: "optimism-mainnet",
    url: OPTIMISM_RPC_URL,
    provider: "Optimism",
    sourceUrls: ["https://docs.optimism.io/op-mainnet/network-information/connecting-to-op"],
    reviewedAt: "2026-11-07",
    capabilities: {
      archive: false,
      batch: false,
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
    reviewedAt: "2026-11-07",
    capabilities: {
      archive: false,
      batch: false,
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
    capabilities: {
      archive: false,
      batch: false,
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
    reviewedAt: "2026-11-07",
    capabilities: {
      archive: false,
      batch: false,
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
    ],
    reviewedAt: "2026-11-07",
    capabilities: {
      archive: false,
      batch: false,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
    },
  },
];

export const OPTIMISM_MAINNET_ENDPOINTS: readonly string[] = OPTIMISM_MAINNET_REGISTRY.map(({ url }) => url);
