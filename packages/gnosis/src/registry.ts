import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const GNOSIS_RPC_URL = "https://rpc.gnosischain.com";
export const GNOSIS_WEBSOCKET_URL = "wss://rpc.gnosischain.com/wss";
export const GNOSIS_GATEWAY_RPC_URL = "https://rpc.gnosis.gateway.fm";

export interface GnosisPublicRpcEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
  /** Documented URL, not a claim that every subscription is available. */
  readonly websocketUrl?: string;
}

/**
 * Public execution RPCs. Undocumented numeric quotas are intentionally omitted.
 * `archive` is enabled only where repeated live probes (2026-11-08: block 1 plus
 * five spread historical blocks, on separate runs) returned historical state.
 * PublicNode prunes history; Pocket answered some historical blocks and not others.
 */
export const GNOSIS_MAINNET_REGISTRY: readonly GnosisPublicRpcEndpoint[] = [
  {
    id: "gnosis-starter", provider: "Gnosis", url: GNOSIS_RPC_URL,
    websocketUrl: GNOSIS_WEBSOCKET_URL,
    sourceUrls: ["https://docs.gnosischain.com/about/networks/mainnet", "https://docs.gnosischain.com/tools/RPC%20Providers/", "https://chainlist.org/chain/100"],
    reviewedAt: "2026-11-08",
    capabilities: { archive: true, debug: false, trace: false, subscriptions: false, batch: false, pinning: false, blockTags: ["latest", "pending"] },
  },
  {
    id: "gnosis-gateway", provider: "Gateway.fm", url: GNOSIS_GATEWAY_RPC_URL,
    sourceUrls: ["https://docs.gnosischain.com/about/networks/mainnet", "https://chainlist.org/chain/100"],
    reviewedAt: "2026-11-08",
    capabilities: { archive: true, debug: false, trace: false, subscriptions: false, batch: false, pinning: false, blockTags: ["latest", "pending"] },
  },
  {
    id: "gnosis-pocket", provider: "Pocket Network", url: "https://gnosis.api.pocket.network",
    sourceUrls: ["https://docs.pocket.network/developers/supported-chains/", "https://chainlist.org/chain/100"],
    reviewedAt: "2026-11-08",
    capabilities: { archive: false, debug: false, trace: false, subscriptions: false, batch: false, pinning: false, blockTags: ["latest", "pending"] },
  },
  {
    id: "gnosis-drpc", provider: "dRPC", url: "https://gnosis.drpc.org",
    sourceUrls: ["https://drpc.org/chainlist/gnosis-mainnet-rpc", "https://drpc.org/docs/howitworks/ratelimiting", "https://docs.gnosischain.com/tools/RPC%20Providers/", "https://chainlist.org/chain/100"],
    reviewedAt: "2026-11-08",
    unsupportedMethods: ["eth_newFilter", "eth_newBlockFilter", "eth_newPendingTransactionFilter", "eth_getFilterChanges", "eth_getFilterLogs", "eth_uninstallFilter"],
    capabilities: { archive: true, debug: false, trace: false, subscriptions: false, batch: false, pinning: false, blockTags: ["latest", "pending"] },
  },
  {
    id: "gnosis-publicnode", provider: "PublicNode", url: "https://gnosis-rpc.publicnode.com",
    sourceUrls: ["https://gnosis.publicnode.com/", "https://chainlist.org/chain/100"],
    reviewedAt: "2026-11-08",
    capabilities: { archive: false, debug: false, trace: false, subscriptions: false, batch: false, pinning: false, blockTags: ["latest", "pending"] },
  },
];

export const GNOSIS_MAINNET_ENDPOINTS: readonly string[] = GNOSIS_MAINNET_REGISTRY.map(({ url }) => url);
