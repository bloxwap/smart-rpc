import type { BreakerOptions } from "./breaker.js";
import type { BudgetConfig, BudgetOptions, Budgets } from "./budget.js";
import type { CacheOptions, CachePolicy, CacheStats } from "./cache.js";
import type { EndpointSnapshot, RpcEvent } from "./events.js";
import type { PinLatestOptions } from "./pin.js";
import type { RaceOptions } from "./race.js";
import type { ScoreConfig } from "./score.js";
import type { ScorePersistence, ScoreSnapshot } from "./warmstart.js";

/** A JSON-RPC call. `chainId` is a CAIP-2 id such as `eip155:1` or `solana:mainnet`. */
export interface RpcRequest {
  chainId?: string | undefined;
  method: string;
  params?: unknown;
  signal?: AbortSignal | undefined;
}

/** One registered transport inside {@link createSmartRpc}. */
export interface SmartRpcTransport {
  readonly chainIds: readonly string[];
  request(request: RpcRequest): Promise<unknown>;
  requestBatch?: ((requests: readonly RpcRequest[]) => Promise<PromiseSettledResult<unknown>[]>) | undefined;
  probe?: (() => Promise<void>) | undefined;
  close?: (() => void) | undefined;
  snapshot?: ((method?: string) => readonly EndpointSnapshot[]) | undefined;
  onEvent?: ((listener: (event: RpcEvent) => void) => () => void) | undefined;
}

/** Calls one endpoint. Transports build this around viem or `fetch`. */
export interface EndpointCall {
  (request: { method: string; params?: unknown }, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** One endpoint the pool can route to. */
export interface PoolEndpointConfig {
  /** Public runtime label. Default: `url`. Unlabeled endpoints use an opaque URL hash in score snapshots. */
  id?: string | undefined;
  url: string;
  /** Routing weight above 0. Default: 1. */
  weight?: number | undefined;
  /** Sustained requests per second. Overrides the pool `budget` for this endpoint. */
  rps?: number | undefined;
  /** Bucket size for `rps`. Default: `max(1, ceil(rps * 2))`. */
  burst?: number | undefined;
  call: EndpointCall;
  /** False when the endpoint cannot serve `method`. Default: every method. */
  supports?: ((method: string) => boolean) | undefined;
  /** Parameter-sensitive capability check, evaluated before routing. */
  supportsRequest?: ((request: { method: string; params?: unknown }) => boolean) | undefined;
  /** False for latest-only endpoints that cannot serve numeric state reads. */
  pinning?: boolean | undefined;
  /** URLs sharing a provider quota use the same group inside this pool. */
  providerGroup?: string | undefined;
  providerBudget?: BudgetOptions | undefined;
  /** Release owned resources on pool close, or immediately when a shared acquisition discards this duplicate. */
  close?: (() => void) | undefined;
  /**
   * Milliseconds a recent rate-limited response asked for in `Retry-After`.
   * Reading it clears it. viem drops headers on some JSON-RPC errors, so HTTP transports keep a copy here.
   */
  retryAfter?: (() => number) | undefined;
  /** Set when this endpoint has a known provider budget the pool should enforce. */
  budget?: BudgetConfig | undefined;
}

/**
 * Chain-specific hooks. Scoring, failover, and the breaker stay in the pool.
 * Each transport supplies how to probe, how to recognize the chain, and which methods are safe.
 */
export interface ChainPolicy {
  /** CAIP-2 chain ids this pool serves. */
  chainIds: readonly string[];
  /** Health probe method. EVM: `eth_blockNumber`. Solana: `getSlot`. */
  probeMethod: string;
  probeParams?: unknown;
  /** Parse a probe result into a freshness unit (block or slot). Null when it is not a head. */
  parseHead: (result: unknown) => number | null;
  /** Pull a head out of some other call results. Default: probe method only. */
  headFromResult?: ((method: string, result: unknown, params: unknown) => number | null) | undefined;
  /** Chain-identity method. EVM: `eth_chainId`. Solana: `getGenesisHash`. */
  identityMethod: string;
  identityParams?: unknown;
  expectedIdentity: unknown;
  /** Null when the result is not an identity. */
  parseIdentity: (result: unknown) => unknown;
  identityEquals?: ((reported: unknown, expected: unknown) => boolean) | undefined;
  isSafeMethod: (method: string) => boolean;
  isRebroadcastMethod?: ((method: string) => boolean) | undefined;
  shouldFailover?: ((error: Error) => boolean) | undefined;
  /** A miss that should fail over without counting as a sick endpoint. EVM: block not held yet. */
  isBenignMiss?: ((error: Error) => boolean) | undefined;
  /**
   * The endpoint is over its request rate. It cools down and its budget adapts; its score is untouched.
   * Default: HTTP 429, `-32005`, or rate-limit wording.
   */
  isRateLimited?: ((error: Error) => boolean) | undefined;
  /**
   * The endpoint's own policy refused this request (span, size, filter shape, token-gated method). The call fails
   * over, the endpoint is not counted as failing, and it is not sent the same request shape first for a minute.
   * Default: provider-restriction wording, including in JSON-RPC `data`.
   */
  isRestriction?: ((error: Error) => boolean) | undefined;
  /**
   * True when a read answers from the head (`"latest"`, `"pending"`, a head method). An endpoint lagging past
   * `maxLag` does not lead these while a fresh one can. Default: the EVM tag rules of `isHeadSensitiveRead`.
   */
  isHeadSensitive?: ((method: string, params: unknown) => boolean) | undefined;
  isAlreadyKnown?: ((error: Error) => boolean) | undefined;
  /** Hash to return when a rebroadcast is answered "already known". */
  rebroadcastResult?: ((method: string, params: unknown) => unknown) | undefined;
  uncoalescedMethods?: ReadonlySet<string> | undefined;
  /** Server-local handles. The pool returns opaque handles and keeps followups on their owner. */
  statefulMethods?: {
    create: readonly string[];
    use: readonly string[];
    release: readonly string[];
  } | undefined;
  cachePolicy?: CachePolicy | undefined;
  /**
   * Block-tag pinning. Default: off. EVM transports turn it on.
   * Needs head tracking.
   */
  pin?: boolean | PinLatestOptions | undefined;
  /** Freshness units per second for outlier comparison. Default: from `blockTimeMs`, else 2. */
  maxUnitsPerSecond?: number | undefined;
  /**
   * Typical milliseconds between heads. When set, the default `maxLag` is about one second of blocks (at least
   * one) and the default `maxUnitsPerSecond` is the production rate plus 25%. Default: unset, so `maxLag` is 2.
   */
  blockTimeMs?: number | undefined;
}

export interface HeadLagOptions {
  /**
   * Freshness units of lag that do not change the score. Past it, an endpoint is not raced or hedged and does not
   * lead head reads while a fresh endpoint can. Default: about one second of blocks when the chain declares
   * `blockTimeMs`, else 2.
   */
  maxLag?: number | undefined;
  /** Milliseconds between health probes. `false` disables the timer. Default: 4000. */
  probeInterval?: number | false | undefined;
  /** Stop the probe timer after this many milliseconds without a request. `false` never stops it. Default: 60000. */
  probeIdleTimeout?: number | false | undefined;
  /** Heads older than this stop affecting the score. Default: 30000. */
  staleMs?: number | undefined;
  /**
   * Units a head may lead the median of the other endpoints' fresh heads.
   * A head further ahead is ignored. Default: 1000.
   */
  maxAhead?: number | undefined;
}

export interface HedgeOptions {
  /** Minimum wait before a second endpoint is tried. Default: 250. */
  minDelay?: number | undefined;
  /** After three samples, hedge once the call exceeds this multiple of the tail. Default: 2. */
  multiplier?: number | undefined;
}

/** Total upstream work allowed for one request or requestBatch operation. */
export interface OperationBudgetOptions {
  /** Includes identity checks, races, retries and every batch item. Default: 64. */
  maxRequests?: number | undefined;
  /** Total milliseconds including queueing and retries. Default: four attempt timeouts. */
  timeout?: number | undefined;
}

/** A factory-local owner for shared pools and budgets. Create one with `createPoolScope()`. */
export interface PoolShareScope {
  /** @internal Called by `createPool` when `sharing` is set. */
  acquire(
    key: string,
    budgetKey: string,
    now: () => number,
    build: (budgets: Budgets) => RpcPool,
  ): RpcPool;
  /** Close every pool in this scope. Existing and future leases cannot make requests. */
  close(): void;
}

/** Opt in to reuse inside one explicit factory scope. No process-global registry is used. */
export interface PoolSharingOptions {
  scope: PoolShareScope;
  /**
   * Identity of every routing-relevant input. Dedicate a scope to fixed endpoints, credentials,
   * and policy, then include per-consumer chain, timeout, and retry settings in this key.
   */
  key: string;
  /**
   * Identity of the provider allowance. Default: `key`. Use the same value across timeout/retry
   * variants only when their endpoints, credentials, chain, and budget configuration match.
   */
  budgetKey?: string | undefined;
}

/** Options for {@link createPool}. Defaults match the HyperEVM transport at 092b8f9. */
export interface PoolOptions {
  endpoints: readonly PoolEndpointConfig[];
  policy: ChainPolicy;
  /** Extra attempts after the first, for safe methods and rebroadcasts. Default: 2. */
  retryCount?: number | undefined;
  /**
   * Wait between failovers, in milliseconds. Default: 0, so another endpoint is tried at once.
   * Re-trying an endpoint that already failed this call waits a jittered exponential backoff from
   * this base (100 when 0), capped at 2000.
   */
  retryDelay?: number | undefined;
  /** Per-attempt deadline in milliseconds. Default: 10000. */
  timeout?: number | undefined;
  /** Score some methods separately. Default: true. */
  perMethod?: boolean | undefined;
  /** Deprioritize endpoints behind the best known head. Default: enabled, probing every 4s. */
  headLag?: boolean | HeadLagOptions | undefined;
  /** Send a second safe read when the first is slower than usual. Default: off. */
  hedge?: boolean | HedgeOptions | undefined;
  /**
   * Send each safe read to the best verified endpoints at once. `true` races 2.
   * Only the first attempt races. Default: on, width 2.
   */
  race?: boolean | RaceOptions | undefined;
  /** `"best"` always uses the lowest score. `"p2c"` draws two and keeps the better one. Default: `"p2c"`. */
  routing?: "best" | "p2c" | undefined;
  /** Eject an endpoint after consecutive failures, or for a `Retry-After`. Default: enabled. */
  breaker?: boolean | BreakerOptions | undefined;
  /**
   * Request budget for every endpoint without its own `rps`. `false` turns every budget off.
   * Default: none, unless an endpoint sets `budget` or `rps`.
   */
  budget?: BudgetOptions | false | undefined;
  /** One shared ceiling for attempts, hedges, identity checks and batch items. */
  operationBudget?: OperationBudgetOptions | undefined;
  /** Share identical in-flight safe reads. Default: true. */
  coalesce?: boolean | undefined;
  /** Answer safe reads from memory while they are fresh. Default: on when `policy.cachePolicy` is set, else off. */
  cache?: boolean | CacheOptions | undefined;
  /** Check chain identity once per endpoint before its first call. Default: true. */
  verifyIdentity?: boolean | undefined;
  /** Return true to stop failover. Terminal errors already stop it. */
  shouldThrow?: ((error: Error) => boolean) | undefined;
  onEvent?: ((event: RpcEvent) => void) | undefined;
  /** Head probes send nothing while this returns false. Default: hidden browser tabs are inactive. */
  isActive?: (() => boolean) | undefined;
  score?: Partial<ScoreConfig> | undefined;
  /**
   * Warm-start scores from storage. `load` runs once, on the instance's first request, and `save` runs at most every
   * `saveInterval` and on `close()`. A load still pending at the first pick lands later, so it never delays or fails
   * a call. Load and save errors fire a `persist` event. Use {@link localStoragePersistence} in a browser. Default: off.
   */
  persist?: ScorePersistence | undefined;
  /** Clock used for latency, budgets, persistence freshness, and the probe idle timeout. Default: `Date.now`. */
  now?: (() => number) | undefined;
  /** Source of randomness for power-of-two-choices and backoff jitter. Default: `Math.random`. */
  random?: (() => number) | undefined;
  /** Reuse equivalent pools and coordinate budgets only inside this explicit scope. Default: off. */
  sharing?: PoolSharingOptions | undefined;
}

/** A routed pool. Register it with {@link createSmartRpc} or call `request` directly. */
export interface RpcPool extends SmartRpcTransport {
  readonly chainIds: readonly string[];
  request(request: RpcRequest): Promise<unknown>;
  /** Ordered per-item results; one failure never discards successful siblings. */
  requestBatch(requests: readonly RpcRequest[]): Promise<PromiseSettledResult<unknown>[]>;
  probe(): Promise<void>;
  close(): void;
  snapshot(method?: string): readonly EndpointSnapshot[];
  /** Learned latency, tail, and error books by endpoint label. Transient routing state is never included. */
  scores(): ScoreSnapshot;
  /**
   * Seed books that have no samples yet from a {@link ScoreSnapshot} or its JSON, which may come from untrusted storage.
   * Unknown endpoints, invalid books, and books older than `persist.maxAge` are ignored, and values are clamped.
   * A seeded book counts as at most two samples, and the endpoint's first live sample replaces it.
   * True when a book was seeded.
   */
  restoreScores(snapshot: unknown): boolean;
  onEvent(listener: (event: RpcEvent) => void): () => void;
  readonly endpoints: readonly { id: string; url: string; weight: number }[];
  cacheStats(): CacheStats;
}
