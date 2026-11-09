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

/**
 * 12s slots (measured 2026-11-08: 1,000 blocks in 12,036s, so few missed slots). Lag tolerance is one block, the
 * minimum, and the head-growth ceiling 0.104 blocks/s. Applied only to chain 1; other chain ids pass their own.
 */
const ETHEREUM_BLOCK_TIME_MS = 12_000;

// Explicit read extensions cannot turn transaction submission or wallet/admin calls into reads.
const WRITE_PREFIX = /^(?:eth_(?:send|sign|submit|new|uninstall|subscribe|unsubscribe)|personal_|wallet_|engine_|mev_|builder_|flashbots_)/;

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
  /** Chain-specific head growth bound used for peer outlier rejection. Default: from `blockTimeMs`, else 2. */
  maxUnitsPerSecond?: number | undefined;
  /**
   * Typical milliseconds between blocks. Sets the default `headLag.maxLag` to about one second of blocks (at least
   * one) and `maxUnitsPerSecond` to the production rate plus 25%. Chain packages set it from measured block times.
   * Default: 12000 on chain 1; unset elsewhere (`maxLag` 2, `maxUnitsPerSecond` 2).
   */
  blockTimeMs?: number | undefined;
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
    blockTimeMs,
    rebroadcastRawTransactions,
    batch,
    fetchFn,
    ...poolOptions
  } = options;
  const readableFetch = readableErrorBodies(fetchFn);
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
        timeout, batch: endpointBatch(batch, caps), fetchFn: readableFetch, headers: config.headers, expectedChainId: chainId,
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
        (isIdempotentMethod(method) || (safeMethods ?? []).includes(method)),
      maxUnitsPerSecond,
      blockTimeMs: blockTimeMs ?? (chainId === 1 ? ETHEREUM_BLOCK_TIME_MS : undefined),
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

type FetchFn = NonNullable<EthereumOptions["fetchFn"]>;

/**
 * A fetch whose non-2xx answers keep their reason. viem keeps the message of a JSON-RPC error body, but a JSON body
 * without the envelope (Sentio's HTTP 429 `{"code":8,"message":"public eth_getLogs is limited to 1000 blocks"}`)
 * reaches the pool as a bare "HTTP request failed" and reads as a rate limit. Such a body is rewritten into a
 * JSON-RPC error with the provider's message and the original body as `data`, under the same status and headers.
 */
function readableErrorBodies(fetchFn: FetchFn | undefined): FetchFn {
  return async (input, init) => {
    const response = await (fetchFn ?? globalThis.fetch)(input, init);
    if (response.ok) return response;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.clone().text());
    } catch {
      return response;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return response;
    if ("error" in parsed || "result" in parsed || !("message" in parsed) || typeof parsed.message !== "string") {
      return response;
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: parsed.message, data: parsed } });
    // Keep Retry-After and the rest, but describe the new body: the old length and encoding no longer apply.
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "application/json");
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  };
}

function defaultEndpoints(chainId: number): readonly EthereumEndpoint[] {
  if (chainId === 1) {
    // Capabilities and provider budgets are routing facts: dropping them would send archive reads to a
    // latest-only node, oversize batches or log ranges, or let URLs of one provider overspend its quota.
    return ETHEREUM_MAINNET_REGISTRY.map((entry) => {
      const shared = entry as { providerGroup?: string | undefined; providerBudget?: BudgetConfig | undefined };
      return {
        url: entry.url,
        rps: entry.rps,
        burst: entry.burst,
        unsupportedMethods: entry.unsupportedMethods,
        capabilities: entry.capabilities,
        providerGroup: shared.providerGroup,
        providerBudget: shared.providerBudget,
      };
    });
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

/** `keccak256` of the signed bytes, which is the hash `eth_sendRawTransaction` returns. */
function rebroadcastResult(method: string, params: unknown): string | undefined {
  if (method !== "eth_sendRawTransaction" || !Array.isArray(params)) return undefined;
  const raw: unknown = params[0];
  if (typeof raw !== "string" || !isHex(raw, { strict: true })) return undefined;
  return keccak256(raw);
}
