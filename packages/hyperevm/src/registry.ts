import type { PublicRpcEndpoint } from "@smart-rpc/core";

/** Official HyperEVM mainnet HTTP RPC. */
export const HYPEREVM_RPC_URL = "https://rpc.hyperliquid.xyz/evm";

/** Official HyperEVM testnet HTTP RPC. */
export const HYPEREVM_TESTNET_RPC_URL = "https://rpc.hyperliquid-testnet.xyz/evm";

const reviewedAt = "2026-11-06";

/** dRPC disables stateful filter methods on public endpoints. */
const drpcUnsupportedMethods: readonly string[] = [
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
];

/**
 * Keyless mainnet RPCs with chain, head, and HyperCore precompile checks.
 * Budgets are conservative client settings, not promises of provider capacity.
 * Quotas and restricted-method services are documented in docs/research/hyperevm.md.
 */
export const HYPEREVM_MAINNET_REGISTRY: readonly PublicRpcEndpoint[] = [
  {
    id: "hyperliquid-mainnet",
    url: HYPEREVM_RPC_URL,
    provider: "Hyperliquid",
    sourceUrls: ["https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm"],
    reviewedAt,
    rps: 1.5,
    burst: 3,
  },
  {
    id: "hypurrscan-mainnet",
    url: "https://rpc.hypurrscan.io",
    provider: "Hypurrscan",
    sourceUrls: ["https://hyperliquid.gitbook.io/hyperliquid-docs/builder-tools/hyperevm-tools"],
    reviewedAt,
    rps: 1,
    burst: 2,
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
    rps: 1,
    burst: 2,
    unsupportedMethods: drpcUnsupportedMethods,
  },
  {
    id: "purroof-mainnet",
    url: "https://rpc.purroofgroup.com",
    provider: "Purroof",
    sourceUrls: ["https://www.purroofgroup.com/"],
    reviewedAt,
    rps: 1,
    burst: 2,
  },
  {
    id: "stakely-mainnet",
    url: "https://hyperliquid-json-rpc.stakely.io",
    provider: "Stakely",
    sourceUrls: ["https://stakely.io/web3-api-load-balancer/hyperliquid"],
    reviewedAt,
    rps: 1,
    burst: 2,
  },
  {
    id: "onfinality-mainnet",
    url: "https://hyperliquid.api.onfinality.io/evm/public",
    provider: "OnFinality",
    sourceUrls: [
      "https://onfinality.io/en/networks/hyperliquid",
      "https://documentation.onfinality.io/support/hyperliquid",
    ],
    reviewedAt,
    rps: 1,
    burst: 2,
  },
  {
    id: "bloxroute-mainnet",
    url: "https://hyperliquid.rpc.blxrbdn.com",
    provider: "bloXroute",
    sourceUrls: ["https://docs.bloxroute.com/core-solutions/rpc-service/fast-rpc"],
    reviewedAt,
    rps: 1,
    burst: 2,
  },
  {
    id: "publicnode-mainnet",
    url: "https://hyperliquid-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: ["https://publicnode.com/"],
    reviewedAt,
    rps: 1,
    burst: 2,
  },
  {
    id: "pocket-mainnet",
    url: "https://hyperliquid.api.pocket.network",
    provider: "Pocket Network",
    sourceUrls: ["https://docs.pocket.network/developers/supported-chains/"],
    reviewedAt,
    rps: 1,
    burst: 2,
  },
  {
    id: "web3cdn-mainnet",
    url: "https://hyperliquid.web3cdn.rest",
    provider: "Web3CDN",
    sourceUrls: ["https://web3cdn.network/rpc/hyperliquid"],
    reviewedAt,
    // Shares provider quotas with its other networks. One pool per network stays
    // below the advertised daily allowance; budgets do not coordinate processes.
    rps: 0.025,
    burst: 2,
  },
];

/**
 * Broad-method testnet RPCs. Other discovered public testnet services failed
 * head checks or restrict eth_call; do not route general reads to those hosts.
 */
export const HYPEREVM_TESTNET_REGISTRY: readonly PublicRpcEndpoint[] = [
  {
    id: "hyperliquid-testnet",
    url: HYPEREVM_TESTNET_RPC_URL,
    provider: "Hyperliquid",
    sourceUrls: ["https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm"],
    reviewedAt,
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
    rps: 1,
    burst: 2,
    unsupportedMethods: drpcUnsupportedMethods,
  },
];

/** Public mainnet URL list; the default transport also applies registry budgets. */
export const HYPEREVM_MAINNET_ENDPOINTS: readonly string[] = HYPEREVM_MAINNET_REGISTRY.map(({ url }) => url);

/** Public testnet URL list; the default transport also applies registry budgets. */
export const HYPEREVM_TESTNET_ENDPOINTS: readonly string[] = HYPEREVM_TESTNET_REGISTRY.map(({ url }) => url);
