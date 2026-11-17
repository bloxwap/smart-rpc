import type { RpcEvent } from "@smart-rpc/core";
import { describe, expect, test } from "vitest";

import { avalanche, subscribeAcceptedTransactions, AVALANCHE_CHAIN_ID, AVALANCHE_MAINNET_CAIP, AVALANCHE_MAINNET_ENDPOINTS, AVALANCHE_MAINNET_REGISTRY, AVALANCHE_NATIVE_CURRENCY, AVALANCHE_RPC_URL, AVALANCHE_WS_URL, AVALANCHE_RPC_METHODS } from "../src/index.js";

interface Call { url: string; method: string; params: unknown[]; headers: Headers }
interface Body { id: number; method: string; params?: unknown[] }
function mockRpc(answer: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  return {
    calls,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const payload = JSON.parse(String(init?.body)) as Body | Body[];
      const run = async (body: Body) => {
        const call = { url, method: body.method, params: body.params ?? [], headers: new Headers(init?.headers) };
        calls.push(call);
        const result = await answer(call);
        if (result instanceof Response) return result;
        return { jsonrpc: "2.0", id: body.id, result };
      };
      if (Array.isArray(payload)) return Response.json(await Promise.all(payload.map(run)));
      const result = await run(payload);
      return result instanceof Response ? result : Response.json(result);
    },
  };
}
const idle = { probeInterval: false } as const;
const address = "0x1111111111111111111111111111111111111111";
const identity = "0xa86a";

describe("Avalanche C-Chain transport", () => {
  test("registers execution RPC lazily with AVAX metadata and exact WS path", () => {
    const mock = mockRpc(() => identity);
    const pool = avalanche({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(AVALANCHE_CHAIN_ID).toBe(43114);
      expect(pool.chainIds).toEqual([AVALANCHE_MAINNET_CAIP]);
      expect(AVALANCHE_MAINNET_REGISTRY.length).toBeLessThanOrEqual(5);
      expect(AVALANCHE_MAINNET_ENDPOINTS).toEqual(AVALANCHE_MAINNET_REGISTRY.map(({ url }) => url));
      expect(pool.endpoints.map(({ url }) => url)).toEqual(AVALANCHE_MAINNET_ENDPOINTS);
      expect(AVALANCHE_NATIVE_CURRENCY).toEqual({ name: "Avalanche", symbol: "AVAX", decimals: 18 });
      expect(AVALANCHE_RPC_URL).toBe("https://api.avax.network/ext/bc/C/rpc");
      expect(AVALANCHE_WS_URL).toBe("wss://api.avax.network/ext/bc/C/ws");
      expect(AVALANCHE_MAINNET_REGISTRY[0]?.rps).toBeUndefined();
      // The official node keeps 8,192 ancestors; only Tenderly served historical state reliably.
      expect(AVALANCHE_MAINNET_REGISTRY.filter(({ capabilities }) => capabilities?.archive).map(({ id }) => id)).toEqual(["avalanche-tenderly"]);
      expect(mock.calls).toEqual([]);
    } finally { pool.close(); }
  });

  test.each([
    "https://api.avax.network/ext/bc/C/avax", "https://node.example/ext/bc/C/avax",
    "https://api.avax.network/ext/bc/P", "https://node.example/ext/bc/X",
    "https://api.avax.network/ext/info", "wss://api.avax.network/ext/bc/C/rpc",
  ])("rejects non-execution endpoint %s before any network use", (url) => {
    expect(() => avalanche({ endpoints: [url] })).toThrow(/execution RPC/);
  });

  test("never sends atomic namespaces to a C-Chain execution endpoint", async () => {
    const mock = mockRpc(() => identity);
    const pool = avalanche({ endpoints: [AVALANCHE_RPC_URL], fetchFn: mock.fetchFn, headLag: idle });
    try {
      await expect(pool.request({ method: "avax.getUTXOs", params: { addresses: [] } })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
      expect(() => avalanche({ endpoints: [{ url: "https://node.example", supportedMethods: ["avax.getUTXOs"] }] }))
        .toThrow(/execution methods/);
    } finally { pool.close(); }
  });

  test("quarantines Fuji before any user call and routes mainnet by identity", async () => {
    const mock = mockRpc(({ method, url }) => method === "eth_chainId" ? url.includes("wrong") ? "0xa869" : identity : "0x64");
    const pool = avalanche({ endpoints: ["https://wrong.example", "https://right.example"], fetchFn: mock.fetchFn, headLag: idle, race: false, routing: "best" });
    try {
      expect(await pool.request({ method: "eth_blockNumber" })).toBe("0x64");
      expect(mock.calls.filter(({ url }) => url.includes("wrong")).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(pool.snapshot().find(({ url }) => url.includes("wrong"))?.quarantined).toBe(true);
    } finally { pool.close(); }
  });

  test("preserves executed versus settled tags and independent cached answers", async () => {
    const blocks: Record<string, string> = { latest: "0x64", pending: "0x64", safe: "0x62", finalized: "0x62" };
    const mock = mockRpc(({ method, params }) => method === "eth_chainId" ? identity : { number: blocks[String(params[0])], requestedTag: params[0] });
    const pool = avalanche({ endpoints: [{ url: "https://verified.example", capabilities: { blockTags: ["latest", "pending", "safe", "finalized"] } }], fetchFn: mock.fetchFn, headLag: idle, pinLatest: false });
    try {
      for (const tag of ["latest", "pending", "safe", "finalized"]) {
        expect(await pool.request({ method: "eth_getBlockByNumber", params: [tag, false] })).toEqual({ number: blocks[tag], requestedTag: tag });
      }
      await pool.request({ method: "eth_getBlockByNumber", params: ["pending", false] });
      expect(mock.calls.filter(({ method }) => method === "eth_getBlockByNumber").map(({ params }) => params[0]))
        .toEqual(["latest", "pending", "safe", "finalized", "pending"]);
    } finally { pool.close(); }
  });

  test("does not cache empty unexecuted logs as a completed receipt", async () => {
    let executed = false;
    const log = { address, blockNumber: "0x65", data: "0xab", topics: [], removed: false };
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : executed ? [log] : []);
    const pool = avalanche({ endpoints: [AVALANCHE_RPC_URL], fetchFn: mock.fetchFn, headLag: idle });
    const request = { method: "eth_getLogs", params: [{ address, fromBlock: "0x65", toBlock: "0x65" }] };
    try {
      expect(await pool.request(request)).toEqual([]);
      executed = true;
      expect(await pool.request(request)).toEqual([log]);
      expect(mock.calls.filter(({ method }) => method === "eth_getLogs")).toHaveLength(2);
    } finally { pool.close(); }
  });

  test("keeps header settlement and execution receipt gas values intact", async () => {
    const header = { number: "0x65", stateRoot: "0xsettled", receiptsRoot: "0xsettledReceipts", logsBloom: "0x00", gasUsed: "0x10000", baseFeePerGas: "0x300" };
    const receipt = { blockNumber: "0x65", status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x200", extension: { executed: true } };
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : method === "eth_getBlockByNumber" ? header : receipt);
    const pool = avalanche({ endpoints: [AVALANCHE_RPC_URL], fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(await pool.request({ method: "eth_getBlockByNumber", params: ["latest", false] })).toEqual(header);
      expect(await pool.request({ method: "eth_getTransactionReceipt", params: ["0xdead"] })).toEqual(receipt);
    } finally { pool.close(); }
  });

  test("passes through C-Chain fee upper bounds and tier options", async () => {
    const prices = { slow: { maxPriorityFeePerGas: "0x1", maxFeePerGas: "0xa" }, normal: { maxPriorityFeePerGas: "0x2", maxFeePerGas: "0xb" }, fast: { maxPriorityFeePerGas: "0x3", maxFeePerGas: "0xc" } };
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : method === "eth_baseFee" ? "0x300" : prices);
    const pool = avalanche({ endpoints: [AVALANCHE_RPC_URL], fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(await pool.request({ method: "eth_baseFee" })).toBe("0x300");
      expect(await pool.request({ method: "eth_suggestPriceOptions" })).toEqual(prices);
      await expect(pool.request({ method: "eth_getChainConfig" })).rejects.toThrow();
      expect(mock.calls.some(({ method }) => method === "eth_getChainConfig")).toBe(false);
    } finally { pool.close(); }
  });

  test("dedicated headers and archive/config capabilities stay explicit", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : method === "eth_getChainConfig" ? { chainId: 43114, heliconTimestamp: 1 } : "0x123");
    const pool = avalanche({ endpoints: [{ url: "https://private.example", headers: { "x-test-key": "fixture" }, capabilities: { archive: true } }], fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(await pool.request({ method: "eth_getBalance", params: [address, "0x10"] })).toBe("0x123");
      expect(await pool.request({ method: "eth_getChainConfig" })).toEqual({ chainId: 43114, heliconTimestamp: 1 });
      expect(mock.calls.every(({ headers }) => headers.get("x-test-key") === "fixture")).toBe(true);
    } finally { pool.close(); }
  });

  test("unverified historical state/finality requests are rejected without state downgrade", async () => {
    const mock = mockRpc(() => identity);
    const pool = avalanche({ endpoints: [AVALANCHE_RPC_URL], fetchFn: mock.fetchFn, headLag: idle });
    try {
      for (const tag of ["0x1", "safe", "finalized"]) await expect(pool.request({ method: "eth_getBalance", params: [address, tag] })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
    } finally { pool.close(); }
  });

  test("a pre-aborted caller sends neither identity nor user calls", async () => {
    const mock = mockRpc(() => identity);
    const pool = avalanche({ endpoints: [AVALANCHE_RPC_URL], fetchFn: mock.fetchFn, headLag: idle });
    try {
      await expect(pool.request({ method: "eth_blockNumber", signal: AbortSignal.abort() })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
    } finally { pool.close(); }
  });

  test("preserves per-item batch errors and bounds the entire operation", async () => {
    const calls: Body[] = [];
    const pool = avalanche({ endpoints: ["https://batch.example"], verifyIdentity: false, headLag: idle, race: false, retryCount: 0, cache: false, operationBudget: { maxRequests: 2 },
      async fetchFn(_input, init) {
        const body = JSON.parse(String(init?.body)) as Body;
        calls.push(body);
        return Response.json(body.params?.[0] === "invalid"
          ? { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "invalid address" } }
          : { jsonrpc: "2.0", id: body.id, result: "0x1" });
      },
    });
    try {
      const results = await pool.requestBatch([
        { method: "eth_getBalance", params: [address, "latest"] },
        { method: "eth_getBalance", params: ["invalid", "latest"] },
        { method: "eth_getBalance", params: [address, "pending"] },
      ]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "0x1" });
      expect(results[1]?.status).toBe("rejected");
      expect(results[2]?.status).toBe("rejected");
      expect(calls).toHaveLength(2);
    } finally { pool.close(); }
  });

  test("bounds retry amplification and never lets successful probes heal failed calls", async () => {
    const events: RpcEvent[] = [];
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : method === "eth_blockNumber" ? "0x64" : new Response("Unavailable", { status: 503 }));
    const pool = avalanche({ endpoints: [AVALANCHE_RPC_URL], fetchFn: mock.fetchFn, headLag: idle, race: false, retryCount: 0, onEvent: (event) => events.push(event) });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(pool.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
        await pool.probe();
      }
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance")).toHaveLength(3);
      expect(events.some((event) => event.type === "eject" && event.failures === 3)).toBe(true);
    } finally { pool.close(); }
  });

  test("probes track executed heads without latency samples and expire stale observations", async () => {
    let now = 0;
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : "0x64");
    const pool = avalanche({ endpoints: [AVALANCHE_RPC_URL], fetchFn: mock.fetchFn, headLag: { probeInterval: false, staleMs: 1000 }, now: () => now });
    try {
      await pool.probe();
      expect(pool.snapshot()[0]?.head).toBe(100);
      expect(pool.snapshot()[0]?.methods["*"]?.n ?? 0).toBe(0);
      now += 1001;
      expect(pool.snapshot()[0]?.lag).toBeNull();
    } finally { pool.close(); }
  });

  test("subscription requests need a dedicated session, never a receipt read", async () => {
    const mock = mockRpc(() => identity);
    const pool = avalanche({ endpoints: [AVALANCHE_RPC_URL], fetchFn: mock.fetchFn, headLag: idle });
    try {
      await expect(pool.request({ method: "eth_subscribe", params: ["newAcceptedTransactions", true] })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
      expect(AVALANCHE_RPC_METHODS).toContain("eth_getTransactionReceipt");
    } finally { pool.close(); }
  });

  test("typed acceptance subscriptions preserve the event envelope and owned lifecycle", async () => {
    const messages: unknown[] = [];
    const notification = { jsonrpc: "2.0" as const, id: 1, result: { hash: "0xaccepted", blockNumber: null } };
    let unsubscribed = false;
    const subscription = await subscribeAcceptedTransactions({
      async subscribe(options) {
        expect(options.params).toEqual(["newAcceptedTransactions", true]);
        options.onData(notification);
        return {
          subscriptionId: "0x1",
          async unsubscribe() { unsubscribed = true; return { jsonrpc: "2.0", id: 2, result: true }; },
        };
      },
    }, { fullTransactions: true, onData: (data) => messages.push(data) });
    expect(messages).toEqual([notification]);
    await subscription.unsubscribe();
    expect(unsubscribed).toBe(true);
  });
});
