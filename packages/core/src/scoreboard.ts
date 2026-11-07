/**
 * Per-endpoint memory: latency, errors, in-flight calls, and the newest head.
 *
 * Head rejection matches `@bloxwap/smart-hyperevm` `transport/_scoreboard.ts` at 092b8f9.
 * A fresh head further than `maxAhead` ahead of the median of the other fresh heads is ignored.
 * Heads older than `staleMs` stop affecting the score. Power-of-two-choices draws two candidates
 * and keeps the lower score, with the in-flight penalty applied inside {@link endpointScore}.
 * @module
 */

import { DEFAULT_MAX_AHEAD, DEFAULT_MAX_UNITS_PER_SECOND } from "./constants.js";
import type { EndpointSnapshot } from "./events.js";
import {
  type MethodStat,
  type ScoreConfig,
  defaultScoreConfig,
  emptyStat,
  endpointScore,
  observe,
  observeLiveness,
} from "./score.js";

/** Identity of an endpoint the pool can call. */
export interface RankedEndpoint {
  readonly id: string;
  readonly url: string;
}

/** A concrete endpoint the scoreboard can rank. */
export interface ScoreboardEndpoint extends RankedEndpoint {
  weight: number;
  index: number;
  supports: (method: string) => boolean;
}

interface EndpointState extends ScoreboardEndpoint {
  /** Deadlines of the calls in flight. A call past its deadline no longer counts. */
  inflight: Set<{ readonly until: number }>;
  head: number | null;
  headAt: number;
  global: MethodStat;
  methods: Map<string, MethodStat>;
}

export interface ScoreboardOptions {
  perMethod: boolean;
  headLag: boolean;
  maxLag: number;
  staleMs: number;
  /** Default: {@link DEFAULT_MAX_AHEAD}. */
  maxAhead?: number | undefined;
  /** Freshness units per second used to carry an older head forward. Default: 2. */
  maxUnitsPerSecond?: number | undefined;
  config?: ScoreConfig | undefined;
  now: () => number;
  /** Ejected endpoints. `pick` skips them unless every candidate is ejected. */
  ejected?: ((id: string) => boolean) | undefined;
  /** Endpoints out of request budget. `pick` skips them unless every candidate in the same breaker state is. */
  spent?: ((id: string) => boolean) | undefined;
}

/** Picks an endpoint and records what happened after the call. */
export class Scoreboard {
  readonly #endpoints: EndpointState[];
  readonly #byId: ReadonlyMap<string, EndpointState>;
  readonly #options: ScoreboardOptions;
  #headRevision = 0;
  #headView: { revision: number; at: number; value: HeadView } | undefined;
  /** Books seeded from a stored snapshot, with when they were measured. The first live sample replaces one. */
  readonly #priors = new WeakMap<MethodStat, number>();

  constructor(endpoints: readonly ScoreboardEndpoint[], options: ScoreboardOptions) {
    this.#endpoints = endpoints.map((endpoint) => ({
      ...endpoint,
      inflight: new Set(),
      head: null,
      headAt: 0,
      global: emptyStat(),
      methods: new Map(),
    }));
    this.#byId = new Map(this.#endpoints.map((endpoint) => [endpoint.id, endpoint]));
    this.#options = options;
  }

  /**
   * Lowest score, or the better of two randomly drawn endpoints. Ejected endpoints are a last resort.
   * Spent endpoints come after funded ones of the same breaker state.
   */
  pick(
    method: string,
    exclude: ReadonlySet<string>,
    mode: "best" | "p2c",
    random: () => number,
  ): RankedEndpoint | undefined {
    const eligible = this.#endpoints.filter((endpoint) => !exclude.has(endpoint.id) && endpoint.supports(method));
    const ejected = this.#options.ejected;
    const closed = ejected ? eligible.filter((endpoint) => !ejected(endpoint.id)) : eligible;
    const pool = closed.length > 0 ? closed : eligible;
    const spent = this.#options.spent;
    const funded = spent ? pool.filter((endpoint) => !spent(endpoint.id)) : pool;
    const candidates = funded.length > 0 ? funded : pool;
    const chosen =
      candidates.length === 0
        ? undefined
        : candidates.length === 1 || mode === "best"
          ? this.#best(candidates, method)
          : this.#p2c(candidates, method, random);
    if (!chosen) return undefined;
    return { id: chosen.id, url: chosen.url };
  }

  /**
   * Count a call in flight for at most `ttlMs`. Returns the function that ends it.
   * Calling that again does nothing.
   */
  begin(id: string, ttlMs: number): () => void {
    const endpoint = this.#require(id);
    this.#inflight(endpoint);
    const call = { until: this.#options.now() + ttlMs };
    endpoint.inflight.add(call);
    return (): void => {
      endpoint.inflight.delete(call);
    };
  }

  success(id: string, method: string, latencyMs: number, sampleLatency: boolean): void {
    const endpoint = this.#require(id);
    const config = this.#config();
    if (!sampleLatency) {
      observeLiveness(endpoint.global, true, 0, config);
      return;
    }
    observe(this.#live(endpoint.global), latencyMs, true, config);
    observe(this.#live(this.#method(endpoint, method)), latencyMs, true, config);
  }

  failure(id: string, method: string, latencyMs: number, sampleLatency: boolean, penaltyMs: number): void {
    const endpoint = this.#require(id);
    const config = this.#config();
    if (!sampleLatency) {
      observeLiveness(endpoint.global, false, penaltyMs, config);
      observeLiveness(this.#method(endpoint, method), false, penaltyMs, config);
      return;
    }
    observe(this.#live(endpoint.global), latencyMs, false, config);
    observe(this.#live(this.#method(endpoint, method)), latencyMs, false, config);
  }

  /**
   * Seed an unmeasured book with a stored one measured at `at`. `method` `"*"` is the endpoint's global book.
   * False when the endpoint is unknown or the book already holds samples: live samples always win.
   */
  seed(id: string, method: string, stat: MethodStat, at: number): boolean {
    const endpoint = this.#byId.get(id);
    if (!endpoint) return false;
    const book = method === "*" ? endpoint.global : this.#method(endpoint, method);
    if (book.n > 0) return false;
    Object.assign(book, copyStat(stat));
    this.#priors.set(book, at);
    return true;
  }

  /** Every book with samples. `at` is set on a seeded book no live sample has replaced yet. */
  books(): { id: string; method: string; stat: MethodStat; at: number | undefined }[] {
    return this.#endpoints.flatMap((endpoint) =>
      [["*", endpoint.global] as const, ...endpoint.methods]
        .filter(([, stat]) => stat.n > 0)
        .map(([method, stat]) => ({ id: endpoint.id, method, stat: copyStat(stat), at: this.#priors.get(stat) })),
    );
  }

  /**
   * Record a freshness sample. Returns lag behind the best believed head.
   * `trusted` is false when no reference is believed or this head is ignored as implausible.
   */
  noteHead(id: string, head: number): { best: number; lag: number; trusted: boolean } {
    const endpoint = this.#require(id);
    const now = this.#options.now();
    endpoint.head = head;
    endpoint.headAt = now;
    this.#headRevision += 1;
    const view = this.#heads(now);
    const best = view.best ?? head;
    return { best, lag: Math.max(0, best - head), trusted: view.best !== null && !view.liars.has(endpoint) };
  }

  /**
   * Heads seen in the last `maxAgeMs`, capped at `staleMs`. `trusted` is false when no reference is believed
   * or the head is ignored as implausible.
   */
  heads(maxAgeMs: number): { id: string; head: number; ageMs: number; trusted: boolean }[] {
    const now = this.#options.now();
    const view = this.#heads(now);
    const maxAge = Math.min(maxAgeMs, this.#options.staleMs);
    const readings: { id: string; head: number; ageMs: number; trusted: boolean }[] = [];
    for (const endpoint of this.#endpoints) {
      if (endpoint.head === null || now - endpoint.headAt > maxAge) continue;
      readings.push({
        id: endpoint.id,
        head: endpoint.head,
        ageMs: Math.max(0, now - endpoint.headAt),
        trusted: view.best !== null && !view.liars.has(endpoint),
      });
    }
    return readings;
  }

  /**
   * How long to wait before cloning a safe read.
   * Cold endpoints use `minDelay`. After a few samples, wait until the call is slower than `multiplier` times the tail.
   */
  hedgeDelay(id: string, method: string, minDelay: number, multiplier: number): number {
    const endpoint = this.#require(id);
    const stat = endpoint.methods.get(method) ?? endpoint.global;
    if (stat.n < 3) return minDelay;
    const tail = stat.tail > 0 ? stat.tail : stat.ewma;
    const scaled = tail * multiplier;
    return scaled > minDelay ? scaled : minDelay;
  }

  snapshot(method: string): Omit<EndpointSnapshot, "quarantined" | "tokens" | "ejected">[] {
    const view = this.#heads(this.#options.now());
    return this.#endpoints.map((endpoint) => ({
      id: endpoint.id,
      url: endpoint.url,
      weight: endpoint.weight,
      inflight: this.#inflight(endpoint),
      head: endpoint.head,
      lag: this.#lag(endpoint, view),
      score: this.#score(endpoint, method),
      methods: Object.fromEntries([
        ["*", copyStat(endpoint.global)],
        ...[...endpoint.methods.entries()].map(([name, stat]) => [name, copyStat(stat)]),
      ]),
    }));
  }

  #require(id: string): EndpointState {
    const endpoint = this.#byId.get(id);
    if (!endpoint) throw new Error(`Unknown RPC endpoint: ${id}`);
    return endpoint;
  }

  #method(endpoint: EndpointState, method: string): MethodStat {
    const existing = endpoint.methods.get(method);
    if (existing) return existing;
    const created = emptyStat();
    endpoint.methods.set(method, created);
    return created;
  }

  /** `stat`, emptied first when it is a seeded prior, so the first live sample replaces it instead of mixing in. */
  #live(stat: MethodStat): MethodStat {
    if (this.#priors.delete(stat)) Object.assign(stat, emptyStat());
    return stat;
  }

  #score(endpoint: EndpointState, method: string): number {
    return endpointScore({
      global: endpoint.global,
      method: endpoint.methods.get(method),
      perMethod: this.#options.perMethod,
      inflight: this.#inflight(endpoint),
      lagPenalty: this.#lagPenalty(endpoint),
      weight: endpoint.weight,
      config: this.#options.config ?? defaultScoreConfig,
    });
  }

  /** Calls in flight that are still inside their deadline. Expired ones are dropped. */
  #inflight(endpoint: EndpointState): number {
    const now = this.#options.now();
    for (const call of endpoint.inflight) if (call.until <= now) endpoint.inflight.delete(call);
    return endpoint.inflight.size;
  }

  /** Null when there is no head, no believed reference, or this endpoint's head is ignored. */
  #lag(endpoint: EndpointState, view: HeadView): number | null {
    if (endpoint.head === null || view.best === null || view.liars.has(endpoint)) return null;
    return Math.max(0, view.best - endpoint.head);
  }

  #config(): ScoreConfig {
    return this.#options.config ?? defaultScoreConfig;
  }

  #lagPenalty(endpoint: EndpointState): number {
    if (!this.#options.headLag) return 1;
    const view = this.#heads(this.#options.now());
    if (endpoint.head !== null && view.best !== null && view.liars.has(endpoint)) {
      return 1 + this.#config().lagWeight * (endpoint.head - view.best);
    }
    const lag = this.#lag(endpoint, view);
    if (lag === null || lag <= this.#options.maxLag) return 1;
    return 1 + this.#config().lagWeight * (lag - this.#options.maxLag);
  }

  /**
   * The reference head, and the endpoints whose heads are ignored.
   *
   * A fresh head is implausible when it leads the median of the other fresh heads by more than `maxAhead`.
   * Older heads are carried forward at `maxUnitsPerSecond` before the comparison. The reference is the highest
   * head that is not implausible.
   *
   * One fresh head is its own reference. Two fresh heads more than `maxAhead` apart leave no reference.
   * With three or more the majority wins.
   */
  #heads(now: number): HeadView {
    const cached = this.#headView;
    if (cached?.revision === this.#headRevision && cached.at === now) return cached.value;
    const fresh: HeadSample[] = [];
    for (const endpoint of this.#endpoints) {
      if (endpoint.head === null) continue;
      if (now - endpoint.headAt > this.#options.staleMs) continue;
      fresh.push({ endpoint, head: endpoint.head, at: endpoint.headAt });
    }
    const maxAhead = this.#options.maxAhead ?? DEFAULT_MAX_AHEAD;
    const liars = new Set<EndpointState>();
    for (const sample of fresh) {
      const anchor = peerMedian(sample, fresh, this.#options.maxUnitsPerSecond ?? DEFAULT_MAX_UNITS_PER_SECOND);
      if (anchor !== null && sample.head > anchor + maxAhead) liars.add(sample.endpoint);
    }
    if (fresh.length === 2 && liars.size > 0) {
      const value = { best: null, liars: new Set<EndpointState>() };
      this.#headView = { revision: this.#headRevision, at: now, value };
      return value;
    }
    let best: number | null = null;
    for (const sample of fresh) {
      if (liars.has(sample.endpoint)) continue;
      if (best === null || sample.head > best) best = sample.head;
    }
    const value = { best, liars };
    this.#headView = { revision: this.#headRevision, at: now, value };
    return value;
  }

  #better(left: EndpointState, right: EndpointState, method: string): EndpointState {
    const leftScore = this.#score(left, method);
    const rightScore = this.#score(right, method);
    if (leftScore < rightScore) return left;
    if (rightScore < leftScore) return right;
    return left.index <= right.index ? left : right;
  }

  #best(candidates: readonly EndpointState[], method: string): EndpointState | undefined {
    let best: EndpointState | undefined;
    let bestScore = 0;
    for (const candidate of candidates) {
      const score = this.#score(candidate, method);
      if (!best || score < bestScore || (!(bestScore < score) && candidate.index <= best.index)) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  #p2c(candidates: readonly EndpointState[], method: string, random: () => number): EndpointState | undefined {
    const first = candidates[draw(random, candidates.length)];
    if (!first) return undefined;
    let secondIndex = draw(random, candidates.length);
    if (candidates[secondIndex] === first) secondIndex = (candidates.indexOf(first) + 1) % candidates.length;
    const second = candidates[secondIndex] ?? first;
    return this.#better(first, second, method);
  }
}

interface HeadSample {
  readonly endpoint: EndpointState;
  readonly head: number;
  readonly at: number;
}

interface HeadView {
  readonly best: number | null;
  readonly liars: ReadonlySet<EndpointState>;
}

/** Median of the other fresh heads, each carried forward to when `sample` was taken. Upper middle on an even count. */
function peerMedian(sample: HeadSample, fresh: readonly HeadSample[], unitsPerSecond: number): number | null {
  const others = fresh
    .filter((other) => other !== sample)
    .map((other) => other.head + (Math.max(0, sample.at - other.at) / 1_000) * unitsPerSecond)
    .sort((left, right) => left - right);
  return others[Math.floor(others.length / 2)] ?? null;
}

function copyStat(stat: MethodStat): MethodStat {
  return { ewma: stat.ewma, tail: stat.tail, error: stat.error, n: stat.n };
}

function draw(random: () => number, length: number): number {
  const scaled = Math.floor(random() * length);
  if (scaled < 0) return 0;
  if (scaled >= length) return length - 1;
  return scaled;
}
