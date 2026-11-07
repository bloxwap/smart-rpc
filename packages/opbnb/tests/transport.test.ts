import { describe, expect, test } from "vitest";
import type { RpcEvent } from "@smart-rpc/core";
import {
  opbnb, OPBNB_CHAIN_ID, OPBNB_MAINNET_CAIP, OPBNB_NATIVE_CURRENCY,
  OPBNB_PARENT_CHAIN_ID, OPBNB_MAINNET_REGISTRY, OPBNB_MAINNET_WEBSOCKET_ENDPOINTS,
} from "../src/index.js";

interface Call { url: string; method: string; params: unknown[]; headers: Headers }
interface Body { id: number; method: string; params?: unknown[] }
const address = "0x1111111111111111111111111111111111111111";
const idle = { probeInterval: false } as const;

function mockRpc(answer: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  return {
    calls,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const raw = JSON.parse(String(init?.body)) as Body | Body[];
      const run = async (body: Body) => {
        const call = { url, method: body.method, params: body.params ?? [], headers: new Headers(init?.headers) };
        calls.push(call);
        const result = await answer(call);
        if (result instanceof Response) return result;
        if (result instanceof Error) return { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: result.message } };
        return { jsonrpc: "2.0", id: body.id, result };
      };
      if (Array.isArray(raw)) return Response.json(await Promise.all(raw.map(run)));
      const result = await run(raw);
      return result instanceof Response ? result : Response.json(result);
    },
  };
}

describe("opBNB execution transport", () => {
  test("registers chain 204/BNB and keeps its BSC parent separate", async () => {
    const mock = mockRpc(() => "0xcc");
    const pool = opbnb({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(pool.chainIds).toEqual([OPBNB_MAINNET_CAIP]);
      expect(OPBNB_CHAIN_ID).toBe(204);
      expect(OPBNB_PARENT_CHAIN_ID).toBe(56);
      expect(OPBNB_NATIVE_CURRENCY).toEqual({ name: "BNB", symbol: "BNB", decimals: 18 });
      expect(pool.endpoints.map(({ url }) => url)).toEqual(OPBNB_MAINNET_REGISTRY.map(({ url }) => url));
      expect(mock.calls).toEqual([]);
      await expect(pool.request({ chainId: "eip155:56", method: "eth_blockNumber" })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
    } finally { pool.close(); }
  });

  test("records exact provider WS metadata without enabling undocumented quotas/capabilities", () => {
    expect(OPBNB_MAINNET_WEBSOCKET_ENDPOINTS).toEqual(["wss://opbnb-rpc.publicnode.com"]);
    for (const endpoint of OPBNB_MAINNET_REGISTRY) {
      expect(endpoint.rps).toBeUndefined();
      expect(endpoint.capabilities?.maxBatchSize).toBeUndefined();
      expect(endpoint.capabilities).toMatchObject({ archive: false, batch: false, subscriptions: false, pinning: false });
      expect(endpoint.provider).toBeTruthy();
      expect(endpoint.sourceUrls.length).toBeGreaterThan(0);
    }
  });

  test.each(["0x38", "0x1", "0xa"])("quarantines another chain %s before any user method", async (wrong) => {
    const mock = mockRpc(({ url, method }) => method === "eth_chainId"
      ? url.includes("wrong") ? wrong : "0xcc" : "0x64");
    const pool = opbnb({ endpoints: ["https://wrong.example", "https://right.example"], fetchFn: mock.fetchFn,
      routing: "best", race: false, headLag: idle });
    try {
      expect(await pool.request({ method: "eth_blockNumber" })).toBe("0x64");
      expect(mock.calls.filter(({ url }) => url.includes("wrong")).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(pool.snapshot().find(({ url }) => url.includes("wrong"))?.quarantined).toBe(true);
    } finally { pool.close(); }
  });

  test("preserves separate BSC data-fee and L2 execution-gas receipt fields", async () => {
    const receipt = {
      transactionHash: `0x${"ab".repeat(32)}`, blockNumber: "0x64", status: "0x1",
      gasUsed: "0x5208", effectiveGasPrice: "0x3f1", l1Fee: "0x1234",
      l1GasPrice: "0x2faf080", l1GasUsed: "0x384", l1FeeScalar: "1",
      depositNonce: "0x2", depositReceiptVersion: "0x1",
    };
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xcc" : receipt);
    const pool = opbnb({ endpoints: ["https://opbnb.example"], fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(await pool.request({ method: "eth_getTransactionReceipt", params: [receipt.transactionHash] })).toEqual(receipt);
      expect(receipt).not.toHaveProperty("l1BlobBaseFee");
    } finally { pool.close(); }
  });

  test("keeps explicitly supported unsafe, safe and finalized tags and caches separate", async () => {
    const mock = mockRpc(({ method, params }) => method === "eth_chainId" ? "0xcc" : params[1]);
    const pool = opbnb({ endpoints: [{ url: "https://verified.example", capabilities: {
      blockTags: ["latest", "safe", "finalized"], pinning: false,
    } }], fetchFn: mock.fetchFn, headLag: idle });
    try {
      for (let repeat = 0; repeat < 2; repeat += 1) {
        for (const tag of ["latest", "safe", "finalized"]) {
          expect(await pool.request({ method: "eth_getBalance", params: [address, tag] })).toBe(tag);
        }
      }
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance").map(({ params }) => params[1]))
        .toEqual(["latest", "safe", "finalized"]);
    } finally { pool.close(); }
  });

  test("does not degrade unsupported finality/historical state to latest", async () => {
    const mock = mockRpc(() => "0xcc");
    const pool = opbnb({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      for (const tag of ["safe", "finalized", "0x1"]) {
        await expect(pool.request({ method: "eth_getBalance", params: [address, tag] })).rejects.toThrow();
      }
      await expect(pool.request({ method: "debug_traceTransaction", params: ["0x1234"] })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
    } finally { pool.close(); }
  });

  test("supports private headers and archive reads without rewriting params", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xcc" : "0x123");
    const pool = opbnb({ endpoints: [{ url: "https://private.example", headers: { "x-api-key": "fixture-key" },
      capabilities: { archive: true } }], fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(await pool.request({ method: "eth_getBalance", params: [address, "0x1"] })).toBe("0x123");
      expect(mock.calls.every(({ headers }) => headers.get("x-api-key") === "fixture-key")).toBe(true);
      expect(mock.calls.at(-1)?.params).toEqual([address, "0x1"]);
    } finally { pool.close(); }
  });

  test("never races or coalesces identical transaction submissions", async () => {
    const events: RpcEvent[] = [];
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xcc" : "0x1234");
    const pool = opbnb({ endpoints: ["https://a.example", "https://b.example"], fetchFn: mock.fetchFn,
      headLag: idle, rebroadcastRawTransactions: false, onEvent: (event) => events.push(event) });
    try {
      const request = { method: "eth_sendRawTransaction", params: ["0x1234"] };
      await Promise.all([pool.request(request), pool.request(request)]);
      await pool.request(request);
      expect(mock.calls.filter(({ method }) => method === request.method)).toHaveLength(3);
      expect(events.filter(({ type }) => ["race", "coalesce", "cache"].includes(type))).toEqual([]);
    } finally { pool.close(); }
  });

  test("honors pre-dispatch cancellation without sending identity traffic", async () => {
    const mock = mockRpc(() => "0xcc");
    const pool = opbnb({ fetchFn: mock.fetchFn, headLag: idle });
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(pool.request({ method: "eth_blockNumber", signal: controller.signal })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
    } finally { pool.close(); }
  });

  test("bounds retries and shares operation work across batch items", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xcc" : new Response("Unavailable", { status: 503 }));
    const pool = opbnb({ endpoints: ["https://failed.example"], fetchFn: mock.fetchFn, headLag: idle,
      retryCount: 10, retryDelay: 1, race: false, operationBudget: { maxRequests: 3 } });
    try {
      const results = await pool.requestBatch([
        { method: "eth_getBalance", params: [address, "latest"] },
        { method: "eth_getCode", params: [address, "latest"] },
      ]);
      expect(results.every(({ status }) => status === "rejected")).toBe(true);
      expect(mock.calls.length).toBeLessThanOrEqual(3);
    } finally { pool.close(); }
  });

  test("retains a successful batch sibling when one item is rejected", async () => {
    const mock = mockRpc(({ method, params }) => method === "eth_chainId" ? "0xcc"
      : params[0] === "invalid" ? new Error("invalid address") : "0x42");
    const pool = opbnb({ endpoints: [{ url: "https://batch.example", capabilities: { batch: true, maxBatchSize: 2 } }],
      fetchFn: mock.fetchFn, headLag: idle, batch: { batchSize: 2, wait: 1 }, race: false });
    try {
      const results = await pool.requestBatch([
        { method: "eth_getBalance", params: [address, "latest"] },
        { method: "eth_getBalance", params: ["invalid", "latest"] },
      ]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "0x42" });
      expect(results[1]?.status).toBe("rejected");
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance")).toHaveLength(2);
    } finally { pool.close(); }
  });

  test("probes expire stale full-block heads without sampling call latency or healing call failure", async () => {
    let now = 100;
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xcc" : method === "eth_blockNumber"
      ? "0x64" : new Response("Unavailable", { status: 503 }));
    const pool = opbnb({ endpoints: ["https://opbnb.example"], fetchFn: mock.fetchFn, now: () => now,
      headLag: { probeInterval: false, staleMs: 1000 }, retryCount: 0, race: false });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
      await pool.probe();
      expect(pool.snapshot()[0]?.head).toBe(100);
      expect(pool.snapshot()[0]?.methods["*"]?.n).toBe(1);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(pool.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
      }
      expect(pool.snapshot()[0]?.ejected).toBe(true);
      now += 1001;
      expect(pool.snapshot()[0]?.lag).toBeNull();
    } finally { pool.close(); }
  });
});
