import type { PublicRpcEndpoint } from "@smart-rpc/core";

/** Genesis hashes from smart-solana at ff5891a. */
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";

/** Alias used by `createSmartRpc` examples. The genesis-hash CAIP-2 id is registered too. */
export const SOLANA_MAINNET_CAIP = "solana:mainnet";
export const SOLANA_DEVNET_CAIP = "solana:devnet";
export const SOLANA_TESTNET_CAIP = "solana:testnet";

export const SOLANA_MAINNET_GENESIS_CAIP = `solana:${MAINNET_GENESIS_HASH}`;
export const SOLANA_DEVNET_GENESIS_CAIP = `solana:${DEVNET_GENESIS_HASH}`;
export const SOLANA_TESTNET_GENESIS_CAIP = `solana:${TESTNET_GENESIS_HASH}`;

export type SolanaCluster = "mainnet" | "devnet" | "testnet";

export interface SolanaEndpointConfig {
  url: string;
  label?: string | undefined;
  weight?: number | undefined;
  rps?: number | undefined;
  burst?: number | undefined;
  unsupportedMethods?: readonly string[] | undefined;
}

/** Methods PublicNode's keyless Solana gateways refuse without a personal token. */
const PUBLICNODE_TOKEN_GATED_METHODS: readonly string[] = [
  "getProgramAccounts",
  "getTokenAccountsByOwner",
  "getTokenAccountsByDelegate",
  "getTokenAccountBalance",
  "getTokenSupply",
  "getTokenLargestAccounts",
  "getSupply",
  "getLargestAccounts",
];

/**
 * Public HTTP RPCs that do not require an account or API key. Source review does
 * not guarantee availability. Budgets are conservative local routing limits;
 * chain checks, probes, retries, and ordinary calls all spend the same tokens.
 */
export const MAINNET_REGISTRY: readonly PublicRpcEndpoint[] = [
  {
    id: "publicnode",
    url: "https://solana-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: ["https://solana.publicnode.com/"],
    reviewedAt: "2026-11-08",
    rps: 3,
    burst: 3,
    // Live probes (2026-11-08) on mainnet and testnet: these return HTTP 403/-32602
    // "Indexed requests require a personal token" (getLargestAccounts: 410 disabled).
    // -32602 is terminal for callers, so the pool must never route them here.
    unsupportedMethods: PUBLICNODE_TOKEN_GATED_METHODS,
  },
  {
    id: "pocket",
    url: "https://solana.api.pocket.network",
    provider: "Pocket Network",
    sourceUrls: [
      "https://docs.pocket.network/developers/supported-chains/",
      "https://docs.pocket.network/developers/integration-examples/",
    ],
    reviewedAt: "2026-11-08",
    rps: 3,
    burst: 3,
    // Pocket documents getTokenAccountsByOwner as unreliable on its public Solana gateway.
    // getProgramAccounts for the SPL Token program returns terminal -32602 "not served by
    // this endpoint (multi-minute account-index scans)" (live probe 2026-11-08).
    unsupportedMethods: ["getTokenAccountsByOwner", "getProgramAccounts"],
  },
  {
    id: "solana",
    url: "https://api.mainnet.solana.com",
    provider: "Solana",
    sourceUrls: ["https://solana.com/docs/references/clusters"],
    reviewedAt: "2026-11-08",
    // The public cluster limits each method to 40 requests per 10 seconds.
    rps: 3,
    burst: 3,
  },
  {
    id: "solanavibestation",
    url: "https://public.rpc.solanavibestation.com",
    provider: "Solana Vibe Station",
    sourceUrls: [
      "https://solanavibestation.com/",
      "https://docs.solanavibestation.com/services/solana-node-services/rpc-services",
    ],
    reviewedAt: "2026-11-08",
    // Documented free tier: 5 r/s and 1 sendTransaction r/s. One budget covers every
    // method, so the stricter sendTransaction limit applies; mixed reads near 2.5 r/s
    // drew HTTP 429 in live probes (2026-11-08).
    rps: 1,
    burst: 1,
  },
];

/** Source-backed development network RPCs, isolated from mainnet. */
export const DEVNET_REGISTRY: readonly PublicRpcEndpoint[] = [
  {
    id: "solana-devnet",
    url: "https://api.devnet.solana.com",
    provider: "Solana",
    sourceUrls: ["https://solana.com/docs/references/clusters"],
    reviewedAt: "2026-11-08",
    rps: 3,
    burst: 3,
  },
  {
    id: "tatum-devnet",
    url: "https://solana-devnet.gateway.tatum.io",
    provider: "Tatum",
    sourceUrls: [
      "https://docs.tatum.io/reference/rpc-solana",
      "https://docs.tatum.io/changelog/anonymous-and-free-api-key-limits",
      "https://docs.tatum.io/docs/gateway-limits",
      "https://www.comparenodes.com/library/public-endpoints/solana/",
    ],
    reviewedAt: "2026-11-08",
    // Keyless use is capped at 10,000 credits/month, and the gateway's own HTTP 429
    // reads "limit of 5 requests per minute". This is a cold fallback for the
    // official devnet cluster, budgeted under that per-minute ceiling: a full burst plus
    // one minute of refill (2 + 0.05 * 60 = 5) never exceeds 5 requests in a minute.
    rps: 0.05,
    burst: 2,
    // Documented as unavailable to anonymous callers. getBalance returned -16401
    // "available for paid plans only" in a live probe (2026-11-08).
    unsupportedMethods: [
      "getBalance",
      "getConfirmedSignaturesForAddress2",
      "getProgramAccounts",
      "getSignaturesForAddress",
      "getTokenAccountsByOwner",
    ],
  },
];

/** Source-backed test network RPCs, isolated from mainnet and devnet. */
export const TESTNET_REGISTRY: readonly PublicRpcEndpoint[] = [
  {
    id: "solana-testnet",
    url: "https://api.testnet.solana.com",
    provider: "Solana",
    sourceUrls: ["https://solana.com/docs/references/clusters"],
    reviewedAt: "2026-11-08",
    rps: 3,
    burst: 3,
  },
  {
    id: "publicnode-testnet",
    url: "https://solana-testnet-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: [
      "https://solana.publicnode.com/",
      "https://www.comparenodes.com/library/public-endpoints/solana/",
    ],
    reviewedAt: "2026-11-08",
    rps: 3,
    burst: 3,
    // Live probes (2026-11-08) on mainnet and testnet: these return HTTP 403/-32602
    // "Indexed requests require a personal token" (getLargestAccounts: 410 disabled).
    // -32602 is terminal for callers, so the pool must never route them here.
    unsupportedMethods: PUBLICNODE_TOKEN_GATED_METHODS,
  },
];

/** Endpoint config arrays retain the original public API and provider labels. */
export const MAINNET_ENDPOINTS: readonly SolanaEndpointConfig[] = MAINNET_REGISTRY.map(endpointConfig);
export const DEVNET_ENDPOINTS: readonly SolanaEndpointConfig[] = DEVNET_REGISTRY.map(endpointConfig);
export const TESTNET_ENDPOINTS: readonly SolanaEndpointConfig[] = TESTNET_REGISTRY.map(endpointConfig);

function endpointConfig(endpoint: PublicRpcEndpoint): SolanaEndpointConfig {
  return {
    label: endpoint.id,
    url: endpoint.url,
    rps: endpoint.rps,
    burst: endpoint.burst,
    unsupportedMethods: endpoint.unsupportedMethods,
  };
}

export function defaultEndpoints(cluster: SolanaCluster): readonly SolanaEndpointConfig[] {
  if (cluster === "mainnet") return MAINNET_ENDPOINTS;
  if (cluster === "devnet") return DEVNET_ENDPOINTS;
  return TESTNET_ENDPOINTS;
}

export function defaultGenesisHash(cluster: SolanaCluster): string {
  if (cluster === "mainnet") return MAINNET_GENESIS_HASH;
  if (cluster === "devnet") return DEVNET_GENESIS_HASH;
  return TESTNET_GENESIS_HASH;
}

export function defaultChainIds(cluster: SolanaCluster): readonly string[] {
  if (cluster === "mainnet") return [SOLANA_MAINNET_CAIP, SOLANA_MAINNET_GENESIS_CAIP];
  if (cluster === "devnet") return [SOLANA_DEVNET_CAIP, SOLANA_DEVNET_GENESIS_CAIP];
  return [SOLANA_TESTNET_CAIP, SOLANA_TESTNET_GENESIS_CAIP];
}
