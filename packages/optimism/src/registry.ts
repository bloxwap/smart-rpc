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
export const OPTIMISM_MAINNET_REGISTRY: readonly OptimismPublicRpcEndpoint[] = [{
  id: "optimism-mainnet",
  url: OPTIMISM_RPC_URL,
  provider: "Optimism",
  sourceUrls: ["https://docs.optimism.io/op-mainnet/network-information/connecting-to-op"],
  reviewedAt: "2026-11-06",
  capabilities: {
    archive: false,
    batch: false,
    debug: false,
    trace: false,
    subscriptions: false,
    pinning: false,
  },
}];

export const OPTIMISM_MAINNET_ENDPOINTS: readonly string[] = OPTIMISM_MAINNET_REGISTRY.map(({ url }) => url);
