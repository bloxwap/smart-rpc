import { describe, expect, test } from "vitest";

import {
  EndpointCapabilityError,
  evmCachePolicy,
  OperationBudgetExceededError,
  type ChainPolicy,
  type PoolEndpointConfig,
  type PoolOptions,
  type RpcPool,
} from "../src/index.js";
import { evmPolicy, pool } from "./helpers.js";

const ADDRESS = "0xAbCd000000000000000000000000000000000000";
const HASH = `0x${"ab".repeat(32)}`;

interface Call {
  method: string;
  params: unknown;
  signal: AbortSignal | undefined;
}

function hex(block: number): string {
  return `0x${block.toString(16)}`;
}

function log(block: number, logIndex: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: ADDRESS.toLowerCase(),
    blockHash: HASH,
    blockNumber: hex(block),
    logIndex: hex(logIndex),
    topics: [],
    data: "0x",
    ...extra,
  };
}

function filter(from: number, to: number | "latest" = "latest"): Record<string, unknown> {
  return {
    address: ADDRESS,
    fromBlock: hex(from),
    toBlock: to === "latest" ? to : hex(to),
  };
}

function numericBlock(value: unknown): number | undefined {
  return typeof value === "string" && /^0x[\da-f]+$/i.test(value) ? Number.parseInt(value, 16) : undefined;
}

function logsNode(
  id: string,
  head: { value: number },
  table: readonly Record<string, unknown>[],
  read?: (call: Call) => unknown | Promise<unknown>,
): { config: PoolEndpointConfig; calls: Call[]; count: (method: string) => number } {
  const calls: Call[] = [];
  return {
    calls,
    config: {
      id,
      url: id,
      call: async (request, options) => {
        const call = { method: request.method, params: request.params, signal: options?.signal };
        calls.push(call);
        if (request.method === "eth_chainId") return "0x1";
        if (request.method === "eth_blockNumber") return hex(head.value);
        if (request.method === "eth_getLogs") {
          const params = Array.isArray(request.params) ? request.params : [];
          const selected = params[0] as Record<string, unknown>;
          if (selected.blockHash !== undefined) return table.filter((item) => item.blockHash === selected.blockHash);
          const from = numericBlock(selected.fromBlock) ?? head.value;
          const to = numericBlock(selected.toBlock) ?? head.value;
          return table.filter((item) => {
            const block = numericBlock(item.blockNumber) ?? -1;
            return block >= from && block <= to;
          });
        }
        return read?.(call) ?? "0x1";
      },
    },
    count: (method) => calls.filter((call) => call.method === method).length,
  };
}

function opened(
  nodes: readonly PoolEndpointConfig[],
  overrides: Partial<PoolOptions> = {},
  policy: ChainPolicy = evmPolicy(1, true),
): RpcPool {
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

const TABLE = [
  log(100, 1),
  log(95, 0, { nested: { value: "original" } }),
  log(100, 0),
  log(103, 2),
  log(101, 0),
  log(103, 0),
];

describe("pool rolling log cache", () => {
  test("seeds, fetches only a tail, serves covered subsets in order, and copies results", async () => {
    const head = { value: 100 };
    const node = logsNode("a", head, TABLE);
    const client = opened([node.config], { isActive: () => false, now: () => 0 });
    await client.probe();
    const query = [filter(90)];
    const first = await client.request({ method: "eth_getLogs", params: query });
    expect(first).toEqual([TABLE[1], TABLE[2], TABLE[0]]);
    expect(node.calls.filter((call) => call.method === "eth_getLogs")[0]?.params).toEqual([
      { ...filter(90, 100), address: ADDRESS.toLowerCase() },
    ]);
    (first as { nested?: { value: string } }[])[0]!.nested!.value = "changed";

    head.value = 103;
    await client.probe();
    await expect(client.request({ method: "eth_getLogs", params: query })).resolves.toEqual([
      TABLE[1], TABLE[2], TABLE[0], TABLE[4], TABLE[5], TABLE[3],
    ]);
    expect(node.calls.filter((call) => call.method === "eth_getLogs").at(-1)?.params).toEqual([
      { ...filter(101, 103), address: ADDRESS.toLowerCase() },
    ]);

    await expect(client.request({ method: "eth_getLogs", params: [filter(96, 100)] })).resolves.toEqual([
      TABLE[2], TABLE[0],
    ]);
    expect(node.count("eth_getLogs")).toBe(2);
    expect(client.cacheStats()).toMatchObject({ hits: 1, misses: 2, entries: 1 });
    expect(client.cacheStats().bytes).toBeGreaterThan(0);
    client.close();
  });

  test("serves a one-block-stale latest hit but maxStaleBlocks zero scans forward immediately", async () => {
    const head = { value: 100 };
    const staleNode = logsNode("stale", head, TABLE);
    const stale = opened([staleNode.config], { isActive: () => false, now: () => 0 });
    await stale.probe();
    await stale.request({ method: "eth_getLogs", params: [filter(90)] });
    head.value = 101;
    await stale.probe();
    await stale.request({ method: "eth_getLogs", params: [filter(90)] });
    expect(staleNode.count("eth_getLogs")).toBe(1);
    stale.close();

    head.value = 100;
    const exactNode = logsNode("exact", head, TABLE);
    const exact = opened([exactNode.config], {
      cache: { maxStaleBlocks: 0, refreshInterval: false },
      isActive: () => false,
      now: () => 0,
    });
    await exact.probe();
    await exact.request({ method: "eth_getLogs", params: [filter(90)] });
    head.value = 101;
    await exact.probe();
    await exact.request({ method: "eth_getLogs", params: [filter(90)] });
    expect(exactNode.count("eth_getLogs")).toBe(2);
    expect(exactNode.calls.filter((call) => call.method === "eth_getLogs").at(-1)?.params).toEqual([
      { ...filter(101, 101), address: ADDRESS.toLowerCase() },
    ]);
    exact.close();
  });

  test("refreshes a hot latest filter with only its missing tail", async () => {
    const head = { value: 100 };
    const node = logsNode("a", head, TABLE);
    const client = opened([node.config]);
    await client.probe();
    await client.request({ method: "eth_getLogs", params: [filter(90)] });
    head.value = 103;
    await client.probe();
    await until(() => node.count("eth_getLogs") === 2);
    expect(node.calls.filter((call) => call.method === "eth_getLogs").at(-1)?.params).toEqual([
      { ...filter(101, 103), address: ADDRESS.toLowerCase() },
    ]);
    expect(client.cacheStats()).toMatchObject({ refreshes: 1, entries: 1, hotKeys: 1 });
    await client.request({ method: "eth_getLogs", params: [filter(90)] });
    expect(node.count("eth_getLogs")).toBe(2);
    client.close();
  });

  test("keeps blockHash logs fresh by default and immutable only under HyperEVM policy", async () => {
    const head = { value: 100 };
    const params = [{ address: ADDRESS, blockHash: HASH }];
    const freshNode = logsNode("fresh", head, TABLE);
    const fresh = opened([freshNode.config], { isActive: () => false, now: () => 0 });
    await fresh.probe();
    await fresh.request({ method: "eth_getLogs", params });
    head.value = 200;
    await fresh.probe();
    await fresh.request({ method: "eth_getLogs", params });
    expect(freshNode.count("eth_getLogs")).toBe(2);
    fresh.close();

    head.value = 100;
    const hyperNode = logsNode("hyper", head, TABLE);
    const policy = evmPolicy(1, true);
    policy.cachePolicy = evmCachePolicy({ immutable: true });
    const hyper = opened([hyperNode.config], { isActive: () => false, now: () => 0 }, policy);
    await hyper.probe();
    await hyper.request({ method: "eth_getLogs", params });
    head.value = 200;
    await hyper.probe();
    await hyper.request({ method: "eth_getLogs", params });
    expect(hyperNode.count("eth_getLogs")).toBe(1);
    hyper.close();
  });

  test("invalidates an in-flight tail on a same-height hash conflict", async () => {
    const head = { value: 100 };
    let hash = "0xold";
    const gate = deferred<Record<string, unknown>[]>();
    let delayTail = false;
    const node = logsNode("a", head, TABLE, (call) => {
      if (call.method === "eth_getBlockByNumber" || call.method === "eth_getBlockByHash") {
        return { number: "0x64", hash };
      }
      return "0x1";
    });
    const baseCall = node.config.call;
    node.config.call = (request, options) => {
      if (request.method === "eth_getLogs" && delayTail) {
        delayTail = false;
        node.calls.push({ method: request.method, params: request.params, signal: options?.signal });
        return gate.promise;
      }
      return baseCall(request, options);
    };
    const client = opened([node.config], {
      cache: { maxStaleBlocks: 0, refreshInterval: false },
      isActive: () => false,
      now: () => 0,
    });
    await client.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
    await client.request({ method: "eth_getLogs", params: [filter(90)] });
    head.value = 101;
    await client.probe();
    delayTail = true;
    const pending = client.request({ method: "eth_getLogs", params: [filter(90)] });
    await until(() => node.count("eth_getLogs") === 2);
    hash = "0xnew";
    await client.request({ method: "eth_getBlockByHash", params: [HASH, false] });
    gate.resolve([log(101, 0)]);
    await expect(pending).resolves.toEqual([TABLE[0], TABLE[1], TABLE[2], TABLE[4]]);

    await client.request({ method: "eth_getLogs", params: [filter(95, 100)] });
    expect(node.count("eth_getLogs")).toBe(4);
    client.close();
  });

  test("falls back to unchanged latest queries on a latest-only provider without indexing them", async () => {
    const head = { value: 100 };
    const node = logsNode("latest-only", head, TABLE);
    node.config.pinning = false;
    node.config.supportsRequest = ({ method, params }) => {
      if (method !== "eth_getLogs" || !Array.isArray(params)) return true;
      const selected = params[0] as Record<string, unknown>;
      return numericBlock(selected.toBlock) === undefined;
    };
    const client = opened([node.config], { isActive: () => false, now: () => 0 });
    await client.probe();
    await expect(client.request({ method: "eth_getLogs", params: [filter(90)] })).resolves.toEqual([
      TABLE[0], TABLE[1], TABLE[2],
    ]);
    await client.request({ method: "eth_getLogs", params: [filter(90)] });
    expect(node.count("eth_getLogs")).toBe(2);
    expect(client.cacheStats().entries).toBe(0);
    for (const call of node.calls.filter((call) => call.method === "eth_getLogs")) {
      expect((call.params as Record<string, unknown>[])[0]?.toBlock).toBe("latest");
    }
    client.close();
  });

  test("respects generated range limits and uses the original latest request as the safe fallback", async () => {
    const head = { value: 100 };
    const node = logsNode("limited", head, TABLE);
    node.config.supportsRequest = ({ method, params }) => {
      if (method !== "eth_getLogs" || !Array.isArray(params)) return true;
      const selected = params[0] as Record<string, unknown>;
      const from = numericBlock(selected.fromBlock);
      const to = numericBlock(selected.toBlock);
      return from === undefined || to === undefined || to - from + 1 <= 2;
    };
    const client = opened([node.config], { isActive: () => false, now: () => 0 });
    await client.probe();
    await client.request({ method: "eth_getLogs", params: [filter(90)] });
    expect(node.calls.filter((call) => call.method === "eth_getLogs")).toHaveLength(1);
    expect(node.calls.filter((call) => call.method === "eth_getLogs")[0]?.params).toEqual([filter(90)]);
    expect(client.cacheStats().entries).toBe(0);
    await expect(client.request({ method: "eth_getLogs", params: [filter(90, 100)] })).rejects.toBeInstanceOf(
      EndpointCapabilityError,
    );
    expect(node.count("eth_getLogs")).toBe(1);
    client.close();
  });

  test("cancels a foreground fetch without filling or starting its fallback", async () => {
    const head = { value: 100 };
    const gate = deferred<Record<string, unknown>[]>();
    const node = logsNode("a", head, TABLE, () => gate.promise);
    const baseCall = node.config.call;
    node.config.call = (request, options) => request.method === "eth_getLogs"
      ? (() => {
          node.calls.push({ method: request.method, params: request.params, signal: options?.signal });
          return gate.promise;
        })()
      : baseCall(request, options);
    const client = opened([node.config]);
    await client.probe();
    const controller = new AbortController();
    const pending = client.request({ method: "eth_getLogs", params: [filter(90)], signal: controller.signal });
    await until(() => node.count("eth_getLogs") === 1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(node.calls[0]?.signal?.aborted).toBe(true);
    expect(node.count("eth_getLogs")).toBe(1);
    expect(client.cacheStats().entries).toBe(0);
    client.close();
  });

  test("suppresses background log reads without endpoint budget", async () => {
    let now = 0;
    const head = { value: 100 };
    const node = logsNode("budgeted", head, TABLE);
    node.config.rps = 0.5;
    node.config.burst = 2;
    const client = opened([node.config], { now: () => now }, evmPolicy(1, false));
    await client.probe();
    await client.request({ method: "eth_getLogs", params: [filter(90)] });
    expect(client.snapshot()[0]?.tokens).toBe(0);
    now += 2_001;
    head.value = 101;
    await client.request({ method: "eth_blockNumber" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(node.count("eth_getLogs")).toBe(1);
    expect(client.cacheStats()).toMatchObject({ refreshes: 0, entries: 1 });
    client.close();
  });

  test("retains one batch operation ceiling across log fetches", async () => {
    const head = { value: 100 };
    const node = logsNode("a", head, TABLE);
    const client = opened([node.config], { operationBudget: { maxRequests: 1 } });
    await client.probe();
    const results = await client.requestBatch([
      { method: "eth_getLogs", params: [filter(90)] },
      { method: "eth_getLogs", params: [filter(80)] },
    ]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(OperationBudgetExceededError) });
    expect(node.count("eth_getLogs")).toBe(1);
    client.close();
  });

  test("honors logsWindow and shares entry/byte ceilings with ordinary values", async () => {
    const head = { value: 100 };
    const node = logsNode("a", head, TABLE);
    const client = opened([node.config], {
      cache: { logsWindow: 5, maxEntries: 1, refreshInterval: false },
      isActive: () => false,
      now: () => 0,
    });
    await client.probe();
    await expect(client.request({ method: "eth_getLogs", params: [filter(90)] })).resolves.toEqual([
      TABLE[1], TABLE[2], TABLE[0],
    ]);
    expect(node.count("eth_getLogs")).toBe(1);
    await client.request({ method: "eth_getLogs", params: [filter(96, 100)] });
    expect(node.count("eth_getLogs")).toBe(1);
    await client.request({ method: "eth_chainId", params: [] });
    expect(client.cacheStats().entries).toBe(1);
    expect(client.cacheStats().bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    await client.request({ method: "eth_getLogs", params: [filter(96, 100)] });
    expect(node.count("eth_getLogs")).toBe(2);
    client.close();
  });

  test.each([{ maxEntries: 0 }, { maxBytes: 1 }])("does not repeat a complete fetch evicted by %o", async (capacity) => {
    const node = logsNode("a", { value: 100 }, [...TABLE, TABLE[0]!]);
    const client = opened([node.config], {
      cache: { ...capacity, refreshInterval: false },
      operationBudget: { maxRequests: 1 },
      isActive: () => false,
      now: () => 0,
    });
    try {
      await client.probe();
      const results = await client.requestBatch([{ method: "eth_getLogs", params: [filter(90)] }]);
      expect(results).toEqual([{ status: "fulfilled", value: [TABLE[1], TABLE[2], TABLE[0]] }]);
      expect(node.count("eth_getLogs")).toBe(1);
      expect(client.cacheStats().entries).toBe(0);
    } finally {
      client.close();
    }
  });
});
