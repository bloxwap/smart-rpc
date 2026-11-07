import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const ARC_RPC_URL = "https://rpc.mainnet.arc.io";
export const ARC_RPC_SOURCE = "https://docs.arc.io/arc/references/connect-to-arc";

export interface ArcPublicRpcEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
  /** Documented address only; never synthesized from the HTTP URL or enabled automatically. */
  readonly webSocketUrl?: string;
}

/** Unknown optional capabilities stay off; there is no documented universal rate or batch ceiling. */
export const ARC_MAINNET_REGISTRY: readonly ArcPublicRpcEndpoint[] = [
  { id: "arc-primary", provider: "Arc", url: ARC_RPC_URL },
  {
    id: "arc-blockdaemon", provider: "Blockdaemon", url: "https://rpc.blockdaemon.mainnet.arc.io",
    webSocketUrl: "wss://rpc.blockdaemon.mainnet.arc.io/websocket",
  },
  { id: "arc-drpc", provider: "dRPC", url: "https://rpc.drpc.mainnet.arc.io" },
  {
    id: "arc-quicknode", provider: "QuickNode", url: "https://rpc.quicknode.mainnet.arc.io",
    webSocketUrl: "wss://rpc.quicknode.mainnet.arc.io",
  },
].map((endpoint) => ({
  ...endpoint,
  sourceUrls: [ARC_RPC_SOURCE],
  reviewedAt: "2026-11-06",
  capabilities: {
    archive: false, blockTags: ["latest", "pending"] as const,
    debug: false, trace: false, subscriptions: false, pinning: false, batch: false,
  },
}));

export const ARC_MAINNET_ENDPOINTS: readonly string[] = ARC_MAINNET_REGISTRY.map(({ url }) => url);
