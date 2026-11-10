import { MAX_RETRY_BACKOFF_MS } from "./constants.js";

/**
 * A finite sample in the closed unit interval.
 * Anything else, including NaN and values above 1, is replaced with `Math.random()`
 * so backoff cannot exceed its cap and power-of-two-choices cannot stick to one slot.
 */
export function unitRandom(random: () => number): number {
  const sample = random();
  if (Number.isFinite(sample) && sample >= 0 && sample <= 1) return sample;
  return Math.random();
}

/**
 * Jittered exponential backoff: half to all of `base * 2^round`, capped.
 * `random` 0 yields the floor (half the ceiling). `random` 1 yields the ceiling.
 * Matches the HyperEVM transport at 092b8f9.
 */
export function backoffMs(round: number, base: number, random: () => number): number {
  const ceiling = Math.min(MAX_RETRY_BACKOFF_MS, base * 2 ** round);
  return Math.round(ceiling * (0.5 + unitRandom(random) * 0.5));
}
