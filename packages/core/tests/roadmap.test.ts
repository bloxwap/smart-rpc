import { afterEach, describe, expect, test, vi } from "vitest";
import {
  Budgets, EndpointCapabilityError, OperationBudgetExceededError, createSmartRpc, parseQuantity, shouldFailover, isAlreadyKnownError,
  evmCachePolicy, ReadCache, resolveCache, isIdempotentMethod,
} from "../src/index.js";
import { evmPolicy, pool } from "./helpers.js";

afterEach(() => vi.useRealTimers());

const read = { method: "eth_getBalance", params: ["0xabc", "latest"] };

describe("provider and operation budgets", () => {
  test("URLs share one atomic provider bucket while retaining individual limits", () => {
    let now = 0;
    const budgets = new Budgets(() => now);
    budgets.configure("a", { rps: 10, burst: 2 }, "provider", { rps: 1, burst: 1 });
    budgets.configure("b", { rps: 10, burst: 2 }, "provider", { rps: 1, burst: 1 });
    expect(budgets.take("a")).toBe(true);
    expect(budgets.take("b")).toBe(false);
    expect(budgets.remaining("a")).toBe(0);
    expect(budgets.refillMs(["a", "b"])).toBe(1_000);
    now = 1_000;
    expect(budgets.take("b")).toBe(true);
    expect(budgets.remaining("a")).toBe(0);
  });

  test("racing cannot spend one provider token twice", async () => {
    const calls: string[] = [];
    const client = pool(["a", "b"].map((id) => ({
      id, url: id, providerGroup: "same", providerBudget: { rps: 0.1, burst: 1 },
      call: async () => { calls.push(id); return "0x1"; },
    })), { race: true });
    await expect(client.request(read)).resolves.toBe("0x1");
    expect(calls).toHaveLength(1);
    expect(client.snapshot().map((entry) => entry.tokens)).toEqual([0, 0]);
    client.close();
  });

  test("one request cap includes identity before any user call", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const client = pool([{ url: "a", call: async ({ method }) => { calls.push(method); return "0x1"; } }], {
      verifyIdentity: true, operationBudget: { maxRequests: 1 },
    });
    const result = client.request(read).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(OperationBudgetExceededError);
    expect(calls).toEqual(["eth_chainId"]);
    client.close();
  });

  test("shared batch cap retains successful siblings and identifies exhausted items", async () => {
    const calls: string[] = [];
    const client = pool([{ url: "a", call: async ({ method }) => { calls.push(method); return method; } }], {
      operationBudget: { maxRequests: 2 },
    });
    const results = await client.requestBatch([
      { method: "eth_blockNumber" }, { method: "eth_chainId" }, { method: "eth_getCode" },
    ]);
    expect(results.slice(0, 2)).toEqual([
      { status: "fulfilled", value: "eth_blockNumber" }, { status: "fulfilled", value: "eth_chainId" },
    ]);
    expect(results[2]).toMatchObject({ status: "rejected", reason: expect.any(OperationBudgetExceededError) });
    expect(calls).toHaveLength(2);
    client.close();
  });

  test("batch exposes the original per-item RPC error", async () => {
    const invalid = Object.assign(new Error("invalid params"), { code: -32602 });
    const client = pool([{ url: "a", call: async ({ method }) => {
      if (method === "eth_getCode") throw invalid;
      return "0x2";
    } }]);
    expect(await client.requestBatch([{ method: "eth_blockNumber" }, { method: "eth_getCode" }])).toEqual([
      { status: "fulfilled", value: "0x2" }, { status: "rejected", reason: invalid },
    ]);
    client.close();
  });

  test("total deadline cancels a hanging request without poisoning endpoint health", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const client = pool([{ url: "a", call: (_request, options) => {
      signal = options?.signal;
      return new Promise(() => undefined);
    } }], { operationBudget: { timeout: 25 }, timeout: 10_000, retryCount: 5 });
    const result = client.request(read).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);
    expect(await result).toMatchObject({ name: "TimeoutError", timeoutMs: 25 });
    expect(signal?.aborted).toBe(true);
    expect(client.snapshot()[0]?.methods["*"]?.n).toBe(0);
    expect(client.snapshot()[0]?.ejected).toBe(false);
    client.close();
  });

  test("a race or hedge never exceeds the remaining operation count", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const client = pool(["a", "b", "c"].map((id) => ({ id, url: id, call: async () => {
      calls.push(id);
      return "ok";
    } })), { race: true, hedge: { minDelay: 0 }, operationBudget: { maxRequests: 1 } });
    await expect(client.request(read)).resolves.toBe("ok");
    expect(calls).toHaveLength(1);
    client.close();
  });
});

describe("capability and identity boundaries", () => {
  test("rejects unavailable state before identity or user traffic", async () => {
    const call = vi.fn(async () => "0x1");
    const client = pool([{ url: "latest", call, supportsRequest: ({ params }) =>
      !Array.isArray(params) || params[1] === "latest",
    }], { verifyIdentity: true });
    await expect(client.request({ ...read, params: ["0xabc", "finalized"] })).rejects.toBeInstanceOf(EndpointCapabilityError);
    expect(call).not.toHaveBeenCalled();
    client.close();
  });

  test("a write-only endpoint cannot bypass identity verification", async () => {
    vi.useFakeTimers();
    const call = vi.fn(async () => "0x1");
    const client = pool([{ url: "write-only", call, supports: (method) => method !== "eth_chainId" }], { verifyIdentity: true });
    const result = client.request({ method: "eth_sendRawTransaction", params: ["0x1234"] }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(Error);
    expect(call).not.toHaveBeenCalled();
    client.close();
  });

  test("only a capable archive endpoint receives a historical request", async () => {
    const calls: string[] = [];
    const client = pool([
      { url: "latest", supportsRequest: ({ params }) => !Array.isArray(params) || params[1] === "latest", call: async () => { calls.push("latest"); return "a"; } },
      { url: "archive", call: async () => { calls.push("archive"); return "b"; } },
    ], { race: true });
    await expect(client.request({ ...read, params: ["0xabc", "0x123"] })).resolves.toBe("b");
    expect(calls).toEqual(["archive"]);
    client.close();
  });

  test("latest-only endpoints are not silently pinned to numeric state", async () => {
    const seen: unknown[] = [];
    const client = pool([{ url: "latest", pinning: false, call: async ({ method, params }) => {
      if (method === "eth_blockNumber") return "0x10";
      seen.push(params); return "0x1";
    } }], {}, evmPolicy(1, true));
    await client.probe();
    await client.request(read);
    expect(seen).toEqual([read.params]);
    client.close();
  });

  test("learns method-not-found once, fails over, and preserves health", async () => {
    const calls: string[] = [];
    const client = pool([
      { id: "missing", url: "missing", call: async () => { calls.push("missing"); throw Object.assign(new Error("not found"), { code: -32601 }); } },
      { id: "capable", url: "capable", call: async () => { calls.push("capable"); return "ok"; } },
    ], { routing: "best" });
    await expect(client.request(read)).resolves.toBe("ok");
    await expect(client.request(read)).resolves.toBe("ok");
    expect(calls).toEqual(["missing", "capable", "capable"]);
    expect(client.snapshot()[0]?.methods["*"]?.n).toBe(0);
    expect(client.snapshot()[0]?.ejected).toBe(false);
    client.close();
  });

  test("pre-aborted callers send no identity request and cannot receive cached results", async () => {
    const call = vi.fn(async () => "0x1");
    const client = pool([{ url: "a", call }], { verifyIdentity: true, cache: true });
    const controller = new AbortController(); controller.abort();
    await expect(client.request({ ...read, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(call).not.toHaveBeenCalled();
    client.close();
  });
});

describe("stateful and concurrent calls", () => {
  test("unknown writes, signing, subscriptions and server-local methods are never inferred safe", () => {
    for (const method of ["eth_sendRawTransactionConditional", "eth_unsubscribe", "eth_uninstallFilter", "eth_getFilterLogs", "personal_unlockAccount", "debug_setHead", "custom_write"]) {
      expect(isIdempotentMethod(method), method).toBe(false);
    }
    expect(isIdempotentMethod("eth_getBalance")).toBe(true);
  });

  test("colliding server filter ids are virtualized and always routed to their owner", async () => {
    const seen: { id: string; method: string; params: unknown }[] = [];
    const policy = { ...evmPolicy(), statefulMethods: { create: ["eth_newFilter"], use: ["eth_getFilterChanges", "eth_getFilterLogs"], release: ["eth_uninstallFilter"] } };
    const client = pool(["a", "b"].map((id) => ({ id, url: id,
      supportsRequest: ({ method, params }: { method: string; params?: unknown }) => method !== "eth_newFilter" || (Array.isArray(params) && params[0] === id),
      call: async ({ method, params }: { method: string; params?: unknown }) => {
        seen.push({ id, method, params });
        return method === "eth_newFilter" ? "0xdead" : method === "eth_uninstallFilter" ? true : [id];
      },
    })), { race: true, coalesce: true }, policy);
    const a = await client.request({ method: "eth_newFilter", params: ["a"] });
    const b = await client.request({ method: "eth_newFilter", params: ["b"] });
    expect(a).not.toEqual(b);
    await expect(client.request({ method: "eth_getFilterChanges", params: [b] })).resolves.toEqual(["b"]);
    await expect(client.request({ method: "eth_getFilterLogs", params: [a] })).resolves.toEqual(["a"]);
    expect(seen.slice(2)).toEqual([
      { id: "b", method: "eth_getFilterChanges", params: ["0xdead"] },
      { id: "a", method: "eth_getFilterLogs", params: ["0xdead"] },
    ]);
    await client.request({ method: "eth_uninstallFilter", params: [a] });
    await expect(client.request({ method: "eth_getFilterChanges", params: [a] })).rejects.toThrow("Unknown or expired");
    client.close();
  });

  test("race winner aborts the losing read without failure or latency samples", async () => {
    let loserSignal: AbortSignal | undefined;
    const client = pool([
      { id: "winner", url: "winner", call: async () => "ok" },
      { id: "loser", url: "loser", call: (_request, options) => { loserSignal = options?.signal; return new Promise(() => undefined); } },
    ], { race: true });
    await expect(client.request(read)).resolves.toBe("ok");
    expect(loserSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(client.snapshot().find(({ id }) => id === "loser")).toMatchObject({ inflight: 0, ejected: false, methods: { "*": { n: 0 } } });
    client.close();
  });

  test("cancelling one coalesced caller leaves another subscriber running", async () => {
    let signal: AbortSignal | undefined;
    let release!: (result: string) => void;
    const call = vi.fn((_request, options) => { signal = options?.signal; return new Promise<string>((resolve) => { release = resolve; }); });
    const client = pool([{ url: "a", call }], { coalesce: true });
    const controller = new AbortController();
    const first = client.request({ ...read, signal: controller.signal }).catch((error: unknown) => error);
    const second = client.request(read);
    await Promise.resolve();
    controller.abort();
    expect(await first).toMatchObject({ name: "AbortError" });
    expect(signal?.aborted).toBe(false);
    release("ok");
    await expect(second).resolves.toBe("ok");
    expect(call).toHaveBeenCalledTimes(1);
    client.close();
  });

  test("close releases every endpoint resource once", () => {
    const close = vi.fn();
    const client = pool([{ url: "a", call: async () => "0x1", close }]);
    client.close(); client.close();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("reorg and finality cache semantics", () => {
  test("pending and missing transactions are never cached forever", async () => {
    let count = 0;
    const client = pool([{ url: "a", call: async ({ method }) => {
      count += 1; return method === "eth_getTransactionReceipt" ? null : `0x${count}`;
    } }], { cache: true });
    await client.request({ ...read, params: ["0xabc", "pending"] });
    await client.request({ ...read, params: ["0xabc", "pending"] });
    await client.request({ method: "eth_getTransactionReceipt", params: ["0xhash"] });
    await client.request({ method: "eth_getTransactionReceipt", params: ["0xhash"] });
    expect(count).toBe(4);
    client.close();
  });

  test("safe/finalized/latest and extensions remain separate cache keys", async () => {
    const seen: unknown[] = [];
    const client = pool([{ url: "a", call: async ({ params }) => { seen.push(params); return params; } }], { cache: true });
    for (const tag of ["latest", "safe", "finalized"]) await client.request({ method: "eth_call", params: [{ feeCurrency: "0xa" }, tag] });
    await client.request({ method: "eth_call", params: [{ feeCurrency: "0xb" }, "safe"] });
    await client.request({ method: "eth_call", params: [{ feeCurrency: "0xa" }, "safe"] });
    expect(seen).toHaveLength(4);
    expect(seen).toContainEqual([{ feeCurrency: "0xa" }, "finalized"]);
    client.close();
  });

  test("a same-height replacement block invalidates cached inclusion and state", async () => {
    let hash = "0xold";
    let reads = 0;
    const client = pool([{ url: "a", call: async ({ method }) => {
      if (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") return { number: "0xa", hash };
      if (method === "eth_blockNumber") return "0xa";
      reads += 1; return hash;
    } }], { cache: true, coalesce: false });
    await client.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
    await client.request(read);
    await client.request(read);
    expect(reads).toBe(1);
    hash = "0xnew";
    // A hash selector cannot be answered by the latest-to-number alias.
    await client.request({ method: "eth_getBlockByHash", params: ["0xhash", false] });
    await expect(client.request(read)).resolves.toBe("0xnew");
    expect(reads).toBe(2);
    client.close();
  });

  test("an in-flight pre-reorg fill cannot repopulate the invalidated cache", () => {
    const cache = new ReadCache(resolveCache(true), evmCachePolicy());
    const miss = cache.lookup(read.method, read.params, true, { now: 0, head: undefined });
    if (!miss || miss.hit) throw new Error("expected miss");
    cache.invalidate();
    miss.fill("old-fork", 10);
    expect(cache.stats().entries).toBe(0);
  });
});


describe("shared transport release regressions", () => {
  test("router preserves mixed-chain order and errors while delegating each pool batch", async () => {
    const first = pool([{ url: "one", call: async () => "one" }]);
    const second = pool([{ url: "two", call: async () => "two" }], {}, evmPolicy(2));
    const firstBatch = vi.spyOn(first, "requestBatch");
    const rpc = createSmartRpc({ transports: [first, second] });
    const results = await rpc.requestBatch([
      { chainId: "eip155:2", method: "eth_chainId" },
      { chainId: "eip155:1", method: "eth_chainId" },
      { chainId: "eip155:999", method: "eth_chainId" },
      { chainId: "eip155:1", method: "eth_blockNumber" },
    ]);
    expect(results).toEqual([
      { status: "fulfilled", value: "two" }, { status: "fulfilled", value: "one" },
      { status: "rejected", reason: expect.objectContaining({ name: "UnknownChainError" }) },
      { status: "fulfilled", value: "one" },
    ]);
    expect(firstBatch).toHaveBeenCalledOnce();
    expect(firstBatch.mock.calls[0]?.[0]).toHaveLength(2);
    rpc.close();
  });

  test("successful probes cannot heal user-call failures or add latency samples", async () => {
    const client = pool([{ url: "a", call: async ({ method }) => {
      if (method === "eth_blockNumber") return "0x10";
      throw new Error("unavailable");
    } }], { retryCount: 0 });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(client.request(read)).rejects.toThrow("unavailable");
      await client.probe();
      expect(client.snapshot()[0]?.methods["*"]?.n).toBe(attempt);
      expect(client.snapshot()[0]?.ejected).toBe(attempt === 3);
    }
    client.close();
  });

  test("identity and head quantities cannot be partially parsed or rounded", () => {
    expect(parseQuantity("0x1garbage")).toBeNull();
    expect(parseQuantity("0x20000000000001")).toBeNull();
    expect(parseQuantity("0x")).toBeNull();
    expect(parseQuantity("0x38")).toBe(56);
  });

  test("transaction verdicts remain terminal regardless of chain-specific code", () => {
    for (const message of ["replacement transaction underpriced", "duplicate transaction hash", "nonce too low", "insufficient funds"]) {
      expect(shouldFailover(Object.assign(new Error(message), { code: 10055 }))).toBe(false);
    }
    expect(isAlreadyKnownError(new Error("duplicate transaction hash"))).toBe(true);
  });
});


describe("review regressions", () => {
  test("speculative identity verification cannot starve the foreground provider token", async () => {
    const seen: string[] = [];
    const client = pool(["a", "b"].map((id) => ({ id, url: id,
      providerGroup: "shared", providerBudget: { rps: 0.01, burst: 2 },
      call: async ({ method }: { method: string }) => { seen.push(`${id}:${method}`); return "0x1"; },
    })), { verifyIdentity: true, race: true, retryCount: 0, routing: "best" });
    await expect(client.request(read)).resolves.toBe("0x1");
    expect(seen).toEqual(["a:eth_chainId", "a:eth_getBalance"]);
    client.close();
  });

  test("cancelling one caller abandons unrelated keys even when another caller keeps one key alive", async () => {
    const signals = new Map<string, AbortSignal | undefined>();
    const releases = new Map<string, (result: string) => void>();
    const client = pool([{ url: "a", call: ({ params }, options) => {
      const key = (params as string[])[0] as string;
      signals.set(key, options?.signal);
      return new Promise<string>((resolve) => releases.set(key, resolve));
    } }], { coalesce: true });
    const caller = new AbortController();
    const firstA = client.request({ method: read.method, params: ["A"], signal: caller.signal }).catch((error: unknown) => error);
    const firstB = client.request({ method: read.method, params: ["B"], signal: caller.signal }).catch((error: unknown) => error);
    const otherA = client.request({ method: read.method, params: ["A"] });
    await Promise.resolve();
    caller.abort();
    await Promise.all([firstA, firstB]);
    expect(signals.get("A")?.aborted).toBe(false);
    expect(signals.get("B")?.aborted).toBe(true);
    releases.get("A")?.("kept alive");
    await expect(otherA).resolves.toBe("kept alive");
    client.close();
  });
});
