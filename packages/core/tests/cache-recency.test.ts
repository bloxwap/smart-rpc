import { expect, test } from "vitest";
import { evmCachePolicy, ReadCache, resolveCache, type CacheMiss } from "../src/cache.js";

test("consecutive hits, replacement, eviction, and invalidation preserve LRU order", () => {
  const cache = new ReadCache(resolveCache({ maxEntries: 2 }), { classify: () => "immutable" });
  const get = (key: string) => cache.lookup("read", [key], true);
  const fill = (key: string, value = key) => (get(key) as CacheMiss).fill(value, undefined);
  fill("a");
  fill("b");
  for (let i = 0; i < 10; i++) expect(get("a")?.hit).toBe(true);
  fill("c");
  expect(get("b")?.hit).toBe(false);
  expect(get("a")?.hit).toBe(true);
  expect(get("c")?.hit).toBe(true);

  // Two concurrent misses can fill the same key; the second fill still makes it newest.
  const first = get("d") as CacheMiss;
  const second = get("d") as CacheMiss;
  first.fill("first", undefined);
  expect(get("c")?.hit).toBe(true);
  second.fill("second", undefined);
  fill("e");
  expect(get("c")?.hit).toBe(false);
  expect(get("d")).toMatchObject({ hit: true, result: "second" });

  cache.invalidate();
  expect(get("d")?.hit).toBe(false);
  fill("d");
  fill("f");
  expect(get("d")?.hit).toBe(true);
  fill("g");
  expect(get("f")?.hit).toBe(false);
  expect(get("d")?.hit).toBe(true);
});

test("cached log hits isolate nested results from both the input and other readers", () => {
  const cache = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy());
  const address = "0x000000000000000000000000000000000000dead";
  const params = [{ address, fromBlock: "0x1", toBlock: "0x1" }];
  const context = { now: 0, head: { block: 1, ageMs: 0 } };
  const input = [{ address, blockNumber: "0x1", logIndex: "0x0", topics: ["0x" + "ab".repeat(32)], data: "0x" }];
  const expected = structuredClone(input);
  (cache.lookup("eth_getLogs", params, true, context) as CacheMiss).fill(input, 1);
  input[0]!.topics[0] = "changed input";
  const first = cache.lookup("eth_getLogs", params, true, context);
  expect(first).toMatchObject({ hit: true, result: expected });
  if (!first?.hit) throw new Error("expected hit");
  (first.result as typeof input)[0]!.topics[0] = "changed output";
  expect(cache.lookup("eth_getLogs", params, true, context)).toMatchObject({ hit: true, result: expected });
});
