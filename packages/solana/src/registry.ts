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
    reviewedAt: "2026-11-06",
    rps: 3,
    burst: 3,
  },
  {
    id: "pocket",
    url: "https://solana.api.pocket.network",
    provider: "Pocket Network",
    sourceUrls: [
      "https://docs.pocket.network/developers/supported-chains/",
      "https://docs.pocket.network/developers/integration-examples/",
    ],
    reviewedAt: "2026-11-06",
    rps: 3,
    burst: 3,
    // Pocket documents this method as unreliable on its public Solana gateway.
    unsupportedMethods: ["getTokenAccountsByOwner"],
  },
  {
    id: "solana",
    url: "https://api.mainnet.solana.com",
    provider: "Solana",
    sourceUrls: ["https://solana.com/docs/references/clusters"],
    reviewedAt: "2026-11-06",
    // The public cluster limits each method to 40 requests per 10 seconds.
    rps: 3,
    burst: 3,
  },
  {
    id: "onfinality",
    url: "https://solana.api.onfinality.io/public",
    provider: "OnFinality",
    sourceUrls: ["https://www.onfinality.io/en/networks/solana"],
    reviewedAt: "2026-11-06",
    rps: 3,
    burst: 2,
  },
  {
    id: "solanavibestation",
    url: "https://public.rpc.solanavibestation.com",
    provider: "Solana Vibe Station",
    sourceUrls: [
      "https://solanavibestation.com/",
      "https://docs.solanavibestation.com/services/solana-node-services/rpc-services",
    ],
    reviewedAt: "2026-11-06",
    // This also respects the provider's stricter sendTransaction limit.
    rps: 1,
    burst: 1,
  },
  {
    id: "web3cdn",
    url: "https://solana.web3cdn.rest",
    provider: "Web3CDN",
    sourceUrls: ["https://web3cdn.network/rpc/solana"],
    reviewedAt: "2026-11-06",
    // Split the shared IP quota across the four shipped Web3CDN network defaults.
    rps: 0.025,
    burst: 2,
  },
];

/** Source-backed development network RPCs, isolated from mainnet. */
export const DEVNET_REGISTRY: readonly PublicRpcEndpoint[] = [
  {
    id: "solana-devnet",
    url: "https://api.devnet.solana.com",
    provider: "Solana",
    sourceUrls: ["https://solana.com/docs/references/clusters"],
    reviewedAt: "2026-11-06",
    rps: 3,
    burst: 3,
  },
  {
    id: "onfinality-devnet",
    url: "https://solana-devnet.api.onfinality.io/public",
    provider: "OnFinality",
    sourceUrls: ["https://www.onfinality.io/en/networks/solana-devnet"],
    reviewedAt: "2026-11-06",
    rps: 3,
    burst: 2,
  },
];

/** Source-backed test network RPCs, isolated from mainnet and devnet. */
export const TESTNET_REGISTRY: readonly PublicRpcEndpoint[] = [
  {
    id: "solana-testnet",
    url: "https://api.testnet.solana.com",
    provider: "Solana",
    sourceUrls: ["https://solana.com/docs/references/clusters"],
    reviewedAt: "2026-11-06",
    rps: 3,
    burst: 3,
  },
  {
    id: "publicnode-testnet",
    url: "https://solana-testnet-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: ["https://solana.publicnode.com/"],
    reviewedAt: "2026-11-06",
    rps: 3,
    burst: 3,
  },
  {
    id: "web3cdn-testnet",
    url: "https://solana-testnet.web3cdn.rest",
    provider: "Web3CDN",
    sourceUrls: ["https://web3cdn.network/rpc/solana"],
    reviewedAt: "2026-11-06",
    rps: 0.025,
    burst: 2,
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
