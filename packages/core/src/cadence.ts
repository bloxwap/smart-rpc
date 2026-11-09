/**
 * Head-lag settings from a chain's block (or slot) time.
 *
 * Lag is counted in freshness units, so a fixed unit count means very different staleness on different chains:
 * 2 blocks is 0.2s on a 100ms chain and 24s on Ethereum. A chain transport that knows its cadence passes
 * `blockTimeMs` and the pool derives a lag allowance of about {@link DEFAULT_LAG_TOLERANCE_MS} of staleness,
 * and a production-rate ceiling for carrying heads across time.
 * @module
 */

import { DEFAULT_LAG_TOLERANCE_MS } from "./constants.js";

/** Headroom over the nominal production rate, so carrying a head across time never overstates growth. */
export const BLOCK_RATE_HEADROOM = 1.25;

/** Head-lag settings for one chain cadence. */
export interface BlockCadence {
  /** Units of lag still treated as caught up: about `toleranceMs` of staleness, at least 1. */
  readonly maxLag: number;
  /** Ceiling on units produced per second: the nominal rate plus {@link BLOCK_RATE_HEADROOM}. */
  readonly maxUnitsPerSecond: number;
}

/**
 * `maxLag` and `maxUnitsPerSecond` for a chain producing one unit every `blockTimeMs`.
 * A 250ms chain allows 4 blocks of lag, a 1s chain 1, a 2s chain 1.
 */
export function blockCadence(blockTimeMs: number, toleranceMs: number = DEFAULT_LAG_TOLERANCE_MS): BlockCadence {
  if (!(Number.isFinite(blockTimeMs) && blockTimeMs > 0)) {
    throw new Error(`smart-rpc blockTimeMs must be a positive number of milliseconds, got ${String(blockTimeMs)}.`);
  }
  if (!(Number.isFinite(toleranceMs) && toleranceMs > 0)) {
    throw new Error(`smart-rpc lag tolerance must be a positive number of milliseconds, got ${String(toleranceMs)}.`);
  }
  return {
    maxLag: Math.max(1, Math.round(toleranceMs / blockTimeMs)),
    maxUnitsPerSecond: (1_000 / blockTimeMs) * BLOCK_RATE_HEADROOM,
  };
}
