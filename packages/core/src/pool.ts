/**
 * Chain-agnostic JSON-RPC pool.
 *
 * Scoring, power-of-two-choices, top-2 racing, the circuit breaker, retries, budgets,
 * coalescing, caching, cancellation, and health probes live here. Chain packages supply
 * the probe, the identity check, and method safety through {@link ChainPolicy}.
 *
 * Defaults match `@bloxwap/smart-hyperevm` at 092b8f9: 2 extra retries, a 10s attempt
 * timeout, immediate failover when another endpoint is up, and a jittered backoff from
 * 100ms to 2s only when every candidate has already failed this call.
 * @module
 */

import { Activity } from "./activity.js";
import { Breaker, retryAfterMs, resolveBreaker } from "./breaker.js";
import {
  type BudgetConfig,
  Budgets,
  type RateLimitOutcome,
  resolveDefaultBudget,
  resolveEndpointBudget,
} from "./budget.js";
import { type CacheStats, ReadCache, resolveCache } from "./cache.js";
import { Coalescer, coalesceKey, isCoalescableMethod } from "./coalesce.js";
import {
  DEFAULT_MAX_AHEAD,
  DEFAULT_MAX_LAG,
  DEFAULT_PROBE_IDLE_MS,
  DEFAULT_PROBE_MS,
  DEFAULT_RETRY_BACKOFF_MS,
  DEFAULT_RETRY_COUNT,
  DEFAULT_STALE_MS,
  DEFAULT_TIMEOUT_MS,
  INFLIGHT_GRACE_MS,
  MAX_RETRY_BACKOFF_MS,
} from "./constants.js";
import { abortError, isAbortError, toError } from "./error-util.js";
import {
  AllEndpointsFailedError,
  BudgetExhaustedError,
  EndpointCapabilityError,
  OperationBudgetExceededError,
  ChainMismatchError,
  TimeoutError,
  TransportClosedError,
  UnknownChainError,
} from "./errors.js";
import type { EndpointSnapshot, RpcEvent } from "./events.js";
import {
  isAlreadyKnownError,
  isBlockNotHeldError,
  isProviderRestriction,
  isRateLimitError,
  shouldFailover,
} from "./evm-methods.js";
import { blockCadence } from "./cadence.js";
import { Operation } from "./operation.js";
import { isHeadSensitiveRead, LatestPin, resolvePin } from "./pin.js";
import { pickRacers, raceCalls, resolveRace } from "./race.js";
import { backoffMs } from "./retry.js";
import { defaultScoreConfig } from "./score.js";
import { type RankedEndpoint, Scoreboard } from "./scoreboard.js";
import type {
  ChainPolicy,
  EndpointCall,
  HeadLagOptions,
  HedgeOptions,
  PoolOptions,
  RpcPool,
  RpcRequest,
} from "./types.js";
import { type ScoreSnapshot, WarmStart } from "./warmstart.js";

interface BuiltEndpoint {
  id: string;
  snapshotLabel: string;
  url: string;
  weight: number;
  call: EndpointCall;
  supports: (method: string) => boolean;
  supportsRequest: (request: { method: string; params?: unknown }) => boolean;
  pinning: boolean;
  providerGroup: string | undefined;
  providerBudget: BudgetConfig | undefined;
  close: (() => void) | undefined;
  retryAfter: () => number;
  budget: BudgetConfig | undefined;
}

interface Inflight {
  promise: Promise<unknown>;
  cancel: () => void;
  cancelled: () => boolean;
  /** Detach from the caller: finish in the background, score the answer, never deliver it. */
  release?: (() => void) | undefined;
}

interface ChainGate {
  verified: boolean;
  mismatch: ChainMismatchError | undefined;
  pending: Promise<Error | undefined> | undefined;
}

interface ResolvedHeadLag {
  enabled: boolean;
  maxLag: number;
  /**
   * Lag tolerance for choosing a pinned block. Pin holders are judged on raw heads sampled at different times, so a
   * block-time-derived `maxLag` below the default would bar endpoints only because they were probed earlier.
   */
  pinMaxLag: number;
  probeInterval: number | false;
  probeIdleTimeout: number | false;
  staleMs: number;
  maxAhead: number;
}

interface ResolvedHedge {
  enabled: boolean;
  minDelay: number;
  multiplier: number;
}

const NO_BAR: ReadonlySet<string> = new Set();
const noProgress = (): void => undefined;

/** How long an endpoint that refused a request shape is not sent that shape first again. */
const RESTRICTION_MEMORY_MS = 60_000;
/** Remembered refusals per pool. The oldest is dropped first. */
const RESTRICTION_ENTRIES = 256;
/** A hex quantity, as opposed to an address or hash. */
const QUANTITY = /^0x[0-9a-f]{1,16}$/i;

/**
 * A coarse description of a request: the method, each object parameter's key names, block tags, and whether a
 * string is a quantity. An address-less log filter and one with an address differ, as do `"latest"` and a block
 * number, so a gateway rule about one shape never bars another. A numeric block range adds its order of magnitude.
 */
function requestShape(method: string, params: unknown): string {
  if (!Array.isArray(params)) return method;
  const parts = params.map((param: unknown): string => {
    if (typeof param === "string") {
      if (/^(?:latest|pending|safe|finalized|earliest)$/.test(param)) return param;
      return QUANTITY.test(param) ? "n" : "s";
    }
    if (typeof param !== "object" || param === null || Array.isArray(param)) return typeof param;
    const record = param as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined && record[key] !== null).sort().join(",");
    return `{${keys}}${spanClass(record.fromBlock, record.toBlock)}`;
  });
  return `${method}(${parts.join(",")})`;
}

/**
 * The order of magnitude of a numeric block range, so a refusal of a 5,000-block log query never bars the same
 * endpoint from leading a 50-block one. Empty when either bound is a tag or missing.
 */
function spanClass(fromBlock: unknown, toBlock: unknown): string {
  if (typeof fromBlock !== "string" || typeof toBlock !== "string" || !QUANTITY.test(fromBlock) || !QUANTITY.test(toBlock)) {
    return "";
  }
  const span = Math.max(0, Number.parseInt(toBlock, 16) - Number.parseInt(fromBlock, 16)) + 1;
  return `~${Math.ceil(Math.log2(span + 1))}`;
}

/** Build a pool. Registration with {@link createSmartRpc} is separate and explicit. */
export function createPool(options: PoolOptions): RpcPool {
  const now = options.now ?? ((): number => Date.now());
  const sharing = options.sharing;
  if (sharing) {
    const chainKey = JSON.stringify(options.policy.chainIds);
    const key = JSON.stringify([sharing.key, chainKey]);
    const budgetKey = JSON.stringify([sharing.budgetKey ?? sharing.key, chainKey]);
    let built = false;
    const lease = sharing.scope.acquire(key, budgetKey, now, (budgets) => {
      built = true;
      return buildPool(options, budgets, budgetKey);
    });
    if (!built) for (const endpoint of options.endpoints) endpoint.close?.();
    return lease;
  }
  return buildPool(options, new Budgets(now), "");
}

function buildPool(options: PoolOptions, budgetStore: Budgets, budgetNamespace: string): RpcPool {
  const policy = options.policy;
  const now = options.now ?? ((): number => Date.now());
  const random = options.random ?? Math.random;
  const headLag = resolveHeadLag(options.headLag, policy.blockTimeMs);
  const maxUnitsPerSecond = policy.maxUnitsPerSecond ??
    (policy.blockTimeMs === undefined ? undefined : blockCadence(policy.blockTimeMs).maxUnitsPerSecond);
  const hedge = resolveHedge(options.hedge);
  const raceRivals = resolveRace(options.race);
  const routing = options.routing ?? "p2c";
  const perMethod = options.perMethod ?? true;
  const retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
  const retryDelay = options.retryDelay ?? 0;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`smart-rpc timeout must be a positive number of milliseconds, got ${String(timeout)}.`);
  }
  const retryBackoff = retryDelay > 0 ? retryDelay : DEFAULT_RETRY_BACKOFF_MS;
  const verifyIdentity = options.verifyIdentity ?? true;
  const breaker = new Breaker(resolveBreaker(options.breaker), now);
  const built = buildEndpoints(options);
  const budgetId = (id: string): string => budgetNamespace === "" ? id : JSON.stringify([budgetNamespace, id]);
  const budgets = {
    configure(id: string, config: BudgetConfig | undefined, group?: string, provider?: BudgetConfig): void {
      budgetStore.configure(budgetId(id), config, group === undefined ? undefined : budgetId(group), provider);
    },
    has: (id: string): boolean => budgetStore.has(budgetId(id)),
    take: (id: string): boolean => budgetStore.take(budgetId(id)),
    remaining: (id: string): number | null => budgetStore.remaining(budgetId(id)),
    refillMs: (ids: Iterable<string>): number => budgetStore.refillMs([...ids].map(budgetId)),
    heldMs: (id: string): number => budgetStore.heldMs(budgetId(id)),
    rateLimited: (id: string, retryAfter: number): RateLimitOutcome => budgetStore.rateLimited(budgetId(id), retryAfter),
    served: (id: string): void => budgetStore.served(budgetId(id)),
  };
  for (const endpoint of built) budgets.configure(endpoint.id, endpoint.budget, endpoint.providerGroup, endpoint.providerBudget);
  /**
   * True when `id` can take a speculative or background request and still keep one token for a caller.
   * Race rivals, hedges, cache refreshes and cache head ticks only spend spare tokens, so they never make a
   * foreground call wait for a refill or push a provider over its documented rate. Unbudgeted endpoints are
   * always spare.
   */
  const spare = (id: string): boolean => {
    const remaining = budgets.remaining(id);
    return remaining === null || remaining >= 2;
  };
  const operations = new WeakMap<AbortSignal, Operation>();
  const stateful = policy.statefulMethods;
  const handles = new Map<string, { endpoint: string; upstream: unknown }>();
  let handleSequence = 0n;
  const learnedUnsupported = new Map<string, Set<string>>();
  const supports = (endpoint: BuiltEndpoint, method: string): boolean =>
    endpoint.supports(method) && !learnedUnsupported.get(endpoint.id)?.has(method);
  const isStateful = (method: string): boolean =>
    stateful !== undefined && [...stateful.create, ...stateful.use, ...stateful.release].includes(method);
  const scoreConfig = { ...defaultScoreConfig, ...options.score };
  const failoverOf = policy.shouldFailover ?? shouldFailover;
  const benignMiss = policy.isBenignMiss ?? isBlockNotHeldError;
  const rateLimited = policy.isRateLimited ?? isRateLimitError;
  const restricted = policy.isRestriction ?? isProviderRestriction;
  const headSensitive = policy.isHeadSensitive ?? isHeadSensitiveRead;
  const alreadyKnown = policy.isAlreadyKnown ?? isAlreadyKnownError;
  /**
   * Request shapes an endpoint's policy refused recently, by endpoint and shape, with when the memory ends. Such an
   * endpoint does not lead that shape again while another can, so one gateway rule costs one round trip a minute.
   */
  const restrictions = new Map<string, number>();
  /** Endpoints that refused this request's shape in the last {@link RESTRICTION_MEMORY_MS}. */
  const restrictedFor = (method: string, params: unknown): ReadonlySet<string> => {
    if (restrictions.size === 0) return NO_BAR;
    const shape = requestShape(method, params);
    const at = now();
    const ids = new Set<string>();
    for (const endpoint of built) {
      const key = `${endpoint.id}\u0000${shape}`;
      const until = restrictions.get(key);
      if (until === undefined) continue;
      if (until > at) ids.add(endpoint.id);
      else restrictions.delete(key);
    }
    return ids;
  };
  const noteRestriction = (id: string, method: string, params: unknown): void => {
    const key = `${id}\u0000${requestShape(method, params)}`;
    restrictions.delete(key);
    restrictions.set(key, now() + RESTRICTION_MEMORY_MS);
    if (restrictions.size > RESTRICTION_ENTRIES) restrictions.delete(restrictions.keys().next().value as string);
  };
  const listeners = new Set<(event: RpcEvent) => void>();
  const emit = (event: RpcEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // A listener must not break routing.
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Same for subscribers.
      }
    }
  };

  const gates = new Map<string, ChainGate>(
    built.map((endpoint) => [
      endpoint.id,
      {
        verified: !verifyIdentity,
        mismatch: undefined,
        pending: undefined,
      },
    ]),
  );
  const quarantined = (id: string): boolean => gates.get(id)?.mismatch !== undefined;
  const byId = new Map(built.map((endpoint) => [endpoint.id, endpoint]));
  const board = new Scoreboard(
    built.map((endpoint, index) => ({
      id: endpoint.id,
      url: endpoint.url,
      weight: endpoint.weight,
      index,
      supports: (method: string): boolean => !quarantined(endpoint.id) && supports(endpoint, method),
    })),
    {
      perMethod,
      headLag: headLag.enabled,
      maxLag: headLag.maxLag,
      staleMs: headLag.staleMs,
      maxAhead: headLag.maxAhead,
      maxUnitsPerSecond,
      config: scoreConfig,
      now,
      ejected: (id: string): boolean => breaker.isOpen(id),
      spent: (id: string): boolean => !budgets.has(id),
    },
  );
  const warm = new WarmStart(board, {
    persistence: options.persist,
    endpoints: built.map((endpoint) => ({ id: endpoint.id, label: endpoint.snapshotLabel })),
    latencyCapMs: timeout,
    loadTimeoutMs: timeout,
    now,
    emit,
  });
  const servable = (id: string, method: string): boolean =>
    gates.get(id)?.verified === true && !quarantined(id) && !breaker.isOpen(id) && byId.get(id)?.supports(method) === true && !learnedUnsupported.get(id)?.has(method);
  const pinConfig = resolvePin(policy.pin ?? false, false);
  const pin = headLag.enabled
    ? new LatestPin(
        pinConfig,
        {
          heads: (maxAgeMs: number) => board.heads(maxAgeMs),
          maxLag: headLag.pinMaxLag,
          servable: (id: string, method: string): boolean => servable(id, method) && byId.get(id)?.pinning === true,
        },
        policy.probeMethod,
      )
    : undefined;
  const coalescer = new Coalescer(timeout + Math.min(timeout, INFLIGHT_GRACE_MS));
  const routeCacheRead = (
    method: string,
    params: unknown,
    originalParams: unknown,
    pinRequired: boolean,
    parent: AbortSignal | undefined,
    batchOperation: Operation | undefined,
    background: boolean,
  ): Promise<{ result: unknown; block: number | undefined }> => {
    const original = pin?.pinTop(method, originalParams) ?? { params: originalParams, holders: undefined, block: undefined };
    if (pinRequired && original.block === undefined) return Promise.reject(new EndpointCapabilityError(method));
    const pinned = pin?.pinTop(method, params) ?? { params, holders: undefined, block: undefined };
    const sentParams = pinRequired ? params : pinned.params;
    const holders = pinRequired ? original.holders : pinned.holders;
    const block = pinRequired ? original.block : pinned.block;
    const barred = new Set(barredFrom(holders));
    for (const endpoint of built) {
      if (!endpoint.supportsRequest({ method, params: sentParams })) barred.add(endpoint.id);
    }
    if (!built.some((endpoint) => !barred.has(endpoint.id) && supports(endpoint, method))) {
      return Promise.reject(new EndpointCapabilityError(method));
    }
    return sendShared(method, sentParams, parent, true, false, barred, batchOperation, background).then(
      (result) => ({ result, block }),
    );
  };
  const cacheConfig = resolveCache(options.cache ?? (policy.cachePolicy ? true : false));
  const cache = cacheConfig.enabled && policy.cachePolicy
    ? new ReadCache(cacheConfig, policy.cachePolicy, {
        now,
        head: (method: string) => newestHead(method),
        held: (method: string) => heldHead(method),
        active: () => activity.active(),
        probe: () => probeBest(),
        probeMethod: policy.probeMethod,
        read: (method: string, params: unknown, readOptions) => routeCacheRead(
          method,
          params,
          readOptions?.originalParams ?? params,
          readOptions?.pinRequired ?? false,
          undefined,
          undefined,
          true,
        ),
        ready: (method: string): boolean => built.some((endpoint) =>
          !quarantined(endpoint.id) && supports(endpoint, method) && !breaker.isOpen(endpoint.id) && spare(endpoint.id)),
        emit,
      })
    : undefined;

  const closeCircuit = (endpoint: RankedEndpoint, call: boolean): void => {
    if (!call && breaker.isOpen(endpoint.id)) return;
    if (breaker.success(endpoint.id, !call)) emit({ type: "restore", endpoint: endpoint.url });
  };

  /**
   * A rate-limited answer cools the endpoint down and cuts its request rate instead of striking its breaker or
   * its score. It is skipped like a spent budget meanwhile, and probes leave it alone.
   */
  const throttle = (endpoint: BuiltEndpoint, error: Error): void => {
    const asked = Math.max(retryAfterMs(error, now()), endpoint.retryAfter());
    const outcome = budgets.rateLimited(endpoint.id, asked);
    emit({ type: "throttle", endpoint: endpoint.url, cooldownMs: outcome.cooldownMs, rps: outcome.rps, error });
  };

  const openCircuit = (endpoint: RankedEndpoint, error: Error, call: boolean): void => {
    const asked = Math.max(retryAfterMs(error, now()), byId.get(endpoint.id)?.retryAfter() ?? 0);
    const ejection = breaker.failure(endpoint.id, asked, !call);
    if (!ejection) return;
    emit({
      type: "eject",
      endpoint: endpoint.url,
      failures: ejection.failures,
      cooldownMs: ejection.cooldownMs,
      error,
    });
  };

  const checkChain = (endpoint: BuiltEndpoint, operation?: Operation): Promise<Error | undefined> => {
    const gate = gates.get(endpoint.id);
    if (!gate || gate.verified) return Promise.resolve(undefined);
    if (gate.mismatch) return Promise.resolve(gate.mismatch);
    if (!endpoint.supports(policy.identityMethod)) return Promise.resolve(new EndpointCapabilityError(policy.identityMethod));
    let pending: Promise<Error | undefined>;
    try { pending = gate.pending ?? startCheck(endpoint, gate, operation); }
    catch (error: unknown) { return Promise.resolve(toError(error)); }
    return pending.catch((error: unknown): Error => {
      if (gate.pending === pending) gate.pending = undefined;
      return toError(error);
    });
  };

  const startCheck = (endpoint: BuiltEndpoint, gate: ChainGate, operation?: Operation): Promise<Error | undefined> => {
    operation?.check();
    if (!budgets.take(endpoint.id)) return Promise.resolve(new BudgetExhaustedError([endpoint.id], budgets.refillMs([endpoint.id])));
    operation?.take();
    const started = now();
    // Identity checks are shared by concurrent callers. Only their own deadline,
    // not one caller's cancellation, aborts the upstream request.
    const controller = new AbortController();
    const pending = withDeadline(
      Promise.resolve().then(() =>
        endpoint.call({ method: policy.identityMethod, params: policy.identityParams }, { signal: controller.signal }),
      ),
      timeout,
    ).then(
      (result): Error | undefined => {
        const reported = policy.parseIdentity(result);
        const equals = policy.identityEquals ?? Object.is;
        if (reported !== null && reported !== undefined && equals(reported, policy.expectedIdentity)) {
          gate.verified = true;
          closeCircuit(endpoint, false);
          return undefined;
        }
        if (reported === null || reported === undefined) {
          return new Error(`${endpoint.url} returned no chain identity.`);
        }
        gate.mismatch = new ChainMismatchError(endpoint.url, policy.expectedIdentity, reported);
        emit({
          type: "quarantine",
          endpoint: endpoint.url,
          reported,
          expected: policy.expectedIdentity,
        });
        return gate.mismatch;
      },
    ).catch(
      (error: unknown): Error => {
        const wrapped = toError(error);
        const latencyMs = Math.max(0, now() - started);
        const limited = rateLimited(wrapped);
        const terminal = !limited && !failoverOf(wrapped);
        if (!limited) board.failure(endpoint.id, policy.identityMethod, latencyMs, false, timeout);
        emit({
          type: "error",
          endpoint: endpoint.url,
          method: policy.identityMethod,
          latencyMs,
          error: wrapped,
          terminal,
        });
        if (limited) throttle(endpoint, wrapped);
        else if (!terminal) openCircuit(endpoint, wrapped, false);
        return wrapped;
      },
    ).finally(() => controller.abort());
    gate.pending = pending;
    void pending.finally(() => {
      if (gate.pending === pending) gate.pending = undefined;
    });
    return pending;
  };

  const pickVerified = (
    method: string,
    exclude: Set<string>,
    mode: "best" | "p2c",
    parent: AbortSignal | undefined,
    errors: Error[],
    skipEjected: boolean,
  ): RankedEndpoint | undefined | Promise<boolean> => {
    const endpoint = board.pick(method, exclude, mode, random);
    if (!endpoint) {
      if (errors.length === 0) {
        for (const gate of gates.values()) if (gate.mismatch) errors.push(gate.mismatch);
      }
      return undefined;
    }
    if (skipEjected && breaker.isOpen(endpoint.id)) return undefined;
    const target = byId.get(endpoint.id);
    if (!target || gates.get(endpoint.id)?.verified !== false || !budgets.has(endpoint.id)) return endpoint;
    // A cold identity check costs a handshake and a round trip before the call even starts. When a verified,
    // funded endpoint can serve now, use it and verify this one in the background. No caller can use an
    // unverified endpoint's own tokens, so its last one may pay for the check; a token shared with provider
    // peers must stay spare. Otherwise a burst-1 endpoint would never be verified while any peer is.
    const unverified = new Set(exclude);
    for (const [id, gate] of gates) if (!gate.verified) unverified.add(id);
    const ready = board.pick(method, unverified, mode, random);
    if (ready && !breaker.isOpen(ready.id) && budgets.has(ready.id) && gates.get(ready.id)?.verified === true) {
      if (target.providerGroup === undefined || spare(endpoint.id)) void checkChain(target);
      return ready;
    }
    return untilAborted(checkChain(target, parent ? operations.get(parent) : undefined), parent).then((reason) => {
      if (!reason) return false;
      exclude.add(endpoint.id);
      errors.push(reason);
      return true;
    });
  };

  const observedHeads = new Map<string, number>();
  const observedHashes = new Map<number, string>();
  const noteHead = (endpoint: BuiltEndpoint, method: string, result: unknown, params: unknown): void => {
    if (result && typeof result === "object" && "number" in result && "hash" in result && typeof result.hash === "string") {
      const height = policy.parseHead(result.number);
      if (height !== null) {
        const previousHash = observedHashes.get(height);
        if (previousHash !== undefined && previousHash !== result.hash) { cache?.invalidate(); pin?.reset(); }
        observedHashes.set(height, result.hash);
        if (observedHashes.size > 128) observedHashes.delete(observedHashes.keys().next().value as number);
      }
    }
    if (!headLag.enabled) return;
    const head =
      method === policy.probeMethod
        ? policy.parseHead(result)
        : (policy.headFromResult?.(method, result, params) ?? null);
    if (head === null) return;
    const previousHead = observedHeads.get(endpoint.id);
    if (previousHead !== undefined && head < previousHead) { cache?.invalidate(); pin?.reset(); }
    observedHeads.set(endpoint.id, head);
    const recorded = board.noteHead(endpoint.id, head);
    emit({
      type: "head",
      endpoint: endpoint.url,
      head,
      best: recorded.best,
      lag: recorded.lag,
      trusted: recorded.trusted,
    });
    cache?.headChanged();
  };

  const start = (
    endpoint: RankedEndpoint,
    method: string,
    params: unknown,
    parent: AbortSignal | undefined,
    hedged: boolean,
    sampleLatency: boolean,
  ): Inflight => {
    const operation = parent ? operations.get(parent) : undefined;
    operation?.check();
    if (!budgets.take(endpoint.id)) throw new BudgetExhaustedError([endpoint.id], budgets.refillMs([endpoint.id]));
    operation?.take();
    const state = { ignore: false, timedOut: false, released: false };
    const controller = new AbortController();
    const unlink = linkAbort(controller, parent);
    const timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, timeout);
    unrefTimer(timer);
    const target = byId.get(endpoint.id);
    if (!target) throw new Error(`Unknown RPC endpoint: ${endpoint.id}`);
    const end = board.begin(endpoint.id, timeout + INFLIGHT_GRACE_MS);
    emit({ type: "request", endpoint: endpoint.url, method });
    const started = now();
    const requestPromise = Promise.resolve().then(() =>
      target.call({ method, params }, { signal: controller.signal }),
    );
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const fail = (): void => reject(abortError(controller.signal));
      if (controller.signal.aborted) {
        fail();
        return;
      }
      controller.signal.addEventListener("abort", fail, { once: true });
    });
    const promise = Promise.race([
      requestPromise.then(
        (result) => ({ kind: "result" as const, result }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      abortPromise.then(
        () => ({ kind: "abort" as const, error: undefined }),
        (error: unknown) => ({ kind: "abort" as const, error }),
      ),
    ])
      .then((outcome) => {
        const latencyMs = Math.max(0, now() - started);
        if (outcome.kind === "result") {
          budgets.served(endpoint.id);
          if (!state.ignore) {
            board.success(endpoint.id, method, latencyMs, sampleLatency);
            noteHead(target, method, outcome.result, params);
            if (!state.released) emit({ type: "success", endpoint: endpoint.url, method, latencyMs, hedged });
            closeCircuit(endpoint, sampleLatency);
          }
          return outcome.result;
        }
        const wrapped = state.timedOut && !state.ignore ? new TimeoutError(timeout) : toError(outcome.error);
        const callerAbort = parent?.aborted === true || isAbortError(wrapped);
        if (!state.ignore && !callerAbort && isUnsupportedMethod(wrapped)) {
          const methods = learnedUnsupported.get(endpoint.id) ?? new Set<string>();
          methods.add(method);
          learnedUnsupported.set(endpoint.id, methods);
          emit({ type: "error", endpoint: endpoint.url, method, latencyMs, error: wrapped, terminal: false });
        } else if (!state.ignore && !callerAbort && target.supports(method) && benignMiss(wrapped)) {
          emit({ type: "error", endpoint: endpoint.url, method, latencyMs, error: wrapped, terminal: false });
        } else if (!state.ignore && !callerAbort && rateLimited(wrapped)) {
          // Over its rate, not unhealthy: no score or breaker strike, a cooldown and a lower rate instead.
          emit({ type: "error", endpoint: endpoint.url, method, latencyMs, error: wrapped, terminal: false });
          throttle(target, wrapped);
        } else if (
          !state.ignore && !callerAbort && target.supports(method) && method !== policy.probeMethod && restricted(wrapped)
        ) {
          // This endpoint's policy refused this request shape. It answered, so it is healthy; the call fails over.
          // A refused head probe is no shape rule ("Request blocked" for every request): it counts as a failure below.
          noteRestriction(endpoint.id, method, params);
          emit({ type: "error", endpoint: endpoint.url, method, latencyMs, error: wrapped, terminal: false });
          closeCircuit(endpoint, sampleLatency);
        } else if (!state.ignore && !callerAbort && target.supports(method)) {
          const terminal = !failoverOf(wrapped);
          if (terminal) board.success(endpoint.id, method, latencyMs, sampleLatency);
          else board.failure(endpoint.id, method, latencyMs, sampleLatency, timeout);
          emit({ type: "error", endpoint: endpoint.url, method, latencyMs, error: wrapped, terminal });
          if (terminal) closeCircuit(endpoint, sampleLatency);
          else openCircuit(endpoint, wrapped, sampleLatency);
        }
        throw wrapped;
      })
      .finally(() => {
        clearTimeout(timer);
        unlink();
        if (!controller.signal.aborted) controller.abort();
        end();
      });
    return {
      promise,
      cancelled: (): boolean => state.ignore,
      cancel(): void {
        state.ignore = true;
        clearTimeout(timer);
        controller.abort();
      },
      release(): void {
        if (state.ignore || state.released) return;
        state.released = true;
        // The caller no longer waits. Its cancellation or operation deadline must not abort this call now;
        // the attempt timer still bounds it. It also stops counting as queued work: the in-flight penalty
        // would otherwise push the next leads onto slower endpoints while discarded answers drain.
        unlink();
        end();
      },
    };
  };

  /**
   * Endpoints that should not lead this call, or none when no other endpoint could lead it now. An endpoint lagging
   * past `maxLag` does not lead a head read (a pinned read already bars endpoints that lack its block), and one that
   * refused this request shape in the last minute does not lead it again. The alternative must be verified, closed,
   * funded, and itself not avoided.
   */
  const avoidAsLead = (method: string, params: unknown, exclude: ReadonlySet<string>): ReadonlySet<string> => {
    let head: boolean | undefined;
    const refused = restrictedFor(method, params);
    const avoid = new Set<string>();
    let alternative = false;
    for (const endpoint of built) {
      if (exclude.has(endpoint.id)) continue;
      const lagging = headLag.enabled && board.lagging(endpoint.id) && (head ??= headSensitive(method, params));
      if (lagging || refused.has(endpoint.id)) avoid.add(endpoint.id);
      else if (!alternative && servable(endpoint.id, method) && budgets.has(endpoint.id)) alternative = true;
    }
    return alternative ? avoid : NO_BAR;
  };

  const barredFrom = (holders: ReadonlySet<string> | undefined): ReadonlySet<string> =>
    holders === undefined ? NO_BAR : new Set(built.filter((endpoint) => !holders.has(endpoint.id)).map((endpoint) => endpoint.id));

  const spentPeers = (picked: RankedEndpoint, method: string, exclude: ReadonlySet<string>): string[] => {
    const open = breaker.isOpen(picked.id);
    return built
      .filter(
        (endpoint) =>
          !exclude.has(endpoint.id) &&
          !quarantined(endpoint.id) &&
          supports(endpoint, method) &&
          breaker.isOpen(endpoint.id) === open,
      )
      .map((endpoint) => endpoint.id);
  };

  const pickRivals = (method: string, exclude: Set<string>, parent?: AbortSignal): RankedEndpoint[] => {
    const rivals = pickRacers(raceRivals, exclude, {
      // The rival slot explores first: an endpoint with no latency sample is raced before a measured one,
      // so a fast endpoint listed late is learned instead of hiding behind the prior forever.
      next: (skip: ReadonlySet<string>): RankedEndpoint | undefined =>
        board.pickUnsampled(method, skip) ?? board.pick(method, skip, "best", random),
      state: (endpoint: RankedEndpoint): "ready" | "unverified" | "unavailable" => {
        // The first answer wins a race, so a racer must be fresh as well as funded.
        if (breaker.isOpen(endpoint.id) || !spare(endpoint.id) || board.lagging(endpoint.id)) return "unavailable";
        return gates.get(endpoint.id)?.verified === false ? "unverified" : "ready";
      },
      verify: (endpoint: RankedEndpoint): void => {
        const target = byId.get(endpoint.id);
        const operation = parent ? operations.get(parent) : undefined;
        if (target && (operation?.remaining ?? 2) > 1) void checkChain(target, operation);
      },
    });
    for (const rival of rivals) exclude.add(rival.id);
    return rivals;
  };

  const dispatch = (
    endpoint: RankedEndpoint,
    method: string,
    params: unknown,
    parent: AbortSignal | undefined,
    idempotent: boolean,
    exclude: Set<string>,
    errors: Error[],
    race: boolean,
  ): Promise<unknown> => {
    const operation = parent ? operations.get(parent) : undefined;
    // Reserve the foreground request before speculative identity checks can spend
    // the last provider token shared by its URLs.
    const lead = start(endpoint, method, params, parent, false, true);
    const rivals = race && (operation?.remaining ?? 1) > 0 ? pickRivals(method, exclude, parent) : [];
    const started = [lead];
    const raced = [endpoint.url];
    for (const rival of rivals) {
      if (!spare(rival.id) || (operation?.remaining ?? 1) === 0) continue;
      started.push(start(rival, method, params, parent, false, true));
      raced.push(rival.url);
    }
    if (started.length > 1) emit({ type: "race", endpoints: raced, method });
    const primary = started.length === 1 ? lead : raceCalls(
      started,
      (error) => (!failoverOf(error) && !isUnsupportedMethod(error)) || options.shouldThrow?.(error) === true,
      (lost) => errors.push(...lost),
    );
    if (!hedge.enabled || !idempotent) return primary.promise;
    const wait = board.hedgeDelay(endpoint.id, method, hedge.minDelay, hedge.multiplier);
    return raceHedge(primary, wait, (active) => {
      const next = board.pick(method, exclude, "best", random);
      if ((operation?.remaining ?? 1) === 0 || !next || breaker.isOpen(next.id) || !spare(next.id) || board.lagging(next.id)) {
        return undefined;
      }
      exclude.add(next.id);
      const launch = (): Inflight => {
        emit({ type: "hedge", endpoint: next.url, method });
        return start(next, method, params, parent, true, true);
      };
      const target = byId.get(next.id);
      if (!target || gates.get(next.id)?.verified !== false) return launch();
      return untilAborted(checkChain(target, operation), parent).then(
        (reason) =>
          reason || !active() || breaker.isOpen(next.id) || quarantined(next.id) || !supports(target, method) || !spare(next.id)
            ? undefined
            : launch(),
        () => undefined,
      );
    });
  };

  const send = async (
    method: string,
    params: unknown,
    parent: AbortSignal | undefined,
    idempotent: boolean,
    rebroadcast: boolean,
    barred: ReadonlySet<string>,
    progress: (waitMs?: number) => void = noProgress,
    background = false,
  ): Promise<unknown> => {
    const pause = (ms: number): Promise<void> => {
      progress(ms);
      return delay(ms, parent);
    };
    if (background) {
      // Background refreshes use spare capacity only. They never queue for a refill behind caller traffic.
      const spent = built.filter((endpoint) => !barred.has(endpoint.id) && supports(endpoint, method) && !spare(endpoint.id));
      if (spent.length > 0) {
        const allowed = new Set(barred);
        for (const endpoint of spent) allowed.add(endpoint.id);
        if (built.every((endpoint) => allowed.has(endpoint.id) || !supports(endpoint, method))) {
          const ids = spent.map((endpoint) => endpoint.id);
          throw new BudgetExhaustedError(ids, budgets.refillMs(ids));
        }
        barred = allowed;
      }
    }
    const exclude = new Set<string>(barred);
    // Endpoints that should not lead this call while a fresh, verified, funded endpoint can: those lagging past
    // maxLag, for a read that answers from the head, and those whose policy refused this request shape recently.
    // They stay available as fallbacks once the first attempt has failed.
    const avoided = avoidAsLead(method, params, exclude);
    for (const id of avoided) exclude.add(id);
    /** `exclude.size` while no endpoint has been tried yet in this round. */
    let untried = exclude.size;
    const errors: Error[] = [];
    const retries = idempotent || rebroadcast;
    const racing = idempotent && raceRivals > 0 && !background;
    const attempts = retries ? retryCount + 1 : 1;
    let previous: RankedEndpoint | undefined;
    let round = 0;
    let ejectionWaitMs = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (parent?.aborted) throw abortError(parent);
      if (parent) operations.get(parent)?.check();
      let wait = attempt > 0 ? retryDelay : 0;
      let mode: "best" | "p2c" = attempt === 0 && !racing ? routing : "best";
      let allowEjected = false;
      let newRound = false;
      let exhausted: BudgetExhaustedError | undefined;
      let endpoint: RankedEndpoint | undefined;
      for (;;) {
        const picked = pickVerified(method, exclude, mode, parent, errors, !allowEjected);
        if (picked instanceof Promise) {
          progress();
          if (await picked) allowEjected = false;
          continue;
        }
        if (picked && wait > 0) {
          await pause(wait);
          wait = 0;
          continue;
        }
        if (picked && budgets.has(picked.id)) {
          if (gates.get(picked.id)?.verified === false) {
            const target = byId.get(picked.id);
            if (!target) break;
            progress();
            const reason = await untilAborted(checkChain(target, parent ? operations.get(parent) : undefined), parent);
            if (reason) {
              exclude.add(picked.id);
              errors.push(reason);
            }
            continue;
          }
          endpoint = picked;
          break;
        }
        if (picked) {
          const spent = spentPeers(picked, method, exclude);
          const refillMs = Math.max(1, budgets.refillMs(spent));
          if (!background && ejectionWaitMs + refillMs <= MAX_RETRY_BACKOFF_MS) {
            ejectionWaitMs += refillMs;
            await pause(refillMs);
            continue;
          }
          exhausted = new BudgetExhaustedError(spent, refillMs);
          if (exclude.size === untried || newRound) break;
        }
        if (attempt === 0 && !allowEjected && !newRound && errors.length === 0 && exclude.size === untried) {
          allowEjected = true;
          continue;
        }
        if (exclude.size > untried && !newRound) {
          exclude.clear();
          for (const id of barred) exclude.add(id);
          // An endpoint that refused this request shape would refuse it again.
          for (const id of restrictedFor(method, params)) exclude.add(id);
          untried = exclude.size;
          const candidate = board.pick(method, exclude, "best", random);
          if (!candidate || ejectionWaitMs + breaker.remaining(candidate.id) > MAX_RETRY_BACKOFF_MS) break;
          await pause(backoffMs(round, retryBackoff, random));
          round += 1;
          wait = 0;
          mode = "best";
          newRound = true;
          continue;
        }
        const candidate = board.pick(method, exclude, "best", random);
        const leftMs = candidate ? breaker.remaining(candidate.id) : 0;
        if (leftMs <= 0 || ejectionWaitMs + leftMs > MAX_RETRY_BACKOFF_MS) break;
        ejectionWaitMs += leftMs;
        await pause(leftMs);
      }
      if (!endpoint) {
        if (exhausted) errors.push(exhausted);
        break;
      }
      exclude.add(endpoint.id);
      if (previous && previous.id !== endpoint.id) {
        emit({ type: "failover", from: previous.url, to: endpoint.url, method });
      }
      progress();
      try {
        const result = await dispatch(
          endpoint,
          method,
          params,
          parent,
          idempotent && !background,
          exclude,
          errors,
          attempt === 0 && racing,
        );
        if (stateful?.create.includes(method) && typeof result === "string") {
          const handle = `0x${(++handleSequence).toString(16)}`;
          handles.set(handle, { endpoint: endpoint.id, upstream: result });
          return handle;
        }
        return result;
      } catch (error: unknown) {
        const wrapped = toError(error);
        errors.push(wrapped);
        if (rebroadcast && attempt > 0 && alreadyKnown(wrapped)) {
          const hash = policy.rebroadcastResult?.(method, params);
          if (hash !== undefined) return hash;
        }
        const stop = parent?.aborted === true || wrapped instanceof OperationBudgetExceededError || !retries ||
          (!failoverOf(wrapped) && !isUnsupportedMethod(wrapped)) || options.shouldThrow?.(wrapped) === true;
        if (stop) throw wrapped;
        previous = endpoint;
        // Avoided endpoints only lose the lead. The failover may use them.
        if (attempt === 0 && avoided.size > 0) {
          const refused = restrictedFor(method, params);
          for (const id of avoided) if (!refused.has(id) && exclude.delete(id)) untried -= 1;
        }
      }
    }
    if (errors.length === 1) {
      const only = errors[0];
      if (only) throw only;
    }
    throw new AllEndpointsFailedError(errors);
  };

  const sendShared = (
    method: string,
    params: unknown,
    signal: AbortSignal | undefined,
    idempotent: boolean,
    rebroadcast: boolean,
    barred: ReadonlySet<string>,
    batchOperation?: Operation,
    background = false,
  ): Promise<unknown> => {
    const run = async (caller: AbortSignal | undefined, progress = noProgress): Promise<unknown> => {
      const operation = batchOperation ?? new Operation(options.operationBudget, timeout, caller);
      const signal = batchOperation && caller ? AbortSignal.any([operation.signal, caller]) : operation.signal;
      operations.set(signal, operation);
      try { return await send(method, params, signal, idempotent, rebroadcast, barred, progress, background); }
      finally { if (!batchOperation) operation.close(); }
    };
    const share = batchOperation === undefined &&
      (options.coalesce ?? true) && isCoalescableMethod(method, idempotent, policy.uncoalescedMethods);
    const key = share ? coalesceKey(method, params) : undefined;
    if (key === undefined) return run(signal);
    return coalescer.request(
      key,
      signal,
      (sharedSignal, progress) => run(sharedSignal, progress),
      () => emit({ type: "coalesce", method }),
    );
  };

  let closed = false;
  let probing: Promise<void> | undefined;
  let lastProbeAt = Number.NEGATIVE_INFINITY;
  const runProbe = (reserveToken: boolean): Promise<void> => {
    if (closed) return Promise.resolve();
    if (probing) return probing;
    lastProbeAt = now();
    // Background maintenance leaves one token for a foreground call. This matters
    // for low-quota public RPCs whose refill is slower than the probe interval.
    const funded = (id: string): boolean => {
      const remaining = budgets.remaining(id);
      return remaining === null || remaining >= (reserveToken ? 2 : 1);
    };
    const pending = built.map(async (endpoint) =>
      breaker.isOpen(endpoint.id) || !endpoint.supports(policy.probeMethod) || !funded(endpoint.id)
        ? Promise.resolve()
        : checkChain(endpoint).then((reason) =>
            reason || !funded(endpoint.id)
              ? undefined
              : start(endpoint, policy.probeMethod, policy.probeParams, undefined, false, false).promise.then(
                  () => undefined,
                  () => undefined,
                ),
          ),
    );
    const done = Promise.allSettled(pending).then(() => undefined);
    probing = done;
    void done.finally(() => {
      if (probing === done) probing = undefined;
    });
    return done;
  };
  const probe = (): Promise<void> => runProbe(false);

  /** One head sample from the best verified, closed, funded endpoint for cache ticks. */
  const probeBest = async (): Promise<void> => {
    if (closed) return;
    const picked = board.pick(policy.probeMethod, NO_BAR, "best", random);
    if (!picked || breaker.isOpen(picked.id) || !spare(picked.id)) return;
    const target = byId.get(picked.id);
    if (target?.supports(policy.probeMethod) !== true) return;
    const reason = await checkChain(target);
    if (reason || closed || breaker.isOpen(picked.id) || !spare(picked.id)) return;
    await start(picked, policy.probeMethod, policy.probeParams, undefined, false, false).promise.then(
      () => undefined,
      () => undefined,
    );
  };

  const probeEvery =
    headLag.enabled && headLag.probeInterval !== false && headLag.probeInterval > 0 ? headLag.probeInterval : 0;
  let probeTimer: ReturnType<typeof setInterval> | undefined;
  let lastRequestAt = 0;
  const activity = new Activity(options.isActive);
  const stopProbes = (): void => {
    if (probeTimer === undefined) return;
    clearInterval(probeTimer);
    probeTimer = undefined;
    activity.unwatch();
  };
  const probeTick = (): void => {
    const idle = headLag.probeIdleTimeout;
    if (idle !== false && now() - lastRequestAt >= idle) {
      stopProbes();
      return;
    }
    if (!activity.active()) return;
    void runProbe(true);
  };
  const probeOnVisible = (): void => {
    if (probing !== undefined || now() - lastProbeAt < probeEvery) return;
    probeTick();
  };
  const touch = (): void => {
    lastRequestAt = now();
    if (probeEvery === 0 || probeTimer !== undefined) return;
    probeTimer = setInterval(probeTick, probeEvery);
    unrefTimer(probeTimer);
    activity.watch(probeOnVisible);
  };

  const newestHead = (method: string): { block: number; ageMs: number } | undefined => {
    let best: { block: number; ageMs: number } | undefined;
    for (const reading of board.heads(Number.POSITIVE_INFINITY)) {
      if (!reading.trusted || !servable(reading.id, method)) continue;
      if (!best || reading.head > best.block) best = { block: reading.head, ageMs: reading.ageMs };
    }
    return best;
  };

  const heldHead = (method: string): number | undefined => {
    const readings = new Map(board.heads(Number.POSITIVE_INFINITY).map((reading) => [reading.id, reading]));
    let held: number | undefined;
    for (const endpoint of built) {
      if (!servable(endpoint.id, method)) continue;
      const reading = readings.get(endpoint.id);
      if (reading?.trusted !== true) return undefined;
      if (held === undefined || reading.head < held) held = reading.head;
    }
    return held;
  };

  const execute = async (request: RpcRequest, batchOperation?: Operation): Promise<unknown> => {
    if (closed) throw new TransportClosedError();
    if (request.chainId !== undefined && !policy.chainIds.includes(request.chainId)) {
      throw new UnknownChainError(request.chainId);
    }
    touch();
    cache?.touch();
    const warming = warm.touch();
    if (warming) await warming;
    const method = request.method;
    const idempotent = !isStateful(method) && policy.isSafeMethod(method);
    const rebroadcast = policy.isRebroadcastMethod?.(method) ?? false;
    let params = request.params;
    let owner: { endpoint: string; upstream: unknown } | undefined;
    let handle: string | undefined;
    if (stateful && [...stateful.use, ...stateful.release].includes(method)) {
      handle = Array.isArray(params) && typeof params[0] === "string" ? params[0] : undefined;
      owner = handle === undefined ? undefined : handles.get(handle);
      if (!owner || !Array.isArray(params)) throw new Error("Unknown or expired RPC stateful handle.");
      params = [owner.upstream, ...params.slice(1)];
    }
    const signal = request.signal;
    if (signal?.aborted) throw abortError(signal);
    if (method === "eth_blockNumber" && method === policy.probeMethod && idempotent && (pin?.answersBlockNumber || cache)) {
      const pinned = pin?.blockNumber();
      if (pinned !== undefined) return pinned;
      const local = cache?.blockNumber();
      if (local !== undefined) return pin?.answersBlockNumber ? pin.observe(local) : local;
      const upstream = await sendShared(method, params, signal, idempotent, rebroadcast, NO_BAR, batchOperation);
      return pin?.answersBlockNumber ? pin.observe(upstream) : upstream;
    }
    const cached = cache?.lookup(method, params, idempotent, { now: now(), head: newestHead(method) });
    if (cached?.hit) {
      emit({ type: "cache", method, outcome: "hit", stale: cached.stale });
      return cached.result;
    }
    if (cached && !cached.hit) emit({ type: "cache", method, outcome: "miss", stale: null });
    if (cached && !cached.hit && cached.fetch) {
      const fetch = cached.fetch;
      try {
        const read = await routeCacheRead(
          method,
          fetch.params,
          fetch.originalParams,
          fetch.pinRequired,
          signal,
          batchOperation,
          false,
        );
        if (signal?.aborted) throw abortError(signal);
        if (batchOperation?.signal.aborted) throw abortError(batchOperation.signal);
        const completed = fetch.complete(read.result);
        if (completed !== undefined) return completed;
      } catch (error: unknown) {
        const wrapped = toError(error);
        if (
          !fetch.pinRequired || signal?.aborted || batchOperation?.signal.aborted || isAbortError(wrapped) ||
          wrapped instanceof OperationBudgetExceededError || wrapped instanceof TransportClosedError
        ) {
          throw wrapped;
        }
        // Only a latest-derived miss has a distinct, unchanged original query to use as its fallback.
      }
    }
    const pinned = cached && !cached.hit && cached.fetch
      ? { params, holders: undefined, block: undefined }
      : (pin?.pin(method, params, idempotent) ?? { params, holders: undefined, block: undefined });
    const barred = new Set(barredFrom(pinned.holders));
    for (const endpoint of built) {
      if ((owner && owner.endpoint !== endpoint.id) || !endpoint.supportsRequest({ method, params: pinned.params })) barred.add(endpoint.id);
    }
    if (!built.some((endpoint) => !barred.has(endpoint.id) && supports(endpoint, method))) throw new EndpointCapabilityError(method);
    const result = await sendShared(method, pinned.params, signal, idempotent, rebroadcast, barred, batchOperation);
    if (handle && stateful?.release.includes(method) && result === true) handles.delete(handle);
    if (!cached || cached.hit) {
      return method === policy.probeMethod && pin?.answersBlockNumber ? pin.observe(result) : result;
    }
    cached.fill(result, pinned.block);
    return method === policy.probeMethod && pin?.answersBlockNumber ? pin.observe(result) : result;
  };

  const pool: RpcPool = {
    chainIds: policy.chainIds,
    endpoints: built.map((endpoint) => ({ id: endpoint.id, url: endpoint.url, weight: endpoint.weight })),
    onEvent(listener: (event: RpcEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: (method = policy.probeMethod): readonly EndpointSnapshot[] =>
      board.snapshot(method).map((entry) => ({
        ...entry,
        quarantined: quarantined(entry.id),
        ejected: breaker.isOpen(entry.id),
        tokens: budgets.remaining(entry.id),
        throttledMs: budgets.heldMs(entry.id),
      })),
    scores: (): ScoreSnapshot => warm.scores(),
    restoreScores: (snapshot: unknown): boolean => warm.restore(snapshot),
    probe,
    cacheStats: (): CacheStats => cache?.stats() ?? { hits: 0, misses: 0, refreshes: 0, entries: 0, bytes: 0, hotKeys: 0 },
    close(): void {
      if (closed) return;
      closed = true;
      stopProbes();
      cache?.close();
      warm.close();
      handles.clear();
      for (const endpoint of built) endpoint.close?.();
    },
    request: (request: RpcRequest): Promise<unknown> => execute(request),
    async requestBatch(requests: readonly RpcRequest[]): Promise<PromiseSettledResult<unknown>[]> {
      const operation = new Operation(options.operationBudget, timeout);
      try { return await Promise.allSettled(requests.map((request) => execute(request, operation))); }
      finally { operation.close(); }
    }
  };
  return pool;
}

function resolveHeadLag(value: boolean | HeadLagOptions | undefined, blockTimeMs: number | undefined): ResolvedHeadLag {
  if (value === false) {
    return {
      enabled: false,
      maxLag: DEFAULT_MAX_LAG,
      pinMaxLag: DEFAULT_MAX_LAG,
      probeInterval: false,
      probeIdleTimeout: DEFAULT_PROBE_IDLE_MS,
      staleMs: DEFAULT_STALE_MS,
      maxAhead: DEFAULT_MAX_AHEAD,
    };
  }
  const options = value === true || value === undefined ? {} : value;
  const derived = blockTimeMs === undefined ? undefined : blockCadence(blockTimeMs).maxLag;
  return {
    enabled: true,
    maxLag: options.maxLag ?? derived ?? DEFAULT_MAX_LAG,
    pinMaxLag: options.maxLag ?? Math.max(derived ?? DEFAULT_MAX_LAG, DEFAULT_MAX_LAG),
    probeInterval: options.probeInterval === undefined ? DEFAULT_PROBE_MS : options.probeInterval,
    probeIdleTimeout: options.probeIdleTimeout === undefined ? DEFAULT_PROBE_IDLE_MS : options.probeIdleTimeout,
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    maxAhead: options.maxAhead ?? DEFAULT_MAX_AHEAD,
  };
}

function resolveHedge(value: boolean | HedgeOptions | undefined): ResolvedHedge {
  if (!value) return { enabled: false, minDelay: 250, multiplier: 2 };
  const options = value === true ? {} : value;
  return {
    enabled: true,
    minDelay: options.minDelay ?? 250,
    multiplier: options.multiplier ?? 2,
  };
}

function buildEndpoints(options: PoolOptions): BuiltEndpoint[] {
  if (options.endpoints.length === 0) throw new Error("smart-rpc requires at least one endpoint.");
  const fallback = resolveDefaultBudget(options.budget);
  const ids = new Set<string>();
  const snapshotLabels = new Set(options.endpoints.flatMap((endpoint) => endpoint.id === undefined ? [] : [endpoint.id]));
  return options.endpoints.map((endpoint, index) => {
    const id = endpoint.id ?? endpoint.url;
    if (id.trim() === "") throw new Error(`smart-rpc endpoints[${index}].id must not be empty.`);
    if (ids.has(id)) throw new Error(`smart-rpc endpoint "${id}" is used more than once.`);
    ids.add(id);
    const snapshotLabel = endpoint.id ?? uniqueSnapshotLabel(endpoint.url, snapshotLabels);
    const weight = endpoint.weight ?? 1;
    if (!(Number.isFinite(weight) && weight > 0)) {
      throw new Error(`smart-rpc endpoints[${index}].weight must be a finite number above 0.`);
    }
    const budget =
      fallback === false
        ? undefined
        : (endpoint.budget ?? resolveEndpointBudget(endpoint, fallback, `smart-rpc endpoints[${index}]`));
    return {
      id,
      snapshotLabel,
      url: endpoint.url,
      weight,
      call: endpoint.call,
      supports: endpoint.supports ?? ((): boolean => true),
      supportsRequest: endpoint.supportsRequest ?? ((): boolean => true),
      pinning: endpoint.pinning !== false,
      providerGroup: endpoint.providerGroup,
      providerBudget: options.budget === false ? undefined : resolveEndpointBudget(endpoint.providerBudget ?? {}, undefined, `smart-rpc endpoints[${index}].providerBudget`),
      close: endpoint.close,
      retryAfter: endpoint.retryAfter ?? ((): number => 0),
      budget,
    };
  });
}

function uniqueSnapshotLabel(url: string, used: Set<string>): string {
  const base = `endpoint:${urlHash(url)}`;
  let label = base;
  for (let suffix = 2; used.has(label); suffix += 1) label = `${base}:${suffix}`;
  used.add(label);
  return label;
}

/** Stable across sessions without exposing userinfo, query parameters, paths, or hostnames from credentialed URLs. */
function urlHash(url: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= BigInt(url.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function raceHedge(
  primary: Inflight,
  waitMs: number,
  startHedge: (active: () => boolean) => Inflight | undefined | Promise<Inflight | undefined>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let pending = 1;
    let settled = false;
    let hedge: Inflight | undefined;
    let primaryError: Error | undefined;
    const track = (call: Inflight | undefined): void => {
      if (!call) {
        fail(undefined, new Error("The hedge did not start."), false);
        return;
      }
      hedge = call;
      call.promise.then(
        (result) => finish(result, primary),
        (error: unknown) => fail(call, toError(error), false),
      );
    };
    const timer = setTimeout(() => {
      if (settled) return;
      let started: Inflight | undefined | Promise<Inflight | undefined>;
      try {
        started = startHedge(() => !settled);
      } catch {
        return;
      }
      if (started === undefined) return;
      pending += 1;
      if (started instanceof Promise) {
        started.then(track, (error: unknown) => fail(undefined, toError(error), false));
      } else {
        track(started);
      }
    }, waitMs);
    unrefTimer(timer);
    const finish = (result: unknown, loser: Inflight | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      loser?.cancel();
      resolve(result);
    };
    const fail = (call: Inflight | undefined, error: Error, isPrimary: boolean): void => {
      if (call?.cancelled()) return;
      if (settled) return;
      if (isPrimary) primaryError = error;
      pending -= 1;
      if (pending > 0) return;
      settled = true;
      clearTimeout(timer);
      hedge?.cancel();
      reject(primaryError ?? error);
    };
    primary.promise.then(
      (result) => finish(result, hedge),
      (error: unknown) => {
        clearTimeout(timer);
        fail(primary, toError(error), true);
      },
    );
  });
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal ? abortError(signal) : new Error("This operation was aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    unrefTimer(timer);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function linkAbort(controller: AbortController, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }
  const onAbort = (): void => {
    controller.abort(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
  };
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

function isUnsupportedMethod(error: Error): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if ("code" in current && current.code === -32601) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
