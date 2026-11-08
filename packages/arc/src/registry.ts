import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const ARC_RPC_URL = "https://rpc.mainnet.arc.io";
export const ARC_RPC_SOURCE = "https://docs.arc.io/arc/references/connect-to-arc";

const chainlistSource = "https://chainlist.org/chain/5042";
const publicNodeSource = "https://arc.publicnode.com/";
const drpcRateLimitSource = "https://drpc.org/docs/howitworks/ratelimiting";

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
  {
    id: "arc-drpc", provider: "dRPC", url: "https://rpc.drpc.mainnet.arc.io",
    sourceUrls: [ARC_RPC_SOURCE, chainlistSource, drpcRateLimitSource],
    unsupportedMethods: [
      "eth_newFilter",
      "eth_newBlockFilter",
      "eth_newPendingTransactionFilter",
      "eth_getFilterChanges",
      "eth_getFilterLogs",
      "eth_uninstallFilter",
    ],
  },
  {
    id: "arc-quicknode", provider: "QuickNode", url: "https://rpc.quicknode.mainnet.arc.io",
    webSocketUrl: "wss://rpc.quicknode.mainnet.arc.io",
  },
  {
    id: "arc-publicnode", provider: "PublicNode", url: "https://arc-rpc.publicnode.com",
    sourceUrls: [chainlistSource, publicNodeSource],
  },
].map((endpoint) => ({
  ...endpoint,
  sourceUrls: ("sourceUrls" in endpoint ? endpoint.sourceUrls : undefined) ?? [ARC_RPC_SOURCE, chainlistSource],
  reviewedAt: "2026-11-07",
  capabilities: {
    archive: false, blockTags: ["latest", "pending"] as const,
    debug: false, trace: false, subscriptions: false, pinning: false, batch: false,
  },
}));

export const ARC_MAINNET_ENDPOINTS: readonly string[] = ARC_MAINNET_REGISTRY.map(({ url }) => url);
