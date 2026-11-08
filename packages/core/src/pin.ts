/**
 * Pin `"latest"` to a block every endpoint that may serve the call holds.
 *
 * Ported from `@bloxwap/smart-hyperevm` `transport/_pin.ts` at 092b8f9.
 * Ethereum and HyperEVM transports use this. HyperEVM also skips HyperCore read
 * precompiles (`0x…0800`–`0x…08ff`), which ignore the block tag; Ethereum leaves
 * that skip off because those addresses are ordinary contracts there.
 * @module
 */

import { parseQuantity, toHexQuantity } from "./quantity.js";

/** Without a head this recent, nothing pins. HyperEVM makes about one block per second. */
export const DEFAULT_PIN_FRESH_MS = 1_000;

/** Options for `pinLatest`. */
export interface PinLatestOptions {
  /**
   * Pin only while some endpoint's head was seen in the last this many milliseconds.
   * Older heads still count as blocks their endpoints hold. Default: 1000.
   */
  freshMs?: number | undefined;
  /**
   * Answer the probe method locally with the block a pinned `"latest"` would use, when one exists.
   * Answers are monotonic until an observed reorganization. Default: true.
   */
  blockNumber?: boolean | undefined;
  /**
   * Skip `eth_call`s that target a HyperCore read precompile. Default: false.
   * HyperEVM turns this on. The reference transport always skips them.
   */
  skipPrecompiles?: boolean | undefined;
}

/** Resolved `pinLatest` settings. */
export interface PinConfig {
  enabled: boolean;
  freshMs: number;
  blockNumber: boolean;
  skipPrecompiles: boolean;
}

/** One endpoint's head, as the scoreboard reports it. */
export interface HeadReading {
  readonly id: string;
  readonly head: number;
  /** Milliseconds since the head was seen. */
  readonly ageMs: number;
  /** False when no reference head is believed or this head is ignored as implausible. */
  readonly trusted: boolean;
}

/** A block to pin to, and the endpoints known to hold it. */
export interface PinTarget {
  readonly block: number;
  readonly holders: ReadonlySet<string>;
}

/** What the pin reads from the pool. */
export interface PinSource {
  /** Heads seen in the last `maxAgeMs`, capped at the pool's `staleMs`. */
  heads: (maxAgeMs: number) => readonly HeadReading[];
  /** Blocks behind the highest servable head that still pin. */
  maxLag: number;
  /** True when `id` may serve `method` now. */
  servable: (id: string, method: string) => boolean;
}

export function resolvePin(value: boolean | PinLatestOptions | undefined, skipPrecompiles = false): PinConfig {
  const options = typeof value === "object" ? value : {};
  return {
    enabled: value !== false,
    freshMs: options.freshMs ?? DEFAULT_PIN_FRESH_MS,
    blockNumber: options.blockNumber ?? true,
    skipPrecompiles: options.skipPrecompiles ?? skipPrecompiles,
  };
}

/** Where a method carries its block tag, and whether an omitted tag means `"latest"`. */
const BLOCK_SLOTS: ReadonlyMap<string, { index: number; implied: boolean }> = new Map([
  ["eth_call", { index: 1, implied: true }],
  ["eth_getBalance", { index: 1, implied: true }],
  ["eth_getCode", { index: 1, implied: true }],
  ["eth_getTransactionCount", { index: 1, implied: true }],
  ["eth_getStorageAt", { index: 2, implied: true }],
  ["eth_estimateGas", { index: 1, implied: false }],
  ["eth_getBlockByNumber", { index: 0, implied: false }],
  ["eth_feeHistory", { index: 1, implied: false }],
]);

/**
 * `params` with every `"latest"`, given or implied, replaced by `block`. A copy, never the caller's object.
 * Returns `params` itself when nothing changes.
 */
export function pinParams(method: string, params: unknown, block: number, skipPrecompiles = false): unknown {
  if (!Array.isArray(params)) return params;
  if (method === "eth_getLogs") return pinLogs(params, block);
  if (method === "eth_call" && skipPrecompiles && isPrecompileCall(params[0])) return params;
  const slot = BLOCK_SLOTS.get(method);
  if (!slot || params.length < slot.index) return params;
  const tag: unknown = params[slot.index];
  const pinned = tag === undefined ? (slot.implied ? toHexQuantity(block) : undefined) : pinTag(tag, block);
  if (pinned === undefined) return params;
  const next = [...params];
  next[slot.index] = pinned;
  return next;
}

/** Methods that read the head with no block parameter at all. */
const HEAD_METHODS: ReadonlySet<string> = new Set([
  "eth_blockNumber",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_blobBaseFee",
  "eth_syncing",
]);

/** Methods whose omitted block parameter means the head, though pinning leaves them alone. */
const OPTIONAL_HEAD_TAG: ReadonlySet<string> = new Set(["eth_estimateGas", "eth_createAccessList"]);

function isHeadTag(tag: unknown): boolean {
  if (tag === "latest" || tag === "pending") return true;
  if (typeof tag !== "object" || tag === null || Array.isArray(tag) || "blockHash" in tag) return false;
  return "blockNumber" in tag && (tag.blockNumber === "latest" || tag.blockNumber === "pending");
}

/**
 * True when an EVM read answers from the chain head: a `"latest"` or `"pending"` tag, given or implied, a log
 * filter that ends at the head, or a head method such as `eth_gasPrice`. Block-hash, fixed-number, `"safe"`,
 * `"finalized"` and transaction-hash reads are not: a lagging endpoint answers them as well as a fresh one.
 */
export function isHeadSensitiveRead(method: string, params: unknown): boolean {
  if (HEAD_METHODS.has(method)) return true;
  const list: readonly unknown[] = Array.isArray(params) ? params : [];
  if (method === "eth_getLogs") {
    const filter: unknown = list[0];
    if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return false;
    if ("blockHash" in filter && filter.blockHash !== undefined && filter.blockHash !== null) return false;
    const fields = filter as { fromBlock?: unknown; toBlock?: unknown };
    return isHeadTag(fields.fromBlock ?? "latest") || isHeadTag(fields.toBlock ?? "latest");
  }
  const slot = BLOCK_SLOTS.get(method);
  const index = slot?.index ?? (OPTIONAL_HEAD_TAG.has(method) ? 1 : undefined);
  if (index !== undefined) {
    const tag: unknown = list[index];
    if (tag === undefined) return slot?.implied === true || OPTIONAL_HEAD_TAG.has(method);
    return isHeadTag(tag);
  }
  return list.some(isHeadTag);
}

/** HyperCore read precompiles live at `0x0000…0800` through `0x0000…08ff` and ignore the block tag. */
const PRECOMPILE_ADDRESS = /^0x0{37}8[0-9a-f]{2}$/i;

/** True when `call` (an `eth_call` params[0]) targets a HyperCore read precompile. */
export function isPrecompileCall(call: unknown): boolean {
  if (typeof call !== "object" || call === null || !("to" in call)) return false;
  return typeof call.to === "string" && PRECOMPILE_ADDRESS.test(call.to);
}

function pinTag(tag: unknown, block: number): unknown {
  if (tag === "latest") return toHexQuantity(block);
  if (typeof tag !== "object" || tag === null || Array.isArray(tag)) return undefined;
  if ("blockHash" in tag || !("blockNumber" in tag) || tag.blockNumber !== "latest") return undefined;
  return { ...tag, blockNumber: toHexQuantity(block) };
}

function pinLogs(params: readonly unknown[], block: number): unknown {
  const filter: unknown = params[0];
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return params;
  if ("blockHash" in filter && filter.blockHash !== undefined && filter.blockHash !== null) return params;
  const fields = filter as { fromBlock?: unknown; toBlock?: unknown };
  const from = fields.fromBlock ?? "latest";
  const to = fields.toBlock ?? "latest";
  const pinFrom = from === "latest";
  const pinTo = to === "latest";
  if (!pinFrom && !pinTo) return params;
  const fromBlock = pinFrom ? block : parseQuantity(from);
  const toBlock = pinTo ? block : parseQuantity(to);
  if (fromBlock !== null && toBlock !== null && fromBlock > toBlock) return params;
  return [
    { ...filter, fromBlock: pinFrom ? toHexQuantity(block) : from, toBlock: pinTo ? toHexQuantity(block) : to },
    ...params.slice(1),
  ];
}

/** `params` as sent, and the endpoints that may serve them when `"latest"` was pinned. */
export interface PinnedParams {
  readonly params: unknown;
  /** Undefined when nothing was pinned. Every endpoint may then serve the call. */
  readonly holders: ReadonlySet<string> | undefined;
  /** The block `"latest"` was pinned to. Undefined when nothing was pinned. */
  readonly block: number | undefined;
}

export interface TargetOptions {
  /** Require a head seen in the last `freshMs`. Default: true. */
  fresh?: boolean | undefined;
  /** Pin to the highest head instead of the floor. Default: false. */
  top?: boolean | undefined;
}

const unpinned = (params: unknown): PinnedParams => ({ params, holders: undefined, block: undefined });

/** Per-pool pinning. Holds the highest probe answer it has returned. */
export class LatestPin {
  readonly #config: PinConfig;
  readonly #source: PinSource;
  /** Method whose local answer is the pinned block. EVM transports pass `eth_blockNumber`. */
  readonly #probeMethod: string;
  #served = -1;

  constructor(config: PinConfig, source: PinSource, probeMethod = "eth_blockNumber") {
    this.#config = config;
    this.#source = source;
    this.#probeMethod = probeMethod;
  }

  /** Forget the previous monotonic answer after an observed chain reorganization. */
  reset(): void { this.#served = 0; }

  /** True when the probe method is answered locally. */
  get answersBlockNumber(): boolean {
    return this.#config.enabled && this.#config.blockNumber;
  }

  /**
   * The block a pinned `method` would read, and the endpoints known to hold it, or null when nothing pins.
   * The block is the lowest trusted head within `maxLag` of the highest, raised to the last probe answer
   * returned while an endpoint holds that.
   */
  target(method: string, options: TargetOptions = {}): PinTarget | null {
    const readings: HeadReading[] = [];
    let fresh = options.fresh === false;
    let top: number | null = null;
    for (const reading of this.#source.heads(Number.POSITIVE_INFINITY)) {
      if (!reading.trusted || !this.#source.servable(reading.id, method)) continue;
      readings.push(reading);
      if (reading.ageMs <= this.#config.freshMs) fresh = true;
      if (top === null || reading.head > top) top = reading.head;
    }
    if (!fresh || top === null) return null;
    const cutoff = top - this.#source.maxLag;
    let floor = top;
    for (const reading of readings) if (reading.head >= cutoff && reading.head < floor) floor = reading.head;
    const block = options.top === true ? top : this.#served > floor && this.#served <= top ? this.#served : floor;
    const holders = new Set<string>();
    for (const reading of readings) if (reading.head >= block) holders.add(reading.id);
    return { block, holders };
  }

  /** `params` with `"latest"` pinned for a safe read while a target exists, and who may serve it. */
  pin(method: string, params: unknown, idempotent: boolean): PinnedParams {
    if (!this.#config.enabled || !idempotent) return unpinned(params);
    return this.#pinAt(method, params, {});
  }

  /** Pin a cache refresh to the newest servable head, whether foreground pinning is enabled or not. */
  pinTop(method: string, params: unknown): PinnedParams {
    return this.#pinAt(method, params, { top: true, fresh: false });
  }

  #pinAt(method: string, params: unknown, options: TargetOptions): PinnedParams {
    if (method !== "eth_getLogs" && !BLOCK_SLOTS.has(method)) return unpinned(params);
    const target = this.target(method, options);
    if (target === null) return unpinned(params);
    const pinned = pinParams(method, params, target.block, this.#config.skipPrecompiles);
    return pinned === params ? unpinned(params) : { params: pinned, holders: target.holders, block: target.block };
  }

  /** The local probe answer, or undefined when it must go upstream. */
  blockNumber(): string | undefined {
    if (!this.answersBlockNumber) return undefined;
    const target = this.target(this.#probeMethod);
    return target === null ? undefined : toHexQuantity(this.#serve(target.block));
  }

  /** An upstream probe answer, lowered to the pin and raised to the highest one already returned. */
  observe(result: unknown): unknown {
    const block = parseQuantity(result);
    if (block === null) return result;
    const target = this.target(this.#probeMethod);
    const served = this.#serve(target === null ? block : Math.min(block, target.block));
    return served === block ? result : toHexQuantity(served);
  }

  #serve(block: number): number {
    if (block > this.#served) this.#served = block;
    return this.#served;
  }
}
