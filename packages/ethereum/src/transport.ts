/**
 * Ethereum JSON-RPC transport.
 *
 * Routing lives in `@smart-rpc/core`. This package supplies `eth_blockNumber` probes,
 * `eth_chainId` quarantine, block-tag pinning, and viem `http()` / `webSocket()` children.
 * @module
 */

import {
  blockNumberFromResult,
  createPool,
  evmCachePolicy,
  isAlreadyKnownError,
  isBlockNotHeldError,
  isIdempotentMethod,
  isRebroadcastMethod,
  parseQuantity,
  shouldFailover,
  type PinLatestOptions,
  type PoolOptions,
  type RpcPool,
} from "@smart-rpc/core";
import { isHex, keccak256 } from "viem";

import { connectViem, type ViemConnectionOptions } from "./viem.js";
import { ETHEREUM_MAINNET_REGISTRY } from "./registry.js";

export { ETHEREUM_MAINNET_ENDPOINTS } from "./registry.js";

/** CAIP-2 id for Ethereum mainnet. */
export const ETHEREUM_MAINNET_CAIP = "eip155:1";

/** A URL, or a URL plus label, weight, and budget. `wss:` URLs use viem `webSocket()`. */
export interface EthereumEndpointConfig {
  url: string;
  /** Public label. Default: the URL. */
  label?: string | undefined;
  weight?: number | undefined;
  rps?: number | undefined;
  burst?: number | undefined;
  unsupportedMethods?: readonly string[] | undefined;
}

export type EthereumEndpoint = string | EthereumEndpointConfig;

export interface EthereumOptions
  extends Omit<PoolOptions, "endpoints" | "policy">,
    Pick<ViemConnectionOptions, "batch" | "fetchFn"> {
  /** Numeric EIP-155 chain id endpoints must report. Default: 1. */
  chainId?: number | undefined;
  /** CAIP-2 ids this transport serves. Default: [`eip155:${chainId}`]. */
  chainIds?: readonly string[] | undefined;
  /** Explicit endpoints replace the defaults. Chain 1 defaults to {@link ETHEREUM_MAINNET_REGISTRY} with its budgets. */
  endpoints?: readonly EthereumEndpoint[] | undefined;
  /**
   * Rewrite `"latest"` to one block every servable endpoint holds.
   * HyperCore precompile calls are left alone only when `skipPrecompiles` is true. Default: on.
   */
  pinLatest?: boolean | PinLatestOptions | undefined;
  /** Skip `eth_call` to HyperCore precompiles `0x…0800`–`0x…08ff`. Default: false. HyperEVM sets true. */
  skipPrecompiles?: boolean | undefined;
  /** Extra methods that must not be retried or raced. */
  nonIdempotentMethods?: readonly string[] | undefined;
  /**
   * Fail over `eth_sendRawTransaction` and `eth_sendRawTransactionSync` on endpoint errors.
   * Default: true.
   */
  rebroadcastRawTransactions?: boolean | undefined;
}

/** Ethereum transport for `createSmartRpc({ transports })`. */
export function ethereum(options: EthereumOptions = {}): RpcPool {
  const chainId = options.chainId ?? 1;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`ethereum() chainId must be a positive integer, got ${String(chainId)}.`);
  }
  const chainIds = options.chainIds ?? [`eip155:${chainId}`];
  const endpoints = options.endpoints ?? defaultEndpoints(chainId);
  const timeout = options.timeout ?? 10_000;
  const skipPrecompiles = options.skipPrecompiles ?? false;
  const {
    chainId: _chainId,
    chainIds: _chainIds,
    endpoints: _endpoints,
    pinLatest,
    skipPrecompiles: _skip,
    nonIdempotentMethods,
    rebroadcastRawTransactions,
    batch,
    fetchFn,
    ...poolOptions
  } = options;
  void _chainId;
  void _chainIds;
  void _endpoints;
  void _skip;
  return createPool({
    ...poolOptions,
    timeout,
    endpoints: endpoints.map((input, index) => {
      const config = endpointConfig(input);
      const connection = connectViem(config.url, { timeout, batch, fetchFn });
      const unsupported = new Set(config.unsupportedMethods ?? []);
      return {
        id: config.label ?? publicId(config.url, index),
        url: config.url,
        weight: config.weight,
        rps: config.rps,
        burst: config.burst,
        call: connection.call,
        retryAfter: connection.retryAfter,
        supports: (method: string): boolean => !unsupported.has(method),
      };
    }),
    policy: {
      chainIds,
      probeMethod: "eth_blockNumber",
      probeParams: [],
      parseHead: parseQuantity,
      headFromResult: blockNumberFromResult,
      identityMethod: "eth_chainId",
      identityParams: [],
      expectedIdentity: chainId,
      parseIdentity: parseQuantity,
      isSafeMethod: (method: string): boolean => isIdempotentMethod(method, nonIdempotentMethods ?? []),
      isRebroadcastMethod: (method: string): boolean =>
        (rebroadcastRawTransactions ?? true) && isRebroadcastMethod(method),
      shouldFailover,
      isBenignMiss: isBlockNotHeldError,
      isAlreadyKnown: isAlreadyKnownError,
      rebroadcastResult,
      cachePolicy: evmCachePolicy(),
      pin: resolveEvmPin(pinLatest, skipPrecompiles),
    },
  });
}

function defaultEndpoints(chainId: number): readonly EthereumEndpoint[] {
  if (chainId === 1) {
    return ETHEREUM_MAINNET_REGISTRY.map(({ url, rps, burst, unsupportedMethods }) => ({
      url,
      rps,
      burst,
      unsupportedMethods,
    }));
  }
  throw new Error(
    `ethereum() has no default endpoints for chain ${chainId}. Pass endpoints, or use a chain package that knows them.`,
  );
}

function endpointConfig(input: EthereumEndpoint): EthereumEndpointConfig {
  if (typeof input === "string") return { url: input };
  if (input.url.trim() === "") throw new Error("ethereum() endpoint url must not be empty.");
  return input;
}

function publicId(url: string, index: number): string {
  try {
    const parsed = new URL(url);
    if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "") return parsed.origin;
    return url;
  } catch {
    return `endpoint:${index}`;
  }
}

function resolveEvmPin(
  value: boolean | PinLatestOptions | undefined,
  skipPrecompiles: boolean,
): boolean | PinLatestOptions {
  if (value === false) return false;
  const options = typeof value === "object" ? value : {};
  return { ...options, skipPrecompiles: options.skipPrecompiles ?? skipPrecompiles };
}

/** `keccak256` of the signed bytes, which is the hash `eth_sendRawTransaction` returns. */
function rebroadcastResult(method: string, params: unknown): string | undefined {
  if (method !== "eth_sendRawTransaction" || !Array.isArray(params)) return undefined;
  const raw: unknown = params[0];
  if (typeof raw !== "string" || !isHex(raw, { strict: true })) return undefined;
  return keccak256(raw);
}
