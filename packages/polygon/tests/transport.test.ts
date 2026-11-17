import { describe, expect, test } from "vitest";
import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";
import { POLYGON_CHAIN_ID, POLYGON_MAINNET_CAIP, POLYGON_MAINNET_ENDPOINTS, POLYGON_MAINNET_REGISTRY, POLYGON_NATIVE_CURRENCY, POLYGON_PUBLIC_METHODS, POLYGON_RPC_URL, POLYGON_WS_URL, polygon } from "../src/index.js";

interface Call { id: number; url: string; method: string; params: unknown[]; headers: Headers }

function mockRpc(answer: (call: Call) => unknown | Promise<unknown> = () => "0x123") {
  const calls: Call[] = [];
  return {
    calls,
    fetchFn: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const call = { id: body.id, url, method: body.method, params: body.params, headers: new Headers(init?.headers) };
      calls.push(call);
      const result = body.method === "eth_chainId" ? await answer(call) ?? "0x89" : await answer(call);
      if (result instanceof Response) return result;
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  };
}

const inactive = { probeInterval: false as const };
const account = "0x0000000000000000000000000000000000001234";
const officialEndpoint: EthereumEndpointConfig = {
  url: POLYGON_RPC_URL,
  supportedMethods: POLYGON_PUBLIC_METHODS,
  capabilities: {
    archive: false, debug: false, trace: false, subscriptions: false,
    pinning: false, batch: false, blockTags: ["latest", "pending"],
  },
};

describe("Polygon PoS transport", () => {
  test("loads documented providers without network work or invented limits", () => {
    const mock = mockRpc();
    const pool = polygon({ fetchFn: mock.fetchFn, headLag: inactive });
    try {
      expect(pool.chainIds).toEqual([POLYGON_MAINNET_CAIP]);
      expect(POLYGON_CHAIN_ID).toBe(137);
      expect(POLYGON_NATIVE_CURRENCY).toEqual({ name: "POL", symbol: "POL", decimals: 18 });
      expect(POLYGON_MAINNET_REGISTRY.length).toBeLessThanOrEqual(5);
      expect(POLYGON_MAINNET_ENDPOINTS).toEqual(POLYGON_MAINNET_REGISTRY.map(({ url }) => url));
      expect(pool.endpoints.map(({ url }) => url)).toEqual(POLYGON_MAINNET_ENDPOINTS);
      expect(POLYGON_WS_URL).toBe("wss://polygon.drpc.org");
      expect(mock.calls).toEqual([]);
      for (const endpoint of POLYGON_MAINNET_REGISTRY) {
        expect(endpoint.sourceUrls.length).toBeGreaterThan(0);
        expect(endpoint.rps).toBeUndefined();
        expect(endpoint.capabilities?.maxBatchSize).toBeUndefined();
        expect(endpoint.capabilities?.batch).toBe(false);
        expect(endpoint.reviewedAt).toBe("2026-11-08");
      }
      // ZAN rejects eth_getLogs and throttles keyless callers at 2 rps; QuickNode is listed by Polygon.
      expect(POLYGON_MAINNET_ENDPOINTS.some((url) => url.includes("zan.top"))).toBe(false);
      expect(POLYGON_MAINNET_REGISTRY.filter(({ capabilities }) => capabilities?.archive).map(({ id }) => id))
        .toEqual(["polygon-drpc", "polygon-tenderly", "polygon-quicknode"]);
    } finally { pool.close(); }
  });

  test("quarantines a different EVM network before any user call", async () => {
    const wrong = "https://wrong.example/rpc";
    const correct = "https://polygon.example/rpc";
    const mock = mockRpc(({ url, method }) => method === "eth_chainId" ? url === wrong ? "0x1" : "0x89" : "0x123");
    const pool = polygon({ endpoints: [wrong, correct], fetchFn: mock.fetchFn, headLag: inactive, routing: "best", race: false });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: [account, "latest"] })).resolves.toBe("0x123");
      expect(mock.calls.filter(({ url }) => url === wrong).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(pool.snapshot().find(({ url }) => url === wrong)?.quarantined).toBe(true);
      expect(mock.calls.filter(({ url }) => url === correct).map(({ method }) => method)).toEqual(["eth_chainId", "eth_getBalance"]);
    } finally { pool.close(); }
  });

  test("preserves provider headers, gas quantities and Polygon receipt extensions", async () => {
    const receipt = { status: "0x1", effectiveGasPrice: "0x5d21dba00", borReceipt: { stateSync: true } };
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x89" : method === "eth_getTransactionReceipt" ? receipt : "0x5d21dba00");
    const pool = polygon({
      endpoints: [{ url: "https://dedicated.example/rpc", headers: { "x-api-key": "fixture-only" } }],
      fetchFn: mock.fetchFn, headLag: inactive, race: false,
    });
    try {
      await expect(pool.request({ method: "eth_gasPrice" })).resolves.toBe("0x5d21dba00");
      await expect(pool.request({ method: "eth_maxPriorityFeePerGas" })).resolves.toBe("0x5d21dba00");
      await expect(pool.request({ method: "eth_getTransactionReceipt", params: ["0x123"] })).resolves.toEqual(receipt);
      expect(mock.calls.every(({ headers }) => headers.get("x-api-key") === "fixture-only")).toBe(true);
    } finally { pool.close(); }
  });

  test.each(["bor_getAuthor", "debug_traceTransaction", "trace_block"])("does not send unconfigured %s to public providers", async (method) => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x89" : "0x123");
    const pool = polygon({ endpoints: [officialEndpoint], fetchFn: mock.fetchFn, headLag: inactive, race: false });
    try {
      await expect(pool.request({ method, params: ["0x10"] })).rejects.toThrow();
      expect(mock.calls.some((call) => call.method === method)).toBe(false);
    } finally { pool.close(); }
  });

  test("routes a Bor fixture only to the provider that opted in", async () => {
    const author = "0x0375b2fc7140977c9c76d45421564e354ed42277";
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x89" : author);
    const endpoints: EthereumEndpointConfig[] = [
      { url: "https://standard.example/rpc", supportedMethods: POLYGON_PUBLIC_METHODS },
      { url: "https://bor.example/rpc", supportedMethods: [...POLYGON_PUBLIC_METHODS, "bor_getAuthor"] },
    ];
    const pool = polygon({ endpoints, fetchFn: mock.fetchFn, headLag: inactive, routing: "best", cache: false });
    try {
      await expect(pool.request({ method: "bor_getAuthor", params: ["0x1000"] })).resolves.toBe(author);
      expect(mock.calls.filter(({ method }) => method === "bor_getAuthor").map(({ url, params }) => ({ url, params }))).toEqual([
        { url: "https://bor.example/rpc", params: ["0x1000"] },
      ]);
    } finally { pool.close(); }
  });

  test("preserves safe, finalized and historical tags on a capable provider", async () => {
    const mock = mockRpc(({ method, params }) => method === "eth_chainId" ? "0x89" : { number: "0x10", requestedTag: params[0], extraData: "0xbeef" });
    const pool = polygon({
      endpoints: [{ url: "https://archive.example/rpc", capabilities: { archive: true, blockTags: ["latest", "pending", "safe", "finalized", "earliest"] } }],
      fetchFn: mock.fetchFn, headLag: inactive, race: false,
    });
    try {
      for (const tag of ["safe", "finalized", "0x10", "pending"]) {
        await expect(pool.request({ method: "eth_getBlockByNumber", params: [tag, false] })).resolves.toEqual({ number: "0x10", requestedTag: tag, extraData: "0xbeef" });
      }
      expect(mock.calls.filter(({ method }) => method === "eth_getBlockByNumber").map(({ params }) => params[0])).toEqual(["safe", "finalized", "0x10", "pending"]);
    } finally { pool.close(); }
  });

  test("does not downgrade an unverified finality request to latest", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x89" : "0x1");
    const pool = polygon({ endpoints: [officialEndpoint], fetchFn: mock.fetchFn, headLag: inactive });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: [account, "finalized"] })).rejects.toThrow();
      expect(mock.calls.some(({ method }) => method === "eth_getBalance")).toBe(false);
    } finally { pool.close(); }
  });

  test("honors caller cancellation without harming provider health", async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = mockRpc();
    const pool = polygon({ endpoints: [officialEndpoint], fetchFn: mock.fetchFn, headLag: inactive });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: [account, "latest"], signal: controller.signal })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
      expect(pool.snapshot().every(({ ejected, quarantined, inflight }) => !ejected && !quarantined && inflight === 0)).toBe(true);
    } finally { pool.close(); }
  });

  test("uses the shared bounded retry policy for a failing Polygon read", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x89" : new Response("unavailable", { status: 503 }));
    const pool = polygon({
      endpoints: ["https://retry.example/rpc"], fetchFn: mock.fetchFn,
      headLag: inactive, retryCount: 2, retryDelay: 1, random: () => 0, race: false,
    });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: [account, "latest"] })).rejects.toThrow();
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance")).toHaveLength(3);
      expect(pool.snapshot()[0]?.ejected).toBe(true);
    } finally { pool.close(); }
  });

  test("retains each logical batch item's result or RPC error", async () => {
    const mock = mockRpc(({ id, method }) => method === "eth_chainId" ? "0x89" : method === "eth_call"
      ? Response.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Polygon fixture invalid parameters" } })
      : "0x10");
    const pool = polygon({ endpoints: ["https://batch.example/rpc"], fetchFn: mock.fetchFn, headLag: inactive, race: false });
    try {
      const results = await pool.requestBatch([
        { method: "eth_blockNumber" },
        { method: "eth_call", params: [{ to: account, data: "0x" }, "latest"] },
      ]);
      expect(results).toMatchObject([
        { status: "fulfilled", value: "0x10" },
        { status: "rejected", reason: expect.any(Error) },
      ]);
      expect(mock.calls.filter(({ method }) => method === "eth_call")).toHaveLength(1);
    } finally { pool.close(); }
  });

  test("a healthy Polygon probe neither adds call latency samples nor heals failed calls", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x89" : method === "eth_blockNumber" ? "0x10" : new Response("unavailable", { status: 503 }));
    const pool = polygon({ endpoints: ["https://probe.example/rpc"], fetchFn: mock.fetchFn, headLag: inactive, race: false, retryCount: 0 });
    const request = { method: "eth_getBalance", params: [account, "latest"] };
    try {
      await expect(pool.request(request)).rejects.toThrow();
      const before = pool.snapshot()[0]?.methods["*"];
      await pool.probe();
      const after = pool.snapshot()[0]?.methods["*"];
      expect(after?.n).toBe(before?.n);
      expect(after?.ewma).toBe(before?.ewma);
      await expect(pool.request(request)).rejects.toThrow();
      await expect(pool.request(request)).rejects.toThrow();
      expect(pool.snapshot()[0]?.ejected).toBe(true);
    } finally { pool.close(); }
  });

  test("expires stale Polygon heads using the configured freshness window", async () => {
    let now = 1_000;
    const mock = mockRpc(({ method, url }) => method === "eth_chainId" ? "0x89" : url.includes("first") ? "0x10" : "0x11");
    const pool = polygon({
      endpoints: ["https://first.example/rpc", "https://second.example/rpc"], fetchFn: mock.fetchFn,
      now: () => now, headLag: { probeInterval: false, staleMs: 5_000 },
    });
    try {
      await pool.probe();
      expect(pool.snapshot().map(({ lag }) => lag)).toEqual([1, 0]);
      now += 5_001;
      expect(pool.snapshot().map(({ lag }) => lag)).toEqual([null, null]);
    } finally { pool.close(); }
  });
});
