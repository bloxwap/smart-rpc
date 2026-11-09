/**
 * Keyless Ethereum mainnet RPCs advertised by their operators.
 *
 * `rps`/`burst` appear only where the operator publishes a numeric keyless allowance;
 * where none is published they are left unspecified rather than invented.
 * Capabilities record direct live evidence (reviewedAt); omitted values stay unknown.
 * Sources and review dates make endpoint additions and removals auditable.
 * Provider documentation does not imply a successful live health check.
 * @module
 */

import type { PublicRpcEndpoint } from "@smart-rpc/core";

import type { EthereumEndpointCapabilities } from "./capabilities.js";

/** A registry entry. Budgets are optional because most keyless services publish none. */
export interface EthereumPublicRpcEndpoint extends Omit<PublicRpcEndpoint, "rps" | "burst"> {
  readonly rps?: number | undefined;
  readonly burst?: number | undefined;
  readonly capabilities?: EthereumEndpointCapabilities | undefined;
}

const DRPC_FILTER_METHODS = [
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
] as const;

/** Public HTTP endpoints eligible for the default Ethereum mainnet pool. */
export const ETHEREUM_MAINNET_REGISTRY: readonly EthereumPublicRpcEndpoint[] = [
  {
    id: "ethereum-publicnode",
    url: "https://ethereum-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: ["https://ethereum.publicnode.com/"],
    reviewedAt: "2026-11-08",
    // No numeric keyless limit is published. Historical state (even ~1,000 blocks back)
    // returns HTTP 403 "Archive requests require a personal token".
    capabilities: { archive: false },
  },
  {
    id: "ethereum-drpc",
    url: "https://eth.drpc.org",
    provider: "dRPC",
    sourceUrls: [
      "https://drpc.org/docs/ethereum-api",
      "https://drpc.org/docs/howitworks/ratelimiting",
    ],
    reviewedAt: "2026-11-08",
    // The published free-tier CU allowance applies to keyed free accounts; keyless public
    // endpoints use separate, unpublished per-network limits, so no budget is asserted.
    unsupportedMethods: DRPC_FILTER_METHODS,
    // "Batch requests are limited to 3 items" (rate-limiting docs; a 4-item batch is rejected).
    // Keyless eth_getLogs rejects spans over ~101 blocks with code 35 regardless of result count.
    capabilities: { archive: true, batch: true, maxBatchSize: 3, maxLogBlockRange: 100 },
  },
  {
    id: "ethereum-nownodes",
    url: "https://public-eth.nownodes.io",
    provider: "NOWNodes",
    sourceUrls: ["https://nownodes.io/public-endpoints"],
    reviewedAt: "2026-11-08",
    // Published public-endpoint limit: "Rate limit: 5 RPS".
    rps: 5,
    burst: 5,
    // eth_getLogs timed out (>10 s) even for a single-block query in repeated runs.
    unsupportedMethods: ["eth_getLogs"],
    capabilities: { archive: false },
  },
  {
    id: "ethereum-tenderly",
    url: "https://mainnet.gateway.tenderly.co",
    provider: "Tenderly",
    sourceUrls: [
      "https://docs.tenderly.co/node-rpc/rpc-reference",
      "https://docs.tenderly.co/node-rpc/overview#public-endpoint-limits",
    ],
    reviewedAt: "2026-11-08",
    // Keyless limits are a 1 GB/day per-IP egress cap, not a request rate.
    // Over 3,000 log results returns -32602, indistinguishable from invalid caller params.
    // Route log queries to the other providers instead of making that terminal error.
    unsupportedMethods: ["eth_getLogs"],
    capabilities: { archive: true },
  },
  {
    id: "ethereum-pocket",
    url: "https://eth.api.pocket.network",
    provider: "Pocket Network",
    sourceUrls: ["https://docs.pocket.network/developers/supported-chains/"],
    reviewedAt: "2026-11-08",
    // Published: "2,000 requests per IP per minute" (about 33 per second).
    rps: 33,
    capabilities: { archive: true },
  },
];

/** Public URL list retained for callers that supply their own endpoint budgets. */
export const ETHEREUM_MAINNET_ENDPOINTS: readonly string[] = ETHEREUM_MAINNET_REGISTRY.map(
  (endpoint) => endpoint.url,
);
