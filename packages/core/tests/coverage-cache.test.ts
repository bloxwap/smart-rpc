import { afterEach, describe, expect, test, vi } from "vitest";

import {
  evmCachePlan,
  evmCachePolicy,
  ReadCache,
  resolveCache,
  type CacheLookupContext,
  type CacheMiss,
  type CacheOptions,
  type CachePlan,
  type CachePolicy,
  type CacheRead,
  type CacheReadOptions,
  type CacheSource,
} from "../src/cache.js";
import type { RpcEvent } from "../src/events.js";

const TX = { to: "0x000000000000000000000000000000000000dead", data: "0x" };
const ADDRESS = "0x233ff29b239abc1d7748605da9b205c3e008626e";
const OTHER = "0x00000000000000000000000000000000000000aa";
const HASH = `0x${"ab".repeat(32)}`;

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

function log(block: number, logIndex: number): Record<string, unknown> {
  return { address: ADDRESS, blockNumber: hex(block), logIndex: hex(logIndex), topics: [], data: "0x" };
}

function at(now: number, block?: number): CacheLookupContext {
  return { now, head: block === undefined ? undefined : { block, ageMs: 0 } };
}

function missed(
  cache: ReadCache,
  method: string,
  params: unknown,
  context?: CacheLookupContext,
): CacheMiss {
  const found = cache.lookup(method, params, true, context);
  if (!found || found.hit) throw new Error(`expected a miss for ${method}`);
  return found;
}

interface ReadCall {
  method: string;
  params: unknown;
  options: CacheReadOptions | undefined;
}

/** A pool stand-in whose clock, head, activity, and budget are set by the test. */
function fakeSource(read: (method: string, params: unknown) => CacheRead | Promise<CacheRead> = () => ({
  result: "0x2",
  block: undefined,
})) {
  const state: { now: number; head: number | undefined; active: boolean; ready: boolean } = {
    now: 0,
    head: 100,
    active: true,
    ready: true,
  };
  const reads: ReadCall[] = [];
  const events: RpcEvent[] = [];
  let probes = 0;
  const source: CacheSource = {
    now: () => state.now,
    head: () => (state.head === undefined ? undefined : { block: state.head, ageMs: 0 }),
    held: () => state.head,
    active: () => state.active,
    probe: async () => {
      probes += 1;
    },
    probeMethod: "eth_blockNumber",
    read: async (method, params, options) => {
      reads.push({ method, params, options });
      return read(method, params);
    },
    ready: () => state.ready,
    emit: (event) => events.push(event),
  };
  return { source, state, reads, events, probes: () => probes };
}

function sourced(
  options: CacheOptions,
  fake: ReturnType<typeof fakeSource>,
  policy: CachePolicy = evmCachePolicy(),
): ReadCache {
  return new ReadCache(resolveCache(options), policy, fake.source);
}

/** Let queued microtasks (a head-change round and the reads it starts) settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

/** A JSON value with no canonical key: its `toJSON` answers with itself. */
function unserializable(): Record<string, unknown> {
  return {
    toJSON(this: unknown): unknown {
      return this;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("canonical EVM plans for unusual params", () => {
  test("unknown methods and calls missing their leading params are not planned", () => {
    expect(evmCachePlan("eth_notAMethod", [TX, "latest"])).toBeUndefined();
    expect(evmCachePlan("eth_getStorageAt", [ADDRESS])).toBeUndefined();
    expect(evmCachePlan("eth_call", [])).toBeUndefined();
    expect(evmCachePlan("eth_getStorageAt", [ADDRESS, "0x0"])?.kind).toBe("latest");
  });

  test("a required block tag that is missing or not a tag is not planned", () => {
    expect(evmCachePlan("eth_getBlockByNumber", [])).toBeUndefined();
    expect(evmCachePlan("eth_call", [TX, 5])).toBeUndefined();
    expect(evmCachePlan("eth_call", [TX, null])).toBeUndefined();
    expect(evmCachePlan("eth_call", [TX, ["latest"]])).toBeUndefined();
    // An EIP-1898 object with neither a hash nor a number names no block.
    expect(evmCachePlan("eth_call", [TX, {}])).toBeUndefined();
    expect(evmCachePlan("eth_call", [TX, { blockNumber: "pending" }])).toBeUndefined();
  });

  test("an EIP-1898 block number plans the same exact block as the bare quantity", () => {
    const bare = evmCachePlan("eth_call", [TX, "0x64"]);
    const object = evmCachePlan("eth_call", [TX, { blockNumber: "0X64" }]);
    expect(object).toMatchObject({ kind: "number", block: 100, guard: true, immutable: false });
    expect(object?.exact).toBe(bare?.exact);
    expect(object?.key).toBe(bare?.key);
    expect(evmCachePlan("eth_call", [TX, { blockNumber: "latest" }])?.key).toBe(bare?.key);
  });

  test("params without a canonical key are not planned on any path", () => {
    const timed = { isTimedCall: () => true };
    expect(evmCachePlan("eth_getBlockByHash", [unserializable(), false])).toBeUndefined();
    expect(evmCachePlan("eth_getTransactionReceipt", [unserializable()])).toBeUndefined();
    expect(evmCachePlan("eth_call", [unserializable()], timed)).toBeUndefined();
    expect(evmCachePlan("eth_call", [unserializable(), "safe"])).toBeUndefined();
    expect(evmCachePlan("eth_call", [unserializable(), { blockHash: HASH }])).toBeUndefined();
    expect(evmCachePlan("eth_call", [unserializable(), "latest"])).toBeUndefined();
    expect(evmCachePlan("eth_call", [unserializable(), "0x5"])).toBeUndefined();
    // The same shapes plan normally once the call object is serializable.
    expect(evmCachePlan("eth_call", [TX], timed)?.kind).toBe("timed");
    expect(evmCachePlan("eth_call", [TX, "0x5"])?.kind).toBe("number");
  });

  test("the policy classifies exactly what it plans", () => {
    const policy = evmCachePolicy({ immutable: true });
    expect(policy.classify("eth_sendRawTransaction", ["0x00"])).toBe(false);
    expect(policy.classify("eth_call", [TX, "pending"])).toBe(false);
    expect(policy.classify("eth_call", "not-an-array")).toBe(false);
    expect(policy.classify("eth_chainId", [])).toBe("immutable");
    expect(policy.classify("eth_getBlockByHash", [HASH, false])).toBe("immutable");
    expect(policy.classify("eth_call", [TX, "finalized"])).toBe("immutable");
    expect(policy.classify("eth_call", [TX])).toBe("fresh");
    expect(policy.classify("eth_call", [TX, "0x64"])).toBe("fresh");
    expect(evmCachePolicy().classify("eth_call", [TX, "finalized"])).toBe("fresh");
  });
});

describe("a cache with neither a pool source nor a lookup context", () => {
  test("stamps and ages entries against the wall clock", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(5_000);
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy());
    missed(cache, "eth_call", [TX]).fill("0x1", undefined);
    clock.mockReturnValue(7_000);
    expect(cache.lookup("eth_call", [TX], true)).toEqual({ hit: true, result: "0x1", stale: null });
    clock.mockReturnValue(7_001);
    expect(cache.lookup("eth_call", [TX], true)?.hit).toBe(false);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, hotKeys: 0 });
  });
});

describe("generic policies without canonical plans", () => {
  function generic() {
    const classified: string[] = [];
    const policy: CachePolicy = {
      classify(method) {
        classified.push(method);
        if (method === "never") return false;
        return method === "forever" ? "immutable" : "fresh";
      },
    };
    return { policy, classified };
  }

  test("an unclassified method and unserializable params bypass the cache", () => {
    const { policy } = generic();
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), policy);
    expect(cache.lookup("never", [1], true, at(0, 10))).toBeUndefined();
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(cache.lookup("read", cyclic, true, at(0, 10))).toBeUndefined();
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 0, entries: 0 });

    missed(cache, "read", [1], at(0, 10)).fill("fresh", 10);
    missed(cache, "forever", [1], at(0, 10)).fill("kept", 10);
    // A fresh answer ages out; an immutable one does not.
    expect(cache.lookup("read", [1], true, at(60_000, 500))?.hit).toBe(false);
    expect(cache.lookup("forever", [1], true, at(60_000, 500))).toEqual({ hit: true, result: "kept", stale: 0 });
  });

  test("immutableParams remembers that a params array is uncacheable", () => {
    const { policy, classified } = generic();
    const cache = new ReadCache(resolveCache({ refreshInterval: false, immutableParams: true }), policy);
    const params = [1];
    expect(cache.lookup("never", params, true, at(0, 10))).toBeUndefined();
    expect(cache.lookup("never", params, true, at(0, 10))).toBeUndefined();
    expect(classified).toEqual(["never"]);
    expect(cache.lookup("never", [1], true, at(0, 10))).toBeUndefined();
    expect(classified).toEqual(["never", "never"]);
  });
});

describe("plans a policy left incomplete", () => {
  function fixed(plan: Omit<CachePlan, "method" | "params">): CachePolicy {
    return {
      classify: () => "fresh",
      plan: (method, params) => ({ ...plan, method, params }),
    };
  }

  test("a logs plan without a rolling filter always misses and offers no fetch", () => {
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), fixed({ kind: "logs", key: "logs" }));
    const first = missed(cache, "eth_getLogs", [{}], at(0, 10));
    expect(first.fetch).toBeUndefined();
    first.fill([log(5, 0)], 10);
    expect(missed(cache, "eth_getLogs", [{}], at(0, 10)).fetch).toBeUndefined();
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 2, entries: 0, bytes: 0 });
  });

  test("a number plan without its block or exact key is never stored or served", () => {
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), fixed({ kind: "number", key: "n" }));
    missed(cache, "eth_call", [TX, "0x5"], at(0, 10)).fill("0x1", 5);
    expect(cache.lookup("eth_call", [TX, "0x5"], true, at(0, 10))?.hit).toBe(false);
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });

    const noExact = new ReadCache(
      resolveCache({ refreshInterval: false }),
      fixed({ kind: "number", key: "n", block: 5 }),
    );
    missed(noExact, "eth_call", [TX, "0x5"], at(0, 10)).fill("0x1", 5);
    expect(noExact.lookup("eth_call", [TX, "0x5"], true, at(0, 10))?.hit).toBe(false);
    expect(noExact.stats().entries).toBe(0);
  });
});

describe("numbered plans a chain marks immutable", () => {
  const base = evmCachePolicy();
  const policy: CachePolicy = {
    classify: base.classify,
    plan(method, params) {
      const plan = base.plan?.(method, params);
      return plan?.kind === "number" ? { ...plan, immutable: true } : plan;
    },
  };

  test("a pinned latest answer serves its own block forever", () => {
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), policy);
    missed(cache, "eth_getBalance", [ADDRESS, "latest"], at(0, 100)).fill("0x65", 100);
    // Far past both freshness bounds: age and head lag.
    expect(cache.lookup("eth_getBalance", [ADDRESS, "0x64"], true, at(60_000, 900))).toEqual({
      hit: true,
      result: "0x65",
      stale: 0,
    });
    // A fresh numbered plan over the same entry is still bounded.
    const fresh = new ReadCache(resolveCache({ refreshInterval: false }), base);
    missed(fresh, "eth_getBalance", [ADDRESS, "latest"], at(0, 100)).fill("0x65", 100);
    expect(fresh.lookup("eth_getBalance", [ADDRESS, "0x64"], true, at(60_000, 900))?.hit).toBe(false);
  });

  test("a numbered fill is kept under its exact block until eviction", () => {
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), policy);
    missed(cache, "eth_getBalance", [ADDRESS, "0x64"], at(0, 100)).fill("0x7", undefined);
    expect(cache.lookup("eth_getBalance", [ADDRESS, "0x64"], true, at(60_000, 900))).toEqual({
      hit: true,
      result: "0x7",
      stale: 0,
    });
    // Another block of the same call is a different entry.
    expect(cache.lookup("eth_getBalance", [ADDRESS, "0x63"], true, at(60_000, 900))?.hit).toBe(false);
    expect(cache.stats()).toMatchObject({ hits: 1, entries: 1 });
  });

  test("a guarded numbered fill is dropped until every endpoint holds the block", () => {
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), policy);
    missed(cache, "eth_getBalance", [ADDRESS, "0x64"], at(0, 99)).fill("0x7", undefined);
    expect(cache.stats().entries).toBe(0);
  });
});

describe("fills that must not be stored", () => {
  test("block-hash logs need a trusted head to be kept as fresh", () => {
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy());
    const params = [{ blockHash: HASH }];
    missed(cache, "eth_getLogs", params, at(0)).fill([log(5, 0)], undefined);
    expect(cache.lookup("eth_getLogs", params, true, at(0))?.hit).toBe(false);
    expect(cache.stats().entries).toBe(0);
    missed(cache, "eth_getLogs", params, at(0, 10)).fill([log(5, 0)], undefined);
    expect(cache.lookup("eth_getLogs", params, true, at(0, 10))).toMatchObject({ hit: true, result: [log(5, 0)] });
  });

  test("an inclusion result that is not an object proves no block and is dropped", () => {
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy());
    missed(cache, "eth_getTransactionReceipt", [HASH], at(0, 10)).fill("0xnot-a-receipt", undefined);
    expect(cache.lookup("eth_getTransactionReceipt", [HASH], true, at(0, 10))?.hit).toBe(false);
    missed(cache, "eth_getTransactionReceipt", [HASH], at(0, 10)).fill({ blockNumber: "0x9", status: "0x1" }, undefined);
    expect(cache.lookup("eth_getTransactionReceipt", [HASH], true, at(0, 10))).toMatchObject({
      hit: true,
      result: { blockNumber: "0x9", status: "0x1" },
    });
  });
});

describe("timed entries without a head", () => {
  test("are served by age alone", () => {
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy({ isTimedCall: () => true }));
    missed(cache, "eth_call", [TX, "latest"], at(0)).fill("0xaa", undefined);
    expect(cache.lookup("eth_call", [TX, "0x5"], true, at(2_000))).toEqual({ hit: true, result: "0xaa", stale: null });
    expect(cache.lookup("eth_call", [TX], true, at(2_001))?.hit).toBe(false);
  });
});

describe("shared results", () => {
  const value = { a: "xy", list: [1, "z"], n: null };
  // record 32 + keys (1 + 4 + 1) * 2 + "xy" 20 + array 16 + number 8 + "z" 18 + null 8
  const BYTES = 114;

  test("copyResults: false stores and returns the caller's object, charged like a copy", () => {
    const shared = new ReadCache(resolveCache({ refreshInterval: false, copyResults: false }), evmCachePolicy());
    missed(shared, "eth_call", [TX], at(0, 10)).fill(value, 10);
    const hit = shared.lookup("eth_call", [TX], true, at(0, 10));
    expect(hit?.hit && hit.result).toBe(value);
    expect(shared.stats().bytes).toBe(BYTES);

    const copied = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy());
    missed(copied, "eth_call", [TX], at(0, 10)).fill(value, 10);
    const copy = copied.lookup("eth_call", [TX], true, at(0, 10));
    expect(copy?.hit && copy.result).toEqual(value);
    expect(copy?.hit && copy.result).not.toBe(value);
    expect(copied.stats().bytes).toBe(BYTES);
  });

  test("a byte budget below one shared entry evicts it immediately", () => {
    const cache = new ReadCache(
      resolveCache({ refreshInterval: false, copyResults: false, maxBytes: BYTES - 1 }),
      evmCachePolicy(),
    );
    missed(cache, "eth_call", [TX], at(0, 10)).fill(value, 10);
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
    expect(cache.lookup("eth_call", [TX], true, at(0, 10))?.hit).toBe(false);
  });
});

describe("rolling logs without a pool source", () => {
  const filter = { address: ADDRESS, fromBlock: "0x5a", toBlock: "latest" };

  test("a completed fetch answers the query and later lookups from the lookup clock", () => {
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy());
    const miss = missed(cache, "eth_getLogs", [filter], at(1_000, 100));
    expect(miss.fetch).toMatchObject({
      params: [{ address: ADDRESS, fromBlock: "0x5a", toBlock: "0x64" }],
      originalParams: [{ address: ADDRESS, fromBlock: "0x5a", toBlock: "latest" }],
      pinRequired: true,
    });
    expect(miss.fetch?.complete([log(95, 0)])).toEqual([log(95, 0)]);
    expect(cache.lookup("eth_getLogs", [filter], true, at(3_000, 100))).toEqual({
      hit: true,
      result: [log(95, 0)],
      stale: 0,
    });
    // Stored at the lookup's clock reading, so it ages out 2000 ms after that.
    expect(cache.lookup("eth_getLogs", [filter], true, at(3_001, 100))?.hit).toBe(false);
  });

  test("a latest-bounded fill is stored only when the pinned block is the planned one", () => {
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy());
    const both = [{ address: ADDRESS, fromBlock: "latest", toBlock: "latest" }];
    missed(cache, "eth_getLogs", both, at(0, 100)).fill([], 99);
    missed(cache, "eth_getLogs", both, at(0, 100)).fill([], undefined);
    expect(cache.stats().entries).toBe(0);
    missed(cache, "eth_getLogs", both, at(0, 100)).fill([log(100, 0)], 100);
    expect(cache.lookup("eth_getLogs", both, true, at(0, 100))).toMatchObject({ hit: true, result: [log(100, 0)] });

    const tail = [{ address: OTHER, fromBlock: "0x5a", toBlock: "latest" }];
    missed(cache, "eth_getLogs", tail, at(0, 100)).fill([], 101);
    expect(cache.lookup("eth_getLogs", tail, true, at(0, 100))?.hit).toBe(false);
    missed(cache, "eth_getLogs", tail, at(0, 100)).fill([], 100);
    expect(cache.lookup("eth_getLogs", tail, true, at(0, 100))).toMatchObject({ hit: true, result: [] });
  });
});

describe("refresh ticks", () => {
  test("an inactive pool keeps the timer armed but sends nothing", async () => {
    vi.useFakeTimers();
    const fake = fakeSource((_method, _params) => ({ result: "0x2", block: fake.state.head }));
    const cache = sourced({ refreshInterval: 1_000 }, fake);
    missed(cache, "eth_call", [TX]).fill("0x1", 100);
    expect(vi.getTimerCount()).toBe(1);

    fake.state.active = false;
    fake.state.head = 101;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.reads).toEqual([]);
    expect(fake.probes()).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    fake.state.active = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.reads).toEqual([{ method: "eth_call", params: [TX], options: undefined }]);
    expect(fake.probes()).toBe(1);
    expect(fake.events).toEqual([{ type: "cache", method: "eth_call", outcome: "refresh", stale: null }]);
    expect(cache.lookup("eth_call", [TX], true)).toEqual({ hit: true, result: "0x2", stale: 0 });

    // No endpoint has budget: the tick neither refreshes nor probes.
    fake.state.ready = false;
    fake.state.head = 102;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.reads).toHaveLength(1);
    expect(fake.probes()).toBe(1);
    expect(cache.stats().refreshes).toBe(1);
    cache.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("timed keys refresh on ticks, never on head changes", async () => {
    vi.useFakeTimers();
    const fake = fakeSource(() => ({ result: "0xbb", block: undefined }));
    const cache = sourced({ refreshInterval: 1_000 }, fake, evmCachePolicy({ isTimedCall: () => true }));
    missed(cache, "eth_call", [TX, "latest"]).fill("0xaa", undefined);

    fake.state.head = 101;
    cache.headChanged();
    await settle();
    expect(fake.reads).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.reads).toEqual([{ method: "eth_call", params: [TX, "latest"], options: undefined }]);
    expect(cache.lookup("eth_call", [TX], true)).toEqual({ hit: true, result: "0xbb", stale: null });
    cache.close();
  });

  test("arms in a runtime whose timers are numeric handles", () => {
    const handle = 7 as unknown as ReturnType<typeof setTimeout>;
    const set = vi.spyOn(globalThis, "setTimeout").mockReturnValue(handle);
    const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    const fake = fakeSource();
    const cache = sourced({ refreshInterval: 250 }, fake);
    missed(cache, "eth_call", [TX]);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[1]).toBe(250);
    // The pending timer is still due, so another read does not re-arm it.
    missed(cache, "eth_call", [TX, "safe"]);
    expect(set).toHaveBeenCalledTimes(1);
    expect(cache.stats().hotKeys).toBe(2);
    cache.close();
    expect(clear).toHaveBeenCalledWith(handle);
  });
});

describe("head-change rounds", () => {
  test("a hot key behind the new head is re-read; a round queued before close is dropped", async () => {
    const fake = fakeSource(() => ({ result: "0x2", block: fake.state.head }));
    const cache = sourced({ refreshInterval: false }, fake);
    missed(cache, "eth_call", [TX]).fill("0x1", 100);

    fake.state.head = 101;
    cache.headChanged();
    cache.headChanged();
    await settle();
    expect(fake.reads).toHaveLength(1);
    expect(cache.lookup("eth_call", [TX], true)).toEqual({ hit: true, result: "0x2", stale: 0 });

    fake.state.head = 102;
    cache.headChanged();
    cache.close();
    await settle();
    expect(fake.reads).toHaveLength(1);
    expect(cache.stats().refreshes).toBe(1);
  });

  test("nothing is refreshed while the pool has no head", async () => {
    const fake = fakeSource();
    const cache = sourced({ refreshInterval: false }, fake);
    missed(cache, "eth_call", [TX]).fill("0x1", 100);
    fake.state.head = undefined;
    cache.headChanged();
    await settle();
    expect(fake.reads).toEqual([]);
    expect(cache.stats()).toMatchObject({ refreshes: 0, hotKeys: 1 });
  });

  test("a refresh that lands after a reorg is discarded", async () => {
    let release: (read: CacheRead) => void = () => undefined;
    const fake = fakeSource(() => new Promise<CacheRead>((resolve) => {
      release = resolve;
    }));
    const cache = sourced({ refreshInterval: false }, fake);
    missed(cache, "eth_call", [TX]).fill("0x1", 100);

    fake.state.head = 101;
    cache.headChanged();
    await settle();
    expect(fake.reads).toHaveLength(1);
    cache.invalidate();
    release({ result: "0xstale", block: 101 });
    await settle();
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0, refreshes: 1 });
    expect(cache.lookup("eth_call", [TX], true)?.hit).toBe(false);
  });

  test("a covered log filter is left alone and an uncovered tail is fetched once per head", async () => {
    const tails: unknown[][] = [];
    let fail = true;
    const fake = fakeSource(async () => {
      if (fail) throw new Error("upstream down");
      return { result: [log(101, 0)], block: undefined };
    });
    const cache = sourced({ refreshInterval: false, maxStaleBlocks: 0 }, fake);
    const filter = { address: ADDRESS, fromBlock: "0x5a", toBlock: "latest" };
    const miss = missed(cache, "eth_getLogs", [filter]);
    expect(miss.fetch?.complete([log(95, 0)])).toEqual([log(95, 0)]);

    // Same head: the index already covers the filter.
    cache.headChanged();
    await settle();
    // No head: the latest bound cannot be resolved.
    fake.state.head = undefined;
    cache.headChanged();
    await settle();
    expect(fake.reads).toEqual([]);

    // A failed tail read is counted, leaves the index as it was, and is retried on the next round.
    fake.state.head = 101;
    cache.headChanged();
    await settle();
    expect(fake.reads).toEqual([
      {
        method: "eth_getLogs",
        params: [{ address: ADDRESS, fromBlock: "0x65", toBlock: "0x65" }],
        options: { originalParams: [filter], pinRequired: true },
      },
    ]);
    expect(cache.stats().refreshes).toBe(1);

    fail = false;
    cache.headChanged();
    await settle();
    tails.push(...fake.reads.map((read) => read.params as unknown[]));
    expect(tails).toHaveLength(2);
    expect(fake.events).toEqual([
      { type: "cache", method: "eth_getLogs", outcome: "refresh", stale: null },
      { type: "cache", method: "eth_getLogs", outcome: "refresh", stale: null },
    ]);
    expect(cache.lookup("eth_getLogs", [filter], true)).toEqual({
      hit: true,
      result: [log(95, 0), log(101, 0)],
      stale: 0,
    });
  });
});
