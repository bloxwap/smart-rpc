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
  /**
   * Extra reads that are safe to race and retry. Names that send, sign, submit, or airdrop are ignored.
   * Unknown methods are not safe unless listed here.
   */
  safeMethods?: readonly string[] | undefined;
}

/** Solana transport for `createSmartRpc({ transports })`. */
export function solana(options: SolanaOptions = {}): RpcPool {
  const cluster = options.cluster ?? "mainnet";
  const genesis = options.genesisHash ?? defaultGenesisHash(cluster);
  const chainIds = options.chainIds ?? defaultChainIds(cluster);
  assertSolanaChainIds(cluster, chainIds, genesis, options.endpoints !== undefined, options.genesisHash !== undefined);
  const endpoints = options.endpoints ?? defaultEndpoints(cluster);
  const {
    cluster: _cluster,
    chainIds: _chainIds,
    endpoints: _endpoints,
    genesisHash: _genesisHash,
    commitment,
    fetchFn,
    nonSafeMethods,
    safeMethods,
    ...poolOptions
  } = options;
  void _chainIds;
  void _genesisHash;
  void _cluster;
  void _endpoints;
  return createPool({
    ...poolOptions,
    endpoints: endpoints.map((input) => {
      const config = typeof input === "string" ? { url: input } : input;
      const unsupported = new Set(config.unsupportedMethods ?? []);
      return {
        id: config.label,
        url: config.url,
        weight: config.weight,
        rps: config.rps,
        burst: config.burst,
        call: jsonRpcCaller(config.url, fetchFn),
        supports: (method: string): boolean => !unsupported.has(method),
      };
    }),
    policy: {
      chainIds,
      probeMethod: "getSlot",
      probeParams: [{ commitment: commitment ?? "processed" }],
      parseHead: parseSlot,
      identityMethod: "getGenesisHash",
      identityParams: [],
      expectedIdentity: genesis,
      parseIdentity: (result: unknown): string | null =>
        typeof result === "string" && result.length > 0 ? result : null,
      isSafeMethod: (method: string): boolean => isSafeSolanaMethod(method, nonSafeMethods ?? [], safeMethods ?? []),
      shareId: JSON.stringify({
        cluster,
        commitment: commitment ?? "processed",
        genesis,
        nonSafeMethods: nonSafeMethods ?? [],
        safeMethods: safeMethods ?? [],
        fetch: functionId(fetchFn),
      }),
      isRebroadcastMethod: isSolanaRebroadcast,
      cachePolicy: solanaCachePolicy(),
      pin: false,
    },
  });
}

function assertSolanaChainIds(
  cluster: SolanaCluster,
  chainIds: readonly string[],
  genesis: string,
  endpointsExplicit: boolean,
  genesisExplicit: boolean,
): void {
  const alias = `solana:${cluster}`;
  const genesisId = `solana:${genesis}`;
  const expected = new Set([alias, genesisId]);
  const actual = new Set(chainIds);
  const matches = actual.size === expected.size && [...expected].every((id) => actual.has(id));
  if (matches) return;
  const explicit = endpointsExplicit && genesisExplicit && chainIds.includes(genesisId) &&
    chainIds.every((id) => id.startsWith("solana:") && id.length > "solana:".length);
  if (explicit) return;
  throw new Error(
    `solana() chainIds must be ${alias} and ${genesisId} unless endpoints and genesisHash are both set and the genesis id is included. Got ${chainIds.join(", ")}.`,
  );
}

const functionIds = new WeakMap<object, number>();
let nextFunctionId = 1;

function functionId(value: object | undefined): string {
  if (!value) return "";
  let id = functionIds.get(value);
  if (id === undefined) {
    id = nextFunctionId;
    nextFunctionId += 1;
    functionIds.set(value, id);
  }
  return String(id);
}
