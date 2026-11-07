/**
 * Freshness-bounded read cache with canonical chain-policy plans and hot-key refresh.
 *
 * Sends, errors, filters, subscriptions, nonces at `"latest"`, and gas estimates are not cached.
 * The reference's rolling `eth_getLogs` index is deliberately separate; log queries go upstream.
 * @module
 */

import { coalesceKey } from "./coalesce.js";
import type { RpcEvent } from "./events.js";
import { parseQuantity, toHexQuantity } from "./quantity.js";

/** Freshness units a cached `"latest"` answer may trail the newest head. */
export const DEFAULT_CACHE_MAX_STALE_BLOCKS = 1;

/** Milliseconds a cached fresh answer may be served. */
export const DEFAULT_CACHE_MAX_AGE_MS = 2_000;

/** Milliseconds between best-endpoint head ticks while keys are hot. */
export const DEFAULT_CACHE_REFRESH_INTERVAL_MS = 1_000;

/** Keys refreshed in the background. */
export const DEFAULT_CACHE_HOT_KEYS = 64;

/** A key not read for this long is no longer refreshed. */
export const DEFAULT_CACHE_HOT_IDLE_MS = 30_000;

/** Entries kept, least recently used first out. */
export const DEFAULT_CACHE_MAX_ENTRIES = 1_000;

/** Approximate bytes kept. */
export const DEFAULT_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface CacheOptions {
  /** Units a cached fresh answer may trail the newest known head. Default: 1. */
  maxStaleBlocks?: number | undefined;
  /** Milliseconds a cached fresh answer may be served. Default: 2000. */
  maxAgeMs?: number | undefined;
  /**
   * Milliseconds between head ticks while keys are hot. `false` disables ticks; observed heads still refresh keys.
   * Default: 1000.
   */
  refreshInterval?: number | false | undefined;
  /** Keys kept hot, least recently read first out. Default: 64. */
  hotKeys?: number | undefined;
  /** A key not read for this many milliseconds stops being refreshed. Default: 30000. */
  hotIdleMs?: number | undefined;
  /** Entries kept. Default: 1000. */
  maxEntries?: number | undefined;
  /** Approximate bytes kept. Default: 8 MiB. */
  maxBytes?: number | undefined;
  /** Deep-copy answers when they are stored and returned. Default: true. */
  copyResults?: boolean | undefined;
  /**
   * Reuse a cache plan when the same params array is passed again. The array and every nested value must never be
   * mutated, since identity is what detects reuse. Default: false.
   */
  immutableParams?: boolean | undefined;
}

export interface CacheConfig {
  enabled: boolean;
  maxStaleBlocks: number;
  maxAgeMs: number;
  refreshInterval: number | false;
  hotKeys: number;
  hotIdleMs: number;
  maxEntries: number;
  maxBytes: number;
  copyResults: boolean;
  immutableParams: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Background reads started. */
  refreshes: number;
  entries: number;
  bytes: number;
  hotKeys: number;
}

/** `"fresh"` is bounded by head lag and age. `"immutable"` is kept until eviction. */
export type CacheKind = "fresh" | "immutable";

export type CachePlanKind = "latest" | "timed" | "number" | "immutable";

/** A canonical cache key and the normalized params used for background reads. */
export interface CachePlan {
  kind: CachePlanKind;
  method: string;
  key: string;
  params: unknown;
  /** Explicit block for a numbered plan. */
  block?: number | undefined;
  /** Separate exact-block key for a numbered plan. */
  exact?: string | undefined;
  /** True when every servable endpoint must hold an explicit block before its result is stored. */
  guard?: boolean | undefined;
  /** Chain-opt-in permanent storage for a confirmed numbered result. */
  immutable?: boolean | undefined;
}

export interface CachePolicy {
  /** False when the method must never be cached. */
  classify(method: string, params: unknown): CacheKind | false;
  /** Canonical plans override the generic `classify` plus serialized-params fallback. */
  plan?: ((method: string, params: unknown) => CachePlan | undefined) | undefined;
}

export function resolveCache(value: boolean | CacheOptions | undefined): CacheConfig {
  const options = typeof value === "object" ? value : {};
  const config: CacheConfig = {
    enabled: value !== false,
    maxStaleBlocks: options.maxStaleBlocks ?? DEFAULT_CACHE_MAX_STALE_BLOCKS,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS,
    refreshInterval:
      options.refreshInterval === undefined ? DEFAULT_CACHE_REFRESH_INTERVAL_MS : options.refreshInterval,
    hotKeys: options.hotKeys ?? DEFAULT_CACHE_HOT_KEYS,
    hotIdleMs: options.hotIdleMs ?? DEFAULT_CACHE_HOT_IDLE_MS,
    maxEntries: options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
    maxBytes: options.maxBytes ?? DEFAULT_CACHE_MAX_BYTES,
    copyResults: options.copyResults ?? true,
    immutableParams: options.immutableParams ?? false,
  };
  for (const name of ["maxStaleBlocks", "maxAgeMs", "hotKeys", "hotIdleMs", "maxEntries", "maxBytes"] as const) {
    if (!Number.isFinite(config[name]) || config[name] < 0) {
      throw new Error(`smart-rpc cache.${name} must be a finite number, 0 or more, got ${String(config[name])}.`);
    }
  }
  if (config.refreshInterval !== false && !(Number.isFinite(config.refreshInterval) && config.refreshInterval > 0)) {
    throw new Error(
      `smart-rpc cache.refreshInterval must be a positive number or false, got ${String(config.refreshInterval)}.`,
    );
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
  kind: "latest" | "timed" | "number" | "immutable";
  result: unknown;
  at: number;
  block: number | undefined;
  bytes: number;
}

export interface CacheLookupContext {
  now: number;
  /** Newest trusted head, when the pool has one. */
  head: { block: number; ageMs: number } | undefined;
}

/** A background read's answer and the block it was pinned to. */
export interface CacheRead {
  result: unknown;
  block: number | undefined;
}

/** What the cache reads from, and sends through, its pool. */
export interface CacheSource {
  now: () => number;
  head: (method: string) => { block: number; ageMs: number } | undefined;
  /** The block every endpoint that may serve `method` is known to hold. */
  held: (method: string) => number | undefined;
  active: () => boolean;
  /** Send one head probe to the best endpoint with budget. */
  probe: () => Promise<void>;
  probeMethod: string;
  /** A read pinned to the newest servable head and coalesced, but never raced or hedged. */
  read: (method: string, params: unknown) => Promise<CacheRead>;
  /** True when an endpoint can take this read now without waiting for a budget token. */
  ready: (method: string) => boolean;
  emit: (event: RpcEvent) => void;
}

interface HotKey {
  plan: CachePlan;
  lastReadAt: number;
  refreshing: boolean;
  /** A foreground miss is in flight or failed; do not duplicate it in the background. */
  pending: boolean;
}

const HEX = /^0x[0-9a-f]*$/i;

/** One pool's read cache. */
export class ReadCache {
  readonly #config: CacheConfig;
  readonly #policy: CachePolicy;
  readonly #source: CacheSource | undefined;
  readonly #entries = new Map<string, Stored>();
  readonly #hot = new Map<string, HotKey>();
  readonly #plans = new WeakMap<object, Map<string, CachePlan | null>>();
  #bytes = 0;
  #hits = 0;
  #misses = 0;
  #refreshes = 0;
  #generation = 0;
  #servedHead = -1;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #dueAt = 0;
  #roundQueued = false;
  #closed = false;

  constructor(config: CacheConfig, policy: CachePolicy, source?: CacheSource) {
    this.#config = config;
    this.#policy = policy;
    this.#source = source;
  }

  /** Discard state after an observed reorg, including fills begun before that observation. */
  invalidate(): void {
    this.#generation += 1;
    this.#entries.clear();
    this.#bytes = 0;
    this.#servedHead = -1;
  }

  stats(): CacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      refreshes: this.#refreshes,
      entries: this.#entries.size,
      bytes: this.#bytes,
      hotKeys: this.#hot.size,
    };
  }

  /** The newest fresh trusted EVM head, never lower than one already returned. */
  blockNumber(): string | undefined {
    const head = this.#source?.head("eth_blockNumber");
    if (!head || head.ageMs > this.#config.maxAgeMs) return undefined;
    if (head.block > this.#servedHead) this.#servedHead = head.block;
    return toHexQuantity(this.#servedHead);
  }

  lookup(
    method: string,
    params: unknown,
    idempotent: boolean,
    context?: CacheLookupContext,
  ): CacheHit | CacheMiss | undefined {
    if (!idempotent || this.#closed) return undefined;
    const plan = this.#plan(method, params);
    if (!plan) return undefined;
    const now = this.#source?.now() ?? context?.now ?? Date.now();
    const hit = this.#serve(plan, now, context);
    const hot = this.#source && (plan.kind === "latest" || plan.kind === "timed")
      ? this.#watch(plan, now)
      : undefined;
    if (hit) {
      if (hot) hot.pending = false;
      this.#hits += 1;
      return { hit: true, result: this.#copy(hit.result), stale: hit.stale };
    }
    if (hot) hot.pending = true;
    this.#misses += 1;
    const generation = this.#generation;
    return {
      hit: false,
      fill: (result: unknown, block: number | undefined): void => {
        if (generation !== this.#generation) return;
        this.#fill(plan, result, block, context);
      },
    };
  }

  /** Re-arm a tick timer a Worker runtime dropped with the invocation that set it. */
  touch(): void {
    if (this.#hot.size === 0 || this.#closed) return;
    if (this.#timer !== undefined && Date.now() < this.#dueAt) return;
    this.#arm();
  }

  /** A head moved. Refresh hot keys behind it once the current task yields. */
  headChanged(): void {
    if (this.#roundQueued || this.#closed || this.#hot.size === 0) return;
    this.#roundQueued = true;
    queueMicrotask(() => {
      this.#roundQueued = false;
      this.#round(false);
    });
  }

  /** Stop ticks. Existing entries remain for calls already in flight, but new fills are ignored. */
  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #plan(method: string, params: unknown): CachePlan | undefined {
    const compute = (): CachePlan | undefined => {
      const planned = this.#policy.plan?.(method, params);
      if (planned) return planned;
      if (this.#policy.plan) return undefined;
      const kind = this.#policy.classify(method, params);
      if (kind === false) return undefined;
      const key = coalesceKey(method, params);
      return key === undefined
        ? undefined
        : { kind: kind === "immutable" ? "immutable" : "latest", method, key, params };
    };
    if (!this.#config.immutableParams || !Array.isArray(params)) return compute();
    let methods = this.#plans.get(params);
    if (!methods) {
      methods = new Map();
      this.#plans.set(params, methods);
    }
    if (methods.has(method)) return methods.get(method) ?? undefined;
    const plan = compute();
    methods.set(method, plan ?? null);
    return plan;
  }

  #serve(
    plan: CachePlan,
    now: number,
    context: CacheLookupContext | undefined,
  ): { result: unknown; stale: number | null } | undefined {
    if (plan.kind === "timed") {
      const entry = this.#value(plan.key, "timed");
      if (!entry || now - entry.at > this.#config.maxAgeMs) return undefined;
      return { result: entry.result, stale: null };
    }
    if (plan.kind === "immutable") {
      const entry = this.#value(plan.key, "immutable");
      return entry ? { result: entry.result, stale: 0 } : undefined;
    }
    if (plan.kind === "number") {
      if (plan.block === undefined || plan.exact === undefined) return undefined;
      const latest = this.#value(plan.key, "latest");
      if (latest?.block === plan.block) {
        return plan.immutable
          ? { result: latest.result, stale: 0 }
          : this.#fresh(latest, now, this.#head(plan.method, context));
      }
      const entry = this.#entries.get(plan.exact);
      if (entry?.kind === "immutable") {
        this.#value(plan.exact, "immutable");
        return { result: entry.result, stale: 0 };
      }
      if (entry?.kind !== "number") return undefined;
      this.#value(plan.exact, "number");
      return this.#fresh(entry, now, this.#head(plan.method, context));
    }
    const entry = this.#value(plan.key, "latest");
    return entry ? this.#fresh(entry, now, this.#head(plan.method, context)) : undefined;
  }

  #fresh(
    entry: Stored,
    now: number,
    head: { block: number; ageMs: number } | undefined,
  ): { result: unknown; stale: number | null } | undefined {
    if (now - entry.at > this.#config.maxAgeMs) return undefined;
    if (!head || entry.block === undefined) return { result: entry.result, stale: null };
    const stale = head.block - entry.block;
    if (stale < 0 || stale > this.#config.maxStaleBlocks) return undefined;
    return { result: entry.result, stale };
  }

  #fill(
    plan: CachePlan,
    result: unknown,
    block: number | undefined,
    context: CacheLookupContext | undefined,
  ): void {
    if (this.#closed || result === null || result === undefined) return;
    // Pending inclusion is mutable even on a chain whose confirmed results are immutable.
    if (INCLUSION.has(plan.method) && blockOf(result) === null) return;
    const now = this.#source?.now() ?? context?.now ?? Date.now();
    const stored = this.#store(result);
    if (plan.kind === "timed") {
      this.#set(plan.key, {
        kind: "timed",
        result: stored.result,
        block: this.#head(plan.method, context)?.block ?? -1,
        at: now,
        bytes: stored.bytes,
      });
      return;
    }
    if (plan.kind === "immutable") {
      this.#set(plan.key, {
        kind: "immutable",
        result: stored.result,
        block: this.#head(plan.method, context)?.block ?? -1,
        at: now,
        bytes: stored.bytes,
      });
      return;
    }
    if (plan.kind === "number") {
      if (plan.block === undefined || plan.exact === undefined) return;
      const held = this.#source?.held(plan.method) ?? context?.head?.block;
      if (plan.guard && (held === undefined || held < plan.block)) return;
      this.#set(plan.exact, {
        kind: plan.immutable ? "immutable" : "number",
        result: stored.result,
        block: plan.immutable ? plan.block : (held ?? plan.block),
        at: now,
        bytes: stored.bytes,
      });
      return;
    }
    const ownBlock = plan.method === "eth_getBlockByNumber" ? blockOf(result) : null;
    const stamped = ownBlock ?? block ?? this.#source?.held(plan.method) ?? context?.head?.block;
    this.#set(plan.key, {
      kind: "latest",
      result: stored.result,
      block: stamped,
      at: now,
      bytes: stored.bytes,
    });
  }

  #watch(plan: CachePlan, now: number): HotKey | undefined {
    const existing = this.#hot.get(plan.key);
    if (existing) {
      this.#hot.delete(plan.key);
      existing.lastReadAt = now;
      existing.plan = plan;
      this.#hot.set(plan.key, existing);
    } else {
      this.#hot.set(plan.key, { plan, lastReadAt: now, refreshing: false, pending: false });
      while (this.#hot.size > this.#config.hotKeys) {
        const oldest = this.#hot.keys().next().value;
        if (oldest === undefined) break;
        this.#hot.delete(oldest);
      }
    }
    this.touch();
    return this.#hot.get(plan.key);
  }

  #arm(): void {
    if (this.#config.refreshInterval === false || this.#closed) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#dueAt = Date.now() + this.#config.refreshInterval;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#tick();
    }, this.#config.refreshInterval);
    unrefTimer(this.#timer);
  }

  async #tick(): Promise<void> {
    const source = this.#source;
    if (!source) return;
    const now = source.now();
    for (const [key, hot] of this.#hot) if (now - hot.lastReadAt > this.#config.hotIdleMs) this.#hot.delete(key);
    if (this.#hot.size === 0 || this.#closed) return;
    this.#arm();
    if (!source.active()) return;
    this.#round(true);
    if (source.ready(source.probeMethod)) await source.probe();
  }

  #round(tick: boolean): void {
    const source = this.#source;
    if (!source || this.#closed || !source.active()) return;
    for (const hot of [...this.#hot.values()]) {
      if (hot.refreshing || hot.pending) continue;
      const params = this.#stale(hot.plan, tick);
      if (params === undefined || !source.ready(hot.plan.method)) continue;
      hot.refreshing = true;
      void this.#read(hot.plan.method, params).finally(() => {
        hot.refreshing = false;
      });
    }
  }

  #stale(plan: CachePlan, tick: boolean): unknown {
    const source = this.#source;
    if (!source) return undefined;
    if (plan.kind === "timed") return tick ? plan.params : undefined;
    if (plan.kind !== "latest") return undefined;
    const head = source.head(plan.method)?.block;
    const entry = this.#value(plan.key, "latest");
    if (head === undefined) return undefined;
    const interval = this.#config.refreshInterval === false ? 0 : this.#config.refreshInterval;
    if (entry?.block !== undefined && entry.block >= head && source.now() - entry.at + interval <= this.#config.maxAgeMs) {
      return undefined;
    }
    return plan.params;
  }

  async #read(method: string, params: unknown): Promise<boolean> {
    const source = this.#source;
    const plan = this.#plan(method, params);
    if (!source || !plan || this.#closed) return false;
    const generation = this.#generation;
    this.#refreshes += 1;
    source.emit({ type: "cache", method, outcome: "refresh", stale: null });
    try {
      const read = await source.read(method, params);
      if (generation === this.#generation) this.#fill(plan, read.result, read.block, undefined);
      return generation === this.#generation;
    } catch {
      // A failed refresh leaves the previous, still-valid entry in place.
      return false;
    }
  }

  #head(
    method: string,
    context: CacheLookupContext | undefined,
  ): { block: number; ageMs: number } | undefined {
    return this.#source?.head(method) ?? context?.head;
  }

  #value(key: string, kind: Stored["kind"]): Stored | undefined {
    const entry = this.#entries.get(key);
    if (entry?.kind !== kind) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  #set(key: string, entry: Stored): void {
    const hot = this.#hot.get(key);
    if (hot) hot.pending = false;
    const previous = this.#entries.get(key);
    if (previous) {
      this.#bytes -= previous.bytes;
      this.#entries.delete(key);
    }
    this.#entries.set(key, entry);
    this.#bytes += entry.bytes;
    for (const [oldest, old] of this.#entries) {
      if (this.#entries.size <= this.#config.maxEntries && this.#bytes <= this.#config.maxBytes) break;
      this.#entries.delete(oldest);
      this.#bytes -= old.bytes;
    }
  }

  #store(value: unknown): { result: unknown; bytes: number } {
    return this.#config.copyResults ? copyWithSize(value) : { result: value, bytes: sizeOf(value) };
  }

  #copy(value: unknown): unknown {
    return this.#config.copyResults ? copy(value) : value;
  }
}

/** Where an EVM method carries its block tag and whether an omitted tag means latest. */
interface BlockSlot {
  index: number;
  implied: boolean;
  latest: boolean;
  state: boolean;
}

const BLOCK_SLOTS: ReadonlyMap<string, BlockSlot> = new Map([
  ["eth_call", { index: 1, implied: true, latest: true, state: true }],
  ["eth_getBalance", { index: 1, implied: true, latest: true, state: true }],
  ["eth_getCode", { index: 1, implied: true, latest: true, state: true }],
  ["eth_getStorageAt", { index: 2, implied: true, latest: true, state: true }],
  ["eth_getTransactionCount", { index: 1, implied: true, latest: false, state: true }],
  ["eth_getBlockByNumber", { index: 0, implied: false, latest: true, state: false }],
  ["eth_getBlockTransactionCountByNumber", { index: 0, implied: false, latest: false, state: false }],
  ["eth_getTransactionByBlockNumberAndIndex", { index: 0, implied: false, latest: false, state: false }],
]);

const BY_HASH: ReadonlySet<string> = new Set([
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockTransactionCountByHash",
  "eth_getTransactionByBlockHashAndIndex",
]);

const INCLUSION: ReadonlySet<string> = new Set([
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
]);

const ALWAYS_IMMUTABLE: ReadonlySet<string> = new Set([
  "eth_getBlockByHash",
  "eth_getBlockTransactionCountByHash",
  "eth_getTransactionByBlockHashAndIndex",
]);

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

export interface EvmCachePolicyOptions {
  /**
   * Keep confirmed numbered, EIP-1898 hash, transaction, and receipt results until eviction. Enable only for a chain
   * without reorganizations. Default: false.
   */
  immutable?: boolean | undefined;
  /** Return true for `eth_call` targets whose block tag is ignored and whose entries are bounded only by age. */
  isTimedCall?: ((call: unknown) => boolean) | undefined;
}

/** Compute one canonical EVM plan. Safe/finalized stay distinct and fresh; pending is never cached. */
export function evmCachePlan(
  method: string,
  params: unknown,
  options: EvmCachePolicyOptions = {},
): CachePlan | undefined {
  if (NEVER.has(method)) return undefined;
  if (method === "eth_chainId") {
    return { kind: "immutable", method, key: "eth_chainId", params: [] };
  }
  if (!Array.isArray(params)) return undefined;
  const normalized = normalize(params) as unknown[];
  if (BY_HASH.has(method)) {
    const key = coalesceKey(method, normalized);
    if (key === undefined) return undefined;
    const immutable = options.immutable === true || ALWAYS_IMMUTABLE.has(method);
    return { kind: immutable ? "immutable" : "latest", method, key, params: normalized };
  }
  const slot = BLOCK_SLOTS.get(method);
  if (!slot || normalized.length < slot.index) return undefined;
  if (method === "eth_call" && options.isTimedCall?.(normalized[0])) {
    const key = coalesceKey(method, withTag(normalized, slot.index, "latest"));
    return key === undefined ? undefined : { kind: "timed", method, key, params: normalized };
  }
  const tag = readTag(normalized[slot.index], slot.implied);
  if (tag === undefined) return undefined;
  if (tag === "hash" || tag === "fresh") {
    const key = coalesceKey(method, normalized);
    if (key === undefined) return undefined;
    const kind = tag === "hash" && options.immutable ? "immutable" : "latest";
    return { kind, method, key, params: normalized };
  }
  const key = coalesceKey(method, withTag(normalized, slot.index, "latest"));
  if (key === undefined) return undefined;
  if (tag === "latest") {
    return slot.latest ? { kind: "latest", method, key, params: normalized } : undefined;
  }
  const exact = coalesceKey(method, withTag(normalized, slot.index, toHexQuantity(tag)));
  if (exact === undefined) return undefined;
  return {
    kind: "number",
    method,
    key,
    params: normalized,
    block: tag,
    exact,
    guard: slot.state,
    immutable: options.immutable === true,
  };
}

/** EVM cache policy. Numbered state stays fresh unless a no-reorg chain explicitly opts into immutable results. */
export function evmCachePolicy(options: EvmCachePolicyOptions = {}): CachePolicy {
  const plan = (method: string, params: unknown): CachePlan | undefined => evmCachePlan(method, params, options);
  return {
    plan,
    classify(method: string, params: unknown): CacheKind | false {
      const planned = plan(method, params);
      if (!planned) return false;
      return planned.kind === "immutable" || planned.immutable === true ? "immutable" : "fresh";
    },
  };
}

/** A finality tag, latest, a block number, EIP-1898 hash, or undefined for a tag that is never cached. */
function readTag(tag: unknown, implied: boolean): "latest" | "fresh" | "hash" | number | undefined {
  if (tag === undefined) return implied ? "latest" : undefined;
  if (tag === "latest") return "latest";
  if (tag === "safe" || tag === "finalized") return "fresh";
  if (tag === "earliest") return 0;
  if (typeof tag === "string") return parseQuantity(tag) ?? undefined;
  if (!isRecord(tag)) return undefined;
  if (typeof tag.blockHash === "string") return "hash";
  return readTag(tag.blockNumber, false);
}

function withTag(params: readonly unknown[], index: number, tag: string): unknown[] {
  const next = params.slice();
  next[index] = tag;
  return next;
}

/** The block number of a block or transaction result, or null when it has none. */
function blockOf(result: unknown): number | null {
  if (!isRecord(result)) return null;
  const field = "number" in result ? result.number : result.blockNumber;
  return parseQuantity(field);
}

/** A deep copy of JSON params with every hex string lower-cased. */
function normalize(value: unknown): unknown {
  if (typeof value === "string") return HEX.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(normalize);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = normalize(value[key]);
    return out;
  }
  return value;
}

function copy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copy);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = copy(value[key]);
    return out;
  }
  return value;
}

function copyWithSize(value: unknown): { result: unknown; bytes: number } {
  let bytes = 0;
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      bytes += 16 + item.length * 2;
      return item;
    }
    if (Array.isArray(item)) {
      bytes += 16;
      return item.map(walk);
    }
    if (isRecord(item)) {
      bytes += 32;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(item)) {
        bytes += key.length * 2;
        out[key] = walk(item[key]);
      }
      return out;
    }
    bytes += 8;
    return item;
  };
  return { result: walk(value), bytes };
}

function sizeOf(value: unknown): number {
  if (typeof value === "string") return 16 + value.length * 2;
  if (Array.isArray(value)) {
    let total = 16;
    for (const item of value) total += sizeOf(item);
    return total;
  }
  if (isRecord(value)) {
    let total = 32;
    for (const key of Object.keys(value)) total += key.length * 2 + sizeOf(value[key]);
    return total;
  }
  return 8;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}
