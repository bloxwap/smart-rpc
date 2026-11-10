import { afterEach, describe, expect, test, vi } from "vitest";

import { TransportClosedError } from "../src/errors.js";
import { createPoolScope } from "../src/share.js";
import type { PoolShareScope, PoolSharingOptions } from "../src/types.js";
import { evmPolicy, pool } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

function sharing(scope: PoolShareScope, key: string, budgetKey = key): PoolSharingOptions {
  return { scope, key, budgetKey };
}

describe("factory-scoped pools", () => {
  test("equivalent leases share coalescing, cache, and learned endpoint state", async () => {
    const scope = createPoolScope();
    const now = (): number => 0;
    let calls = 0;
    let release: (value: string) => void = () => undefined;
    const response = new Promise<string>((resolve) => { release = resolve; });
    const acquire = () => {
      return pool([{
        id: "endpoint",
        url: "https://endpoint.example",
        call: async () => {
          calls += 1;
          return response;
        },
      }], {
        coalesce: true,
        cache: true,
        now,
        sharing: sharing(scope, "chain-1"),
      });
    };
    const first = acquire();
    const second = acquire();
    const request = { method: "eth_getBalance", params: ["0x1", "latest"] };
    const pending = [first.request(request), second.request(request)];
    release("0x2");
    await expect(Promise.all(pending)).resolves.toEqual(["0x2", "0x2"]);
    await expect(second.request(request)).resolves.toBe("0x2");
    expect(calls).toBe(1);
    expect(first.cacheStats().hits).toBe(1);
    expect(second.scores().endpoints.endpoint?.["*"]?.n).toBe(1);
    expect(second.restoreScores(second.scores())).toBe(false);
    first.close();
    second.close();
    scope.close();
  });

  test("closed leases cannot restore scores into a pool used by peers", () => {
    const scope = createPoolScope();
    const now = (): number => 0;
    const acquire = () => pool([{
      id: "endpoint",
      url: "https://endpoint.example",
      call: async () => "0x1",
    }], { now, sharing: sharing(scope, "equivalent") });
    const first = acquire();
    const second = acquire();
    const snapshot = (method: string) => ({
      version: 1,
      savedAt: 0,
      endpoints: { endpoint: { [method]: { ewma: 25, tail: 25, error: 0, n: 1 } } },
    });

    expect(second.restoreScores(snapshot("*"))).toBe(true);
    expect(second.scores().endpoints.endpoint?.["*"]).toMatchObject({ ewma: 25, n: 1 });

    first.close();
    expect(first.restoreScores(snapshot("eth_call"))).toBe(false);
    expect(second.scores().endpoints.endpoint?.eth_call).toBeUndefined();

    scope.close();
    expect(second.restoreScores(snapshot("eth_blockNumber"))).toBe(false);
    expect(second.scores().endpoints.endpoint?.eth_blockNumber).toBeUndefined();
    second.close();
  });

  test("different keys and different scopes never share pool state", async () => {
    const firstScope = createPoolScope();
    const secondScope = createPoolScope();
    const now = (): number => 0;
    const calls: string[] = [];
    const acquire = (scope: PoolShareScope, key: string, id: string, chainId: number) => pool([{
      id,
      url: `https://${id}.example`,
      call: async () => {
        calls.push(id);
        return "0x1";
      },
    }], {
      policy: evmPolicy(chainId),
      cache: true,
      now,
      sharing: sharing(scope, key),
    });
    const first = acquire(firstScope, "chain-1", "credential-a", 1);
    const isolatedKey = acquire(firstScope, "chain-56", "credential-b", 56);
    const isolatedScope = acquire(secondScope, "chain-1", "credential-c", 1);
    const request = { method: "eth_getBalance", params: ["0x1", "latest"] };
    await first.request(request);
    await first.request(request);
    await isolatedKey.request(request);
    await isolatedScope.request(request);
    expect(calls).toEqual(["credential-a", "credential-b", "credential-c"]);
    expect(isolatedKey.cacheStats().hits).toBe(0);
    expect(isolatedScope.cacheStats().hits).toBe(0);
    firstScope.close();
    secondScope.close();
  });

  test("timeout variants spend the same endpoint bucket", async () => {
    const scope = createPoolScope();
    const now = (): number => 0;
    const acquire = (key: string) => pool([{
      id: "limited",
      url: "https://limited.example",
      rps: 1,
      burst: 2,
      call: async () => "0x1",
    }], {
      now,
      sharing: sharing(scope, key, "chain-1-endpoint"),
    });
    const first = acquire("timeout-1000");
    const second = acquire("timeout-2000");
    expect(second.snapshot()[0]?.tokens).toBe(2);
    await first.request({ method: "eth_chainId" });
    expect(second.snapshot()[0]?.tokens).toBe(1);
    await second.request({ method: "eth_chainId" });
    expect(first.snapshot()[0]?.tokens).toBe(0);
    expect(second.snapshot()[0]?.tokens).toBe(0);
    scope.close();
  });

  test("provider-group buckets coordinate different endpoints across pools", async () => {
    const scope = createPoolScope();
    const now = (): number => 0;
    const acquire = (key: string, id: string) => pool([{
      id,
      url: `https://${id}.example`,
      providerGroup: "one-provider-account",
      providerBudget: { rps: 1, burst: 2 },
      call: async () => "0x1",
    }], {
      now,
      sharing: sharing(scope, key, "chain-1-provider"),
    });
    const first = acquire("first", "a");
    const second = acquire("second", "b");
    await first.request({ method: "eth_chainId" });
    expect(second.snapshot()[0]?.tokens).toBe(1);
    await second.request({ method: "eth_chainId" });
    expect(first.snapshot()[0]?.tokens).toBe(0);
    expect(second.snapshot()[0]?.tokens).toBe(0);
    scope.close();
  });

  test("one probe timer survives an individual close and stops after the final close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const scope = createPoolScope();
    const now = (): number => Date.now();
    let probes = 0;
    let acquisitions = 0;
    const closeEndpoints = [vi.fn(), vi.fn(), vi.fn()];
    const acquire = () => {
      const close = closeEndpoints[acquisitions++]!;
      return pool([{
        id: "endpoint",
        url: "https://endpoint.example",
        close,
        call: async (request) => {
          if (request.method === "eth_blockNumber") probes += 1;
          return "0x10";
        },
      }], {
        now,
        headLag: { probeInterval: 4_000, probeIdleTimeout: false },
        sharing: sharing(scope, "equivalent"),
      });
    };
    const first = acquire();
    const second = acquire();
    expect(closeEndpoints[1]).toHaveBeenCalledTimes(1);
    await first.request({ method: "eth_call", params: [] });
    await second.request({ method: "eth_call", params: [] });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(probes).toBe(1);
    first.close();
    expect(closeEndpoints[0]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(probes).toBe(2);
    second.close();
    expect(closeEndpoints[0]).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(probes).toBe(2);

    const fresh = acquire();
    await fresh.request({ method: "eth_call", params: [] });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(probes).toBe(3);
    fresh.close();
    expect(closeEndpoints[2]).toHaveBeenCalledTimes(1);
    scope.close();
  });

  test("a closed lease cannot break its peers and final close permits a fresh pool", async () => {
    const scope = createPoolScope();
    const acquire = () => pool([{
      id: "endpoint",
      url: "https://endpoint.example",
      call: async () => "0x1",
    }], { sharing: sharing(scope, "equivalent") });
    const first = acquire();
    const second = acquire();
    first.close();
    first.close();
    await expect(first.request({ method: "eth_chainId" })).rejects.toBeInstanceOf(TransportClosedError);
    await expect(second.request({ method: "eth_chainId" })).resolves.toBe("0x1");
    second.close();

    const fresh = acquire();
    await expect(fresh.request({ method: "eth_chainId" })).resolves.toBe("0x1");
    scope.close();
    await expect(fresh.request({ method: "eth_chainId" })).rejects.toBeInstanceOf(TransportClosedError);
    expect(() => acquire()).toThrow(TransportClosedError);
  });
});
