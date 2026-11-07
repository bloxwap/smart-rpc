import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DEFAULT_CACHE_MAX_AGE_MS,
  DEFAULT_CACHE_MAX_STALE_BLOCKS,
  evmCachePlan,
  evmCachePolicy,
  isPrecompileCall,
  ReadCache,
  resolveCache,
  type CachePolicy,
  type CacheSource,
  type ChainPolicy,
  type PoolEndpointConfig,
  type PoolOptions,
  type RpcEvent,
} from "../src/index.js";
import { evmPolicy, pool } from "./helpers.js";

const TX = { to: "0x000000000000000000000000000000000000dead", data: "0x" };
const PRECOMPILE = { to: "0x0000000000000000000000000000000000000809", data: "0x" };
const ADDRESS = "0x233ff29b239abc1d7748605da9b205c3e008626e";
const HASH = `0x${"ab".repeat(32)}`;

interface Call {
  id: string;
  method: string;
  params: unknown;
}

function node(
  id: string,
  head: { value: number },
  read: (method: string, params: unknown) => unknown | Promise<unknown> = () => "0x1",
): { config: PoolEndpointConfig; calls: Call[]; count: (method: string) => number } {
  const calls: Call[] = [];
  return {
    calls,
    config: {
      id,
      url: id,
      call: async (request) => {
        calls.push({ id, method: request.method, params: request.params });
        if (request.method === "eth_chainId") return "0x1";
        if (request.method === "eth_blockNumber") return `0x${head.value.toString(16)}`;
        return read(request.method, request.params);
      },
    },
    count: (method) => calls.filter((call) => call.method === method).length,
  };
}

function opened(
  nodes: readonly PoolEndpointConfig[],
  overrides: Partial<PoolOptions> = {},
  policy: ChainPolicy = evmPolicy(1, true),
) {
  return pool(nodes, {
    cache: { refreshInterval: false },
    coalesce: true,
    race: false,
    routing: "best",
    ...overrides,
  }, policy);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function until(condition: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("cache configuration and canonical plans", () => {
  test("resolves hot-key defaults and validates their bounds", () => {
    expect(DEFAULT_CACHE_MAX_STALE_BLOCKS).toBe(1);
    expect(DEFAULT_CACHE_MAX_AGE_MS).toBe(2_000);
    expect(resolveCache(true)).toEqual({
      enabled: true,
      maxStaleBlocks: 1,
      maxAgeMs: 2_000,
      refreshInterval: 1_000,
      hotKeys: 64,
      hotIdleMs: 30_000,
      maxEntries: 1_000,
      maxBytes: 8 * 1024 * 1024,
      logsWindow: 1_000,
      copyResults: true,
      immutableParams: false,
    });
    expect(resolveCache({ refreshInterval: false }).refreshInterval).toBe(false);
    expect(() => resolveCache({ refreshInterval: 0 })).toThrow("cache.refreshInterval");
    expect(() => resolveCache({ hotKeys: -1 })).toThrow("cache.hotKeys");
    expect(() => resolveCache({ hotIdleMs: Number.NaN })).toThrow("cache.hotIdleMs");
    expect(() => resolveCache({ logsWindow: 0 })).toThrow("cache.logsWindow");
  });

  test("normalizes hex and aliases implied latest, explicit latest, and the same block", () => {
    const implied = evmCachePlan("eth_call", [TX]);
    const explicit = evmCachePlan("eth_call", [TX, "latest"]);
    const numbered = evmCachePlan("eth_call", [TX, "0X064"]);
    expect(implied?.kind).toBe("latest");
    expect(explicit?.key).toBe(implied?.key);
    expect(numbered).toMatchObject({ kind: "number", key: implied?.key, block: 100, guard: true });
    expect(numbered?.exact).toBe(evmCachePlan("eth_call", [TX, "0x64"])?.exact);
    expect(evmCachePlan("eth_call", [{ ...TX, to: TX.to.toUpperCase() }])?.key).toBe(implied?.key);
    expect(evmCachePlan("eth_call", [TX, "latest", { [ADDRESS]: {} }])?.key).not.toBe(implied?.key);
  });

  test("keeps finality tags in distinct fresh plans and pending out of the cache", () => {
    const latest = evmCachePlan("eth_call", [TX, "latest"]);
    const safe = evmCachePlan("eth_call", [TX, "safe"]);
    const finalized = evmCachePlan("eth_call", [TX, "finalized"]);
    expect(safe?.kind).toBe("latest");
    expect(finalized?.kind).toBe("latest");
    expect(new Set([latest?.key, safe?.key, finalized?.key]).size).toBe(3);
    expect(evmCachePlan("eth_call", [TX, "pending"])).toBeUndefined();
    expect(evmCachePlan("eth_call", [TX, "earliest"])).toMatchObject({ kind: "number", block: 0 });
    expect(evmCachePlan("eth_getTransactionCount", [ADDRESS])).toBeUndefined();
    expect(evmCachePlan("eth_getTransactionCount", [ADDRESS, "latest"])).toBeUndefined();
    expect(evmCachePlan("eth_getLogs", [{ fromBlock: "latest" }])).toMatchObject({ kind: "logs" });
    expect(evmCachePlan("eth_getLogs", [{ fromBlock: "pending" }])).toBeUndefined();
  });

  test("uses one timed precompile key and opts confirmed results into immutability", () => {
    const options = { immutable: true, isTimedCall: isPrecompileCall };
    expect(evmCachePlan("eth_call", [PRECOMPILE], options)?.kind).toBe("timed");
    expect(evmCachePlan("eth_call", [PRECOMPILE, "pending"], options)?.key).toBe(
      evmCachePlan("eth_call", [PRECOMPILE, "0x64"], options)?.key,
    );
    expect(evmCachePlan("eth_getTransactionReceipt", [HASH])?.kind).toBe("latest");
    expect(evmCachePlan("eth_getTransactionReceipt", [HASH], options)?.kind).toBe("immutable");
    expect(evmCachePlan("eth_call", [TX, { blockHash: HASH }])?.kind).toBe("latest");
    expect(evmCachePlan("eth_call", [TX, { blockHash: HASH }], options)?.kind).toBe("immutable");
    expect(evmCachePlan("eth_getBalance", [ADDRESS, "0x10"], options)).toMatchObject({
      kind: "number",
      block: 16,
      immutable: true,
    });
  });

  test("memoizes plans by params-array and method identity only when enabled", () => {
    const base = evmCachePolicy();
    let computations = 0;
    const policy: CachePolicy = {
      classify: base.classify,
      plan(method, params) {
        computations += 1;
        return base.plan?.(method, params);
      },
    };
    const cache = new ReadCache(resolveCache({ immutableParams: true, refreshInterval: false }), policy);
    const params = [TX];
    const context = { now: 0, head: { block: 10, ageMs: 0 } };
    cache.lookup("eth_call", params, true, context);
    cache.lookup("eth_call", params, true, context);
    expect(computations).toBe(1);
    cache.lookup("eth_call", [TX], true, context);
    expect(computations).toBe(2);
    cache.lookup("eth_getBalance", params, true, context);
    expect(computations).toBe(3);
  });
});

describe("fresh and immutable entries", () => {
  test("fills once and serves equivalent spellings as defensive copies", () => {
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy());
    const context = { now: 0, head: { block: 10, ageMs: 0 } };
    const miss = cache.lookup("eth_call", [TX], true, context);
    expect(miss?.hit).toBe(false);
    if (!miss || miss.hit) throw new Error("expected a miss");
    miss.fill({ nested: { value: 1 } }, 10);
    const hit = cache.lookup("eth_call", [{ ...TX, to: TX.to.toUpperCase() }, "latest"], true, {
      now: 100,
      head: { block: 11, ageMs: 0 },
    });
    expect(hit).toMatchObject({ hit: true, result: { nested: { value: 1 } }, stale: 1 });
    if (!hit?.hit) throw new Error("expected a hit");
    (hit.result as { nested: { value: number } }).nested.value = 99;
    expect(cache.lookup("eth_call", [TX, "0xa"], true, context)).toMatchObject({
      hit: true,
      result: { nested: { value: 1 } },
      stale: 0,
    });
    expect(cache.stats()).toMatchObject({ hits: 2, misses: 1, entries: 1 });
    expect(cache.lookup("eth_call", [TX, "0xa"], true, {
      now: 2_001,
      head: { block: 10, ageMs: 0 },
    })?.hit).toBe(false);
  });

  test("keeps default numbered results fresh, but HyperEVM-style results immutable", () => {
    const params = [ADDRESS, "0xa"];
    const fresh = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy());
    const first = fresh.lookup("eth_getBalance", params, true, { now: 0, head: { block: 10, ageMs: 0 } });
    if (!first || first.hit) throw new Error("expected a miss");
    first.fill("0x1", undefined);
    expect(fresh.lookup("eth_getBalance", params, true, { now: 100, head: { block: 11, ageMs: 0 } })).toMatchObject({
      hit: true,
      stale: 1,
    });
    expect(fresh.lookup("eth_getBalance", params, true, { now: 2_001, head: { block: 11, ageMs: 0 } })?.hit).toBe(false);

    const historical = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy());
    const old = historical.lookup("eth_getBalance", [ADDRESS, "0x1"], true, {
      now: 0,
      head: { block: 10, ageMs: 0 },
    });
    if (!old || old.hit) throw new Error("expected a miss");
    old.fill("0x1", undefined);
    expect(historical.lookup("eth_getBalance", [ADDRESS, "0x1"], true, {
      now: 100,
      head: { block: 10, ageMs: 0 },
    })).toMatchObject({ hit: true, stale: 0 });

    const immutable = new ReadCache(
      resolveCache({ refreshInterval: false }),
      evmCachePolicy({ immutable: true }),
    );
    const miss = immutable.lookup("eth_getBalance", params, true, { now: 0, head: { block: 10, ageMs: 0 } });
    if (!miss || miss.hit) throw new Error("expected a miss");
    miss.fill("0x1", undefined);
    expect(immutable.lookup("eth_getBalance", params, true, {
      now: 100_000,
      head: { block: 1_000, ageMs: 0 },
    })).toMatchObject({ hit: true, stale: 0 });
  });

  test("stamps fresh inclusion answers at the observation head, not their mined block", () => {
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy());
    const miss = cache.lookup("eth_getTransactionByHash", [HASH], true, {
      now: 0,
      head: { block: 10, ageMs: 0 },
    });
    if (!miss || miss.hit) throw new Error("expected a miss");
    miss.fill({ hash: HASH, blockNumber: "0x1" }, undefined);
    expect(cache.lookup("eth_getTransactionByHash", [HASH], true, {
      now: 100,
      head: { block: 11, ageMs: 0 },
    })).toMatchObject({ hit: true, stale: 1 });
  });

  test("never stores null or pending inclusion results", () => {
    for (const immutable of [false, true]) {
      const cache = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy({ immutable }));
      for (const result of [null, { hash: HASH, blockNumber: null }]) {
        const miss = cache.lookup("eth_getTransactionByHash", [HASH], true, {
          now: 0,
          head: { block: 10, ageMs: 0 },
        });
        if (!miss || miss.hit) throw new Error("expected a miss");
        miss.fill(result, undefined);
      }
      expect(cache.stats().entries).toBe(0);
    }
  });

  test("an in-flight pre-reorg fill cannot repopulate the cache", () => {
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy());
    const miss = cache.lookup("eth_getBalance", [ADDRESS], true, { now: 0, head: undefined });
    if (!miss || miss.hit) throw new Error("expected a miss");
    cache.invalidate();
    miss.fill("old-fork", 10);
    expect(cache.stats().entries).toBe(0);
  });
});

describe("background refresh", () => {
  test("pins to the newest servable head, coalesces, and never races a refresh", async () => {
    const headA = { value: 100 };
    const headB = { value: 100 };
    const a = node("a", headA);
    const b = node("b", headB);
    const events: RpcEvent[] = [];
    const client = opened([a.config, b.config], {
      race: true,
      onEvent: (event) => events.push(event),
    });
    await client.probe();
    await client.request({ method: "eth_call", params: [TX] });
    expect(a.count("eth_call") + b.count("eth_call")).toBe(2);

    headA.value = 101;
    await client.probe();
    await until(() => a.count("eth_call") === 2);
    expect(a.calls.filter((call) => call.method === "eth_call").at(-1)?.params).toEqual([TX, "0x65"]);
    expect(b.count("eth_call")).toBe(1);
    expect(events.filter((event) => event.type === "race")).toHaveLength(1);
    expect(client.cacheStats()).toMatchObject({ refreshes: 1, hotKeys: 1 });
    expect(events).toContainEqual({ type: "cache", method: "eth_call", outcome: "refresh", stale: null });

    await client.request({ method: "eth_call", params: [TX, "latest"] });
    expect(a.count("eth_call") + b.count("eth_call")).toBe(3);
    client.close();
  });

  test("a caller joins a refresh and cancelling another caller does not abort it", async () => {
    const head = { value: 100 };
    const gate = deferred<string>();
    let reads = 0;
    const a = node("a", head, () => {
      reads += 1;
      return reads === 1 ? "0x1" : gate.promise;
    });
    const events: RpcEvent[] = [];
    const client = opened([a.config], {
      cache: { maxStaleBlocks: 0, refreshInterval: false },
      onEvent: (event) => events.push(event),
    });
    await client.probe();
    await client.request({ method: "eth_call", params: [TX] });
    head.value = 101;
    await client.probe();
    await until(() => a.count("eth_call") === 2);

    const controller = new AbortController();
    const cancelled = client.request({ method: "eth_call", params: [TX], signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    const joined = client.request({ method: "eth_call", params: [TX] });
    await until(() => events.filter((event) => event.type === "coalesce").length === 2);
    controller.abort();
    expect(await cancelled).toMatchObject({ name: "AbortError" });
    gate.resolve("0x2");
    await expect(joined).resolves.toBe("0x2");
    await expect(client.request({ method: "eth_call", params: [TX] })).resolves.toBe("0x2");
    expect(a.count("eth_call")).toBe(2);
    client.close();
  });

  test("activity and budget suppression send no background read", async () => {
    const head = { value: 100 };
    const inactiveNode = node("inactive", head);
    let active = false;
    const inactive = opened([inactiveNode.config], { isActive: () => active });
    await inactive.probe();
    await inactive.request({ method: "eth_call", params: [TX] });
    head.value = 101;
    await inactive.probe();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inactiveNode.count("eth_call")).toBe(1);
    inactive.close();

    let now = 0;
    const budgetedNode = node("budgeted", head);
    budgetedNode.config.rps = 0.5;
    budgetedNode.config.burst = 2;
    const budgeted = opened([budgetedNode.config], { now: () => now }, evmPolicy(1, false));
    await budgeted.probe();
    await budgeted.request({ method: "eth_call", params: [TX] });
    expect(budgeted.snapshot()[0]?.tokens).toBe(0);
    now += 2_001;
    head.value = 102;
    await budgeted.request({ method: "eth_blockNumber" });
    expect(budgeted.snapshot()[0]?.tokens).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(budgetedNode.count("eth_call")).toBe(1);
    expect(budgeted.cacheStats().refreshes).toBe(0);
    budgeted.close();
    active = true;
  });

  test("failure retains the old entry and the operation ceiling prevents refresh retries", async () => {
    const head = { value: 100 };
    let fail = false;
    const a = node("a", head, () => {
      if (fail) throw new Error("boom");
      return "0x1";
    });
    const client = opened([a.config], {
      retryCount: 2,
      operationBudget: { maxRequests: 1 },
    });
    await client.probe();
    await client.request({ method: "eth_call", params: [TX] });
    fail = true;
    head.value = 101;
    await client.probe();
    await until(() => a.count("eth_call") === 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(a.count("eth_call")).toBe(2);
    expect(client.cacheStats()).toMatchObject({ entries: 1, hotKeys: 1, refreshes: 1 });
    await expect(client.request({ method: "eth_call", params: [TX] })).resolves.toBe("0x1");
    client.close();
  });

  test("bounds the hot list independently of retained entries", async () => {
    const a = node("a", { value: 100 });
    const client = opened([a.config], { cache: { hotKeys: 2, refreshInterval: false } });
    await client.probe();
    for (const data of ["0x01", "0x02", "0x03"]) {
      await client.request({ method: "eth_call", params: [{ ...TX, data }] });
    }
    expect(client.cacheStats()).toMatchObject({ hotKeys: 2, entries: 3 });
    client.close();
  });

  test("timed reads tick, idle keys stop all cache work, and close stops the timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const head = { value: 100 };
    const a = node("a", head);
    const b = node("b", head);
    const policy = evmPolicy(1, true);
    policy.cachePolicy = evmCachePolicy({ isTimedCall: isPrecompileCall });
    const client = opened([a.config, b.config], {
      cache: { refreshInterval: 10, hotIdleMs: 50 },
      now: () => Date.now(),
    }, policy);
    await client.probe();
    await client.request({ method: "eth_call", params: [PRECOMPILE] });
    await vi.advanceTimersByTimeAsync(25);
    expect(a.count("eth_call") + b.count("eth_call")).toBeGreaterThanOrEqual(3);
    expect(client.cacheStats().refreshes).toBeGreaterThanOrEqual(2);

    await vi.advanceTimersByTimeAsync(40);
    expect(client.cacheStats().hotKeys).toBe(0);
    const probes = a.count("eth_blockNumber") + b.count("eth_blockNumber");
    const reads = a.count("eth_call") + b.count("eth_call");
    await vi.advanceTimersByTimeAsync(50);
    expect(a.count("eth_blockNumber") + b.count("eth_blockNumber")).toBe(probes);
    expect(a.count("eth_call") + b.count("eth_call")).toBe(reads);
    client.close();
  });

  test("a request re-arms a dropped Worker timer and close prevents later ticks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const head = { value: 100 };
    const a = node("a", head);
    const client = opened([a.config], {
      cache: { refreshInterval: 10 },
      now: () => Date.now(),
    });
    await client.probe();
    await client.request({ method: "eth_call", params: [TX] });
    vi.clearAllTimers();
    vi.setSystemTime(11);
    await client.request({ method: "eth_call", params: [TX] });
    await vi.advanceTimersByTimeAsync(10);
    expect(a.count("eth_blockNumber")).toBe(2);
    client.close();
    await vi.advanceTimersByTimeAsync(50);
    expect(a.count("eth_blockNumber")).toBe(2);
  });
});

describe("local eth_blockNumber", () => {
  test("uses a fresh head monotonically and goes stale by age", () => {
    let now = 0;
    let head = { block: 100, ageMs: 0 };
    const source: CacheSource = {
      now: () => now,
      head: () => head,
      held: () => head.block,
      active: () => false,
      probe: async () => undefined,
      probeMethod: "eth_blockNumber",
      read: async () => { throw new Error("unexpected read"); },
      ready: () => false,
      emit: () => undefined,
    };
    const cache = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy(), source);
    expect(cache.blockNumber()).toBe("0x64");
    head = { block: 99, ageMs: 0 };
    expect(cache.blockNumber()).toBe("0x64");
    head = { block: 103, ageMs: 2_001 };
    expect(cache.blockNumber()).toBeUndefined();
    head = { block: 103, ageMs: 0 };
    expect(cache.blockNumber()).toBe("0x67");
    now = 100;
    cache.close();
  });

  test("the pool answers locally without another upstream probe", async () => {
    const head = { value: 100 };
    const a = node("a", head);
    const client = opened([a.config], {}, evmPolicy(1, false));
    await client.probe();
    await expect(client.request({ method: "eth_blockNumber" })).resolves.toBe("0x64");
    expect(a.count("eth_blockNumber")).toBe(1);
    client.close();
  });
});
