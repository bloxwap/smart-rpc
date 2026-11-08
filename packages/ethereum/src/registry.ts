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
    reviewedAt: "2026-11-07",
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
    reviewedAt: "2026-11-07",
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
    id: "ethereum-nownodes",
    url: "https://public-eth.nownodes.io",
    provider: "NOWNodes",
    sourceUrls: ["https://nownodes.io/public-endpoints"],
    reviewedAt: "2026-11-07",
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
    reviewedAt: "2026-11-07",
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
    reviewedAt: "2026-11-07",
    rps: 2,
    burst: 3,
  },
];

/** Public URL list retained for callers that supply their own endpoint budgets. */
export const ETHEREUM_MAINNET_ENDPOINTS: readonly string[] = ETHEREUM_MAINNET_REGISTRY.map(
  (endpoint) => endpoint.url,
);
