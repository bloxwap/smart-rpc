/**
 * Solana method safety and cache classification.
 *
 * Which methods are safe comes from smart-solana at ff5891a. Freshness bounds do not:
 * the pool uses the HyperEVM cache window (2s, one slot of lag), not Solana's per-method TTLs.
 * @module
 */

import { isRateLimitError, type CacheKind, type CachePolicy } from "@smart-rpc/core";

const REBROADCAST = new Set(["sendTransaction", "sendRawTransaction"]);

/**
 * Known idempotent Solana reads. Anything else, including `sendBundle` and `requestAirdrop`,
 * is sent once: not raced, retried, or coalesced.
 */
const SAFE_SOLANA_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlock",
  "getBlockCommitment",
  "getBlockHeight",
  "getBlockProduction",
  "getBlockTime",
  "getBlocks",
  "getBlocksWithLimit",
  "getClusterNodes",
  "getEpochInfo",
  "getEpochSchedule",
  "getFeeForMessage",
  "getFirstAvailableBlock",
  "getGenesisHash",
  "getHealth",
  "getHighestSnapshotSlot",
  "getIdentity",
  "getInflationGovernor",
  "getInflationRate",
  "getInflationReward",
  "getLargestAccounts",
  "getLatestBlockhash",
  "getLeaderSchedule",
  "getMaxRetransmitSlot",
  "getMaxShredInsertSlot",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getRecentPerformanceSamples",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getSlot",
  "getSlotLeader",
  "getSlotLeaders",
  "getStakeActivation",
  "getStakeMinimumDelegation",
  "getSupply",
  "getTokenAccountBalance",
  "getTokenAccountsByDelegate",
  "getTokenAccountsByOwner",
  "getTokenLargestAccounts",
  "getTokenSupply",
  "getTransaction",
  "getTransactionCount",
  "getVersion",
  "getVoteAccounts",
  "isBlockhashValid",
  "minimumLedgerSlot",
  "simulateTransaction",
]);

const UNSAFE_SOLANA = /send|sign|submit|airdrop/i;

/** Methods worth caching. TTLs in the Solana reference are not applied. */
const CACHEABLE = new Set([
  "getBalance",
  "getBlock",
  "getBlockHeight",
  "getBlockProduction",
  "getBlockTime",
  "getBlocks",
  "getEpochInfo",
  "getEpochSchedule",
  "getFeeForMessage",
  "getFirstAvailableBlock",
  "getGenesisHash",
  "getHealth",
  "getIdentity",
  "getLatestBlockhash",
  "getMultipleAccounts",
  "getAccountInfo",
  "getProgramAccounts",
  "getSignaturesForAddress",
  "getSlot",
  "getSupply",
  "getTokenAccountBalance",
  "getTokenAccountsByDelegate",
  "getTokenAccountsByOwner",
  "getTokenLargestAccounts",
  "getTokenSupply",
  "getTransaction",
  "getTransactionCount",
  "getVersion",
  "getVoteAccounts",
  "isBlockhashValid",
]);

const IMMUTABLE = new Set(["getGenesisHash", "getEpochSchedule", "getIdentity", "getVersion"]);

/** Reads of a fixed slot, signature, or cluster constant: a lagging endpoint answers them as well as a fresh one. */
const FIXED_READS = new Set([
  "getBlock",
  "getBlockTime",
  "getBlocks",
  "getBlocksWithLimit",
  "getBlockCommitment",
  "getTransaction",
  "getGenesisHash",
  "getEpochSchedule",
  "getIdentity",
  "getVersion",
  "getFirstAvailableBlock",
  "getMinimumBalanceForRentExemption",
  "getInflationGovernor",
]);

/**
 * True when a read answers from the newest slot an endpoint has seen: account state, balances, blockhashes, the
 * slot itself. A `finalized` read and the fixed reads above are not head-sensitive. An endpoint lagging past
 * `maxLag` does not lead head-sensitive reads while a fresh one can.
 */
export function isHeadSensitiveSolanaMethod(method: string, params: unknown): boolean {
  if (FIXED_READS.has(method)) return false;
  if (!Array.isArray(params)) return true;
  return !params.some((param: unknown) =>
    typeof param === "object" && param !== null && "commitment" in param && param.commitment === "finalized");
}

/**
 * True when a Solana endpoint is over its request rate. Solana's `-32005` is "node unhealthy" (behind the cluster),
 * a real failure, not the EIP-1474 rate limit, so it counts only with HTTP 429 or rate-limit wording.
 */
export function isSolanaRateLimit(error: Error): boolean {
  if (!isRateLimitError(error)) return false;
  if (!("code" in error) || error.code !== -32005) return true;
  const status = "status" in error ? error.status : undefined;
  return status === 429 || /rate[- ]?limit|too many requests/i.test(error.message);
}

/** True when the method may be raced and retried. Sends fail over only as rebroadcasts. */
export function isSafeSolanaMethod(
  method: string,
  blocked: readonly string[] = [],
  allowed: readonly string[] = [],
): boolean {
  if (blocked.includes(method) || UNSAFE_SOLANA.test(method)) return false;
  return SAFE_SOLANA_METHODS.has(method) || allowed.includes(method);
}

export function isSolanaRebroadcast(method: string): boolean {
  return REBROADCAST.has(method);
}

export function solanaCachePolicy(): CachePolicy {
  return {
    classify(method: string, params: unknown): CacheKind | false {
      if (!CACHEABLE.has(method)) return false;
      if (method === "getTransaction") return solanaCommitment(params) === "finalized" ? "immutable" : "fresh";
      return IMMUTABLE.has(method) ? "immutable" : "fresh";
    },
  };
}

export function parseSlot(result: unknown): number | null {
  if (typeof result === "number") return nonNegativeSlot(result);
  if (typeof result === "string" && /^\d+$/.test(result)) return nonNegativeSlot(Number(result));
  return null;
}

function nonNegativeSlot(value: number): number | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** Omitted commitment is Solana's default, finalized. processed and confirmed stay fresh. */
function solanaCommitment(params: unknown): string {
  if (!Array.isArray(params) || params.length < 2 || typeof params[1] !== "object" || params[1] === null) return "finalized";
  const commitment = "commitment" in params[1] ? params[1].commitment : undefined;
  return typeof commitment === "string" ? commitment : "finalized";
}
