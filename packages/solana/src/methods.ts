/**
 * Solana method safety and cache classification.
 *
 * Which methods are safe comes from smart-solana at ff5891a. Freshness bounds do not:
 * the pool uses the HyperEVM cache window (2s, one slot of lag), not Solana's per-method TTLs.
 * @module
 */

import type { CacheKind, CachePolicy } from "@smart-rpc/core";

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
