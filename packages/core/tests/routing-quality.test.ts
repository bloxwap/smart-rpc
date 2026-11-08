import { afterEach, describe, expect, test, vi } from "vitest";

import type { PoolEndpointConfig, PoolOptions, RpcEvent } from "../src/index.js";
import { evmPolicy, pool } from "./helpers.js";

afterEach(() => vi.useRealTimers());

interface Mock {
  config: PoolEndpointConfig;
  /** Reads (not chain id or head probes) this endpoint received. */
  reads: () => number;
  /** Upstream calls of any method, for budget assertions. */
  calls: () => number;
}

interface MockOptions {
  head?: () => number;
  rps?: number;
  burst?: number;
  /** Throw this instead of answering a read, while it returns an error. */
  fail?: () => Error | undefined;
}

/** An endpoint that answers every read after a fixed delay on the fake clock. */
function endpoint(id: string, latencyMs: number, options: MockOptions = {}): Mock {
  let reads = 0;
  let calls = 0;
  return {
    reads: () => reads,
    calls: () => calls,
    config: {
      id,
      url: id,
      rps: options.rps,
      burst: options.burst,
      call: (request, callOptions) => {
        calls += 1;
        if (request.method === "eth_chainId") return Promise.resolve("0x1");
        if (request.method === "eth_blockNumber") return Promise.resolve(`0x${(options.head?.() ?? 100).toString(16)}`);
        reads += 1;
        const error = options.fail?.();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => (error ? reject(error) : resolve("0x1")), error ? 5 : latencyMs);
          callOptions?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      },
    },
  };
}

function client(mocks: readonly Mock[], overrides: Partial<PoolOptions> = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const events: RpcEvent[] = [];
  const rpc = pool(mocks.map((mock) => mock.config), {
    now: () => Date.now(),
    onEvent: (event) => events.push(event),
    ...overrides,
  }, evmPolicy(1, false));
  return { rpc, events };
}

let address = 0;
async function read(rpc: ReturnType<typeof pool>, settleMs = 300): Promise<unknown> {
  address += 1;
  const pending = rpc.request({ method: "eth_getBalance", params: [`0x${address.toString(16)}`, "latest"] });
  const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.advanceTimersByTimeAsync(settleMs);
  const settled = await outcome;
  if ("error" in settled) throw settled.error;
  return settled.value;
}

const winners = (events: readonly RpcEvent[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const event of events) if (event.type === "success" && event.method === "eth_getBalance") counts[event.endpoint] = (counts[event.endpoint] ?? 0) + 1;
  return counts;
};

describe("routing quality", () => {
  test("the fastest healthy endpoint wins steady state even when it is listed last", async () => {
    const slow = endpoint("slow", 200);
    const mid = endpoint("mid", 80);
    const fast = endpoint("fast", 40);
    const { rpc, events } = client([slow, mid, fast], { race: true });
    for (let index = 0; index < 10; index += 1) await read(rpc);
    events.length = 0;
    for (let index = 0; index < 20; index += 1) await read(rpc);
    expect(winners(events)).toEqual({ fast: 20 });
    rpc.close();
  });

  test("a lagging endpoint loses and is never raced, then wins again once it catches up", async () => {
    const heads = { fast: 100, slow: 100 };
    const fast = endpoint("fast", 40, { head: () => heads.fast });
    const slow = endpoint("slow", 120, { head: () => heads.slow });
    const { rpc, events } = client([fast, slow], { race: true });
    await rpc.probe();
    for (let index = 0; index < 8; index += 1) await read(rpc);
    expect(winners(events)).toMatchObject({ fast: 8 });

    heads.slow = 110;
    await rpc.probe();
    events.length = 0;
    const fastReads = fast.reads();
    for (let index = 0; index < 8; index += 1) await read(rpc);
    // Without "latest" pinning a raced lagging endpoint would win with stale state, so it is not raced at all.
    expect(winners(events)).toEqual({ slow: 8 });
    expect(fast.reads()).toBe(fastReads);

    heads.fast = 110;
    await rpc.probe();
    events.length = 0;
    for (let index = 0; index < 8; index += 1) await read(rpc);
    expect(winners(events)).toEqual({ fast: 8 });
    rpc.close();
  });

  test("a rate-limited endpoint is backed off for its Retry-After and restored afterwards", async () => {
    let limited = false;
    const rateLimit = (): Error | undefined => {
      if (!limited) return undefined;
      const error = Object.assign(new Error("HTTP 429 Too Many Requests"), { status: 429 });
      Object.defineProperty(error, "headers", { value: new Headers({ "retry-after": "2" }) });
      return error;
    };
    const fast = endpoint("fast", 40, { fail: rateLimit });
    const slow = endpoint("slow", 400);
    const { rpc, events } = client([fast, slow], { race: false, routing: "best" });
    for (let index = 0; index < 5; index += 1) await read(rpc, 500);
    expect(winners(events)).toEqual({ fast: 5 });

    limited = true;
    events.length = 0;
    await read(rpc, 500);
    expect(events).toContainEqual(expect.objectContaining({ type: "eject", endpoint: "fast", cooldownMs: 2_000 }));
    expect(winners(events)).toEqual({ slow: 1 });
    const limitedReads = fast.reads();
    for (let index = 0; index < 2; index += 1) await read(rpc, 500);
    expect(fast.reads()).toBe(limitedReads);

    limited = false;
    await vi.advanceTimersByTimeAsync(1_000);
    events.length = 0;
    for (let index = 0; index < 5; index += 1) await read(rpc, 500);
    expect(events).toContainEqual({ type: "restore", endpoint: "fast" });
    expect(winners(events)).toEqual({ fast: 5 });
    rpc.close();
  });

  test("load spills to the next endpoint when the best one's budget is spent, without overrunning it", async () => {
    const fast = endpoint("fast", 40, { rps: 1, burst: 1 });
    const slow = endpoint("slow", 100);
    const { rpc } = client([fast, slow], { race: false, routing: "best" });
    // Four concurrent callers: the fast endpoint takes what its bucket holds, the rest go to the next one now.
    const burst = Array.from({ length: 4 }, (_, index) => rpc.request({ method: "eth_getBalance", params: [`0xb${index}`, "latest"] }));
    await vi.advanceTimersByTimeAsync(150);
    await expect(Promise.all(burst)).resolves.toHaveLength(4);
    expect(fast.reads()).toBe(1);
    expect(slow.reads()).toBe(3);

    // Ten seconds of steady demand at five reads per second: fast serves exactly its budget, nothing waits.
    for (let index = 0; index < 50; index += 1) await read(rpc, 200);
    expect(fast.calls()).toBeLessThanOrEqual(1 + 10);
    expect(fast.reads()).toBeGreaterThanOrEqual(10);
    expect(fast.reads() + slow.reads()).toBe(54);
    rpc.close();
  });

  test("race rivals only spend spare tokens, so the last one stays for a caller's failover", async () => {
    let down = false;
    const outage = (): Error | undefined => (down ? new Error("fetch failed") : undefined);
    const fast = endpoint("fast", 40, { fail: outage });
    const budgeted = endpoint("budgeted", 60, { rps: 0.001, burst: 2 });
    const { rpc, events } = client([fast, budgeted], { race: true, retryCount: 1 });
    await read(rpc);
    expect(budgeted.reads()).toBe(1);
    await read(rpc);
    await read(rpc);
    expect(budgeted.reads()).toBe(1);
    expect(rpc.snapshot().find((row) => row.id === "budgeted")?.tokens).toBe(1);
    expect(events.filter((event) => event.type === "race")).toHaveLength(1);

    down = true;
    await read(rpc);
    expect(budgeted.reads()).toBe(2);
    expect(rpc.snapshot().find((row) => row.id === "budgeted")?.tokens).toBe(0);
    rpc.close();
  });

  test("a cold lead is verified in the background while a verified endpoint serves the call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const seen: string[] = [];
    const delayed = (ms: number, value: string): Promise<string> => new Promise((resolve) => setTimeout(() => resolve(value), ms));
    const rpc = pool([
      { id: "warm", url: "warm", call: ({ method }) => { seen.push(`warm:${method}`); return method === "eth_chainId" ? Promise.resolve("0x1") : delayed(400, "0xwarm"); } },
      { id: "cold", url: "cold", call: ({ method }) => { seen.push(`cold:${method}`); return method === "eth_chainId" ? delayed(500, "0x1") : delayed(50, "0xcold"); } },
    ], { now: () => Date.now(), verifyIdentity: true, race: false, routing: "best" }, evmPolicy(1, false));
    const first = rpc.request({ method: "eth_getBalance", params: ["0x1", "latest"] });
    await vi.advanceTimersByTimeAsync(400);
    await expect(first).resolves.toBe("0xwarm");

    // "cold" now scores better (prior 250ms against a measured 400ms) but has not proved its chain id yet.
    const second = rpc.request({ method: "eth_getBalance", params: ["0x2", "latest"] }).then((value) => ({ value, at: Date.now() }));
    await vi.advanceTimersByTimeAsync(600);
    await expect(second).resolves.toEqual({ value: "0xwarm", at: 800 });
    expect(seen).toContain("cold:eth_chainId");
    expect(seen).not.toContain("cold:eth_getBalance");

    const third = rpc.request({ method: "eth_getBalance", params: ["0x3", "latest"] });
    await vi.advanceTimersByTimeAsync(50);
    await expect(third).resolves.toBe("0xcold");
    rpc.close();
  });

  test("a cold burst-1 endpoint is still verified in the background and then used", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const seen: string[] = [];
    const delayed = (ms: number, value: string): Promise<string> => new Promise((resolve) => setTimeout(() => resolve(value), ms));
    const rpc = pool([
      { id: "warm", url: "warm", call: ({ method }) => method === "eth_chainId" ? Promise.resolve("0x1") : delayed(400, "0xwarm") },
      { id: "tight", url: "tight", rps: 1, burst: 1, call: ({ method }) => { seen.push(method); return method === "eth_chainId" ? delayed(20, "0x1") : delayed(50, "0xtight"); } },
    ], { now: () => Date.now(), verifyIdentity: true, race: false, routing: "best", headLag: { probeInterval: false } }, evmPolicy(1, false));
    const results: unknown[] = [];
    for (let index = 0; index < 4; index += 1) {
      const pending = rpc.request({ method: "eth_getBalance", params: [`0x${index + 1}`, "latest"] });
      await vi.advanceTimersByTimeAsync(2_000);
      results.push(await pending);
    }
    // Its only token is useless to callers until it is verified, so the check may spend it.
    expect(seen[0]).toBe("eth_chainId");
    expect(results.slice(2)).toEqual(["0xtight", "0xtight"]);
    rpc.close();
  });

  test("a background cache refresh never takes the last token from caller traffic", async () => {
    let head = 100;
    let reads = 0;
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const rpc = pool([{
      id: "budgeted", url: "budgeted", rps: 0.001, burst: 4,
      call: async (request) => {
        if (request.method === "eth_blockNumber") return `0x${head.toString(16)}`;
        reads += 1;
        return "0x1";
      },
    }], { now: () => Date.now(), cache: { refreshInterval: false } }, evmPolicy(1, false));
    await rpc.probe();
    await rpc.request({ method: "eth_call", params: [{ to: "0xabc" }, "latest"] });
    expect(rpc.snapshot()[0]?.tokens).toBe(2);
    vi.setSystemTime(2_001);
    head = 101;
    await rpc.request({ method: "eth_blockNumber" });
    await vi.advanceTimersByTimeAsync(10);
    expect(reads).toBe(1);
    expect(rpc.snapshot()[0]?.tokens).toBe(1);
    expect(rpc.cacheStats().refreshes).toBe(0);
    rpc.close();
  });
});
