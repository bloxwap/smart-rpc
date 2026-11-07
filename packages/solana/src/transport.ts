/**
 * Solana JSON-RPC transport.
 *
 * The pool is `@smart-rpc/core` (HyperEVM scoring, breaker, retries, and cache bounds).
 * Probes are `getSlot`. A `getGenesisHash` mismatch quarantines the endpoint.
 * @module
 */

import { createPool, type PoolOptions, type RpcPool } from "@smart-rpc/core";

import { jsonRpcCaller, type FetchLike } from "./client.js";
import { isSafeSolanaMethod, isSolanaRebroadcast, parseSlot, solanaCachePolicy } from "./methods.js";
import {
  defaultChainIds,
  defaultEndpoints,
  defaultGenesisHash,
  type SolanaCluster,
  type SolanaEndpointConfig,
} from "./registry.js";

export interface SolanaOptions extends Omit<PoolOptions, "endpoints" | "policy"> {
  /** Cluster whose default endpoints and genesis hash are used. Default: `"mainnet"`. */
  cluster?: SolanaCluster | undefined;
  /** CAIP-2 ids. Default: `solana:mainnet` (or devnet/testnet) plus the genesis-hash form. */
  chainIds?: readonly string[] | undefined;
  /** Complete endpoint override. Omit to use the cluster's source-backed public registry and budgets. */
  endpoints?: readonly (string | SolanaEndpointConfig)[] | undefined;
  /** Expected `getGenesisHash`. Default: the cluster's genesis hash. */
  genesisHash?: string | undefined;
  /** Commitment sent with `getSlot` probes. Default: `"processed"`, matching smart-solana. */
  commitment?: "processed" | "confirmed" | "finalized" | undefined;
  fetchFn?: FetchLike | undefined;
  /** Extra methods that must not be raced or retried. */
  nonSafeMethods?: readonly string[] | undefined;
}

/** Solana transport for `createSmartRpc({ transports })`. */
export function solana(options: SolanaOptions = {}): RpcPool {
  const cluster = options.cluster ?? "mainnet";
  const endpoints = options.endpoints ?? defaultEndpoints(cluster);
  const {
    cluster: _cluster,
    chainIds,
    endpoints: _endpoints,
    genesisHash,
    commitment,
    fetchFn,
    nonSafeMethods,
    ...poolOptions
  } = options;
  void _cluster;
  void _endpoints;
  return createPool({
    ...poolOptions,
    endpoints: endpoints.map((input, index) => {
      const config = typeof input === "string" ? { url: input } : input;
      const unsupported = new Set(config.unsupportedMethods ?? []);
      return {
        id: config.label ?? config.url ?? `solana:${index}`,
        url: config.url,
        weight: config.weight,
        rps: config.rps,
        burst: config.burst,
        call: jsonRpcCaller(config.url, fetchFn),
        supports: (method: string): boolean => !unsupported.has(method),
      };
    }),
    policy: {
      chainIds: chainIds ?? defaultChainIds(cluster),
      probeMethod: "getSlot",
      probeParams: [{ commitment: commitment ?? "processed" }],
      parseHead: parseSlot,
      identityMethod: "getGenesisHash",
      identityParams: [],
      expectedIdentity: genesisHash ?? defaultGenesisHash(cluster),
      parseIdentity: (result: unknown): string | null =>
        typeof result === "string" && result.length > 0 ? result : null,
      isSafeMethod: (method: string): boolean => isSafeSolanaMethod(method, nonSafeMethods ?? []),
      isRebroadcastMethod: isSolanaRebroadcast,
      cachePolicy: solanaCachePolicy(),
      pin: false,
    },
  });
}
