/**
 * Solana method safety and cache classification.
 *
 * Which methods are safe comes from smart-solana at ff5891a. Freshness bounds do not:
 * the pool uses the HyperEVM cache window (2s, one slot of lag), not Solana's per-method TTLs.
 * @module
 */

import type { CacheKind, CachePolicy } from "@smart-rpc/core";

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
