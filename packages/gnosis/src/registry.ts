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

/** Public execution RPCs. Undocumented numeric quotas are intentionally omitted. */
export const GNOSIS_MAINNET_REGISTRY: readonly GnosisPublicRpcEndpoint[] = [
  {
    id: "gnosis-starter", provider: "Gnosis", url: GNOSIS_RPC_URL,
    websocketUrl: GNOSIS_WEBSOCKET_URL,
    sourceUrls: ["https://docs.gnosischain.com/about/networks/mainnet", "https://docs.gnosischain.com/tools/RPC%20Providers/"],
    reviewedAt: "2026-11-06",
    capabilities: { archive: false, debug: false, trace: false, subscriptions: false, batch: false, pinning: false, blockTags: ["latest", "pending"] },
  },
  {
    id: "gnosis-gateway", provider: "Gateway.fm", url: GNOSIS_GATEWAY_RPC_URL,
    sourceUrls: ["https://docs.gnosischain.com/about/networks/mainnet"],
    reviewedAt: "2026-11-06",
    capabilities: { archive: false, debug: false, trace: false, subscriptions: false, batch: false, pinning: false, blockTags: ["latest", "pending"] },
  },
];

export const GNOSIS_MAINNET_ENDPOINTS: readonly string[] = GNOSIS_MAINNET_REGISTRY.map(({ url }) => url);
