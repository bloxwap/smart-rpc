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
  readonly rps: number;
  readonly burst: number;
  tokens: number;
  /** When `tokens` was last brought up to date. Undefined until the bucket is first read. */
  at: number | undefined;
}

/** `undefined` means the endpoint was registered without a bucket. A later budget must match. */
type RecordedBudget = BudgetConfig | undefined;

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

/** Token buckets keyed by endpoint id. Endpoints without a budget are unlimited and hold no bucket. */
export class Budgets {
  readonly #buckets = new Map<string, Bucket>();
  readonly #recorded = new Map<string, RecordedBudget>();
  readonly #providers = new Map<string, Bucket>();
  readonly #groups = new Map<string, string>();
  readonly #now: () => number;

  constructor(now: () => number) { this.#now = now; }

  /** Endpoint and provider buckets are charged together; adding a URL never refills a provider. */
  configure(id: string, config: BudgetConfig | undefined, group?: string, provider?: BudgetConfig): void {
    if (this.#recorded.has(id)) {
      const previous = this.#recorded.get(id);
      if (previous?.rps !== config?.rps || previous?.burst !== config?.burst) {
        throw new Error(`Conflicting request budgets for endpoint ${id}.`);
      }
    } else {
      this.#recorded.set(id, config);
    }
    if (config && !this.#buckets.has(id)) this.#buckets.set(id, this.#make(config));
    if (group !== undefined) this.#groups.set(id, group);
    if (provider) {
      if (group === undefined) throw new Error("providerBudget requires providerGroup.");
      const existing = this.#providers.get(group);
      if (existing && (existing.rps !== provider.rps || existing.burst !== provider.burst)) {
        throw new Error(`Conflicting request budgets for provider group ${group}.`);
      }
      if (!existing) this.#providers.set(group, this.#make(provider));
    }
  }

  has(id: string): boolean { return this.#for(id).every((bucket) => bucket.tokens >= 1); }

  /** Atomic check and charge prevent simultaneous racers from overspending a shared quota. */
  take(id: string): boolean {
    const buckets = this.#for(id);
    if (buckets.some((bucket) => bucket.tokens < 1)) return false;
    for (const bucket of buckets) bucket.tokens -= 1;
    return true;
  }

  remaining(id: string): number | null {
    const buckets = this.#for(id);
    return buckets.length === 0 ? null : Math.floor(Math.min(...buckets.map((bucket) => bucket.tokens)));
  }

  refillMs(ids: Iterable<string>): number {
    let soonest = Number.POSITIVE_INFINITY;
    for (const id of ids) {
      const wait = Math.max(0, ...this.#for(id).map((bucket) => Math.ceil(((1 - bucket.tokens) * 1_000) / bucket.rps)));
      soonest = Math.min(soonest, wait);
    }
    return Number.isFinite(soonest) ? soonest : 0;
  }

  #make(config: BudgetConfig): Bucket {
    return { ...config, tokens: config.burst, at: undefined };
  }

  #for(id: string): Bucket[] {
    const own = this.#buckets.get(id);
    const group = this.#groups.get(id);
    const shared = group === undefined ? undefined : this.#providers.get(group);
    return [own, shared].filter((bucket): bucket is Bucket => bucket !== undefined).map((bucket) => this.#refill(bucket));
  }

  #refill(bucket: Bucket): Bucket {
    const now = this.#now();
    // A non-finite or backwards sample does not move the bucket. The pool clock already
    // drops those samples; this keeps a raw clock from freezing the bucket at NaN.
    if (!Number.isFinite(now)) return bucket;
    if (bucket.at !== undefined && now > bucket.at) {
      bucket.tokens = Math.min(bucket.burst, bucket.tokens + ((now - bucket.at) * bucket.rps) / 1_000);
    }
    if (bucket.at === undefined || now > bucket.at) bucket.at = now;
    return bucket;
  }
}
