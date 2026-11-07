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
 * Keyless defaults. Budgets are the provider starting points from smart-solana, not a change to core retry policy.
 */
export const MAINNET_ENDPOINTS: readonly SolanaEndpointConfig[] = [
  { label: "publicnode", url: "https://solana-rpc.publicnode.com", rps: 50, burst: 10 },
  { label: "pocket", url: "https://solana.api.pocket.network", rps: 30, burst: 10 },
  { label: "solana", url: "https://api.mainnet-beta.solana.com", rps: 8, burst: 8 },
  { label: "solanatracker", url: "https://rpc.solanatracker.io/public", rps: 4, burst: 4 },
];

export const DEVNET_ENDPOINTS: readonly SolanaEndpointConfig[] = [
  { label: "solana-devnet", url: "https://api.devnet.solana.com", rps: 8, burst: 8 },
];

export const TESTNET_ENDPOINTS: readonly SolanaEndpointConfig[] = [
  { label: "solana-testnet", url: "https://api.testnet.solana.com", rps: 8, burst: 8 },
];

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
