/**
 * Freshness-bounded read cache.
 *
 * Defaults match the HyperEVM transport at 092b8f9: a `"latest"` answer may trail the newest head by
 * one unit and must be younger than 2 seconds. Sends, errors, filters, subscriptions, nonces at
 * `"latest"`, and gas estimates are not cached. The reference's rolling `eth_getLogs` index is not
 * part of this v1 cache; log queries go upstream.
 * @module
 */

import { coalesceKey } from "./coalesce.js";

/** Freshness units a cached `"latest"` answer may trail the newest head. */
export const DEFAULT_CACHE_MAX_STALE_BLOCKS = 1;

/** Milliseconds a cached fresh answer may be served. */
export const DEFAULT_CACHE_MAX_AGE_MS = 2_000;

/** Entries kept, least recently used first out. */
export const DEFAULT_CACHE_MAX_ENTRIES = 1_000;

/** Approximate bytes kept. */
export const DEFAULT_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface CacheOptions {
  /** Units a cached fresh answer may trail the newest known head. Default: 1. */
  maxStaleBlocks?: number | undefined;
  /** Milliseconds a cached fresh answer may be served. Default: 2000. */
  maxAgeMs?: number | undefined;
  /** Entries kept. Default: 1000. */
  maxEntries?: number | undefined;
  /** Approximate bytes kept. Default: 8 MiB. */
  maxBytes?: number | undefined;
  /** Deep-copy answers when they are stored and returned. Default: true. */
  copyResults?: boolean | undefined;
}

export interface CacheConfig {
  enabled: boolean;
  maxStaleBlocks: number;
  maxAgeMs: number;
  maxEntries: number;
  maxBytes: number;
  copyResults: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  refreshes: number;
  entries: number;
  bytes: number;
  hotKeys: number;
}

/** `"fresh"` is bounded by head lag and age. `"immutable"` is kept until eviction. */
export type CacheKind = "fresh" | "immutable";

export interface CachePolicy {
  /** False when the method must never be cached. */
  classify(method: string, params: unknown): CacheKind | false;
}

export function resolveCache(value: boolean | CacheOptions | undefined): CacheConfig {
  const options = typeof value === "object" ? value : {};
  const config: CacheConfig = {
    enabled: value !== false,
    maxStaleBlocks: options.maxStaleBlocks ?? DEFAULT_CACHE_MAX_STALE_BLOCKS,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS,
    maxEntries: options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
    maxBytes: options.maxBytes ?? DEFAULT_CACHE_MAX_BYTES,
    copyResults: options.copyResults ?? true,
  };
  for (const name of ["maxStaleBlocks", "maxAgeMs", "maxEntries", "maxBytes"] as const) {
    if (!Number.isFinite(config[name]) || config[name] < 0) {
      throw new Error(`smart-rpc cache.${name} must be a finite number, 0 or more, got ${String(config[name])}.`);
    }
  }
  return config;
}

export interface CacheHit {
  hit: true;
  result: unknown;
  stale: number | null;
}

export interface CacheMiss {
  hit: false;
  fill: (result: unknown, block: number | undefined) => void;
}

interface Stored {
  result: unknown;
  at: number;
  block: number | undefined;
  kind: CacheKind;
  bytes: number;
}

export interface CacheLookupContext {
  now: number;
  /** Newest trusted head, when the pool has one. */
  head: { block: number; ageMs: number } | undefined;
}

/** One pool's read cache. */
export class ReadCache {
  readonly #config: CacheConfig;
  readonly #policy: CachePolicy;
  readonly #entries = new Map<string, Stored>();
  #bytes = 0;
  #hits = 0;
  #misses = 0;

  constructor(config: CacheConfig, policy: CachePolicy) {
    this.#config = config;
    this.#policy = policy;
  }

  stats(): CacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      refreshes: 0,
      entries: this.#entries.size,
      bytes: this.#bytes,
      hotKeys: 0,
    };
  }

  lookup(
    method: string,
    params: unknown,
    idempotent: boolean,
    context: CacheLookupContext,
  ): CacheHit | CacheMiss | undefined {
    if (!idempotent) return undefined;
    const kind = this.#policy.classify(method, params);
    if (kind === false) return undefined;
    const key = coalesceKey(method, params);
    if (key === undefined) return undefined;
    const stored = this.#entries.get(key);
    const hit = stored ? this.#serve(stored, kind, context) : undefined;
    if (hit) {
      this.#hits += 1;
      this.#entries.delete(key);
      this.#entries.set(key, stored as Stored);
      return { hit: true, result: this.#copy(hit.result), stale: hit.stale };
    }
    this.#misses += 1;
    return {
      hit: false,
      fill: (result: unknown, block: number | undefined): void => {
        this.#fill(key, kind, result, block, context.now);
      },
    };
  }

  #serve(stored: Stored, kind: CacheKind, context: CacheLookupContext): { result: unknown; stale: number | null } | undefined {
    if (stored.kind !== kind) return undefined;
    if (kind === "immutable") return { result: stored.result, stale: null };
    if (context.now - stored.at > this.#config.maxAgeMs) return undefined;
    if (stored.block === undefined || !context.head) return { result: stored.result, stale: null };
    const stale = context.head.block - stored.block;
    if (stale < 0 || stale > this.#config.maxStaleBlocks) return undefined;
    return { result: stored.result, stale };
  }

  #fill(key: string, kind: CacheKind, result: unknown, block: number | undefined, now: number): void {
    const stored = this.#copy(result);
    const bytes = sizeOf(stored);
    const previous = this.#entries.get(key);
    if (previous) this.#bytes -= previous.bytes;
    this.#entries.set(key, { result: stored, at: now, block, kind, bytes });
    this.#bytes += bytes;
    while (this.#entries.size > this.#config.maxEntries || this.#bytes > this.#config.maxBytes) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.#entries.get(oldest);
      this.#entries.delete(oldest);
      if (entry) this.#bytes -= entry.bytes;
      if (this.#entries.size === 0) break;
    }
  }

  #copy(value: unknown): unknown {
    if (!this.#config.copyResults) return value;
    if (typeof structuredClone === "function") {
      try {
        return structuredClone(value);
      } catch {
        return value;
      }
    }
    return value;
  }
}

function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 1;
  } catch {
    return 1;
  }
}

const NEVER: ReadonlySet<string> = new Set([
  "eth_subscribe",
  "eth_unsubscribe",
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_feeHistory",
  "eth_maxPriorityFeePerGas",
  "eth_blobBaseFee",
  "eth_sendRawTransaction",
  "eth_sendRawTransactionSync",
  "eth_sendTransaction",
  "eth_sign",
  "eth_signTransaction",
  "eth_getLogs",
]);

const IMMUTABLE: ReadonlySet<string> = new Set([
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockTransactionCountByHash",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_chainId",
]);

const FRESH: ReadonlySet<string> = new Set([
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getBlockByNumber",
  "eth_blockNumber",
]);

/**
 * EVM cache policy. Nonces at `"latest"` or `"pending"` are never cached.
 * Reads named by hash are immutable. State reads are fresh.
 */
export function evmCachePolicy(): CachePolicy {
  return {
    classify(method: string, params: unknown): CacheKind | false {
      if (NEVER.has(method)) return false;
      if (IMMUTABLE.has(method)) return "immutable";
      if (method === "eth_getTransactionCount") {
        const tag: unknown = Array.isArray(params) ? params[1] : undefined;
        if (tag === undefined || tag === "latest" || tag === "pending") return false;
        return "immutable";
      }
      if (FRESH.has(method)) return "fresh";
      return false;
    },
  };
}
