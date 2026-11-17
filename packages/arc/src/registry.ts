import type { EthereumEndpointCapabilities, EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const ARC_RPC_URL = "https://rpc.mainnet.arc.io";
export const ARC_RPC_SOURCE = "https://docs.arc.io/arc/references/connect-to-arc";

const chainlistSource = "https://chainlist.org/chain/5042";
const publicNodeSource = "https://arc.publicnode.com/";
const drpcRateLimitSource = "https://drpc.org/docs/howitworks/ratelimiting";
const finalitySource = "https://docs.arc.io/arc/concepts/deterministic-finality";

export interface ArcPublicRpcEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
  /** Documented address only; never synthesized from the HTTP URL or enabled automatically. */
  readonly webSocketUrl?: string;
}

const filterMethods = [
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
] as const;

/**
 * Arc finality is deterministic, and every keyless endpoint answered `safe` and
 * `finalized` for blocks and state in live probes (2026-11-08).
 */
const blockTags = ["latest", "pending", "safe", "finalized", "earliest"] as const;

/**
 * Capabilities reflect live probes (2026-11-08). `archive` is true only where
 * `eth_getBalance` at block 1 succeeded. Batching, pinning, debug, trace and
 * subscriptions stay off: no provider documents a batch ceiling for these URLs.
 * There is no documented universal rate ceiling, so no numeric budget is set.
 */
export const ARC_MAINNET_REGISTRY: readonly ArcPublicRpcEndpoint[] = [
  {
    // Returns the same error codes and messages as the QuickNode URL, so treat the
    // two as one backend when reasoning about provider independence.
    id: "arc-primary", provider: "Arc", url: ARC_RPC_URL,
    sourceUrls: [ARC_RPC_SOURCE, chainlistSource, finalitySource],
    // -32601 "method not supported" for filters and eth_getProof (terminal for callers).
    unsupportedMethods: [...filterMethods, "eth_getProof"],
    capabilities: { archive: true },
  },
  {
    id: "arc-blockdaemon", provider: "Blockdaemon", url: "https://rpc.blockdaemon.mainnet.arc.io",
    webSocketUrl: "wss://rpc.blockdaemon.mainnet.arc.io/websocket",
    // State older than roughly 1M blocks is pruned.
    capabilities: { archive: false },
  },
  {
    id: "arc-drpc", provider: "dRPC", url: "https://rpc.drpc.mainnet.arc.io",
    sourceUrls: [ARC_RPC_SOURCE, chainlistSource, drpcRateLimitSource],
    unsupportedMethods: [...filterMethods],
    // The free tier answered 101-block eth_getLogs ranges and rejected 128-block ranges
    // with code 35. The gate avoids a wasted request; failover would cover it anyway.
    capabilities: { archive: true, maxLogBlockRange: 100 },
  },
  {
    id: "arc-quicknode", provider: "QuickNode", url: "https://rpc.quicknode.mainnet.arc.io",
    webSocketUrl: "wss://rpc.quicknode.mainnet.arc.io",
    unsupportedMethods: [...filterMethods, "eth_getProof"],
    capabilities: { archive: true },
  },
  {
    id: "arc-publicnode", provider: "PublicNode", url: "https://arc-rpc.publicnode.com",
    sourceUrls: [chainlistSource, publicNodeSource],
    // Logs older than about 10k blocks, and all numeric-block state, return terminal
    // -32602 "Archive requests require a personal token"; address-less filters are refused.
    unsupportedMethods: ["eth_getLogs"],
    capabilities: { archive: false },
  },
].map((endpoint) => ({
  ...endpoint,
  sourceUrls: ("sourceUrls" in endpoint ? endpoint.sourceUrls : undefined) ?? [ARC_RPC_SOURCE, chainlistSource],
  reviewedAt: "2026-11-08",
  capabilities: {
    blockTags,
    debug: false, trace: false, subscriptions: false, pinning: false, batch: false,
    ...endpoint.capabilities,
  } satisfies EthereumEndpointCapabilities,
}));

export const ARC_MAINNET_ENDPOINTS: readonly string[] = ARC_MAINNET_REGISTRY.map(({ url }) => url);
