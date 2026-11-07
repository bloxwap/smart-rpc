/**
 * Keyless Ethereum mainnet RPCs advertised by their operators.
 *
 * Budgets are conservative client limits, not provider capacity guarantees.
 * Sources and review dates make endpoint additions and removals auditable.
 * Provider documentation does not imply a successful live health check.
 * @module
 */

import type { PublicRpcEndpoint } from "@smart-rpc/core";

/** Public HTTP endpoints eligible for the default Ethereum mainnet pool. */
export const ETHEREUM_MAINNET_REGISTRY: readonly PublicRpcEndpoint[] = [
  {
    id: "ethereum-publicnode",
    url: "https://ethereum-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: ["https://ethereum.publicnode.com/"],
    reviewedAt: "2026-11-06",
    rps: 2,
    burst: 3,
  },
  {
    id: "ethereum-drpc",
    url: "https://eth.drpc.org",
    provider: "dRPC",
    sourceUrls: [
      "https://drpc.org/docs/ethereum-api",
      "https://drpc.org/docs/howitworks/ratelimiting",
    ],
    reviewedAt: "2026-11-06",
    rps: 2,
    burst: 3,
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
    id: "ethereum-llama",
    url: "https://eth.llamarpc.com",
    provider: "LlamaNodes",
    sourceUrls: ["https://llamarpc.com/eth"],
    reviewedAt: "2026-11-06",
    rps: 2,
    burst: 3,
  },
  {
    id: "ethereum-blockpi",
    url: "https://ethereum.public.blockpi.network/v1/rpc/public",
    provider: "BlockPI",
    sourceUrls: ["https://public.blockpi.io/"],
    reviewedAt: "2026-11-06",
    rps: 2,
    burst: 3,
  },
  {
    id: "ethereum-onfinality",
    url: "https://eth.api.onfinality.io/public",
    provider: "OnFinality",
    sourceUrls: ["https://www.onfinality.io/en/"],
    reviewedAt: "2026-11-06",
    rps: 2,
    burst: 3,
  },
  {
    id: "ethereum-0xrpc",
    url: "https://0xrpc.io/eth",
    provider: "0xRPC",
    sourceUrls: ["https://0xrpc.github.io/"],
    reviewedAt: "2026-11-06",
    rps: 2,
    burst: 3,
  },
  {
    id: "ethereum-nownodes",
    url: "https://public-eth.nownodes.io",
    provider: "NOWNodes",
    sourceUrls: ["https://nownodes.io/public-endpoints"],
    reviewedAt: "2026-11-06",
    rps: 2,
    burst: 3,
  },
  {
    id: "ethereum-nodies",
    url: "https://ethereum-public.nodies.app",
    provider: "Nodies",
    sourceUrls: ["https://nodies.app/", "https://docs.nodies.app/rpc-services/public-endpoints"],
    reviewedAt: "2026-11-06",
    rps: 2,
    burst: 3,
  },
  {
    id: "ethereum-tenderly",
    url: "https://mainnet.gateway.tenderly.co",
    provider: "Tenderly",
    sourceUrls: [
      "https://docs.tenderly.co/node-rpc/rpc-reference",
      "https://docs.tenderly.co/node-rpc/overview#public-endpoint-limits",
    ],
    reviewedAt: "2026-11-06",
    rps: 2,
    burst: 3,
    // Over 3,000 log results returns -32602, indistinguishable from invalid caller params.
    // Route log queries to the other providers instead of making that terminal error.
    unsupportedMethods: ["eth_getLogs"],
  },
  {
    id: "ethereum-pocket",
    url: "https://eth.api.pocket.network",
    provider: "Pocket Network",
    sourceUrls: ["https://docs.pocket.network/developers/supported-chains/"],
    reviewedAt: "2026-11-06",
    rps: 2,
    burst: 3,
  },
  {
    id: "ethereum-web3cdn",
    url: "https://ethereum.web3cdn.rest",
    provider: "Web3CDN",
    sourceUrls: ["https://web3cdn.network/rpc/ethereum"],
    reviewedAt: "2026-11-06",
    // Share headroom under the anonymous 10,000/day quota with the other chain defaults.
    // Four long-lived pools at this rate consume at most 8,640/day, plus their initial bursts.
    rps: 0.025,
    burst: 2,
  },
];

/** Public URL list retained for callers that supply their own endpoint budgets. */
export const ETHEREUM_MAINNET_ENDPOINTS: readonly string[] = ETHEREUM_MAINNET_REGISTRY.map(
  (endpoint) => endpoint.url,
);
