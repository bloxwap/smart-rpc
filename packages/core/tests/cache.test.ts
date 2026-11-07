import { describe, expect, test } from "vitest";

import {
  DEFAULT_CACHE_MAX_AGE_MS,
  DEFAULT_CACHE_MAX_STALE_BLOCKS,
  evmCachePolicy,
  ReadCache,
  resolveCache,
} from "../src/cache.js";

describe("read cache", () => {
  test("keeps a fresh answer for 2s and one unit of head lag, and never caches a latest nonce", () => {
    expect(DEFAULT_CACHE_MAX_STALE_BLOCKS).toBe(1);
    expect(DEFAULT_CACHE_MAX_AGE_MS).toBe(2_000);
    const cache = new ReadCache(resolveCache(true), evmCachePolicy());
    const params = [{ to: "0x1" }, "latest"];
    const miss = cache.lookup("eth_call", params, true, { now: 0, head: { block: 10, ageMs: 0 } });
    expect(miss?.hit).toBe(false);
    if (!miss || miss.hit) throw new Error("expected a miss");
    miss.fill("0xok", 10);

    const hit = cache.lookup("eth_call", params, true, { now: 100, head: { block: 11, ageMs: 0 } });
    expect(hit).toMatchObject({ hit: true, result: "0xok", stale: 1 });

    const behind = cache.lookup("eth_call", params, true, { now: 200, head: { block: 12, ageMs: 0 } });
    expect(behind?.hit).toBe(false);

    const aged = cache.lookup("eth_call", params, true, { now: 2_001, head: { block: 11, ageMs: 0 } });
    expect(aged?.hit).toBe(false);

    expect(
      cache.lookup("eth_getTransactionCount", ["0x1", "latest"], true, { now: 0, head: { block: 10, ageMs: 0 } }),
    ).toBeUndefined();
  });
});
