import { describe, expect, test } from "vitest";
import type { RpcEvent } from "@smart-rpc/core";

import {
  mantle, MANTLE_CHAIN_ID, MANTLE_MAINNET_CAIP, MANTLE_NATIVE_CURRENCY,
  MANTLE_RPC_URL, MANTLE_MAINNET_WS_URL, MANTLE_MAINNET_REGISTRY, MANTLE_GAS_PRICE_ORACLE,
  MANTLE_MAINNET_ENDPOINTS,
} from "../src/index.js";

interface Request { id: number; method: string; params?: unknown[] }
interface Call extends Request { url: string; headers: Headers }
const address = "0x1111111111111111111111111111111111111111";
const hash = `0x${"ab".repeat(32)}`;
const idle = { probeInterval: false } as const;

function mockRpc(answer: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const batches: number[] = [];
  return {
    calls, batches,
    async fetchFn(input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body)) as Request | Request[];
      const run = async (request: Request) => {
        const call = { ...request, url, headers: new Headers(init?.headers) };
        calls.push(call);
        const result = await answer(call);
        if (result instanceof Response) return result;
        if (result && typeof result === "object" && "error" in result) return { jsonrpc: "2.0", id: request.id, ...result };
        return { jsonrpc: "2.0", id: request.id, result };
      };
      if (Array.isArray(body)) {
        batches.push(body.length);
        return Response.json(await Promise.all(body.map(run)));
      }
      const result = await run(body);
      return result instanceof Response ? result : Response.json(result);
    },
  };
}

describe("Mantle mainnet", () => {
  test("uses documented identity, MNT metadata and exact WS URL without eager calls", () => {
    const mock = mockRpc(() => "0x1388");
    const pool = mantle({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(pool.chainIds).toEqual([MANTLE_MAINNET_CAIP]);
      expect(MANTLE_CHAIN_ID).toBe(5000);
      expect(MANTLE_NATIVE_CURRENCY).toEqual({ name: "Mantle", symbol: "MNT", decimals: 18 });
      expect(pool.endpoints.map(({ url }) => url)).toEqual(MANTLE_MAINNET_ENDPOINTS);
      expect(MANTLE_MAINNET_REGISTRY.map(({ url }) => url)).toEqual(MANTLE_MAINNET_ENDPOINTS);
      expect(MANTLE_MAINNET_REGISTRY.length).toBeLessThanOrEqual(5);
      expect(MANTLE_MAINNET_WS_URL).toBe("wss://wss.mantle.xyz");
      expect(MANTLE_MAINNET_REGISTRY[0]?.rps).toBeUndefined();
      expect(MANTLE_MAINNET_REGISTRY[0]?.capabilities?.maxBatchSize).toBeUndefined();
      expect(mock.calls).toHaveLength(0);
    } finally { pool.close(); }
  });

  test("quarantines the wrong chain before a caller request", async () => {
    const mock = mockRpc(({ method, url }) => method === "eth_chainId" ? url.includes("wrong") ? "0x1" : "0x1388" : "0x64");
    const pool = mantle({ endpoints: ["https://wrong.example", "https://mantle.example"], fetchFn: mock.fetchFn, headLag: idle, race: false, routing: "best" });
    try {
      expect(await pool.request({ method: "eth_blockNumber" })).toBe("0x64");
      expect(mock.calls.filter(({ url }) => url.includes("wrong")).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(pool.snapshot().find(({ url }) => url.includes("wrong"))?.quarantined).toBe(true);
    } finally { pool.close(); }
  });

  test.each(["eth_getBlockRange", "eth_sendTransaction"])("blocks public %s before dispatch and without health penalties", async (method) => {
    const mock = mockRpc(() => "0x1388");
    const pool = mantle({ endpoints: [`${MANTLE_RPC_URL}/`], fetchFn: mock.fetchFn, headLag: idle });
    try {
      await expect(pool.request({ method, params: [] })).rejects.toThrow();
      expect(mock.calls).toHaveLength(0);
      expect(pool.snapshot().every(({ ejected, methods }) => !ejected && Object.values(methods).every(({ n }) => n === 0))).toBe(true);
    } finally { pool.close(); }
  });

  test("permits an explicitly configured self-hosted legacy method without assuming it is a safe read", async () => {
    const events: RpcEvent[] = [];
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x1388" : [{ number: "0x1" }]);
    const pool = mantle({ endpoints: [{ url: "https://self.example", supportedMethods: ["eth_chainId", "eth_getBlockRange"] }], fetchFn: mock.fetchFn, headLag: idle, onEvent: (event) => events.push(event) });
    try {
      expect(await pool.request({ method: "eth_getBlockRange", params: ["0x1", "0x1", false] })).toEqual([{ number: "0x1" }]);
      expect(events.filter(({ type }) => ["race", "coalesce", "cache"].includes(type))).toHaveLength(0);
    } finally { pool.close(); }
  });

  test("keeps execution gas price separate from the oracle's L1 base fee", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x1388" : method === "eth_gasPrice" ? "0x11" : "0x0000000000000000000000000000000000000000000000000000000000000022");
    const pool = mantle({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(await pool.request({ method: "eth_gasPrice" })).toBe("0x11");
      const transaction = { to: MANTLE_GAS_PRICE_ORACLE, data: "0x519b4bd3" };
      expect(await pool.request({ method: "eth_call", params: [transaction, "latest"] })).toMatch(/22$/);
      expect(mock.calls.at(-1)?.params).toEqual([transaction, "latest"]);
    } finally { pool.close(); }
  });

  test("preserves receipt fee fields independently", async () => {
    const receipt = { transactionHash: hash, blockNumber: "0x64", gasUsed: "0x5208", effectiveGasPrice: "0x11", l1GasPrice: "0x22", l1GasUsed: "0x33", l1Fee: "0x44", feeScalar: "1.5", extraMantleField: "0x55" };
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x1388" : receipt);
    const pool = mantle({ fetchFn: mock.fetchFn, headLag: idle });
    try { expect(await pool.request({ method: "eth_getTransactionReceipt", params: [hash] })).toEqual(receipt); }
    finally { pool.close(); }
  });

  test("never races, coalesces or caches successful raw submissions", async () => {
    const events: RpcEvent[] = [];
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x1388" : hash);
    const pool = mantle({ endpoints: ["https://a.example", "https://b.example"], fetchFn: mock.fetchFn, headLag: idle, onEvent: (event) => events.push(event) });
    try {
      const request = { method: "eth_sendRawTransaction", params: ["0x1234"] };
      await Promise.all([pool.request(request), pool.request(request)]);
      expect(await pool.request(request)).toBe(hash);
      expect(mock.calls.filter(({ method }) => method === request.method)).toHaveLength(3);
      expect(events.filter(({ type }) => ["race", "cache", "coalesce"].includes(type))).toHaveLength(0);
    } finally { pool.close(); }
  });

  test.each([false, true])("raw transaction rebroadcast option %s controls transient failover", async (rebroadcastRawTransactions) => {
    const mock = mockRpc(({ method, url }) => method === "eth_chainId" ? "0x1388" : url.includes("a.example") ? new Response("Unavailable", { status: 503 }) : hash);
    const pool = mantle({ endpoints: ["https://a.example", "https://b.example"], fetchFn: mock.fetchFn, headLag: idle, routing: "best", rebroadcastRawTransactions, retryCount: 1 });
    try {
      const result = pool.request({ method: "eth_sendRawTransaction", params: ["0x1234"] });
      if (rebroadcastRawTransactions) await expect(result).resolves.toBe(hash);
      else await expect(result).rejects.toThrow();
      expect(mock.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(rebroadcastRawTransactions ? 2 : 1);
    } finally { pool.close(); }
  });

  test("does not retry a deterministic transaction rejection", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x1388" : { error: { code: -32000, message: "insufficient funds" } });
    const pool = mantle({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      await expect(pool.request({ method: "eth_sendRawTransaction", params: ["0x1234"] })).rejects.toThrow(/insufficient funds/);
      expect(mock.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(1);
    } finally { pool.close(); }
  });

  test("routes historical state only to probe-verified archive endpoints, without rewriting the selector", async () => {
    const mock = mockRpc(({ method, params }) => method === "eth_chainId" ? "0x1388" : params?.[1]);
    const pool = mantle({ fetchFn: mock.fetchFn, headLag: idle, race: false, budget: false });
    const archive = new Set(MANTLE_MAINNET_REGISTRY.filter(({ capabilities }) => capabilities?.archive).map(({ url }) => new URL(url).href));
    try {
      expect([...archive]).toEqual([new URL(MANTLE_RPC_URL).href, "https://mantle.drpc.org/"]);
      for (let index = 0; index < 4; index++) expect(await pool.request({ method: "eth_getBalance", params: [address, "0x1"] })).toBe("0x1");
      const reads = mock.calls.filter(({ method }) => method === "eth_getBalance");
      expect(reads.every(({ url }) => archive.has(new URL(url).href))).toBe(true);
    } finally { pool.close(); }
  });

  test.each(["safe", "finalized"])("does not degrade unsupported state selector %s to latest", async (tag) => {
    const mock = mockRpc(() => "0x1388");
    const pool = mantle({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: [address, tag] })).rejects.toThrow();
      expect(mock.calls).toHaveLength(0);
    } finally { pool.close(); }
  });

  test("supports dedicated headers and explicitly enabled archive/finality without rewriting selectors", async () => {
    const mock = mockRpc(({ method, params }) => method === "eth_chainId" ? "0x1388" : params?.[1]);
    const pool = mantle({ endpoints: [{ url: "https://dedicated.example", headers: { "x-api-key": "fixture" }, capabilities: { archive: true, blockTags: ["latest", "safe", "finalized"], pinning: false } }], fetchFn: mock.fetchFn, headLag: idle });
    try {
      for (const tag of ["0x1", "safe", "finalized"]) expect(await pool.request({ method: "eth_getBalance", params: [address, tag] })).toBe(tag);
      expect(mock.calls.every(({ headers }) => headers.get("x-api-key") === "fixture")).toBe(true);
    } finally { pool.close(); }
  });

  test.each(["debug_traceTransaction", "trace_transaction"])("blocks unverified %s capabilities", async (method) => {
    const mock = mockRpc(() => "0x1388");
    const pool = mantle({ fetchFn: mock.fetchFn, headLag: idle });
    try { await expect(pool.request({ method, params: [hash] })).rejects.toThrow(); expect(mock.calls).toHaveLength(0); }
    finally { pool.close(); }
  });

  test("retains per-item batch failures and provider batch ceilings", async () => {
    const mock = mockRpc(({ method, params }) => method === "eth_chainId" ? "0x1388" : params?.[0] === "bad" ? { error: { code: -32602, message: "invalid address" } } : "0x42");
    const pool = mantle({ endpoints: [{ url: "https://batch.example", capabilities: { batch: true, maxBatchSize: 2 } }], batch: { wait: 1, batchSize: 2 }, fetchFn: mock.fetchFn, headLag: idle, race: false, retryCount: 0 });
    try {
      const outcomes = await pool.requestBatch([{ method: "eth_getBalance", params: [address, "latest"] }, { method: "eth_getBalance", params: ["bad", "latest"] }]);
      expect(outcomes[0]).toEqual({ status: "fulfilled", value: "0x42" });
      expect(outcomes[1]?.status).toBe("rejected");
      expect(mock.batches.every((size) => size <= 2)).toBe(true);
    } finally { pool.close(); }
  });

  test("bounds all upstream work in a batch with one operation budget", async () => {
    const mock = mockRpc(() => "0x42");
    const pool = mantle({ endpoints: ["https://dedicated.example"], fetchFn: mock.fetchFn, headLag: idle, verifyIdentity: false, race: false, operationBudget: { maxRequests: 1 } });
    try {
      const results = await pool.requestBatch([{ method: "eth_getBalance", params: [address, "latest"] }, { method: "eth_getCode", params: [address, "latest"] }]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
      expect(mock.calls).toHaveLength(1);
    } finally { pool.close(); }
  });

  test("a cancelled call does not dispatch or penalize a provider", async () => {
    const mock = mockRpc(() => "0x1388");
    const pool = mantle({ fetchFn: mock.fetchFn, headLag: idle });
    const controller = new AbortController(); controller.abort();
    try {
      await expect(pool.request({ method: "eth_blockNumber", signal: controller.signal })).rejects.toThrow();
      expect(mock.calls).toHaveLength(0);
      expect(pool.snapshot()[0]?.ejected).toBe(false);
    } finally { pool.close(); }
  });

  test("head probes do not count as latency samples, and stale heads expire", async () => {
    let now = 100;
    const mock = mockRpc(({ method, url }) => method === "eth_chainId" ? "0x1388" : url.includes("a.example") ? "0x64" : "0x65");
    const pool = mantle({ endpoints: ["https://a.example", "https://b.example"], fetchFn: mock.fetchFn, now: () => now, headLag: { probeInterval: false, staleMs: 1000 } });
    try {
      await pool.probe();
      expect(pool.snapshot().map(({ head }) => head)).toEqual([100, 101]);
      expect(pool.snapshot().every(({ methods }) => Object.values(methods).every(({ n }) => n === 0))).toBe(true);
      now += 1001;
      expect(pool.snapshot().every(({ lag }) => lag === null)).toBe(true);
    } finally { pool.close(); }
  });

  test("successful probes cannot heal the failed-call streak", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x1388" : method === "eth_blockNumber" ? "0x64" : new Response("Unavailable", { status: 503 }));
    const pool = mantle({ endpoints: [MANTLE_RPC_URL], fetchFn: mock.fetchFn, headLag: idle, retryCount: 0, race: false });
    try {
      for (let index = 0; index < 3; index += 1) {
        await expect(pool.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
        if (index < 2) await pool.probe();
      }
      expect(pool.snapshot()[0]?.ejected).toBe(true);
    } finally { pool.close(); }
  });
});
