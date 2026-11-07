import { afterEach, describe, expect, test, vi } from "vitest";

import type { RpcEvent, ScorePersistence, ScoreSnapshot } from "../src/index.js";
import { localStoragePersistence } from "../src/warmstart.js";
import { pool } from "./helpers.js";

const START = 10_000_000;
const HOUR = 3_600_000;

interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

function clock(): Clock {
  let time = START;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

interface MockEndpoint {
  id?: string;
  url: string;
  calls: string[];
  call: (request: { method: string; params?: unknown }) => Promise<unknown>;
}

/** An endpoint that answers chain 1 and takes `latencyMs` of injected time for every other method. */
function mockEndpoint(
  name: string,
  time: Clock,
  latencyMs: number,
  handler: (method: string) => unknown = () => "0x1",
): MockEndpoint {
  const calls: string[] = [];
  return {
    url: name,
    calls,
    call: async ({ method }) => {
      calls.push(method);
      if (method !== "eth_chainId") time.advance(latencyMs);
      return handler(method);
    },
  };
}

function open(time: Clock, endpoints: readonly MockEndpoint[], options: Parameters<typeof pool>[1] = {}) {
  return pool(
    endpoints.map((endpoint, index) => ({ ...endpoint, id: endpoint.id ?? `node${index}` })),
    {
      headLag: false,
      routing: "best",
      hedge: false,
      timeout: 1_000,
      now: time.now,
      ...options,
    },
  );
}

/** node0 slow, node1 fast, as a session that measured both would save them. */
function learned(time: Clock, savedAt = time.now()): ScoreSnapshot {
  return {
    version: 1,
    savedAt,
    endpoints: {
      node0: { "*": { ewma: 400, tail: 400, error: 0, n: 5 }, eth_call: { ewma: 400, tail: 400, error: 0, n: 5 } },
      node1: { "*": { ewma: 20, tail: 20, error: 0, n: 5 }, eth_call: { ewma: 20, tail: 20, error: 0, n: 5 } },
    },
  };
}

function call(transport: ReturnType<typeof open>, method = "eth_call", signal?: AbortSignal): Promise<unknown> {
  return transport.request({ method, params: [], signal });
}

function book(transport: ReturnType<typeof open>, id: string, method = "*") {
  return transport.snapshot("eth_call").find((entry) => entry.id === id)?.methods[method];
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function persistEvents(events: RpcEvent[]): Extract<RpcEvent, { type: "persist" }>[] {
  return events.filter((event): event is Extract<RpcEvent, { type: "persist" }> => event.type === "persist");
}

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  vi.useRealTimers();
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("score snapshots", () => {
  test("scores() keeps learned books by public label and leaves out transient routing state", async () => {
    const time = clock();
    const slow = mockEndpoint("https://user:SLOW_SECRET@slow.example", time, 400);
    const fast = mockEndpoint("https://user:FAST_SECRET@fast.example", time, 20);
    const idle = mockEndpoint("https://user:IDLE_SECRET@idle.example", time, 20);
    const transport = open(time, [slow, fast, idle]);
    await call(transport);
    await call(transport, "eth_blockNumber");
    const snapshot = transport.scores();
    expect(snapshot.version).toBe(1);
    expect(snapshot.savedAt).toBe(time.now());
    expect(Object.keys(snapshot.endpoints).sort()).toEqual(["node0", "node1"]);
    expect(snapshot.endpoints.node0?.eth_call).toEqual({ ewma: 400, tail: 400, error: 0, n: 1 });
    expect(snapshot.endpoints.node1?.eth_blockNumber).toEqual({ ewma: 20, tail: 20, error: 0, n: 1 });
    const text = JSON.stringify(snapshot);
    for (const field of ["head", "lag", "inflight", "quarantined", "eject", "verified", "openUntil"]) {
      expect(text).not.toContain(field);
    }
    for (const secret of ["SLOW_SECRET", "FAST_SECRET", "IDLE_SECRET", "slow.example", "fast.example"]) {
      expect(text).not.toContain(secret);
    }
    expect(JSON.parse(text)).toEqual(snapshot);
  });

  test("unlabeled core endpoints use stable distinct opaque labels in scores and persisted JSON", async () => {
    const time = clock();
    const urls = [
      "https://user:CORE_SECRET_ONE@same.example/private/PATH_ONE?api-key=QUERY_ONE",
      "https://user:CORE_SECRET_TWO@same.example/private/PATH_TWO?api-key=QUERY_TWO",
    ];
    const endpoints = urls.map((url, index) => ({
      url,
      call: async () => {
        time.advance(index === 0 ? 400 : 20);
        return "0x1";
      },
    }));
    const saved: ScoreSnapshot[] = [];
    const transport = pool(endpoints, {
      headLag: false,
      routing: "best",
      now: time.now,
      persist: { load: () => undefined, save: (snapshot) => void saved.push(snapshot) },
    });
    await call(transport);
    await call(transport);
    const snapshot = transport.scores();
    const labels = Object.keys(snapshot.endpoints);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    for (const label of labels) expect(label).toMatch(/^endpoint:[0-9a-f]{16}$/);
    expect(transport.endpoints.map((endpoint) => endpoint.id)).toEqual(urls);
    transport.close();
    expect(saved).toHaveLength(1);
    for (const text of [JSON.stringify(snapshot), JSON.stringify(saved)]) {
      for (const secret of [...urls, "CORE_SECRET", "QUERY_", "same.example", "private", "PATH_", "api-key"]) {
        expect(text).not.toContain(secret);
      }
    }

    const restored = pool(endpoints, { headLag: false, now: time.now });
    expect(restored.restoreScores(JSON.stringify(snapshot))).toBe(true);
    expect(Object.keys(restored.scores().endpoints)).toEqual(labels);
    expect(restored.endpoints.map((endpoint) => endpoint.id)).toEqual(urls);
  });

  test("a fresh pool restored from a snapshot routes to the endpoint the last session found fastest", async () => {
    const time = clock();
    const first = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)];
    const session = open(time, first);
    await call(session);
    await call(session);
    expect(first.map((endpoint) => endpoint.calls.filter((method) => method === "eth_call").length)).toEqual([1, 1]);
    const saved = JSON.stringify(session.scores());

    const cold = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)];
    await call(open(time, cold));
    expect(cold[0]?.calls).toContain("eth_call");

    const warm = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)];
    const restored = open(time, warm);
    expect(restored.restoreScores(saved)).toBe(true);
    await call(restored);
    expect(warm[0]?.calls).toEqual([]);
    expect(warm[1]?.calls).toEqual(["eth_call"]);
  });

  test("a restored book counts as two samples and the first live sample replaces it", async () => {
    const time = clock();
    const nodes = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 300)];
    const transport = open(time, nodes);
    transport.restoreScores(learned(time));
    expect(book(transport, "node1")).toEqual({ ewma: 20, tail: 20, error: 0, n: 2 });
    expect(book(transport, "node1", "eth_call")).toEqual({ ewma: 20, tail: 20, error: 0, n: 2 });
    await call(transport);
    expect(book(transport, "node1")).toEqual({ ewma: 300, tail: 300, error: 0, n: 1 });
    expect(book(transport, "node1", "eth_call")).toEqual({ ewma: 300, tail: 300, error: 0, n: 1 });
    expect(book(transport, "node0")?.n).toBe(2);
  });

  test("live books win: restore only seeds books with no samples", async () => {
    const time = clock();
    const transport = open(time, [mockEndpoint("a", time, 100), mockEndpoint("b", time, 100)]);
    await call(transport);
    expect(transport.restoreScores(learned(time))).toBe(true);
    expect(book(transport, "node0")).toEqual({ ewma: 100, tail: 100, error: 0, n: 1 });
    expect(book(transport, "node1")?.ewma).toBe(20);
    expect(transport.restoreScores(learned(time))).toBe(false);
  });

  test("a probe does not replace a prior", async () => {
    const time = clock();
    const transport = open(time, [mockEndpoint("a", time, 100), mockEndpoint("b", time, 100)]);
    transport.restoreScores(learned(time));
    await transport.probe();
    expect(book(transport, "node1")).toEqual({ ewma: 20, tail: 20, error: 0, n: 2 });
  });

  test("ignores snapshots and books older than persist.maxAge", () => {
    const time = clock();
    const nodes = [mockEndpoint("a", time, 1), mockEndpoint("b", time, 1)];
    expect(open(time, nodes).restoreScores(learned(time, time.now() - HOUR - 1))).toBe(false);
    expect(open(time, nodes).restoreScores(learned(time, time.now() - HOUR))).toBe(true);
    const short = { load: () => undefined, save: () => undefined, maxAge: 1_000 };
    expect(open(time, nodes, { persist: short }).restoreScores(learned(time, time.now() - 1_001))).toBe(false);
    expect(open(time, nodes).restoreScores(learned(time, time.now() + 120_000))).toBe(false);

    const mixed = learned(time);
    const stale = mixed.endpoints.node0?.["*"];
    if (stale) stale.at = time.now() - HOUR - 1;
    const transport = open(time, nodes);
    expect(transport.restoreScores(mixed)).toBe(true);
    expect(book(transport, "node0")?.n).toBe(0);
    expect(book(transport, "node0", "eth_call")?.n).toBe(2);
  });

  test("a re-saved prior keeps the time it was measured, so it still ages out", () => {
    const time = clock();
    const nodes = [mockEndpoint("a", time, 1), mockEndpoint("b", time, 1)];
    const measuredAt = time.now();
    const first = open(time, nodes);
    first.restoreScores(learned(time));
    time.advance(HOUR / 2);
    const resaved = first.scores();
    expect(resaved.savedAt).toBe(measuredAt + HOUR / 2);
    expect(resaved.endpoints.node1?.["*"]).toEqual({ ewma: 20, tail: 20, error: 0, n: 2, at: measuredAt });
    time.advance(HOUR / 2 + 1);
    expect(open(time, nodes).restoreScores(resaved)).toBe(false);
  });

  test("rejects input that is not a version 1 snapshot", () => {
    const time = clock();
    const transport = open(time, [mockEndpoint("a", time, 1), mockEndpoint("b", time, 1)]);
    const savedAt = time.now();
    const node = { "*": { ewma: 20, tail: 20, error: 0, n: 3 } };
    const inputs: unknown[] = [
      undefined,
      null,
      7,
      "",
      "not json",
      "[]",
      [],
      {},
      { version: 2, savedAt, endpoints: { node0: node } },
      { version: "1", savedAt, endpoints: { node0: node } },
      { version: 1, savedAt: "now", endpoints: { node0: node } },
      { version: 1, savedAt: Number.NaN, endpoints: { node0: node } },
      { version: 1, savedAt, endpoints: [node] },
      { version: 1, savedAt, endpoints: null },
      JSON.stringify({ version: 1, savedAt, endpoints: { node0: node }, pad: "x".repeat(300_000) }),
    ];
    for (const input of inputs) expect(transport.restoreScores(input)).toBe(false);
    expect(transport.scores().endpoints).toEqual({});
  });

  test("skips malformed books, unknown endpoints, and bad method names, and clamps values", () => {
    const time = clock();
    const transport = open(time, [mockEndpoint("a", time, 1), mockEndpoint("b", time, 1)]);
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`m${index}`, { ewma: 1, tail: 1, error: 0, n: 1 }]),
    );
    const raw = JSON.stringify({
      version: 1,
      savedAt: time.now(),
      endpoints: {
        node0: {
          "*": { ewma: 1e12, tail: -5, error: 7, n: 1e9 },
          eth_call: { ewma: "1", tail: 1, error: 0, n: 1 },
          eth_getLogs: { ewma: 1, tail: 1, error: 0, n: 0 },
          eth_getBalance: { ewma: 1, tail: 1, error: 0 },
          eth_getCode: { ewma: 1, tail: 1, error: 0, n: 1, at: "yesterday" },
          "bad method": { ewma: 1, tail: 1, error: 0, n: 1 },
        },
        node1: many,
        "https://evil.example.test/?apikey=x": { "*": { ewma: 1, tail: 1, error: 0, n: 1 } },
        ["__proto__"]: { "*": { ewma: 1, tail: 1, error: 0, n: 1 } },
      },
    });
    expect(raw).toContain('"__proto__"');
    expect(transport.restoreScores(raw)).toBe(true);
    expect(book(transport, "node0")).toEqual({ ewma: 1_000, tail: 0, error: 1, n: 2 });
    const node0 = transport.snapshot("eth_call").find((entry) => entry.id === "node0");
    expect(Object.keys(node0?.methods ?? {})).toEqual(["*"]);
    const node1 = transport.snapshot("eth_call").find((entry) => entry.id === "node1");
    expect(Object.values(node1?.methods ?? {}).filter((stat) => stat.n > 0)).toHaveLength(32);
    expect(transport.snapshot().map((entry) => entry.id)).toEqual(["node0", "node1"]);
    expect(({} as Record<string, unknown>)["*"]).toBeUndefined();
  });
});

describe("restored scores and the safety rules", () => {
  test("a restored favourite still passes its chain check, and is quarantined on the wrong chain", async () => {
    const time = clock();
    const honest = mockEndpoint("a", time, 400);
    const wrong = mockEndpoint("b", time, 20, (method) => (method === "eth_chainId" ? "0x2" : "0x1"));
    const transport = open(time, [honest, wrong], { verifyIdentity: true });
    transport.restoreScores(learned(time));
    await call(transport);
    expect(wrong.calls).toEqual(["eth_chainId"]);
    expect(honest.calls).toEqual(["eth_chainId", "eth_call"]);
    expect(transport.snapshot().find((entry) => entry.id === "node1")?.quarantined).toBe(true);
  });

  test("breaker state is not saved or restored", async () => {
    const time = clock();
    const a = mockEndpoint("a", time, 400);
    const b = mockEndpoint("b", time, 20, (method) => {
      if (method === "eth_chainId") return "0x1";
      throw new Error("socket hang up");
    });
    const transport = open(time, [a, b], { breaker: { threshold: 1, cooldown: 60_000 } });
    transport.restoreScores(learned(time));
    await transport.probe();
    expect(transport.snapshot().find((entry) => entry.id === "node1")?.ejected).toBe(true);
    expect(book(transport, "node1")).toMatchObject({ ewma: 20, n: 2 });
    expect(transport.scores().endpoints.node1?.["*"]?.at).toBe(START);

    const fresh = open(time, [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)]);
    fresh.restoreScores(transport.scores());
    expect(fresh.snapshot().every((entry) => !entry.ejected && entry.head === null && entry.inflight === 0)).toBe(true);
  });

  test("a non-idempotent method goes once to the restored favourite and is not retried", async () => {
    const time = clock();
    const a = mockEndpoint("a", time, 400);
    const b = mockEndpoint("b", time, 20, () => {
      throw new Error("socket hang up");
    });
    const transport = open(time, [a, b], { retryCount: 3 });
    transport.restoreScores(learned(time));
    await expect(call(transport, "eth_sendTransaction")).rejects.toThrow();
    expect(b.calls.filter((method) => method === "eth_sendTransaction")).toHaveLength(1);
    expect(a.calls).not.toContain("eth_sendTransaction");
  });
});

describe("persist", () => {
  test("load runs once per instance, on the first request, not when the pool is built", async () => {
    const time = clock();
    let loads = 0;
    const transport = open(time, [mockEndpoint("a", time, 1)], {
      persist: {
        load: (): undefined => {
          loads += 1;
        },
        save: () => undefined,
      },
    });
    expect(loads).toBe(0);
    await call(transport);
    await call(transport);
    expect(loads).toBe(1);
    transport.close();
  });

  test("a synchronous load, or one that has already settled, seeds the first pick", async () => {
    for (const load of [(time: Clock) => learned(time), async (time: Clock) => JSON.stringify(learned(time))]) {
      const time = clock();
      const nodes = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)];
      const transport = open(time, nodes, { persist: { load: () => load(time), save: () => undefined } });
      await call(transport);
      expect(nodes[0]?.calls).toEqual([]);
      expect(nodes[1]?.calls).toEqual(["eth_call"]);
      transport.close();
    }
  });

  test("a slow load never holds a call, and lands when it settles without replacing live samples", async () => {
    const time = clock();
    const nodes = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)];
    const pending = deferred<unknown>();
    const transport = open(time, nodes, { persist: { load: () => pending.promise, save: () => undefined } });
    await call(transport);
    expect(nodes[0]?.calls).toContain("eth_call");
    pending.resolve(learned(time));
    await sleep(0);
    expect(book(transport, "node1")?.n).toBe(2);
    expect(book(transport, "node0")).toEqual({ ewma: 400, tail: 400, error: 0, n: 1 });
    transport.close();
  });

  test("an aborted first request rejects at once while the load is pending, and the load still lands", async () => {
    const time = clock();
    const nodes = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)];
    const pending = deferred<unknown>();
    const transport = open(time, nodes, { persist: { load: () => pending.promise, save: () => undefined } });
    const controller = new AbortController();
    controller.abort();
    await expect(call(transport, "eth_call", controller.signal)).rejects.toThrow();
    pending.resolve(learned(time));
    await sleep(0);
    await call(transport);
    expect(nodes[1]?.calls).toContain("eth_call");
    transport.close();
  });

  test("a failing or invalid load fires a persist event and the call succeeds", async () => {
    const loads: (() => unknown)[] = [
      () => {
        throw new Error("storage blocked");
      },
      () => Promise.reject(new Error("kv down")),
      () => "{not json",
      () => null,
    ];
    const seen: string[] = [];
    for (const load of loads) {
      const time = clock();
      const events: RpcEvent[] = [];
      const transport = open(time, [mockEndpoint("a", time, 1)], {
        persist: { load, save: () => undefined },
        onEvent: (event) => events.push(event),
      });
      await expect(call(transport)).resolves.toBe("0x1");
      await sleep(0);
      seen.push(...persistEvents(events).map((event) => `${event.operation}:${event.error.message}`));
      transport.close();
    }
    expect(seen).toEqual(["load:storage blocked", "load:kv down", "load:The stored score snapshot is not valid."]);
  });

  test("save is throttled to saveInterval and runs again on close()", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const time = clock();
    const saves: ScoreSnapshot[] = [];
    const transport = open(time, [mockEndpoint("a", time, 5)], {
      persist: { load: () => undefined, save: (snapshot) => void saves.push(snapshot), saveInterval: 40 },
    });
    for (let index = 0; index < 15; index += 1) {
      await call(transport);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(saves).toHaveLength(3);
    transport.close();
    expect(saves).toHaveLength(4);
    expect(saves.at(-1)?.endpoints.node0?.eth_call?.n).toBe(15);
    await vi.advanceTimersByTimeAsync(100);
    expect(saves).toHaveLength(4);
  });

  test("async saves do not overlap and only the newest queued snapshot follows the in-flight save", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const time = clock();
    const writes: { snapshot: ScoreSnapshot; finish: () => void }[] = [];
    const completed: number[] = [];
    const transport = open(time, [mockEndpoint("a", time, 5)], {
      persist: {
        load: () => undefined,
        save: (snapshot) => {
          const pending = deferred<void>();
          writes.push({
            snapshot,
            finish: () => {
              completed.push(snapshot.endpoints.node0?.eth_call?.n ?? 0);
              pending.resolve();
            },
          });
          return pending.promise;
        },
        saveInterval: 0,
      },
    });
    await call(transport);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    await call(transport);
    await vi.advanceTimersByTimeAsync(0);
    await call(transport);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);

    writes[0]!.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.snapshot.endpoints.node0?.eth_call?.n).toBe(3);
    writes[1]!.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toEqual([1, 3]);

    transport.close();
    expect(writes).toHaveLength(3);
    writes[2]!.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toEqual([1, 3, 3]);
  });

  test("close queues its newest snapshot behind an in-flight timer save without blocking", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const time = clock();
    const writes: { snapshot: ScoreSnapshot; finish: () => void }[] = [];
    const completed: number[] = [];
    const transport = open(time, [mockEndpoint("a", time, 5)], {
      persist: {
        load: () => undefined,
        save: (snapshot) => {
          const pending = deferred<void>();
          writes.push({
            snapshot,
            finish: () => {
              completed.push(snapshot.endpoints.node0?.eth_call?.n ?? 0);
              pending.resolve();
            },
          });
          return pending.promise;
        },
        saveInterval: 0,
      },
    });
    await call(transport);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    await call(transport);
    transport.close();
    transport.close();
    expect(writes).toHaveLength(1);

    writes[0]!.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.snapshot.endpoints.node0?.eth_call?.n).toBe(2);
    writes[1]!.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(100);
    expect(writes).toHaveLength(2);
  });

  test("defaults to one save per 10 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const time = clock();
    let saves = 0;
    const transport = open(time, [mockEndpoint("a", time, 5)], {
      persist: {
        load: () => undefined,
        save: (): void => {
          saves += 1;
        },
      },
    });
    for (let index = 0; index < 5; index += 1) await call(transport);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(saves).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toBe(1);
    transport.close();
    expect(saves).toBe(2);
  });

  test("close() saves nothing before the first request or while the load is pending", async () => {
    const time = clock();
    let saves = 0;
    let loads = 0;
    const save = (): void => {
      saves += 1;
    };
    open(time, [mockEndpoint("a", time, 1)], {
      persist: {
        load: (): undefined => {
          loads += 1;
        },
        save,
      },
    }).close();
    expect([loads, saves]).toEqual([0, 0]);

    const pending = deferred<unknown>();
    const transport = open(time, [mockEndpoint("a", time, 1)], {
      persist: { load: () => pending.promise, save, saveInterval: 0 },
    });
    await call(transport);
    await sleep(10);
    transport.close();
    expect(saves).toBe(0);
    pending.resolve(learned(time));
    await sleep(0);
    expect(book(transport, "node1")).toBeUndefined();
  });

  test("a load that never settles stops holding saves back after one timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const time = clock();
    const events: RpcEvent[] = [];
    let saves = 0;
    const transport = open(time, [mockEndpoint("a", time, 1)], {
      timeout: 40,
      onEvent: (event) => events.push(event),
      persist: {
        load: () => new Promise(() => {}),
        save: (): void => {
          saves += 1;
        },
        saveInterval: 0,
      },
    });
    await call(transport);
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toBe(0);
    await vi.advanceTimersByTimeAsync(41);
    await call(transport);
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toBe(1);
    expect(persistEvents(events).map((event) => event.operation)).toEqual(["load"]);
    transport.close();
  });

  test("a save timer the runtime dropped is armed again by a later request", async () => {
    const time = clock();
    let saves = 0;
    const transport = open(time, [mockEndpoint("a", time, 1)], {
      persist: {
        load: () => undefined,
        save: (): void => {
          saves += 1;
        },
        saveInterval: 40,
      },
    });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number) =>
      ms !== undefined && ms > 0 && ms <= 40
        ? realSetTimeout(() => undefined, 0)
        : realSetTimeout(handler, ms)) as typeof setTimeout;
    try {
      await call(transport);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    await sleep(60);
    expect(saves).toBe(0);
    await call(transport);
    await sleep(10);
    expect(saves).toBe(1);
    transport.close();
  });

  test("save errors fire a persist event and calls keep working", async () => {
    for (const save of [
      (): void => {
        throw new Error("quota exceeded");
      },
      (): Promise<void> => Promise.reject(new Error("kv write failed")),
      (): Promise<void> => Promise.reject(),
    ] satisfies ScorePersistence["save"][]) {
      const time = clock();
      const events: RpcEvent[] = [];
      const transport = open(time, [mockEndpoint("a", time, 1)], {
        persist: { load: () => undefined, save, saveInterval: 0 },
        onEvent: (event) => events.push(event),
      });
      await call(transport);
      await sleep(10);
      await expect(call(transport)).resolves.toBe("0x1");
      transport.close();
      await sleep(0);
      const errors = persistEvents(events);
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(errors.every((event) => event.operation === "save")).toBe(true);
    }
  });

  test("rejects a negative or non-finite maxAge or saveInterval", () => {
    const base = { load: () => undefined, save: () => undefined };
    const time = clock();
    const nodes = [mockEndpoint("a", time, 1)];
    expect(() => open(time, nodes, { persist: { ...base, maxAge: -1 } })).toThrow("persist.maxAge");
    expect(() => open(time, nodes, { persist: { ...base, saveInterval: Number.NaN } })).toThrow("persist.saveInterval");
  });
});

describe("localStoragePersistence", () => {
  function stubStorage(value: unknown): void {
    Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
  }

  function memoryStorage(): Map<string, string> & Pick<Storage, "getItem" | "setItem"> {
    const items = new Map<string, string>();
    return Object.assign(items, {
      getItem: (key: string): string | null => items.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        items.set(key, value);
      },
    });
  }

  test("is a no-op where localStorage does not exist", () => {
    Reflect.deleteProperty(globalThis, "localStorage");
    const persistence = localStoragePersistence("scores");
    expect(persistence.load()).toBeUndefined();
    const time = clock();
    expect(() => persistence.save(learned(time))).not.toThrow();
  });

  test("round-trips a snapshot into a new session", async () => {
    const storage = memoryStorage();
    stubStorage(storage);
    const time = clock();
    const first = open(time, [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)], {
      persist: localStoragePersistence("smart-rpc:scores"),
    });
    await call(first);
    await call(first);
    first.close();
    expect(JSON.parse(storage.get("smart-rpc:scores") ?? "{}").version).toBe(1);

    const nodes = [mockEndpoint("a", time, 400), mockEndpoint("b", time, 20)];
    const second = open(time, nodes, { persist: localStoragePersistence("smart-rpc:scores") });
    await call(second);
    expect(nodes[0]?.calls).toEqual([]);
    second.close();
  });

  test("swallows storage that throws on access, read, or write", () => {
    const time = clock();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("SecurityError");
      },
    });
    const blocked = localStoragePersistence("scores");
    expect(blocked.load()).toBeUndefined();
    expect(() => blocked.save(learned(time))).not.toThrow();

    const fail = (): never => {
      throw new Error("QuotaExceededError");
    };
    stubStorage({ getItem: fail, setItem: fail });
    const full = localStoragePersistence("scores");
    expect(full.load()).toBeUndefined();
    expect(() => full.save(learned(time))).not.toThrow();

    stubStorage({});
    expect(localStoragePersistence("scores").load()).toBeUndefined();
  });
});
