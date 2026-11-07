import { MAX_RETRY_BACKOFF_MS } from "./constants.js";

/**
 * Jittered exponential backoff: half to all of `base * 2^round`, capped.
 * `random` 0 yields the floor (half the ceiling). `random` 1 yields the ceiling.
 * Matches the HyperEVM transport at 092b8f9.
 */
export function backoffMs(round: number, base: number, random: () => number): number {
  const ceiling = Math.min(MAX_RETRY_BACKOFF_MS, base * 2 ** round);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}
