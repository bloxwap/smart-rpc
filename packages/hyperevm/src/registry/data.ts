import {
  defaultRankPolicy,
  endpointKey,
  rankRegistry,
  refuseRegistryRewrite,
  type ProbeObservation,
  type RankedEndpoint,
  type RankPolicy,
  type RegistryEndpointStats,
  type RegistryRanking,
} from "./policy.js";

export interface MainnetRegistryRow extends RegistryRanking {
  url: string;
}

export interface MainnetRegistryFile {
  version: 1;
  chainId: 999;
  updatedAt: string;
  policy: RankPolicy;
  endpoints: MainnetRegistryRow[];
}

export interface RegistryHistoryFile {
  version: 1;
  chainId: 999;
  observations: ProbeObservation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : finite(value, label);
}

function assertStats(value: unknown, label: string): asserts value is RegistryEndpointStats | null {
  if (value === null) return;
  if (!isRecord(value)) throw new Error(`${label} must be an object or null.`);
  for (const key of ["observations", "successes"] as const) {
    const number = finite(value[key], `${label}.${key}`);
    if (!Number.isInteger(number) || number < 0) throw new Error(`${label}.${key} must be a non-negative integer.`);
  }
  const uptime = finite(value.uptime, `${label}.uptime`);
  if (uptime < 0 || uptime > 1) throw new Error(`${label}.uptime must be between zero and one.`);
  nullableNumber(value.latencyMs, `${label}.latencyMs`);
  nullableNumber(value.tailMs, `${label}.tailMs`);
  nullableNumber(value.medianLag, `${label}.medianLag`);
  if (typeof value.established !== "boolean") throw new Error(`${label}.established must be boolean.`);
  if (value.precompileOk !== null && typeof value.precompileOk !== "boolean") {
    throw new Error(`${label}.precompileOk must be boolean or null.`);
  }
}

export function assertRankPolicy(value: unknown): asserts value is RankPolicy {
  if (!isRecord(value)) throw new Error("Registry policy must be an object.");
  if (finite(value.windowMs, "policy.windowMs") <= 0) throw new Error("policy.windowMs must be positive.");
  const observations = finite(value.minObservations, "policy.minObservations");
  if (!Number.isInteger(observations) || observations < 1) throw new Error("policy.minObservations must be positive.");
  if (finite(value.minSpanMs, "policy.minSpanMs") < 0) throw new Error("policy.minSpanMs cannot be negative.");
  for (const key of ["minUptime", "minEligibleUptime", "newNodeWeightCap", "maxNewNodeShare"] as const) {
    const number = finite(value[key], `policy.${key}`);
    if (number < 0 || number > 1) throw new Error(`policy.${key} must be between zero and one.`);
  }
  if (value.newNodeWeightCap === 0 || value.maxNewNodeShare === 0) {
    throw new Error("New-node weight and share caps must be positive.");
  }
}

export function assertMainnetRegistryFile(value: unknown): asserts value is MainnetRegistryFile {
  if (!isRecord(value) || value.version !== 1 || value.chainId !== 999) {
    throw new Error("Registry must be a version-1 HyperEVM mainnet document.");
  }
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("Registry updatedAt must be an ISO date.");
  }
  assertRankPolicy(value.policy);
  if (!Array.isArray(value.endpoints) || value.endpoints.length === 0) {
    throw new Error("Registry endpoints must be a non-empty array.");
  }
  const urls = new Set<string>();
  for (const [index, row] of value.endpoints.entries()) {
    if (!isRecord(row) || typeof row.url !== "string" || row.url.length === 0) {
      throw new Error(`Registry endpoints[${index}] must have a URL.`);
    }
    const key = endpointKey(row.url);
    if (urls.has(key)) throw new Error(`Registry lists ${row.url} more than once.`);
    urls.add(key);
    if (typeof row.eligible !== "boolean") throw new Error(`Registry endpoints[${index}].eligible must be boolean.`);
    const weight = finite(row.weight, `endpoints[${index}].weight`);
    if (weight < 0) throw new Error("Registry weight cannot be negative.");
    if (row.rank !== null && (typeof row.rank !== "number" || !Number.isInteger(row.rank) || row.rank < 1)) {
      throw new Error(`Registry endpoints[${index}].rank must be a positive integer or null.`);
    }
    assertStats(row.stats, `endpoints[${index}].stats`);
    if (row.eligible !== (weight > 0 && row.rank !== null)) {
      throw new Error(`Registry endpoints[${index}] has inconsistent eligibility, weight, and rank.`);
    }
  }
}

function assertObservation(value: unknown, label: string): asserts value is ProbeObservation {
  if (!isRecord(value) || typeof value.url !== "string" || typeof value.at !== "string" ||
      !Number.isFinite(Date.parse(value.at)) || typeof value.ok !== "boolean" || typeof value.chainIdOk !== "boolean") {
    throw new Error(`${label} is not a valid probe observation.`);
  }
  if (value.head !== null && finite(value.head, `${label}.head`) < 0) throw new Error(`${label}.head is invalid.`);
  if (value.lag !== null && finite(value.lag, `${label}.lag`) < 0) throw new Error(`${label}.lag is invalid.`);
  if (value.headAt !== undefined && (typeof value.headAt !== "string" || !Number.isFinite(Date.parse(value.headAt)))) {
    throw new Error(`${label}.headAt is invalid.`);
  }
  if (!isRecord(value.methods)) throw new Error(`${label}.methods must be an object.`);
  for (const [method, sample] of Object.entries(value.methods)) {
    if (!isRecord(sample) || typeof sample.ok !== "boolean" || finite(sample.ms, `${label}.methods.${method}.ms`) < 0) {
      throw new Error(`${label}.methods.${method} is invalid.`);
    }
  }
}

export function assertRegistryHistoryFile(value: unknown): asserts value is RegistryHistoryFile {
  if (!isRecord(value) || value.version !== 1 || value.chainId !== 999 || !Array.isArray(value.observations)) {
    throw new Error("History must be a version-1 HyperEVM mainnet document.");
  }
  value.observations.forEach((observation, index) => assertObservation(observation, `observations[${index}]`));
}

/** Validate an imported fixture, which may predate the chainId field in history files. */
export function assertObservationDocument(value: unknown): asserts value is { observations: ProbeObservation[] } {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.observations)) {
    throw new Error("Fixture must be a version-1 observation document.");
  }
  if (value.chainId !== undefined && value.chainId !== 999) throw new Error("Fixture observations are for another chain.");
  value.observations.forEach((observation, index) => assertObservation(observation, `observations[${index}]`));
}

export interface RegistryRefresh<T extends { readonly url: string }> {
  registry: MainnetRegistryFile;
  history: RegistryHistoryFile;
  ranked: RankedEndpoint<T>[];
}

/** Append one bounded probe run, rank the rolling window, and reject unsafe rewrites. */
export function refreshMainnetRegistry<T extends { readonly url: string }>(
  endpoints: readonly T[],
  previous: MainnetRegistryFile,
  history: RegistryHistoryFile,
  current: readonly ProbeObservation[],
  nowMs: number,
): RegistryRefresh<T> {
  if (endpoints.length === 0) throw new Error("The source registry returned no endpoints. Refusing to rewrite rankings.");
  const sourceKeys = new Set(endpoints.map((endpoint) => endpointKey(endpoint.url)));
  if (sourceKeys.size !== endpoints.length) throw new Error("The source registry contains duplicate endpoint URLs.");
  const scoped = current.filter((observation) => sourceKeys.has(endpointKey(observation.url)));
  if (scoped.length === 0) throw new Error("The probe run returned no source observations. Refusing to rewrite rankings.");
  if (previous.endpoints.some((endpoint) => endpoint.eligible) &&
      !scoped.some((observation) => observation.chainIdOk && observation.ok)) {
    throw new Error("No source endpoint returned a valid chain 999 identity and head. Refusing to rewrite the registry.");
  }

  const windowStart = nowMs - previous.policy.windowMs;
  const retained = [...history.observations, ...scoped].filter((observation) => {
    const at = Date.parse(observation.at);
    return sourceKeys.has(endpointKey(observation.url)) && at >= windowStart && at <= nowMs;
  });
  retained.sort((a, b) => a.at.localeCompare(b.at) || endpointKey(a.url).localeCompare(endpointKey(b.url)));
  const ranked = rankRegistry(endpoints, retained, nowMs, previous.policy);
  const refusal = refuseRegistryRewrite(previous.endpoints, ranked);
  if (refusal || !ranked.some((endpoint) => endpoint.eligible && endpoint.weight > 0)) {
    throw new Error(refusal ?? "Ranking left no endpoint eligible. Refusing to write an empty default pool.");
  }
  const next: MainnetRegistryFile = {
    version: 1,
    chainId: 999,
    updatedAt: new Date(nowMs).toISOString(),
    policy: { ...defaultRankPolicy, ...previous.policy },
    endpoints: ranked.map((endpoint) => ({
      url: endpoint.url,
      eligible: endpoint.eligible,
      weight: endpoint.weight,
      rank: endpoint.rank,
      stats: endpoint.stats,
    })),
  };
  const nextHistory: RegistryHistoryFile = { version: 1, chainId: 999, observations: retained };
  assertMainnetRegistryFile(next);
  assertRegistryHistoryFile(nextHistory);
  return { registry: next, history: nextHistory, ranked };
}
