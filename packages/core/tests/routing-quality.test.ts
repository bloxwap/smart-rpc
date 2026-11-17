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

  test("a rate-limited endpoint cools down for exactly its Retry-After, is not ejected, and leads again at once", async () => {
    let limited = false;
    const rateLimit = (): Error | undefined => {
      if (!limited) return undefined;
      const error = Object.assign(new Error("HTTP 429 Too Many Requests"), { status: 429 });
      Object.defineProperty(error, "headers", { value: new Headers({ "retry-after": "2" }) });
      return error;
    };
    // A generous budget, so the rate cut that also follows the 429 never decides who serves here.
    const fast = endpoint("fast", 40, { rps: 100, burst: 100, fail: rateLimit });
    const slow = endpoint("slow", 400);
    const { rpc, events } = client([fast, slow], { race: false, routing: "best" });
    for (let index = 0; index < 5; index += 1) await read(rpc, 500);
    expect(winners(events)).toEqual({ fast: 5 });
    const healthy = rpc.snapshot("eth_getBalance").find((row) => row.id === "fast")?.score;

    limited = true;
    events.length = 0;
    await read(rpc, 500);
    expect(events).toContainEqual(expect.objectContaining({ type: "throttle", endpoint: "fast", cooldownMs: 2_000 }));
    expect(events.some((event) => event.type === "eject")).toBe(false);
    expect(winners(events)).toEqual({ slow: 1 });
    const row = rpc.snapshot("eth_getBalance").find((entry) => entry.id === "fast");
    expect(row?.ejected).toBe(false);
    // The 429 landed 5ms into the read; 495ms later exactly 1505ms of the asked 2s remain.
    expect(row?.throttledMs).toBe(1_505);
    // Rate limited is not unhealthy: the latency and error score is untouched.
    expect(row?.score).toBe(healthy);
    const limitedReads = fast.reads();
    await read(rpc, 500);
    expect(fast.reads()).toBe(limitedReads);

    // The cooldown ends 2s after the 429 (1505ms after the snapshot above, 1005ms after the last read).
    limited = false;
    await vi.advanceTimersByTimeAsync(1_005);
    events.length = 0;
    for (let index = 0; index < 5; index += 1) await read(rpc, 500);
    expect(winners(events)).toEqual({ fast: 5 });
    rpc.close();
  });

  test("429s without Retry-After cool down briefly, grow on repeats, and reset after an answer", async () => {
    let limited = 0;
    const rateLimit = (): Error | undefined => {
      if (limited <= 0) return undefined;
      limited -= 1;
      return Object.assign(new Error("HTTP request failed."), { status: 429 });
    };
    // A generous budget, so the rate cut never decides who serves here.
    const fast = endpoint("fast", 40, { rps: 100, burst: 100, fail: rateLimit });
    const slow = endpoint("slow", 400);
    const { rpc, events } = client([fast, slow], { race: false, routing: "best", retryCount: 0 });
    for (let index = 0; index < 3; index += 1) await read(rpc, 500);
    const cooldowns = (): number[] => events.flatMap((event) => event.type === "throttle" ? [event.cooldownMs] : []);

    // Three 429s in a row, each right after the previous cooldown: 1s, then 2s, then 4s.
    limited = 3;
    events.length = 0;
    await expect(read(rpc, 500)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(600);
    await expect(read(rpc, 500)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_600);
    await expect(read(rpc, 500)).rejects.toThrow();
    expect(cooldowns()).toEqual([1_000, 2_000, 4_000]);
    expect(events.some((event) => event.type === "eject")).toBe(false);

    // One answer after the cooldown resets the streak: the next 429 costs 1s again.
    await vi.advanceTimersByTimeAsync(4_000);
    await read(rpc, 500);
    limited = 1;
    events.length = 0;
    await expect(read(rpc, 500)).rejects.toThrow();
    expect(cooldowns()).toEqual([1_000]);
    rpc.close();
  });

  test("a budgeted endpoint that keeps hitting an undocumented limit has its rate halved, then recovers additively", async () => {
    let limitedFor = 0;
    const rateLimit = (): Error | undefined => {
      if (Date.now() >= limitedFor) return undefined;
      return Object.assign(new Error("You reached Public endpoint rate limit"), { status: 429 });
    };
    const fast = endpoint("fast", 40, { rps: 10, burst: 10, fail: rateLimit });
    const slow = endpoint("slow", 400);
    const { rpc, events } = client([fast, slow], { race: false, routing: "best" });
    await read(rpc, 500);
    limitedFor = Date.now() + 10;
    events.length = 0;
    await read(rpc, 500);
    expect(events).toContainEqual(expect.objectContaining({ type: "throttle", endpoint: "fast", cooldownMs: 1_000, rps: 5 }));
    expect(rpc.snapshot().find((row) => row.id === "fast")?.tokens).toBe(0);

    // After the cooldown the bucket refills at 5 rps, not 10: a burst of 20 gets at most what that allows.
    await vi.advanceTimersByTimeAsync(1_000);
    const before = fast.reads();
    const burst = Array.from({ length: 20 }, (_, index) => rpc.request({ method: "eth_getBalance", params: [`0xa${index}`, "latest"] }));
    await vi.advanceTimersByTimeAsync(600);
    await Promise.all(burst);
    expect(fast.reads() - before).toBeLessThanOrEqual(5);

    // Each second of successful use gives back 5% of the configured rate.
    for (let index = 0; index < 40; index += 1) await read(rpc, 250);
    const second = rpc.snapshot().find((row) => row.id === "fast");
    expect(second?.ejected).toBe(false);
    limitedFor = Date.now() + 10;
    events.length = 0;
    await read(rpc, 500);
    const cut = events.find((event) => event.type === "throttle");
    expect(cut?.type === "throttle" ? cut.rps : null).toBeGreaterThan(2.5);
    rpc.close();
  });

  test("an unbudgeted endpoint that hits a rate limit gets a learned budget instead of flapping", async () => {
    let limitedFor = 0;
    const rateLimit = (): Error | undefined =>
      Date.now() < limitedFor ? Object.assign(new Error("Too Many Requests"), { status: 429 }) : undefined;
    const fast = endpoint("fast", 40, { fail: rateLimit });
    const slow = endpoint("slow", 400);
    const { rpc, events } = client([fast, slow], { race: false, routing: "best" });
    // Ten reads a second for two seconds, then one 429.
    for (let index = 0; index < 20; index += 1) await read(rpc, 100);
    expect(rpc.snapshot().find((row) => row.id === "fast")?.tokens).toBeNull();
    limitedFor = Date.now() + 10;
    events.length = 0;
    await read(rpc, 500);
    const throttle = events.find((event) => event.type === "throttle");
    expect(throttle?.type === "throttle" ? throttle.rps : null).toBeGreaterThanOrEqual(4);
    expect(throttle?.type === "throttle" ? throttle.rps : null).toBeLessThanOrEqual(6);
    // After the cooldown the endpoint serves at the learned rate, and the rest spills over without errors:
    // twenty reads a second for three seconds.
    await vi.advanceTimersByTimeAsync(1_000);
    events.length = 0;
    const before = fast.reads();
    const pending: Promise<unknown>[] = [];
    for (let index = 0; index < 60; index += 1) {
      pending.push(rpc.request({ method: "eth_getBalance", params: [`0xc${index}`, "latest"] }));
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(500);
    await expect(Promise.all(pending)).resolves.toHaveLength(60);
    const served = fast.reads() - before;
    // About 5 rps for 3.5s plus the tokens refilled during the cooldown and 5%/s recovery: well under the 60 sent.
    expect(served).toBeGreaterThan(12);
    expect(served).toBeLessThanOrEqual(30);
    expect(winners(events).slow).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "error" || event.type === "throttle")).toBe(false);

    // A minute without rate limits drops the learned budget.
    await vi.advanceTimersByTimeAsync(60_000);
    await read(rpc, 100);
    expect(rpc.snapshot().find((row) => row.id === "fast")?.tokens).toBeNull();
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

  test("an endpoint lagging past maxLag never leads a head read while a fresh one can, but serves fixed reads", async () => {
    // Fast enough that the lag penalty alone (score x4 at 5 blocks behind, maxLag 2) would still let it lead.
    const heads = { fast: 100 };
    const fast = endpoint("fast", 10, { head: () => heads.fast });
    const slow = endpoint("slow", 100, { head: () => 100 });
    const { rpc, events } = client([fast, slow], { race: false, routing: "best" });
    await rpc.probe();
    for (let index = 0; index < 4; index += 1) await read(rpc, 200);
    expect(winners(events)).toEqual({ fast: 4 });
    heads.fast = 95;
    await rpc.probe();
    expect(rpc.snapshot().find((row) => row.id === "fast")?.lag).toBe(5);
    const served = async (method: string, params: unknown[]): Promise<string | undefined> => {
      events.length = 0;
      const pending = rpc.request({ method, params });
      await vi.advanceTimersByTimeAsync(200);
      await pending;
      return events.find((event) => event.type === "success" && event.method === method)?.type === "success"
        ? (events.find((event) => event.type === "success" && event.method === method) as { endpoint: string }).endpoint
        : undefined;
    };
    for (let index = 0; index < 4; index += 1) {
      expect(await served("eth_getBalance", [`0xd${index}`, "latest"])).toBe("slow");
      expect(await served("eth_getTransactionCount", [`0xe${index}`])).toBe("slow");
      expect(await served("eth_gasPrice", [])).toBe("slow");
      expect(await served("eth_call", [{ to: `0xf${index}` }, { blockNumber: "pending" }])).toBe("slow");
    }
    // Block-number, block-hash and finalized reads do not depend on the head: the lagging endpoint may lead them.
    expect(await served("eth_getBalance", ["0xd9", "0x5"])).toBe("fast");
    expect(await served("eth_getBlockByHash", [`0x${"ab".repeat(32)}`, false])).toBe("fast");
    expect(await served("eth_getBalance", ["0xd8", "finalized"])).toBe("fast");
    expect(events.some((event) => event.type === "error")).toBe(false);
    rpc.close();
  });

  test("a lagging endpoint still serves head reads when no fresh endpoint can, and as a failover", async () => {
    let down = false;
    const fast = endpoint("fast", 10, { head: () => 95 });
    const slow = endpoint("slow", 100, { head: () => 100, rps: 1, burst: 1, fail: () => (down ? new Error("fetch failed") : undefined) });
    const { rpc, events } = client([fast, slow], { race: false, routing: "best" });
    await rpc.probe();
    await vi.advanceTimersByTimeAsync(2_000);
    // The fresh endpoint fails: the lagging one answers as the failover instead of the call failing.
    down = true;
    events.length = 0;
    await expect(read(rpc, 300)).resolves.toBe("0x1");
    expect(winners(events)).toEqual({ fast: 1 });
    // The fresh endpoint is out of budget: the lagging one leads rather than making the caller wait.
    down = false;
    events.length = 0;
    await expect(read(rpc, 300)).resolves.toBe("0x1");
    expect(winners(events)).toEqual({ fast: 1 });
    rpc.close();
  });

  test("concurrent head reads spill to a lagging endpoint instead of queueing on a fresh one's spent budget", async () => {
    const fast = endpoint("fast", 10, { head: () => 95 });
    const slow = endpoint("slow", 100, { head: () => 100, rps: 1, burst: 1 });
    const { rpc, events } = client([fast, slow], { race: false, routing: "best" });
    await rpc.probe();
    await vi.advanceTimersByTimeAsync(2_000);
    events.length = 0;
    // Every call sees one fresh token when it starts; only the first gets it.
    const pending = Array.from({ length: 5 }, (_, index) =>
      rpc.request({ method: "eth_getBalance", params: [`0xb${index}`, "latest"] }).then(() => Date.now()));
    await vi.advanceTimersByTimeAsync(300);
    const finished = await Promise.all(pending);
    expect(winners(events)).toEqual({ slow: 1, fast: 4 });
    expect(Math.max(...finished) - Math.min(...finished)).toBeLessThan(200);
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
