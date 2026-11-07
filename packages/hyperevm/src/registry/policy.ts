/** One historical probe of one HTTP endpoint. */
export interface ProbeObservation {
  at: string;
  url: string;
  ok: boolean;
  chainIdOk: boolean;
  head: number | null;
  /** Blocks behind the best cohort head, adjusted for probe time. */
  lag: number | null;
  headAt?: string | undefined;
  methods: Record<string, { ms: number; ok: boolean }>;
}

export const PRECOMPILE_PROBE = "hypercore_l1BlockNumber";
export const LOGS_RANGE_PROBE = "eth_getLogs_range";
/** A full page for clients that stay below a 1,000-block provider limit. */
export const LOGS_RANGE_BLOCKS = 999;

export interface RegistryEndpointStats {
  observations: number;
  successes: number;
  uptime: number;
  /** Maximum of the successful per-method median latencies. */
  latencyMs: number | null;
  /** Slowest successful method sample in the window. */
  tailMs: number | null;
  medianLag: number | null;
  established: boolean;
  /** Latest live-node HyperCore verdict; null when no observation recorded it. */
  precompileOk: boolean | null;
}

export interface RegistryRanking {
  eligible: boolean;
  weight: number;
  rank: number | null;
  stats: RegistryEndpointStats | null;
}

export type RankedEndpoint<T extends { readonly url: string }> = T & RegistryRanking;

export interface RankPolicy {
  windowMs: number;
  minObservations: number;
  minSpanMs: number;
  minUptime: number;
  minEligibleUptime: number;
  newNodeWeightCap: number;
  maxNewNodeShare: number;
}

/** Weekly probes establish a node after three successes spread over two weeks. */
export const defaultRankPolicy: RankPolicy = {
  windowMs: 28 * 24 * 60 * 60 * 1000,
  minObservations: 3,
  minSpanMs: 14 * 24 * 60 * 60 * 1000,
  minUptime: 0.8,
  minEligibleUptime: 0.5,
  newNodeWeightCap: 0.15,
  maxNewNodeShare: 0.25,
};

const LAG_GRACE_BLOCKS = 2;

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (sorted.length % 2 === 0 && left !== undefined && right !== undefined) return (left + right) / 2;
  return right ?? null;
}

/** Equivalent host-root URLs with and without a trailing slash share history. */
export function endpointKey(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function methodMedians(observations: readonly ProbeObservation[]): { typical: number | null; tail: number | null } {
  const byMethod = new Map<string, number[]>();
  const samples: number[] = [];
  for (const observation of observations) {
    if (!observation.ok || !observation.chainIdOk) continue;
    for (const [method, sample] of Object.entries(observation.methods)) {
      if (!sample.ok) continue;
      const list = byMethod.get(method) ?? [];
      list.push(sample.ms);
      byMethod.set(method, list);
      samples.push(sample.ms);
    }
  }
  const medians: number[] = [];
  for (const list of byMethod.values()) {
    const value = median(list);
    if (value !== null) medians.push(value);
  }
  return {
    typical: medians.length === 0 ? null : Math.max(...medians),
    tail: samples.length === 0 ? null : Math.max(...samples),
  };
}

/** A missing key is an observation from before the probe existed, not a failure. */
function probePassed(observation: ProbeObservation, method: string): boolean {
  return observation.methods[method]?.ok !== false;
}

function isSuccess(observation: ProbeObservation): boolean {
  return observation.ok && observation.chainIdOk && probePassed(observation, LOGS_RANGE_PROBE) &&
    probePassed(observation, PRECOMPILE_PROBE);
}

function latestPrecompile(observations: readonly ProbeObservation[]): boolean | null {
  let latestAt = Number.NEGATIVE_INFINITY;
  let latest: boolean | null = null;
  for (const observation of observations) {
    const sample = observation.methods[PRECOMPILE_PROBE];
    if (sample === undefined || !observation.ok || !observation.chainIdOk) continue;
    const at = Date.parse(observation.at);
    if (!Number.isFinite(at) || at < latestAt) continue;
    latestAt = at;
    latest = sample.ok;
  }
  return latest;
}

function scoreRow(stats: RegistryEndpointStats): number {
  const typical = stats.latencyMs ?? Number.POSITIVE_INFINITY;
  const tail = stats.tailMs ?? typical;
  const latency = 0.6 * typical + 0.4 * tail;
  const lagPenalty = 1 + Math.max(0, (stats.medianLag ?? 0) - LAG_GRACE_BLOCKS);
  return latency * lagPenalty * (1 + (1 - stats.uptime) * 4);
}

function applyShareCap(rows: RegistryRanking[], policy: RankPolicy): void {
  const established = rows.filter((row) => row.eligible && row.stats?.established === true);
  const fresh = rows.filter((row) => row.eligible && row.stats?.established !== true);
  const oldWeight = established.reduce((sum, row) => sum + row.weight, 0);
  const newWeight = fresh.reduce((sum, row) => sum + row.weight, 0);
  if (oldWeight <= 0 || newWeight <= 0) return;
  const share = newWeight / (oldWeight + newWeight);
  if (share <= policy.maxNewNodeShare) return;
  const allowed = (policy.maxNewNodeShare / (1 - policy.maxNewNodeShare)) * oldWeight;
  const scale = allowed / newWeight;
  for (const row of fresh) row.weight = round(row.weight * scale, 4);
}

/**
 * Deterministically rank endpoints from observations inside the rolling window.
 * Nodes without a success stay listed at weight zero. A failed realistic log
 * range counts as downtime; the latest live HyperCore failure vetoes eligibility.
 */
export function rankRegistry<T extends { readonly url: string }>(
  endpoints: readonly T[],
  observations: readonly ProbeObservation[],
  nowMs: number,
  policy: RankPolicy = defaultRankPolicy,
): RankedEndpoint<T>[] {
  const fresh = observations.filter((observation) => {
    const at = Date.parse(observation.at);
    return Number.isFinite(at) && nowMs - at <= policy.windowMs && nowMs - at >= 0;
  });
  const rows = endpoints.map((endpoint) => {
    const key = endpointKey(endpoint.url);
    const mine = fresh.filter((observation) => endpointKey(observation.url) === key);
    const successes = mine.filter(isSuccess);
    const uptime = mine.length === 0 ? 0 : successes.length / mine.length;
    const times = mine.map((observation) => Date.parse(observation.at)).sort((a, b) => a - b);
    const first = times[0];
    const last = times[times.length - 1];
    const span = first !== undefined && last !== undefined ? last - first : 0;
    const { typical, tail } = methodMedians(mine);
    const lag = median(mine.map((observation) => observation.lag).filter((value): value is number => value !== null));
    const established = successes.length >= policy.minObservations && span >= policy.minSpanMs && uptime >= policy.minUptime;
    const precompileOk = latestPrecompile(mine);
    const eligible = successes.length > 0 && uptime >= policy.minEligibleUptime && typical !== null && precompileOk !== false;
    const stats: RegistryEndpointStats = {
      observations: mine.length,
      successes: successes.length,
      uptime: round(uptime, 4),
      latencyMs: typical === null ? null : round(typical, 1),
      tailMs: tail === null ? null : round(tail, 1),
      medianLag: lag === null ? null : round(lag, 2),
      established,
      precompileOk,
    };
    return {
      score: eligible ? scoreRow(stats) : Number.POSITIVE_INFINITY,
      endpoint: {
        ...endpoint,
        eligible,
        weight: eligible ? established ? 1 : policy.newNodeWeightCap : 0,
        rank: null,
        stats,
      } as RankedEndpoint<T>,
    };
  });

  rows
    .filter((row) => row.endpoint.eligible)
    .sort((a, b) => a.score - b.score || endpointKey(a.endpoint.url).localeCompare(endpointKey(b.endpoint.url)))
    .forEach((row, index) => { row.endpoint.rank = index + 1; });
  applyShareCap(rows.map((row) => row.endpoint), policy);

  return rows.map((row) => row.endpoint).sort((a, b) => {
    if (a.rank === null && b.rank === null) return endpointKey(a.url).localeCompare(endpointKey(b.url));
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    return a.rank - b.rank;
  });
}

/** Why a ranked document must not replace the previous one, or undefined when safe. */
export function refuseRegistryRewrite(
  previous: readonly { readonly eligible: boolean }[],
  next: readonly { readonly eligible: boolean }[],
): string | undefined {
  if (!previous.some((endpoint) => endpoint.eligible)) return undefined;
  if (next.some((endpoint) => endpoint.eligible)) return undefined;
  return "Ranking left no endpoint eligible. Refusing to replace a registry that had eligible endpoints.";
}
