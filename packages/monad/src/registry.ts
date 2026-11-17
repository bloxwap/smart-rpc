import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const MONAD_RPC_URL = "https://rpc.monad.xyz";

/** Documentation, not a promise of available quota or provider uptime. */
export interface MonadRpcEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
  readonly websocketUrl?: string;
  readonly documentedLimits: {
    readonly requests: number;
    readonly windowMs: number;
    readonly batchSize: number;
    readonly batchesPerSecond?: number;
  };
}

const networkSource = "https://docs.monad.xyz/developer-essentials/network-information";
const limitsSource = "https://docs.monad.xyz/reference/json-rpc/overview";
const chainlistSource = "https://chainlist.org/chain/143";
const reviewedAt = "2026-11-08";

/**
 * HTTP defaults. WebSocket addresses are recorded verbatim, never inferred.
 * Client budgets deliberately leave headroom for shared-IP traffic. MF aliases
 * share a 2 rps / burst 3 bucket, bounding even singleton batches to 5 per second.
 * Network docs label rpc/rpc1 as MF; the method-limit page names their operators
 * QuickNode/Alchemy. Keep one conservative group for the Foundation aliases.
 * Live probes on 2026-11-08 found rpc1 rejecting eth_getLogs above 101 blocks with
 * the same "block range too large" error as rpc and monadinfra, so it uses the
 * stricter observed 100-block range instead of the 1,000 blocks the limits page lists.
 */
export const MONAD_MAINNET_REGISTRY: readonly MonadRpcEndpoint[] = [
  {
    id: "monad-mf", label: "monad-mf", url: MONAD_RPC_URL,
    provider: "Monad Foundation", websocketUrl: "wss://rpc.monad.xyz",
    sourceUrls: [networkSource, chainlistSource, limitsSource], reviewedAt,
    rps: 2, burst: 3, providerGroup: "monad-foundation", providerBudget: { rps: 2, burst: 3 },
    documentedLimits: { requests: 20, windowMs: 1_000, batchSize: 100, batchesPerSecond: 5 },
    capabilities: { archive: true, pinning: true, batch: true, maxBatchSize: 100, maxLogBlockRange: 100, subscriptions: false },
  },
  {
    id: "monad-mf-1", label: "monad-mf-1", url: "https://rpc1.monad.xyz",
    provider: "Monad Foundation", websocketUrl: "wss://rpc1.monad.xyz",
    sourceUrls: [networkSource, chainlistSource, limitsSource], reviewedAt,
    rps: 2, burst: 3, providerGroup: "monad-foundation", providerBudget: { rps: 2, burst: 3 },
    documentedLimits: { requests: 20, windowMs: 1_000, batchSize: 100, batchesPerSecond: 5 },
    capabilities: { archive: true, pinning: true, batch: true, maxBatchSize: 100, maxLogBlockRange: 100, subscriptions: false },
  },
  {
    id: "monad-goldsky", label: "monad-goldsky", url: "https://rpc2.monad.xyz",
    provider: "Goldsky Edge", sourceUrls: [networkSource, chainlistSource], reviewedAt,
    rps: 20, burst: 20, providerGroup: "monad-goldsky", providerBudget: { rps: 20, burst: 20 },
    documentedLimits: { requests: 300, windowMs: 10_000, batchSize: 10 },
    capabilities: { archive: true, pinning: true, batch: true, maxBatchSize: 10, subscriptions: false },
  },
  {
    id: "monad-ankr", label: "monad-ankr", url: "https://rpc3.monad.xyz",
    provider: "Ankr", websocketUrl: "wss://rpc3.monad.xyz",
    sourceUrls: [networkSource, chainlistSource, limitsSource], reviewedAt,
    rps: 20, burst: 20, providerGroup: "monad-ankr", providerBudget: { rps: 20, burst: 20 },
    documentedLimits: { requests: 300, windowMs: 10_000, batchSize: 10 },
    capabilities: { archive: false, pinning: false, debug: false, batch: true, maxBatchSize: 10, maxLogBlockRange: 1_000, subscriptions: false },
  },
  {
    id: "monad-mf-infra", label: "monad-mf-infra", url: "https://rpc-mainnet.monadinfra.com",
    provider: "Monad Foundation", websocketUrl: "wss://rpc-mainnet.monadinfra.com",
    sourceUrls: [networkSource, chainlistSource, limitsSource], reviewedAt,
    rps: 2, burst: 3, providerGroup: "monad-foundation", providerBudget: { rps: 2, burst: 3 },
    documentedLimits: { requests: 20, windowMs: 1_000, batchSize: 100, batchesPerSecond: 5 },
    capabilities: { archive: true, pinning: true, batch: true, maxBatchSize: 100, maxLogBlockRange: 100, subscriptions: false },
  },
];

/** URLs only; use the registry to retain request budgets and capabilities. */
export const MONAD_MAINNET_ENDPOINTS: readonly string[] = MONAD_MAINNET_REGISTRY.map(({ url }) => url);
