/**
 * Solana method safety and cache classification.
 *
 * Which methods are safe comes from smart-solana at ff5891a. Freshness bounds do not:
 * the pool uses the HyperEVM cache window (2s, one slot of lag), not Solana's per-method TTLs.
 * @module
 */

import { isRateLimitError, type CacheKind, type CachePolicy } from "@smart-rpc/core";

const NON_SAFE = new Set(["requestAirdrop", "sendTransaction", "sendRawTransaction"]);

const REBROADCAST = new Set(["sendTransaction", "sendRawTransaction"]);

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

const IMMUTABLE = new Set(["getGenesisHash", "getEpochSchedule", "getIdentity", "getVersion", "getTransaction"]);

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
export function isSafeSolanaMethod(method: string, extra: readonly string[] = []): boolean {
  return !NON_SAFE.has(method) && !extra.includes(method);
}

export function isSolanaRebroadcast(method: string): boolean {
  return REBROADCAST.has(method);
}

export function solanaCachePolicy(): CachePolicy {
  return {
    classify(method: string): CacheKind | false {
      if (!CACHEABLE.has(method)) return false;
      return IMMUTABLE.has(method) ? "immutable" : "fresh";
    },
  };
}

export function parseSlot(result: unknown): number | null {
  if (typeof result === "number" && Number.isFinite(result)) return result;
  if (typeof result === "string" && /^\d+$/.test(result)) {
    const parsed = Number(result);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
