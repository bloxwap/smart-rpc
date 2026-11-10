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
  NON_IDEMPOTENT_METHODS,
  parseQuantity,
  shouldFailover,
  type BudgetConfig,
  type PinLatestOptions,
  type PoolOptions,
  type RpcPool,
} from "@smart-rpc/core";
import { isHex, keccak256 } from "viem";

import { connectViem, type ViemConnectionOptions } from "./viem.js";
import { ETHEREUM_MAINNET_REGISTRY } from "./registry.js";
import { supportsEvmRequest, validateCapabilities, type EthereumEndpointCapabilities } from "./capabilities.js";

export { ETHEREUM_MAINNET_ENDPOINTS } from "./registry.js";

/** CAIP-2 id for Ethereum mainnet. */
export const ETHEREUM_MAINNET_CAIP = "eip155:1";

// Explicit read extensions cannot turn transaction submission or wallet/admin calls into reads.
const WRITE_PREFIX = /^(?:eth_(?:send|sign|submit|new|uninstall|subscribe|unsubscribe)|personal_|wallet_|engine_|mev_|builder_|flashbots_)/;
const UNSAFE_EXTENSION = /send|sign|submit|subscribe|unsubscribe|^personal_|^wallet_|^engine_|^mev_|^builder_|^flashbots_/i;

/** A URL, or a URL plus label, weight, and budget. `wss:` URLs use viem `webSocket()`. */
export interface EthereumEndpointConfig {
  url: string;
  /** Public label. Default: the URL. */
  label?: string | undefined;
  weight?: number | undefined;
  rps?: number | undefined;
  burst?: number | undefined;
  /** HTTP authentication or provider headers. Never included in public endpoint labels. */
  headers?: Readonly<Record<string, string>> | undefined;
  /** An exact allowlist. Identity checks must remain permitted. */
  supportedMethods?: readonly string[] | undefined;
  unsupportedMethods?: readonly string[] | undefined;
  capabilities?: EthereumEndpointCapabilities | undefined;
  /** URLs sharing one provider allowance use the same group and budget. */
  providerGroup?: string | undefined;
  providerBudget?: BudgetConfig | undefined;
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
  /** Chain-specific cache planning. Default: reorg-safe EVM plans. */
  cachePolicy?: ReturnType<typeof evmCachePolicy> | undefined;
  /** Extra methods that must not be retried or raced. */
  nonIdempotentMethods?: readonly string[] | undefined;
  /** Explicit chain-specific read extensions safe to retry/race. Writes must never be included. */
  safeMethods?: readonly string[] | undefined;
  /** Chain-specific head growth bound used for peer outlier rejection. */
  maxUnitsPerSecond?: number | undefined;
  /**
   * Probe with `eth_getBlockByNumber("latest", false)` and invalidate cached state when a block hash is replaced
   * or the next block names a different parent. HyperEVM sets this. Default: false.
   */
  blockHashProbe?: boolean | undefined;
  /**
   * Fail over `eth_sendRawTransaction` and `eth_sendRawTransactionSync` on endpoint errors.
   * Default: true.
   */
  rebroadcastRawTransactions?: boolean | undefined;
}

/** Ethereum transport for `createSmartRpc({ transports })`. */
export function ethereum(options: EthereumOptions = {}): RpcPool {
  const chainId = options.chainId ?? 1;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`ethereum() chainId must be a positive integer, got ${String(chainId)}.`);
  }
  const chainIds = options.chainIds ?? [`eip155:${chainId}`];
  assertEthereumChainIds(chainId, chainIds, options.endpoints !== undefined);
  const endpoints = options.endpoints ?? defaultEndpoints(chainId);
  const timeout = options.timeout ?? 10_000;
  const skipPrecompiles = options.skipPrecompiles ?? false;
  const {
    chainId: _chainId,
    chainIds: _chainIds,
    endpoints: _endpoints,
    pinLatest,
    skipPrecompiles: _skip,
    cachePolicy,
    nonIdempotentMethods,
    safeMethods,
    maxUnitsPerSecond,
    rebroadcastRawTransactions,
    blockHashProbe,
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
      const caps = config.capabilities;
      validateCapabilities(caps);
      const connection = connectViem(config.url, {
        timeout, batch: endpointBatch(batch, caps), fetchFn, headers: config.headers, expectedChainId: chainId,
      });
      const unsupported = new Set(config.unsupportedMethods ?? []);
      const supported = config.supportedMethods ? new Set(config.supportedMethods) : undefined;
      if (options.verifyIdentity !== false && (unsupported.has("eth_chainId") || (supported && !supported.has("eth_chainId")))) {
        throw new Error("ethereum() endpoints must support eth_chainId verification. Use a separate submission connection for write-only sequencers.");
      }
      return {
        id: config.label ?? publicId(config.url, index),
        url: config.url,
        weight: config.weight,
        rps: config.rps,
        burst: config.burst,
        credentials: credentialKey(config.headers),
        providerGroup: config.providerGroup,
        providerBudget: config.providerBudget,
        pinning: caps?.pinning ?? caps?.archive !== false,
        call: connection.call,
        close: connection.close,
        retryAfter: connection.retryAfter,
        supports: (method: string): boolean =>
          method !== "eth_subscribe" && method !== "eth_unsubscribe" &&
          !unsupported.has(method) && (!supported || supported.has(method)),
        supportsRequest: (request: { method: string; params?: unknown }): boolean => supportsEvmRequest(caps, request),
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
      isSafeMethod: (method: string): boolean =>
        !WRITE_PREFIX.test(method) &&
        !NON_IDEMPOTENT_METHODS.includes(method) &&
        !(nonIdempotentMethods ?? []).includes(method) &&
        (isIdempotentMethod(method) || ((safeMethods ?? []).includes(method) && acceptedSafeMethod(method))),
      maxUnitsPerSecond,
      blockHashProbe,
      shareId: ethereumShareId({
        safeMethods: safeMethods ?? [],
        nonIdempotentMethods: nonIdempotentMethods ?? [],
        rebroadcast: rebroadcastRawTransactions ?? true,
        skipPrecompiles,
        pinLatest: pinLatest ?? null,
        maxUnitsPerSecond: maxUnitsPerSecond ?? null,
        fetchFn,
        batch: batch ?? null,
        blockHashProbe: blockHashProbe === true,
        cachePolicy,
      }),
      statefulMethods: {
        create: ["eth_newFilter", "eth_newBlockFilter", "eth_newPendingTransactionFilter", "eth_newFinalizedHeaderFilter"],
        use: ["eth_getFilterChanges", "eth_getFilterLogs"],
        release: ["eth_uninstallFilter"],
      },
      isRebroadcastMethod: (method: string): boolean =>
        (rebroadcastRawTransactions ?? true) && isRebroadcastMethod(method),
      shouldFailover,
      isBenignMiss: isBlockNotHeldError,
      isAlreadyKnown: isAlreadyKnownError,
      rebroadcastResult,
      cachePolicy: cachePolicy ?? evmCachePolicy(),
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
  if (typeof input === "string") return endpointConfig({ url: input });
  if (input.url.trim() === "") throw new Error("ethereum() endpoint url must not be empty.");
  return input;
}

function endpointBatch(
  batch: EthereumOptions["batch"],
  capabilities: EthereumEndpointCapabilities | undefined,
): EthereumOptions["batch"] {
  if (!batch || capabilities?.batch === false) return false;
  const config = typeof batch === "object" ? batch : {};
  const maximum = capabilities?.maxBatchSize;
  if (maximum === undefined) return batch;
  return { ...config, batchSize: Math.min(config.batchSize ?? maximum, maximum) };
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

function assertEthereumChainIds(chainId: number, chainIds: readonly string[], endpointsExplicit: boolean): void {
  if (chainIds.length === 0) throw new Error("ethereum() chainIds must include at least one CAIP-2 id.");
  const canonical = `eip155:${chainId}`;
  if (new Set(chainIds).size !== chainIds.length) throw new Error("ethereum() chainIds must be unique.");
  if (chainIds.length === 1 && chainIds[0] === canonical) return;
  if (!endpointsExplicit || !chainIds.includes(canonical)) {
    throw new Error(
      `ethereum() chainIds must be ${canonical}, the chain eth_chainId proves, unless endpoints are explicit and that id is included. Got ${chainIds.join(", ")}.`,
    );
  }
  for (const id of chainIds) {
    if (!/^[a-z0-9]{3,8}:[a-zA-Z0-9]{1,128}$/.test(id)) {
      throw new Error(`ethereum() chainIds entry "${id}" is not a CAIP-2 id.`);
    }
  }
}

function acceptedSafeMethod(method: string): boolean {
  return !UNSAFE_EXTENSION.test(method) && !WRITE_PREFIX.test(method) && !NON_IDEMPOTENT_METHODS.includes(method);
}

function credentialKey(headers: Readonly<Record<string, string>> | undefined): string | undefined {
  if (!headers) return undefined;
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return entries.length === 0 ? undefined : JSON.stringify(entries);
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

function ethereumShareId(input: {
  safeMethods: readonly string[];
  nonIdempotentMethods: readonly string[];
  rebroadcast: boolean;
  skipPrecompiles: boolean;
  pinLatest: EthereumOptions["pinLatest"] | null;
  maxUnitsPerSecond: number | null;
  fetchFn: EthereumOptions["fetchFn"];
  batch: EthereumOptions["batch"] | null;
  blockHashProbe: boolean;
  cachePolicy: EthereumOptions["cachePolicy"];
}): string {
  return JSON.stringify({
    safeMethods: input.safeMethods,
    nonIdempotentMethods: input.nonIdempotentMethods,
    rebroadcast: input.rebroadcast,
    skipPrecompiles: input.skipPrecompiles,
    pinLatest: input.pinLatest,
    maxUnitsPerSecond: input.maxUnitsPerSecond,
    fetch: functionId(input.fetchFn),
    batch: input.batch,
    blockHashProbe: input.blockHashProbe,
    cachePolicy: functionId(input.cachePolicy),
  });
}

/** `keccak256` of the signed bytes, which is the hash `eth_sendRawTransaction` returns. */
function rebroadcastResult(method: string, params: unknown): string | undefined {
  if (method !== "eth_sendRawTransaction" || !Array.isArray(params)) return undefined;
  const raw: unknown = params[0];
  if (typeof raw !== "string" || !isHex(raw, { strict: true })) return undefined;
  return keccak256(raw);
}
