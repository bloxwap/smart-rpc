/** Extra attempts after the first, on safe methods and raw transaction rebroadcasts. */
export const DEFAULT_RETRY_COUNT = 2;

/** Per-attempt deadline. The pool races the child call with this budget. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * First backoff before re-trying endpoints that already failed this call, when `retryDelay` is 0.
 * Failover to a different endpoint does not wait.
 */
export const DEFAULT_RETRY_BACKOFF_MS = 100;

/** Longest backoff before a re-try, and the most one call waits out ejections or budget refills. */
export const MAX_RETRY_BACKOFF_MS = 2_000;

/** How long a freshness sample stays usable for lag penalties. */
export const DEFAULT_STALE_MS = 30_000;

/** Blocks or slots behind the best fresh head that are still treated as caught up. */
export const DEFAULT_MAX_LAG = 2;

/** Background health-probe cadence. This refreshes heads. It is not the latency ranker. */
export const DEFAULT_PROBE_MS = 4_000;

/** The probe timer stops after this long without a request, and restarts on the next one. */
export const DEFAULT_PROBE_IDLE_MS = 60_000;

/** How long past its deadline an attempt still counts as in flight. */
export const INFLIGHT_GRACE_MS = 1_000;

/** Freshness units a head may lead the other endpoints' median before it is ignored. */
export const DEFAULT_MAX_AHEAD = 1_000;

/**
 * Generous ceiling on chain growth, used to carry an older head forward before comparing it.
 * HyperEVM makes about one small block per second; the reference uses 2.
 */
export const DEFAULT_MAX_UNITS_PER_SECOND = 2;
