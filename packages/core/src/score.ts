/**
 * Latency score used to pick an endpoint.
 *
 * The service estimate blends a latency EWMA with a tail EWMA that moves up
 * quickly and down slowly. In-flight work inflates that estimate by
 * `1 + n + queueWeight * n^2` (default `queueWeight` 0.25).
 *
 * Constants match `@bloxwap/smart-hyperevm` `transport/_score.ts` at 092b8f9.
 * @module
 */

/** Rolling latency and error memory for one endpoint, optionally one method. */
export interface MethodStat {
  /** EWMA of successful samples, in milliseconds. Zero when no success has landed. */
  ewma: number;
  /** Asymmetric EWMA that remembers slow samples longer than fast ones. */
  tail: number;
  /** EWMA of failures, in the range 0 to 1. */
  error: number;
  /** Number of latency samples folded into this stat. Liveness-only updates do not increment it. */
  n: number;
}

/** Knobs for {@link endpointScore}. Defaults match the HyperEVM transport. */
export interface ScoreConfig {
  /** Weight of the mean EWMA inside the service estimate. The rest is the tail. */
  latencyMix: number;
  /** EWMA step when a successful sample is slower than the current mean. */
  ewmaAlphaUp: number;
  /** EWMA step when a successful sample is faster than the current mean. */
  ewmaAlphaDown: number;
  /** Tail step when a sample is slower than the current tail. */
  tailAlphaUp: number;
  /** Tail step when a sample is faster than the current tail. */
  tailAlphaDown: number;
  /** Step for the error EWMA on a finished call. */
  errorAlpha: number;
  /** Step for cooling the error EWMA after a head probe succeeds. */
  livenessAlpha: number;
  /** Multiplier on the error EWMA inside the penalty. */
  errorWeight: number;
  /** Multiplier on blocks of lag past `maxLag`. 1 keeps `1 + (lag - maxLag)`. */
  lagWeight: number;
  /** Service time assumed before any sample exists. */
  priorMs: number;
  /** Samples required before the prior is fully replaced. */
  confidenceSamples: number;
  /** Per-method samples required before that method fully replaces the global stat. */
  methodBlendSamples: number;
  /** Coefficient on `inflight^2` in the queue term. */
  queueWeight: number;
}

const UNIT_INTERVAL: readonly (keyof ScoreConfig)[] = [
  "latencyMix",
  "ewmaAlphaUp",
  "ewmaAlphaDown",
  "tailAlphaUp",
  "tailAlphaDown",
  "errorAlpha",
  "livenessAlpha",
];

const NON_NEGATIVE: readonly (keyof ScoreConfig)[] = ["errorWeight", "lagWeight", "priorMs", "queueWeight"];

const POSITIVE: readonly (keyof ScoreConfig)[] = ["confidenceSamples", "methodBlendSamples"];

/** Merge a partial score config over the defaults and reject coefficients that invert a penalty. */
export function resolveScoreConfig(partial: Partial<ScoreConfig> | undefined): ScoreConfig {
  const config = { ...defaultScoreConfig, ...partial };
  for (const name of UNIT_INTERVAL) {
    const value = config[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`smart-rpc score.${name} must be a finite number from 0 to 1, got ${String(value)}.`);
    }
  }
  for (const name of NON_NEGATIVE) {
    const value = config[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`smart-rpc score.${name} must be a finite number, 0 or more, got ${String(value)}.`);
    }
  }
  for (const name of POSITIVE) {
    const value = config[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`smart-rpc score.${name} must be a finite number above 0, got ${String(value)}.`);
    }
  }
  return config;
}

export const defaultScoreConfig: ScoreConfig = {
  latencyMix: 0.6,
  ewmaAlphaUp: 0.4,
  ewmaAlphaDown: 0.2,
  tailAlphaUp: 0.5,
  tailAlphaDown: 0.05,
  errorAlpha: 0.3,
  livenessAlpha: 0.15,
  errorWeight: 8,
  lagWeight: 1,
  priorMs: 250,
  confidenceSamples: 5,
  methodBlendSamples: 3,
  queueWeight: 0.25,
};

/** A stat with no samples. */
export function emptyStat(): MethodStat {
  return { ewma: 0, tail: 0, error: 0, n: 0 };
}

function mix(previous: number, sample: number, alpha: number): number {
  return alpha * sample + (1 - alpha) * previous;
}

function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Fold one finished call into `stat`.
 * Failures move the tail and the error rate, and they do not pretend to be a fast success.
 */
export function observe(
  stat: MethodStat,
  latencyMs: number,
  ok: boolean,
  config: ScoreConfig = defaultScoreConfig,
): void {
  const latency = latencyMs < 0 ? 0 : latencyMs;
  if (stat.n === 0) {
    stat.ewma = ok ? latency : 0;
    stat.tail = latency;
    stat.error = ok ? 0 : 1;
    stat.n = 1;
    return;
  }
  if (ok) {
    const alpha = latency > stat.ewma ? config.ewmaAlphaUp : config.ewmaAlphaDown;
    stat.ewma = mix(stat.ewma, latency, alpha);
  }
  const tailAlpha = latency > stat.tail ? config.tailAlphaUp : config.tailAlphaDown;
  stat.tail = mix(stat.tail, latency, tailAlpha);
  stat.error = clamp01(mix(stat.error, ok ? 0 : 1, config.errorAlpha));
  stat.n += 1;
}

/**
 * Update liveness without teaching the latency EWMA.
 * Probe successes only cool the error rate. Probe failures push the tail toward `penaltyMs`.
 */
export function observeLiveness(
  stat: MethodStat,
  ok: boolean,
  penaltyMs: number,
  config: ScoreConfig = defaultScoreConfig,
): void {
  if (ok) {
    if (stat.n === 0) return;
    stat.error = clamp01(mix(stat.error, 0, config.livenessAlpha));
    return;
  }
  const penalty = penaltyMs < 0 ? 0 : penaltyMs;
  if (stat.n === 0) {
    stat.tail = penalty;
    stat.error = 1;
    stat.n = 1;
    return;
  }
  const tailAlpha = penalty > stat.tail ? config.tailAlphaUp : config.tailAlphaDown;
  stat.tail = mix(stat.tail, penalty, tailAlpha);
  stat.error = clamp01(mix(stat.error, 1, config.errorAlpha));
}

/** Estimated service time in milliseconds, pulled toward `priorMs` while the sample count is low. */
export function serviceMs(stat: MethodStat, config: ScoreConfig = defaultScoreConfig): number {
  if (stat.n === 0) return config.priorMs;
  const measured = stat.ewma > 0 ? config.latencyMix * stat.ewma + (1 - config.latencyMix) * stat.tail : stat.tail;
  const confidence = Math.min(1, stat.n / config.confidenceSamples);
  return confidence * measured + (1 - confidence) * config.priorMs;
}

/**
 * In-flight inflation. `inflight` 0 yields 1.
 * Each extra in-flight call adds its own service time, plus `queueWeight * inflight^2`.
 * Default `queueWeight` is 0.25, so the penalty is `1 + n + 0.25 n^2`.
 */
export function inflation(inflight: number, queueWeight: number = defaultScoreConfig.queueWeight): number {
  const queue = inflight < 0 ? 0 : inflight;
  return 1 + queue + queueWeight * queue * queue;
}

export interface EndpointScoreInput {
  global: MethodStat;
  method: MethodStat | undefined;
  perMethod: boolean;
  inflight: number;
  lagPenalty: number;
  weight: number;
  config?: ScoreConfig | undefined;
}

/** Lower is better. Weight above 1 prefers an endpoint the caller already trusts. */
export function endpointScore(input: EndpointScoreInput): number {
  const config = input.config ?? defaultScoreConfig;
  const globalService = serviceMs(input.global, config);
  const globalError = input.global.error;
  let service = globalService;
  let error = globalError;
  if (input.perMethod && input.method && input.method.n > 0) {
    const blend = Math.min(1, input.method.n / config.methodBlendSamples);
    service = blend * serviceMs(input.method, config) + (1 - blend) * globalService;
    error = blend * input.method.error + (1 - blend) * globalError;
  }
  const penalty = 1 + config.errorWeight * error;
  const lag = input.lagPenalty < 1 ? 1 : input.lagPenalty;
  const weight = input.weight > 0 ? input.weight : 1;
  return (service * inflation(input.inflight, config.queueWeight) * penalty * lag) / weight;
}
