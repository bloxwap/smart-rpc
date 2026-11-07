import { coalesceKey } from "./coalesce.js";
import { parseQuantity, toHexQuantity } from "./quantity.js";

/** Blocks retained by each rolling filter index. */
export const DEFAULT_LOG_INDEX_WINDOW = 1_000;

/** Filter indexes retained, least recently used first out. */
export const DEFAULT_LOG_INDEX_MAX_ENTRIES = 1_000;

/** Approximate bytes retained across all filter indexes. */
export const DEFAULT_LOG_INDEX_MAX_BYTES = 8 * 1024 * 1024;

export type LogFilter = Record<string, unknown>;
export type LogValue = Record<string, unknown>;
export type LogBlockBound = number | "latest";

export interface RollingLogQueryPlan {
  kind: "rolling";
  /** Canonical identity of address/topics and all other non-range filter fields. */
  key: string;
  /** Normalized filter without `fromBlock` or `toBlock`. */
  filter: LogFilter;
  from: LogBlockBound;
  to: LogBlockBound;
}

export interface BlockHashLogQueryPlan {
  kind: "blockHash";
  /** Canonical identity including the block hash, suitable for a separate immutable cache. */
  key: string;
  filter: LogFilter;
}

export type LogQueryPlan = RollingLogQueryPlan | BlockHashLogQueryPlan;

export interface LogIndexOptions {
  /** Inclusive block span retained per filter. Default: 1000. */
  window?: number | undefined;
  /** Maximum number of filter indexes. Default: 1000. */
  maxEntries?: number | undefined;
  /** Approximate memory budget across indexes and their logs. Default: 8 MiB. */
  maxBytes?: number | undefined;
  /**
   * Deep-copy logs on input and output. When false, input logs and selected logs are shared and must be treated as
   * immutable by both the provider and caller. Default: true.
   */
  copyResults?: boolean | undefined;
}

export interface LogIndexConfig {
  window: number;
  maxEntries: number;
  maxBytes: number;
  copyResults: boolean;
}

export interface LogRange {
  from: number;
  to: number;
}

export interface LogIndexLookupContext {
  /** Newest trusted chain head. Required when either filter bound is `latest`. */
  head: number | undefined;
  /** Allowed head lag for a latest-ended hit. Numeric ranges never use this slack. Default: 0. */
  maxStaleBlocks?: number | undefined;
  /** Maximum age of a latest-ended hit. Numeric ranges do not expire by age. Default: Infinity. */
  maxAgeMs?: number | undefined;
  /** Clock reading used for freshness checks. Default: Date.now(). */
  now?: number | undefined;
}

export interface LogIndexHit {
  hit: true;
  result: LogValue[];
  /** Blocks behind the supplied head for a latest-ended query; always zero for a numeric end. */
  stale: number;
  /** The exact inclusive range answered, which can end before the head when stale hits are allowed. */
  range: LogRange;
}

export interface LogIndexFetch {
  kind: "seed" | "range" | "tail" | "refresh";
  key: string;
  filter: LogFilter;
  from: number;
  to: number;
  /** Numeric, closed-range params for the pool to fetch. No network request is made by this module. */
  params: [LogFilter & { fromBlock: string; toBlock: string }];
  /**
   * Merge a successful response for exactly this fetch. Returns false for malformed/out-of-range results, a changed
   * base index, or invalidation while the request was in flight. `at` defaults to Date.now().
   */
  fill: (result: unknown, at?: number) => boolean;
}

export interface LogIndexMiss {
  hit: false;
  fetch: LogIndexFetch;
}

export interface LogIndexStats {
  /** Number of filter indexes, not the number of logs. */
  entries: number;
  logs: number;
  bytes: number;
}

export interface LogIndexMetadata {
  key: string;
  from: number;
  to: number;
  logCount: number;
  bytes: number;
  updatedAt: number;
}

interface StoredLog {
  blockNumber: number;
  logIndex: number;
  value: LogValue;
  bytes: number;
}

interface Entry {
  from: number;
  to: number;
  logs: StoredLog[];
  bytes: number;
  updatedAt: number;
}

interface ParsedLog extends StoredLog {
  fingerprint: string | undefined;
}

/** Parse an eth_getLogs argument into a rolling plan or an explicitly separate block-hash plan. */
export function planLogQuery(params: unknown): LogQueryPlan | undefined {
  if (!Array.isArray(params) || params.length !== 1 || !isRecord(params[0])) return undefined;
  const filter = normalizeFilter(params[0]);
  if (!filter) return undefined;
  if (filter.blockHash !== undefined && filter.blockHash !== null) {
    if (typeof filter.blockHash !== "string") return undefined;
    const key = coalesceKey("eth_getLogs", filter);
    return key === undefined ? undefined : { kind: "blockHash", key, filter };
  }
  const { fromBlock, toBlock, ...rest } = filter;
  const from = readBound(fromBlock);
  const to = readBound(toBlock);
  const key = coalesceKey("eth_getLogs", rest);
  if (from === undefined || to === undefined || key === undefined) return undefined;
  return { kind: "rolling", key, filter: rest, from, to };
}

/** Canonical range-free identity for a rolling filter. Block-hash filters have no rolling identity. */
export function canonicalLogFilterKey(filter: unknown): string | undefined {
  if (!isRecord(filter)) return undefined;
  const normalized = normalizeFilter(filter);
  if (!normalized || (normalized.blockHash !== undefined && normalized.blockHash !== null)) return undefined;
  const { fromBlock: _fromBlock, toBlock: _toBlock, ...rest } = normalized;
  return coalesceKey("eth_getLogs", rest);
}

export function resolveLogIndexConfig(options: LogIndexOptions = {}): LogIndexConfig {
  const config: LogIndexConfig = {
    window: options.window ?? DEFAULT_LOG_INDEX_WINDOW,
    maxEntries: options.maxEntries ?? DEFAULT_LOG_INDEX_MAX_ENTRIES,
    maxBytes: options.maxBytes ?? DEFAULT_LOG_INDEX_MAX_BYTES,
    copyResults: options.copyResults ?? true,
  };
  if (!Number.isInteger(config.window) || config.window < 1) {
    throw new Error(`smart-rpc logIndex.window must be a positive integer, got ${String(config.window)}.`);
  }
  if (!Number.isInteger(config.maxEntries) || config.maxEntries < 0) {
    throw new Error(`smart-rpc logIndex.maxEntries must be a non-negative integer, got ${String(config.maxEntries)}.`);
  }
  if (!Number.isFinite(config.maxBytes) || config.maxBytes < 0) {
    throw new Error(`smart-rpc logIndex.maxBytes must be a finite number, 0 or more, got ${String(config.maxBytes)}.`);
  }
  return config;
}

/** Resolve omitted/latest bounds against a trusted head, rejecting inverted ranges. */
export function resolveLogRange(plan: RollingLogQueryPlan, head: number | undefined): LogRange | undefined {
  if (head !== undefined && (!Number.isSafeInteger(head) || head < 0)) return undefined;
  const from = plan.from === "latest" ? head : plan.from;
  const to = plan.to === "latest" ? head : plan.to;
  if (from === undefined || to === undefined || from > to) return undefined;
  return { from, to };
}

/**
 * Chain-local rolling log indexes. Use one instance per pool/chain and invalidate it on observed reorgs.
 * All fetch execution, endpoint capability checks, cancellation, and retry policy remain with the integrator.
 */
export class LogIndex {
  readonly #config: LogIndexConfig;
  readonly #entries = new Map<string, Entry>();
  #bytes = 0;
  #logs = 0;
  #generation = 0;

  constructor(options: LogIndexOptions | LogIndexConfig = {}) {
    this.#config = resolveLogIndexConfig(options);
  }

  stats(): LogIndexStats {
    return { entries: this.#entries.size, logs: this.#logs, bytes: this.#bytes };
  }

  metadata(key: string): LogIndexMetadata | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    return {
      key,
      from: entry.from,
      to: entry.to,
      logCount: entry.logs.length,
      bytes: entry.bytes,
      updatedAt: entry.updatedAt,
    };
  }

  /**
   * Answer a covered range or describe the exact range to fetch. Latest-ended hits obey freshness bounds; numeric
   * hits require complete coverage. A miss retains the old index until `fetch.fill` succeeds.
   */
  lookup(plan: RollingLogQueryPlan, context: LogIndexLookupContext): LogIndexHit | LogIndexMiss | undefined {
    const range = resolveLogRange(plan, context.head);
    if (!range) return undefined;
    const now = context.now ?? Date.now();
    const maxStale = context.maxStaleBlocks ?? 0;
    const maxAge = context.maxAgeMs ?? Number.POSITIVE_INFINITY;
    const entry = this.#get(plan.key);

    if (entry) {
      const startsCovered = range.from >= entry.from && range.from <= entry.to;
      const stale = Math.max(0, range.to - entry.to);
      const endCovered = range.to <= entry.to || (plan.to === "latest" && stale <= maxStale);
      const fresh = plan.to !== "latest" || now - entry.updatedAt <= maxAge;
      if (startsCovered && endCovered && fresh) {
        const served = { from: range.from, to: Math.min(range.to, entry.to) };
        return {
          hit: true,
          result: selectLogs(entry.logs, served.from, served.to, this.#config.copyResults),
          stale: plan.to === "latest" ? stale : 0,
          range: served,
        };
      }
    }

    let kind: LogIndexFetch["kind"] = entry ? "range" : "seed";
    let from = range.from;
    if (entry && range.from >= entry.from && range.from <= entry.to + 1 && range.to > entry.to) {
      kind = "tail";
      from = entry.to + 1;
    } else if (entry && plan.to === "latest" && range.from >= entry.from && range.to <= entry.to) {
      kind = "refresh";
    }

    const filter = copy(plan.filter) as LogFilter;
    const fetchFilter = {
      ...filter,
      fromBlock: toHexQuantity(from),
      toBlock: toHexQuantity(range.to),
    };
    const generation = this.#generation;
    return {
      hit: false,
      fetch: {
        kind,
        key: plan.key,
        filter,
        from,
        to: range.to,
        params: [fetchFilter],
        fill: (result: unknown, at: number = Date.now()): boolean =>
          this.#merge(plan.key, from, range.to, result, entry, generation, at),
      },
    };
  }

  /** Discard all chain data and prevent every outstanding pre-invalidation fill from being stored. */
  invalidate(): void {
    this.#generation += 1;
    this.#entries.clear();
    this.#bytes = 0;
    this.#logs = 0;
  }

  reset(): void {
    this.invalidate();
  }

  /** Evict least-recently-used indexes until both supplied shared-cache allowances are met. */
  trim(maxEntries: number, maxBytes: number): void {
    for (const [oldest, old] of this.#entries) {
      if (this.#entries.size <= maxEntries && this.#bytes <= maxBytes) break;
      this.#entries.delete(oldest);
      this.#bytes -= old.bytes;
      this.#logs -= old.logs.length;
    }
  }

  #get(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  #merge(
    key: string,
    from: number,
    to: number,
    result: unknown,
    expected: Entry | undefined,
    generation: number,
    updatedAt: number,
  ): boolean {
    if (generation !== this.#generation) return false;
    const base = this.#entries.get(key);
    // A replaced base makes a tail stale. Concurrent first seeds may still merge into the base created by a sibling.
    if (expected !== undefined && base !== expected) return false;
    const incoming = parseLogs(result, from, to, this.#config.copyResults);
    if (!incoming) return false;

    let low = from;
    let high = to;
    let logs = incoming;
    if (base && from === base.to + 1) {
      low = base.from;
      logs = base.logs.concat(incoming);
    } else if (base && to === base.from - 1) {
      high = base.to;
      logs = incoming.concat(base.logs);
    } else if (base && from <= base.to && to >= base.from) {
      low = Math.min(from, base.from);
      high = Math.max(to, base.to);
      const retained = base.logs.filter((log) => log.blockNumber < from || log.blockNumber > to);
      logs = retained.concat(incoming).sort(byPosition);
    }

    low = Math.max(low, high - this.#config.window + 1);
    logs = logs.slice(firstAtBlock(logs, low));
    const entry: Entry = { from: low, to: high, logs, bytes: entryBytes(key, logs), updatedAt };
    this.#set(key, entry);
    return true;
  }

  #set(key: string, entry: Entry): void {
    const previous = this.#entries.get(key);
    if (previous) {
      this.#bytes -= previous.bytes;
      this.#logs -= previous.logs.length;
      this.#entries.delete(key);
    }
    this.#entries.set(key, entry);
    this.#bytes += entry.bytes;
    this.#logs += entry.logs.length;
    this.trim(this.#config.maxEntries, this.#config.maxBytes);
  }
}

function readBound(bound: unknown): LogBlockBound | undefined {
  if (bound === undefined || bound === null || bound === "latest") return "latest";
  if (bound === "earliest") return 0;
  const parsed = parseQuantity(bound);
  return parsed === null ? undefined : parsed;
}

function normalizeFilter(filter: LogFilter): LogFilter | undefined {
  const state = { invalid: false };
  const normalized = normalize(filter, new Set(), state);
  return state.invalid ? undefined : (normalized as LogFilter);
}

function normalize(value: unknown, path: Set<object>, state: { invalid: boolean }): unknown {
  if (typeof value === "string") return /^0x[0-9a-f]*$/i.test(value) ? value.toLowerCase() : value;
  if (typeof value !== "object" || value === null) return value;
  if (path.has(value)) {
    state.invalid = true;
    return null;
  }
  path.add(value);
  if (Array.isArray(value)) {
    const out = value.map((item) => normalize(item, path, state));
    path.delete(value);
    return out;
  }
  const out: LogFilter = {};
  for (const key of Object.keys(value)) out[key] = normalize((value as LogFilter)[key], path, state);
  path.delete(value);
  return out;
}

function parseLogs(result: unknown, from: number, to: number, copyResults: boolean): StoredLog[] | undefined {
  if (!Array.isArray(result)) return undefined;
  const unique = new Map<string, ParsedLog>();
  for (const item of result) {
    if (!isRecord(item)) return undefined;
    const blockNumber = parseQuantity(item.blockNumber);
    const logIndex = parseQuantity(item.logIndex);
    if (blockNumber === null || logIndex === null || blockNumber < from || blockNumber > to) return undefined;
    const position = `${blockNumber}:${logIndex}`;
    const fingerprint = coalesceKey("log", item);
    const previous = unique.get(position);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return undefined;
      continue;
    }
    const stored = copyResults ? copyWithSize(item) : sizeOf(item);
    if (!stored) return undefined;
    unique.set(position, {
      blockNumber,
      logIndex,
      value: (copyResults ? stored.value : item) as LogValue,
      bytes: stored.bytes + 48,
      fingerprint,
    });
  }
  return [...unique.values()].sort(byPosition);
}

function selectLogs(logs: readonly StoredLog[], from: number, to: number, copyResults: boolean): LogValue[] {
  const out: LogValue[] = [];
  for (let index = firstAtBlock(logs, from); index < logs.length; index += 1) {
    const log = logs[index];
    if (!log || log.blockNumber > to) break;
    out.push(copyResults ? (copy(log.value) as LogValue) : log.value);
  }
  return out;
}

function firstAtBlock(logs: readonly StoredLog[], block: number): number {
  let low = 0;
  let high = logs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((logs[middle]?.blockNumber ?? block) < block) low = middle + 1;
    else high = middle;
  }
  return low;
}

function byPosition(left: StoredLog, right: StoredLog): number {
  return left.blockNumber - right.blockNumber || left.logIndex - right.logIndex;
}

function entryBytes(key: string, logs: readonly StoredLog[]): number {
  let bytes = 64 + key.length * 2;
  for (const log of logs) bytes += log.bytes;
  return bytes;
}

function copy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copy);
  if (isRecord(value)) {
    const out: LogFilter = {};
    for (const key of Object.keys(value)) out[key] = copy(value[key]);
    return out;
  }
  return value;
}

function copyWithSize(value: unknown): { value: unknown; bytes: number } | undefined {
  let bytes = 0;
  let valid = true;
  const path = new Set<object>();
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      bytes += 16 + item.length * 2;
      return item;
    }
    if (typeof item !== "object" || item === null) {
      bytes += 8;
      return item;
    }
    if (path.has(item)) {
      valid = false;
      return null;
    }
    path.add(item);
    if (Array.isArray(item)) {
      bytes += 16;
      const out = item.map(walk);
      path.delete(item);
      return out;
    }
    bytes += 32;
    const out: LogFilter = {};
    for (const key of Object.keys(item)) {
      bytes += key.length * 2;
      out[key] = walk((item as LogFilter)[key]);
    }
    path.delete(item);
    return out;
  };
  const copied = walk(value);
  return valid ? { value: copied, bytes } : undefined;
}

function sizeOf(value: unknown): { value: unknown; bytes: number } | undefined {
  let valid = true;
  const path = new Set<object>();
  const walk = (item: unknown): number => {
    if (typeof item === "string") return 16 + item.length * 2;
    if (typeof item !== "object" || item === null) return 8;
    if (path.has(item)) {
      valid = false;
      return 0;
    }
    path.add(item);
    let bytes = Array.isArray(item) ? 16 : 32;
    if (Array.isArray(item)) {
      for (const child of item) bytes += walk(child);
    } else {
      for (const key of Object.keys(item)) bytes += key.length * 2 + walk((item as LogFilter)[key]);
    }
    path.delete(item);
    return bytes;
  };
  const bytes = walk(value);
  return valid ? { value, bytes } : undefined;
}

function isRecord(value: unknown): value is LogFilter {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
