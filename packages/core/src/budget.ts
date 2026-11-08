/**
 * Per-endpoint request budgets.
 *
 * Each budgeted endpoint has a token bucket that holds up to `burst` tokens and
 * refills at `rps` tokens per second. Every upstream request spends one: calls,
 * retries, chain checks, and health probes. Buckets refill from the clock when
 * they are read, so there is no timer.
 * @module
 */

/** A request budget for one endpoint, or the default for every endpoint. */
export interface BudgetOptions {
  /** Sustained requests per second, above 0. */
  rps: number;
  /** Requests that may go at once after a quiet spell, at least 1. Default: `max(1, ceil(rps * 2))`. */
  burst?: number | undefined;
}

/** A validated budget. */
export interface BudgetConfig {
  rps: number;
  burst: number;
}

interface Bucket {
  /** The configured rate, or for a learned bucket the rate that drew the rate limit. Recovery stops here. */
  readonly baseRps: number;
  readonly baseBurst: number;
  /** The effective rate: `baseRps` until a rate limit cuts it. */
  rps: number;
  burst: number;
  tokens: number;
  /** When `tokens` was last brought up to date. Undefined until the bucket is first read. */
  at: number | undefined;
  /** Learned from rate limits on an endpoint without a configured budget. Dropped once they stop. */
  readonly learned: boolean;
  /** When a rate limit last cut `rps`. */
  cutAt: number;
  /** When `rps` last recovered. */
  grownAt: number;
}

/** Rate-limit state for one endpoint. */
interface Limit {
  /** Rate limits since the endpoint last answered after a cooldown. Each doubles the next cooldown. */
  strikes: number;
  /** When the endpoint may be sent requests again. */
  until: number;
}

/** First cooldown after a rate limit that names no `Retry-After`. It doubles on each repeat. */
export const RATE_LIMIT_COOLDOWN_MS = 1_000;

/** Longest cooldown repeats without a `Retry-After` grow to. */
export const RATE_LIMIT_MAX_COOLDOWN_MS = 30_000;

/** Longest `Retry-After` honoured. A longer ask is clamped to this. */
export const RATE_LIMIT_MAX_RETRY_AFTER_MS = 300_000;

/** A rate limit multiplies the endpoint's effective rate by this. */
export const RATE_LIMIT_DECREASE = 0.5;

/** Each second of successful use gives back this share of the configured rate. */
export const RATE_LIMIT_RECOVERY_PER_SECOND = 0.05;

/** A rate limit never cuts below this share of the configured rate. */
const MIN_RATE_SHARE = 0.1;

/** Rate limits closer together than this are one event: a burst answered 429 cuts the rate once. */
const CUT_WINDOW_MS = 1_000;

/** Floor for a learned rate, in requests per second. */
const MIN_LEARNED_RPS = 0.5;

/** A learned budget with no rate limit for this long is dropped and the endpoint is unlimited again. */
const LEARNED_EXPIRY_MS = 60_000;

/** Send times kept per unbudgeted endpoint, to estimate the rate that drew a rate limit. */
const RATE_SAMPLES = 32;
const RATE_WINDOW_MS = 5_000;

/** What a rate limit did to an endpoint. */
export interface RateLimitOutcome {
  /** How long the endpoint now gets no requests. */
  readonly cooldownMs: number;
  /** The endpoint's effective requests per second after the cut, rounded to 0.01. Null when it has no budget. */
  readonly rps: number | null;
}

/** The configured burst, scaled with the effective rate, never below 1. */
function scaledBurst(bucket: Bucket): number {
  return Math.max(1, Math.min(bucket.baseBurst, Math.round((bucket.baseBurst * bucket.rps) / bucket.baseRps)));
}

/** `max(1, ceil(rps * 2))`: two seconds of traffic, and always room for one request. */
export function defaultBurst(rps: number): number {
  return Math.max(1, Math.ceil(rps * 2));
}

/** Validate a transport-wide `budget` option. `false` disables every budget. */
export function resolveDefaultBudget(
  value: BudgetOptions | false | undefined,
  where = "smart-rpc budget",
): BudgetConfig | false | undefined {
  if (value === false || value === undefined) return value;
  return validBudget(value.rps, value.burst, where);
}

/**
 * The budget for one endpoint: its own `rps` and `burst` over the transport default.
 * A transport `budget` of `false` turns every budget off.
 */
export function resolveEndpointBudget(
  endpoint: { rps?: number | undefined; burst?: number | undefined },
  fallback: BudgetConfig | false | undefined,
  where: string,
): BudgetConfig | undefined {
  if (fallback === false) return undefined;
  if (endpoint.rps === undefined && endpoint.burst === undefined) return fallback;
  const rps = endpoint.rps ?? fallback?.rps;
  if (rps === undefined) throw new Error(`${where}.burst needs an rps, on the endpoint or in budget.`);
  const burst = endpoint.burst ?? (endpoint.rps === undefined ? fallback?.burst : undefined);
  return validBudget(rps, burst, where);
}

function validBudget(rps: number, burst: number | undefined, where: string): BudgetConfig {
  if (!(Number.isFinite(rps) && rps > 0)) throw new Error(`${where}.rps must be a finite number above 0.`);
  if (burst !== undefined && !(Number.isFinite(burst) && burst >= 1)) {
    throw new Error(`${where}.burst must be a finite number of at least 1.`);
  }
  return { rps, burst: burst ?? defaultBurst(rps) };
}

/**
 * Token buckets keyed by endpoint id. Endpoints without a budget are unlimited and hold no bucket.
 *
 * Rate limits adapt the buckets. A rate-limited endpoint gets no requests for its `Retry-After`, or for a cooldown
 * that starts at {@link RATE_LIMIT_COOLDOWN_MS} and doubles while the endpoint keeps answering 429 straight after
 * one; the first answer after a cooldown resets it. Its effective rate is halved (multiplicative decrease) and
 * grows back by {@link RATE_LIMIT_RECOVERY_PER_SECOND} of the configured rate per second of successful use
 * (additive recovery). An endpoint without a budget gets a learned one at half the rate it was being sent, which
 * is dropped after {@link LEARNED_EXPIRY_MS} without a rate limit. A provider bucket shared by the endpoint is cut
 * as well. None of this touches the endpoint's latency or error score: rate limited is not unhealthy.
 */
export class Budgets {
  readonly #buckets = new Map<string, Bucket>();
  readonly #providers = new Map<string, Bucket>();
  readonly #groups = new Map<string, string>();
  readonly #limits = new Map<string, Limit>();
  readonly #sent = new Map<string, number[]>();
  readonly #now: () => number;

  constructor(now: () => number) { this.#now = now; }

  /** Endpoint and provider buckets are charged together; adding a URL never refills a provider. */
  configure(id: string, config: BudgetConfig | undefined, group?: string, provider?: BudgetConfig): void {
    if (config && !this.#buckets.has(id)) this.#buckets.set(id, this.#make(config, false));
    if (group !== undefined) this.#groups.set(id, group);
    if (provider) {
      if (group === undefined) throw new Error("providerBudget requires providerGroup.");
      const existing = this.#providers.get(group);
      if (existing && (existing.baseRps !== provider.rps || existing.baseBurst !== provider.burst)) {
        throw new Error(`Conflicting request budgets for provider group ${group}.`);
      }
      if (!existing) this.#providers.set(group, this.#make(provider, false));
    }
  }

  has(id: string): boolean { return this.heldMs(id) === 0 && this.#for(id).every((bucket) => bucket.tokens >= 1); }

  /** Atomic check and charge prevent simultaneous racers from overspending a shared quota. */
  take(id: string): boolean {
    if (this.heldMs(id) > 0) return false;
    const buckets = this.#for(id);
    if (buckets.some((bucket) => bucket.tokens < 1)) return false;
    for (const bucket of buckets) bucket.tokens -= 1;
    if (!this.#buckets.has(id) || this.#buckets.get(id)?.learned === true) this.#record(id);
    return true;
  }

  /** Whole tokens left. Zero while the endpoint cools down after a rate limit. Null when it has no budget. */
  remaining(id: string): number | null {
    if (this.heldMs(id) > 0) return 0;
    const buckets = this.#for(id);
    return buckets.length === 0 ? null : Math.floor(Math.min(...buckets.map((bucket) => bucket.tokens)));
  }

  refillMs(ids: Iterable<string>): number {
    let soonest = Number.POSITIVE_INFINITY;
    for (const id of ids) {
      const held = this.heldMs(id);
      const wait = Math.max(held, ...this.#for(id).map((bucket) => Math.ceil(((1 - bucket.tokens) * 1_000) / bucket.rps)));
      soonest = Math.min(soonest, wait);
    }
    return Number.isFinite(soonest) ? soonest : 0;
  }

  /** Milliseconds the endpoint still cools down after a rate limit. Zero when it may be sent requests. */
  heldMs(id: string): number {
    const limit = this.#limits.get(id);
    return limit === undefined ? 0 : Math.max(0, limit.until - this.#now());
  }

  /**
   * Record a rate-limited answer. `retryAfterMs` is the provider's `Retry-After`, honoured exactly (up to
   * {@link RATE_LIMIT_MAX_RETRY_AFTER_MS}); without one the cooldown grows from {@link RATE_LIMIT_COOLDOWN_MS}.
   */
  rateLimited(id: string, retryAfterMs = 0): RateLimitOutcome {
    const now = this.#now();
    const limit = this.#limits.get(id) ?? { strikes: 0, until: 0 };
    this.#limits.set(id, limit);
    // Nothing is sent during a cooldown, so a 429 that lands inside one was sent before it began: it is the same
    // event and does not grow the next cooldown. A strike older than the longest cooldown is forgotten.
    const held = now < limit.until;
    if (!held) {
      if (now - limit.until > RATE_LIMIT_MAX_COOLDOWN_MS) limit.strikes = 0;
      limit.strikes += 1;
    }
    const asked = Math.min(RATE_LIMIT_MAX_RETRY_AFTER_MS, Math.max(0, retryAfterMs));
    const backoff = held ? 0 : Math.min(RATE_LIMIT_MAX_COOLDOWN_MS, RATE_LIMIT_COOLDOWN_MS * 2 ** (limit.strikes - 1));
    limit.until = Math.max(limit.until, now + (asked > 0 ? asked : backoff));
    const cooldownMs = limit.until - now;
    let own = this.#buckets.get(id);
    if (own) this.#cut(this.#refill(own), now);
    else {
      own = this.#learn(id, now);
      this.#buckets.set(id, own);
    }
    const group = this.#groups.get(id);
    const shared = group === undefined ? undefined : this.#providers.get(group);
    if (shared) this.#cut(this.#refill(shared), now);
    return { cooldownMs, rps: Math.round(own.rps * 100) / 100 };
  }

  /** Record a successful answer: the cooldown streak ends and a cut rate grows back. */
  served(id: string): void {
    const now = this.#now();
    const limit = this.#limits.get(id);
    if (limit && now >= limit.until) this.#limits.delete(id);
    const own = this.#buckets.get(id);
    if (own?.learned === true && now - own.cutAt >= LEARNED_EXPIRY_MS) {
      this.#buckets.delete(id);
    } else if (own) this.#grow(this.#refill(own), now);
    const group = this.#groups.get(id);
    const shared = group === undefined ? undefined : this.#providers.get(group);
    if (shared) this.#grow(this.#refill(shared), now);
  }

  #cut(bucket: Bucket, now: number): void {
    if (now - bucket.cutAt < CUT_WINDOW_MS) return;
    bucket.rps = Math.max(bucket.baseRps * MIN_RATE_SHARE, bucket.rps * RATE_LIMIT_DECREASE);
    bucket.burst = scaledBurst(bucket);
    bucket.tokens = Math.min(bucket.tokens, 0);
    bucket.cutAt = now;
    bucket.grownAt = now;
  }

  #grow(bucket: Bucket, now: number): void {
    if (bucket.rps >= bucket.baseRps) return;
    const seconds = Math.min(1, Math.max(0, now - bucket.grownAt) / 1_000);
    bucket.rps = Math.min(bucket.baseRps, bucket.rps + bucket.baseRps * RATE_LIMIT_RECOVERY_PER_SECOND * seconds);
    bucket.burst = scaledBurst(bucket);
    bucket.grownAt = now;
  }

  /** A budget for an unbudgeted endpoint: half the rate it was being sent when it said 429. */
  #learn(id: string, now: number): Bucket {
    const sent = this.#rate(id, now) ?? MIN_LEARNED_RPS * 2;
    const ceiling = Math.max(MIN_LEARNED_RPS * 2, sent);
    const rps = Math.max(MIN_LEARNED_RPS, ceiling * RATE_LIMIT_DECREASE);
    const bucket: Bucket = {
      baseRps: ceiling, baseBurst: defaultBurst(ceiling), rps, burst: defaultBurst(rps), tokens: 0, at: now,
      learned: true, cutAt: now, grownAt: now,
    };
    return bucket;
  }

  #record(id: string): void {
    const times = this.#sent.get(id) ?? [];
    times.push(this.#now());
    if (times.length > RATE_SAMPLES) times.shift();
    this.#sent.set(id, times);
  }

  /**
   * Requests per second recently sent to `id`, or undefined with fewer than two in the window. Measured over at
   * least a second, so a race and its failover landing together do not read as a high rate.
   */
  #rate(id: string, now: number): number | undefined {
    const recent = (this.#sent.get(id) ?? []).filter((at) => now - at <= RATE_WINDOW_MS);
    const first = recent[0];
    if (recent.length < 2 || first === undefined) return undefined;
    return recent.length / Math.max(1, (now - first) / 1_000);
  }

  #make(config: BudgetConfig, learned: boolean): Bucket {
    return {
      baseRps: config.rps, baseBurst: config.burst, rps: config.rps, burst: config.burst, tokens: config.burst,
      at: undefined, learned, cutAt: Number.NEGATIVE_INFINITY, grownAt: Number.NEGATIVE_INFINITY,
    };
  }

  #for(id: string): Bucket[] {
    const own = this.#buckets.get(id);
    const group = this.#groups.get(id);
    const shared = group === undefined ? undefined : this.#providers.get(group);
    return [own, shared].filter((bucket): bucket is Bucket => bucket !== undefined).map((bucket) => this.#refill(bucket));
  }

  #refill(bucket: Bucket): Bucket {
    const now = this.#now();
    if (bucket.at !== undefined && now > bucket.at) {
      bucket.tokens = Math.min(bucket.burst, bucket.tokens + ((now - bucket.at) * bucket.rps) / 1_000);
    }
    if (bucket.at === undefined || now > bucket.at) bucket.at = now;
    return bucket;
  }
}
