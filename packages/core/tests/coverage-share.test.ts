import { describe, expect, test, vi } from "vitest";

import type { Budgets } from "../src/budget.js";
import { TransportClosedError } from "../src/errors.js";
import type { RpcEvent } from "../src/events.js";
import { createPoolScope } from "../src/share.js";
import type { PoolShareScope, RpcPool } from "../src/types.js";

const SCORES = { version: 1 as const, savedAt: 0, endpoints: {} };
const STATS = { hits: 1, misses: 2, refreshes: 3, entries: 4, bytes: 5, hotKeys: 6 };
const SNAPSHOT: ReturnType<RpcPool["snapshot"]> = [];

/** A pool whose every method is a spy, so a lease's delegation can be asserted exactly. */
function fakePool() {
  const listeners = new Set<(event: RpcEvent) => void>();
  const stops: ReturnType<typeof vi.fn<() => void>>[] = [];
  const pool = {
    chainIds: ["eip155:1"],
    endpoints: [{ id: "a", url: "https://a.example", weight: 1 }],
    request: vi.fn(async (request: { method: string }) => `result:${request.method}`),
    requestBatch: vi.fn(async (requests: readonly { method: string }[]): Promise<PromiseSettledResult<unknown>[]> =>
      requests.map((request) => ({ status: "fulfilled", value: request.method }))),
    probe: vi.fn(async () => undefined),
    close: vi.fn<() => void>(),
    snapshot: vi.fn((_method?: string) => SNAPSHOT),
    scores: vi.fn(() => SCORES),
    restoreScores: vi.fn((_snapshot: unknown) => true),
    cacheStats: vi.fn(() => STATS),
    onEvent: vi.fn((listener: (event: RpcEvent) => void) => {
      listeners.add(listener);
      const stop = vi.fn<() => void>(() => {
        listeners.delete(listener);
      });
      stops.push(stop);
      return stop;
    }),
  } satisfies RpcPool;
  const emit = (event: RpcEvent): void => {
    for (const listener of listeners) listener(event);
  };
  return { pool, emit, stops, listeners };
}

const now = (): number => 0;
const EVENT: RpcEvent = { type: "request", endpoint: "a", method: "eth_call" };

function acquire(
  scope: PoolShareScope,
  pool: RpcPool,
  key = "key",
  overrides: { budgetKey?: string; clock?: (() => number) | undefined; fingerprint?: string } = {},
): RpcPool {
  return scope.acquire(key, overrides.budgetKey ?? "budget", now, overrides.clock, overrides.fingerprint ?? "fp", () => pool);
}

describe("createPoolScope acquire", () => {
  test("builds a pool once per key and hands the scope's one Budgets to every build", () => {
    const scope = createPoolScope();
    const seen: Budgets[] = [];
    const first = fakePool();
    const second = fakePool();
    const build = vi.fn((budgets: Budgets) => {
      seen.push(budgets);
      return first.pool;
    });
    const a = scope.acquire("one", "budget", now, undefined, "fp", build);
    const b = scope.acquire("one", "budget", now, undefined, "fp", build);
    scope.acquire("two", "budget", now, undefined, "fp", (budgets) => {
      seen.push(budgets);
      return second.pool;
    });
    expect(build).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(a).not.toBe(b);
    expect(a.chainIds).toBe(first.pool.chainIds);
    expect(a.endpoints).toBe(first.pool.endpoints);
  });

  test("rejects a blank key or budget key before building anything", () => {
    const scope = createPoolScope();
    const build = vi.fn(() => fakePool().pool);
    expect(() => scope.acquire("  ", "budget", now, undefined, "fp", build)).toThrow("smart-rpc sharing.key must not be empty.");
    expect(() => scope.acquire("key", "", now, undefined, "fp", build)).toThrow(
      "smart-rpc sharing.budgetKey must not be empty.",
    );
    expect(build).not.toHaveBeenCalled();
  });

  test("rejects a second clock, including a custom clock after the default one", () => {
    const custom = createPoolScope();
    const clock = (): number => 1;
    acquire(custom, fakePool().pool, "one", { clock });
    acquire(custom, fakePool().pool, "two", { clock });
    expect(() => acquire(custom, fakePool().pool, "three", { clock: () => 1 })).toThrow("already uses a different now()");
    expect(() => acquire(custom, fakePool().pool, "three")).toThrow("already uses a different now()");

    const standard = createPoolScope();
    acquire(standard, fakePool().pool, "one");
    expect(() => acquire(standard, fakePool().pool, "two", { clock })).toThrow("already uses a different now()");
  });

  test("rejects a repeated key with a different fingerprint and leaves the first lease working", async () => {
    const scope = createPoolScope();
    const { pool } = fakePool();
    const lease = acquire(scope, pool);
    expect(() => acquire(scope, fakePool().pool, "key", { fingerprint: "other" })).toThrow(
      "smart-rpc sharing key is already used by a pool with different endpoints, credentials, or policy.",
    );
    await expect(lease.request({ method: "eth_chainId" })).resolves.toBe("result:eth_chainId");
    // The rejected acquire took no reference: one close releases the pool.
    lease.close();
    expect(pool.close).toHaveBeenCalledTimes(1);
  });

  test("a closed scope refuses to acquire", () => {
    const scope = createPoolScope();
    scope.close();
    const build = vi.fn(() => fakePool().pool);
    expect(() => scope.acquire("key", "budget", now, undefined, "fp", build)).toThrow(TransportClosedError);
    expect(build).not.toHaveBeenCalled();
  });
});

describe("lease lifetime", () => {
  test("the pool closes when its last lease closes, and closing a lease twice releases once", () => {
    const scope = createPoolScope();
    const { pool } = fakePool();
    const first = acquire(scope, pool);
    const second = acquire(scope, pool);
    first.close();
    first.close();
    expect(pool.close).not.toHaveBeenCalled();
    second.close();
    expect(pool.close).toHaveBeenCalledTimes(1);

    // The key is free again: the next acquire builds a new pool.
    const next = fakePool();
    const build = vi.fn(() => next.pool);
    const third = scope.acquire("key", "budget", now, undefined, "other-fp", build);
    expect(build).toHaveBeenCalledTimes(1);
    third.close();
    expect(next.pool.close).toHaveBeenCalledTimes(1);
  });

  test("closing the scope closes every live pool once, and is idempotent", () => {
    const scope = createPoolScope();
    const one = fakePool();
    const two = fakePool();
    const released = fakePool();
    const leaseOne = acquire(scope, one.pool, "one");
    acquire(scope, two.pool, "two");
    acquire(scope, released.pool, "released").close();
    expect(released.pool.close).toHaveBeenCalledTimes(1);

    scope.close();
    scope.close();
    expect(one.pool.close).toHaveBeenCalledTimes(1);
    expect(two.pool.close).toHaveBeenCalledTimes(1);
    expect(released.pool.close).toHaveBeenCalledTimes(1);

    // A lease closed after its scope does not close the pool again.
    leaseOne.close();
    expect(one.pool.close).toHaveBeenCalledTimes(1);
  });
});

describe("lease delegation", () => {
  test("an open lease forwards every call to the shared pool", async () => {
    const scope = createPoolScope();
    const { pool } = fakePool();
    const lease = acquire(scope, pool);
    const request = { method: "eth_call", params: [] };
    await expect(lease.request(request)).resolves.toBe("result:eth_call");
    expect(pool.request).toHaveBeenCalledWith(request);

    const batch = [{ method: "eth_chainId" }, { method: "eth_blockNumber" }];
    await expect(lease.requestBatch(batch)).resolves.toEqual([
      { status: "fulfilled", value: "eth_chainId" },
      { status: "fulfilled", value: "eth_blockNumber" },
    ]);
    expect(pool.requestBatch).toHaveBeenCalledWith(batch);

    await expect(lease.probe()).resolves.toBeUndefined();
    expect(pool.probe).toHaveBeenCalledTimes(1);

    expect(lease.snapshot("eth_call")).toBe(SNAPSHOT);
    expect(pool.snapshot).toHaveBeenCalledWith("eth_call");
    expect(lease.scores()).toBe(SCORES);
    expect(lease.cacheStats()).toBe(STATS);
    expect(lease.restoreScores(SCORES)).toBe(true);
    expect(pool.restoreScores).toHaveBeenCalledWith(SCORES);
  });

  test.each([
    ["its own close", (lease: RpcPool, _scope: PoolShareScope) => lease.close()],
    ["the scope closing", (_lease: RpcPool, scope: PoolShareScope) => scope.close()],
  ])("after %s a lease refuses requests and stops touching the pool", async (_name, shut) => {
    const scope = createPoolScope();
    const { pool } = fakePool();
    const lease = acquire(scope, pool);
    // A peer keeps the pool itself open when only the lease closes.
    const peer = acquire(scope, pool);
    shut(lease, scope);

    await expect(lease.request({ method: "eth_call" })).rejects.toBeInstanceOf(TransportClosedError);
    await expect(lease.requestBatch([{ method: "eth_call" }])).rejects.toBeInstanceOf(TransportClosedError);
    await expect(lease.probe()).resolves.toBeUndefined();
    expect(lease.restoreScores(SCORES)).toBe(false);
    const listener = vi.fn();
    const stop = lease.onEvent(listener);
    expect(stop()).toBeUndefined();

    expect(pool.request).not.toHaveBeenCalled();
    expect(pool.requestBatch).not.toHaveBeenCalled();
    expect(pool.probe).not.toHaveBeenCalled();
    expect(pool.restoreScores).not.toHaveBeenCalled();
    expect(pool.onEvent).not.toHaveBeenCalled();
    peer.close();
  });
});

describe("lease events", () => {
  test("a listener hears pool events until it is stopped, and stopping twice unsubscribes once", () => {
    const scope = createPoolScope();
    const { pool, emit, stops } = fakePool();
    const lease = acquire(scope, pool);
    const listener = vi.fn();
    const stop = lease.onEvent(listener);
    emit(EVENT);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(EVENT);

    stop();
    stop();
    emit(EVENT);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(stops[0]).toHaveBeenCalledTimes(1);

    // Closing the lease later has nothing left to unsubscribe.
    lease.close();
    expect(stops[0]).toHaveBeenCalledTimes(1);
  });

  test("closing a lease unsubscribes its listeners and leaves a peer's alone", () => {
    const scope = createPoolScope();
    const { pool, emit, stops, listeners } = fakePool();
    const lease = acquire(scope, pool);
    const peer = acquire(scope, pool);
    const mine = [vi.fn(), vi.fn()];
    const theirs = vi.fn();
    const stopMine = mine.map((listener) => lease.onEvent(listener));
    peer.onEvent(theirs);

    lease.close();
    emit(EVENT);
    expect(mine[0]).not.toHaveBeenCalled();
    expect(mine[1]).not.toHaveBeenCalled();
    expect(theirs).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);

    // The handles returned earlier are now inert.
    for (const stop of stopMine) stop();
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).toHaveBeenCalledTimes(1);
    expect(stops[2]).not.toHaveBeenCalled();
    peer.close();
    expect(stops[2]).toHaveBeenCalledTimes(1);
  });
});
