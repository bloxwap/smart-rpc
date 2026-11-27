import type { PublicRpcEndpoint } from "@smart-rpc/core";
import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

import rawMainnetRanking from "../registry/mainnet.json" with { type: "json" };
import { assertMainnetRegistryFile } from "./registry/data.js";
import { endpointKey, type RegistryRanking } from "./registry/policy.js";

/** Public endpoint with capabilities and its latest persisted registry ranking. */
export interface HyperEvmPublicEndpoint extends PublicRpcEndpoint, RegistryRanking {
  readonly capabilities: NonNullable<EthereumEndpointConfig["capabilities"]>;
}

/**
 * Public defaults enable only documented or live-verified state access. Operators may
 * opt in to additional capabilities on explicitly configured archive or dedicated nodes.
 */
const publicCapabilities: NonNullable<EthereumEndpointConfig["capabilities"]> = {
  archive: false,
  pinning: false,
  blockTags: ["latest"],
  subscriptions: false,
  batch: false,
  debug: false,
  trace: false,
};

/** Official RPC restrictions, also applied when its URL is explicitly supplied. */
export const HYPEREVM_OFFICIAL_CAPABILITIES: NonNullable<EthereumEndpointConfig["capabilities"]> = {
  ...publicCapabilities,
  maxLogBlockRange: 50,
  maxLogTopics: 4,
};

/** Official HyperEVM mainnet HTTP RPC. */
export const HYPEREVM_RPC_URL = "https://rpc.hyperliquid.xyz/evm";

/** Official HyperEVM testnet HTTP RPC. */
export const HYPEREVM_TESTNET_RPC_URL = "https://rpc.hyperliquid-testnet.xyz/evm";

const reviewedAt = "2026-11-08";

/**
 * Budget for community endpoints that publish no numeric limit and answered 300 of 300
 * eth_getBalance reads at 5 requests/second over 60 seconds on 2026-11-27. The budget stays
 * below that measured rate; a 429 still cuts it at runtime. Stakely drew HTTP 429 after about
 * 33 seconds of the same load and the official RPC publishes 100 requests/minute, so neither
 * uses it.
 */
const SOAKED_BUDGET = { rps: 4, burst: 8 } as const;

/**
 * Community nodes that rejected eth_getLogs above 1,000 blocks ("query exceeds max block
 * range 1000") in live probes on 2026-11-08. Archive stays off: Hypurrscan and PublicNode
 * (like the official RPC) answered eth_getBalance at block 1, block 1,000 and head-1M with
 * the current balance, so they silently serve latest state for numeric selectors. Stakely
 * mostly returned true historical values but once returned current state at block 1,000,
 * so it is not trusted for historical reads either.
 */
const communityLogCapabilities: NonNullable<EthereumEndpointConfig["capabilities"]> = {
  ...publicCapabilities,
  maxLogBlockRange: 1_000,
};

/**
 * dRPC's free plan accepted 101-block log ranges and rejected 102 with "ranges over 10000
 * blocks are not supported on free plan" on mainnet and testnet (2026-11-08). dRPC mainnet
 * returned distinct, repeatable historical balances (block 1,000, head-1M, head-100k)
 * that matched Stakely's, so it alone enables archive; testnet refuses numeric state.
 */
const DRPC_FREE_LOG_BLOCK_RANGE = 100;

/** dRPC disables stateful filter methods on public endpoints. */
const drpcUnsupportedMethods: readonly string[] = [
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
];

type MainnetEndpointSource = Omit<HyperEvmPublicEndpoint, keyof RegistryRanking>;

/**
 * Source-backed mainnet metadata. Ranking data lives separately so scheduled
 * probes cannot rewrite capabilities, provenance, or conservative budgets.
 */
const mainnetSources: readonly MainnetEndpointSource[] = [
  {
    id: "hyperliquid-mainnet",
    url: HYPEREVM_RPC_URL,
    provider: "Hyperliquid",
    sourceUrls: [
      "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm",
      "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc",
      "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits",
    ],
    reviewedAt,
    capabilities: HYPEREVM_OFFICIAL_CAPABILITIES,
    rps: 1.5,
    burst: 3,
  },
  {
    id: "hypurrscan-mainnet",
    url: "https://rpc.hypurrscan.io",
    provider: "Hypurrscan",
    sourceUrls: ["https://hyperliquid.gitbook.io/hyperliquid-docs/builder-tools/hyperevm-tools"],
    reviewedAt,
    capabilities: communityLogCapabilities,
    ...SOAKED_BUDGET,
  },
  {
    id: "drpc-mainnet",
    url: "https://hyperliquid.drpc.org",
    provider: "dRPC",
    sourceUrls: [
      "https://blog.drpc.org/drpc-adds-support-for-hyperliquid-rpc/",
      "https://drpc.org/docs/howitworks/ratelimiting",
    ],
    reviewedAt,
    capabilities: { ...publicCapabilities, archive: true, maxLogBlockRange: DRPC_FREE_LOG_BLOCK_RANGE },
    ...SOAKED_BUDGET,
    unsupportedMethods: drpcUnsupportedMethods,
  },
  {
    id: "stakely-mainnet",
    url: "https://hyperliquid-json-rpc.stakely.io",
    provider: "Stakely",
    sourceUrls: ["https://stakely.io/web3-api-load-balancer/hyperliquid"],
    reviewedAt,
    capabilities: communityLogCapabilities,
    rps: 1,
    burst: 2,
  },
  {
    id: "publicnode-mainnet",
    url: "https://hyperliquid-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: ["https://publicnode.com/"],
    reviewedAt,
    capabilities: communityLogCapabilities,
    ...SOAKED_BUDGET,
  },
  {
    id: "purroof-mainnet",
    url: "https://rpc.purroofgroup.com",
    provider: "Purroof Group",
    sourceUrls: ["https://www.purroofgroup.com/"],
    reviewedAt: "2026-11-27",
    // The operator publishes this as a free archive RPC, "currently rate-limited due to high
    // demand", without a number. It passed the same 5 requests/second soak and the HyperCore
    // precompile probe (2026-11-27); the budget is set lower than its peers for that notice.
    // Archive and log-range behavior are unverified, so the conservative public defaults apply.
    capabilities: publicCapabilities,
    rps: 3,
    burst: 6,
  },
];

assertMainnetRegistryFile(rawMainnetRanking);
const rankingByUrl = new Map(rawMainnetRanking.endpoints.map((row) => [endpointKey(row.url), row]));
if (rankingByUrl.size !== mainnetSources.length) {
  throw new Error("HyperEVM ranking data and source registry contain different endpoint counts.");
}

/** Mainnet endpoints ranked from the committed rolling probe history. */
export const HYPEREVM_MAINNET_REGISTRY: readonly HyperEvmPublicEndpoint[] = mainnetSources.map((source) => {
  const key = endpointKey(source.url);
  const ranking = rankingByUrl.get(key);
  if (!ranking) throw new Error(`HyperEVM ranking data is missing ${source.url}.`);
  rankingByUrl.delete(key);
  return { ...source, ...ranking };
}).sort((a, b) => {
  if (a.rank === null && b.rank === null) return endpointKey(a.url).localeCompare(endpointKey(b.url));
  if (a.rank === null) return 1;
  if (b.rank === null) return -1;
  return a.rank - b.rank;
});
/* v8 ignore next -- @preserve unknown URLs are rejected while merging */
if (rankingByUrl.size !== 0) throw new Error("HyperEVM ranking data contains an unknown endpoint URL.");

type TestnetEndpointSource = Omit<HyperEvmPublicEndpoint, keyof RegistryRanking>;

/** Broad-method testnet RPCs. Historical ranking currently covers mainnet only. */
const testnetSources: readonly TestnetEndpointSource[] = [
  {
    id: "hyperliquid-testnet",
    url: HYPEREVM_TESTNET_RPC_URL,
    provider: "Hyperliquid",
    sourceUrls: [
      "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm",
      "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc",
      "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits",
    ],
    reviewedAt,
    capabilities: HYPEREVM_OFFICIAL_CAPABILITIES,
    rps: 1.5,
    burst: 3,
  },
  {
    id: "drpc-testnet",
    url: "https://hyperliquid-testnet.drpc.org",
    provider: "dRPC",
    sourceUrls: [
      "https://drpc.org/chainlist/hyperliquid-testnet-rpc",
      "https://drpc.org/docs/howitworks/ratelimiting",
    ],
    reviewedAt,
    capabilities: { ...publicCapabilities, maxLogBlockRange: DRPC_FREE_LOG_BLOCK_RANGE },
    rps: 1,
    burst: 2,
    unsupportedMethods: drpcUnsupportedMethods,
  },
];

/** Testnet retains neutral weights until it has its own rolling probe history. */
export const HYPEREVM_TESTNET_REGISTRY: readonly HyperEvmPublicEndpoint[] = testnetSources.map((source) => ({
  ...source,
  eligible: true,
  weight: 1,
  rank: null,
  stats: null,
}));

function defaultUrls(registry: readonly HyperEvmPublicEndpoint[]): readonly string[] {
  return registry.filter((endpoint) => endpoint.eligible && endpoint.weight > 0).map(({ url }) => url);
}

/** Eligible mainnet URLs; the default transport also applies weights and budgets. */
export const HYPEREVM_MAINNET_ENDPOINTS: readonly string[] = defaultUrls(HYPEREVM_MAINNET_REGISTRY);

/** Public testnet URL list; the default transport also applies registry budgets. */
export const HYPEREVM_TESTNET_ENDPOINTS: readonly string[] = defaultUrls(HYPEREVM_TESTNET_REGISTRY);
