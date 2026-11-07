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
import { type BudgetConfig, Budgets, resolveDefaultBudget, resolveEndpointBudget } from "./budget.js";
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
import { isAlreadyKnownError, isBlockNotHeldError, shouldFailover } from "./evm-methods.js";
import { Operation } from "./operation.js";
import { LatestPin, resolvePin } from "./pin.js";
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
}

interface ChainGate {
  verified: boolean;
  mismatch: ChainMismatchError | undefined;
  pending: Promise<Error | undefined> | undefined;
}

interface ResolvedHeadLag {
  enabled: boolean;
  maxLag: number;
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

/** Build a pool. Registration with {@link createSmartRpc} is separate and explicit. */
export function createPool(options: PoolOptions): RpcPool {
  const policy = options.policy;
  const now = options.now ?? ((): number => Date.now());
  const random = options.random ?? Math.random;
  const headLag = resolveHeadLag(options.headLag);
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
  const budgets = new Budgets(now);
  for (const endpoint of built) budgets.configure(endpoint.id, endpoint.budget, endpoint.providerGroup, endpoint.providerBudget);
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
  const alreadyKnown = policy.isAlreadyKnown ?? isAlreadyKnownError;
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
      maxUnitsPerSecond: policy.maxUnitsPerSecond,
      config: scoreConfig,
      now,
      ejected: (id: string): boolean => breaker.isOpen(id),
      spent: (id: string): boolean => !budgets.has(id),
    },
  );
  const warm = new WarmStart(board, {
    persistence: options.persist,
    ids: built.map((endpoint) => endpoint.id),
    latencyCapMs: timeout,
    loadTimeoutMs: timeout,
    now,
    emit,
  });
  const servable = (id: string, method: string): boolean =>
    gates.get(id)?.verified === true && !quarantined(id) && !breaker.isOpen(id) && byId.get(id)?.supports(method) === true && !learnedUnsupported.get(id)?.has(method);
  const pinConfig = resolvePin(policy.pin ?? false, false);
  const pin =
    pinConfig.enabled && headLag.enabled
      ? new LatestPin(
          pinConfig,
          {
            heads: (maxAgeMs: number) => board.heads(maxAgeMs),
            maxLag: headLag.maxLag,
            servable: (id: string, method: string): boolean => servable(id, method) && byId.get(id)?.pinning === true,
          },
          policy.probeMethod,
        )
      : undefined;
  const coalescer = new Coalescer(timeout + Math.min(timeout, INFLIGHT_GRACE_MS));
  const cacheConfig = resolveCache(options.cache ?? (policy.cachePolicy ? true : false));
  const cache =
    cacheConfig.enabled && policy.cachePolicy ? new ReadCache(cacheConfig, policy.cachePolicy) : undefined;

  const closeCircuit = (endpoint: RankedEndpoint, call: boolean): void => {
    if (!call && breaker.isOpen(endpoint.id)) return;
    if (breaker.success(endpoint.id, !call)) emit({ type: "restore", endpoint: endpoint.url });
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
        const terminal = !failoverOf(wrapped);
        board.failure(endpoint.id, policy.identityMethod, latencyMs, false, timeout);
        emit({
          type: "error",
          endpoint: endpoint.url,
          method: policy.identityMethod,
          latencyMs,
          error: wrapped,
          terminal,
        });
        if (!terminal) openCircuit(endpoint, wrapped, false);
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
    const state = { ignore: false, timedOut: false };
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
          if (!state.ignore) {
            board.success(endpoint.id, method, latencyMs, sampleLatency);
            noteHead(target, method, outcome.result, params);
            emit({ type: "success", endpoint: endpoint.url, method, latencyMs, hedged });
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
    };
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
      next: (skip: ReadonlySet<string>): RankedEndpoint | undefined => board.pick(method, skip, "best", random),
      state: (endpoint: RankedEndpoint): "ready" | "unverified" | "unavailable" => {
        if (breaker.isOpen(endpoint.id) || !budgets.has(endpoint.id)) return "unavailable";
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
      if (!budgets.has(rival.id) || (operation?.remaining ?? 1) === 0) continue;
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
      if ((operation?.remaining ?? 1) === 0 || !next || breaker.isOpen(next.id) || !budgets.has(next.id)) {
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
          reason || !active() || breaker.isOpen(next.id) || quarantined(next.id) || !supports(target, method) || !budgets.has(next.id)
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
  ): Promise<unknown> => {
    const pause = (ms: number): Promise<void> => {
      progress(ms);
      return delay(ms, parent);
    };
    const exclude = new Set<string>(barred);
    const errors: Error[] = [];
    const retries = idempotent || rebroadcast;
    const racing = idempotent && raceRivals > 0;
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
          if (ejectionWaitMs + refillMs <= MAX_RETRY_BACKOFF_MS) {
            ejectionWaitMs += refillMs;
            await pause(refillMs);
            continue;
          }
          exhausted = new BudgetExhaustedError(spent, refillMs);
          if (exclude.size === barred.size || newRound) break;
        }
        if (attempt === 0 && !allowEjected && !newRound && errors.length === 0 && exclude.size === barred.size) {
          allowEjected = true;
          continue;
        }
        if (exclude.size > barred.size && !newRound) {
          exclude.clear();
          for (const id of barred) exclude.add(id);
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
        const result = await dispatch(endpoint, method, params, parent, idempotent, exclude, errors, attempt === 0 && racing);
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
  ): Promise<unknown> => {
    const run = async (caller: AbortSignal | undefined, progress = noProgress): Promise<unknown> => {
      const operation = batchOperation ?? new Operation(options.operationBudget, timeout, caller);
      const signal = batchOperation && caller ? AbortSignal.any([operation.signal, caller]) : operation.signal;
      operations.set(signal, operation);
      try { return await send(method, params, signal, idempotent, rebroadcast, barred, progress); }
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

  const execute = async (request: RpcRequest, batchOperation?: Operation): Promise<unknown> => {
    if (closed) throw new TransportClosedError();
    if (request.chainId !== undefined && !policy.chainIds.includes(request.chainId)) {
      throw new UnknownChainError(request.chainId);
    }
    touch();
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
    if (method === policy.probeMethod && idempotent && pin?.answersBlockNumber) {
      if (signal?.aborted) throw abortError(signal);
      const local = pin.blockNumber();
      if (local !== undefined) return local;
    }
    const cached = cache?.lookup(method, params, idempotent, { now: now(), head: newestHead(method) });
    if (cached?.hit) {
      emit({ type: "cache", method, outcome: "hit", stale: cached.stale });
      return cached.result;
    }
    if (cached && !cached.hit) emit({ type: "cache", method, outcome: "miss", stale: null });
    const pinned = pin?.pin(method, params, idempotent) ?? { params, holders: undefined, block: undefined };
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
      })),
    scores: (): ScoreSnapshot => warm.scores(),
    restoreScores: (snapshot: unknown): boolean => warm.restore(snapshot),
    probe,
    cacheStats: (): CacheStats => cache?.stats() ?? { hits: 0, misses: 0, refreshes: 0, entries: 0, bytes: 0, hotKeys: 0 },
    close(): void {
      if (closed) return;
      closed = true;
      stopProbes();
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

function resolveHeadLag(value: boolean | HeadLagOptions | undefined): ResolvedHeadLag {
  if (value === false) {
    return {
      enabled: false,
      maxLag: DEFAULT_MAX_LAG,
      probeInterval: false,
      probeIdleTimeout: DEFAULT_PROBE_IDLE_MS,
      staleMs: DEFAULT_STALE_MS,
      maxAhead: DEFAULT_MAX_AHEAD,
    };
  }
  const options = value === true || value === undefined ? {} : value;
  return {
    enabled: true,
    maxLag: options.maxLag ?? DEFAULT_MAX_LAG,
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
  return options.endpoints.map((endpoint, index) => {
    const id = endpoint.id ?? endpoint.url;
    if (id.trim() === "") throw new Error(`smart-rpc endpoints[${index}].id must not be empty.`);
    if (ids.has(id)) throw new Error(`smart-rpc endpoint "${id}" is used more than once.`);
    ids.add(id);
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
