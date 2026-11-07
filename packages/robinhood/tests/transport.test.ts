import { describe, expect, test } from "vitest";
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_INFRASTRUCTURE,
  ROBINHOOD_MAINNET_CAIP,
  ROBINHOOD_MAINNET_ENDPOINTS,
  ROBINHOOD_MAINNET_REGISTRY,
  ROBINHOOD_NATIVE_CURRENCY,
  ROBINHOOD_RPC_URL,
  robinhood,
} from "../src/index.js";

interface Call { id: number; url: string; method: string; params: unknown[]; headers: Headers; signal?: AbortSignal | null }
function mockRpc(answer: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  return {
    calls,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const call: Call = { id: body.id, url, method: body.method, params: body.params, headers: new Headers(init?.headers), signal: init?.signal };
      calls.push(call);
      const result = await answer(call);
      return result instanceof Response ? result : new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    },
  };
}
const noTimer = { probeInterval: false } as const;
const address = "0x0000000000000000000000000000000000000064";

describe("Robinhood mainnet", () => {
  test("registers only the mainnet public RPC and documents capabilities without inventing a quota", () => {
    const mock = mockRpc(() => "0x1237");
    const pool = robinhood({ fetchFn: mock.fetchFn, headLag: noTimer });
    try {
      expect(ROBINHOOD_CHAIN_ID).toBe(4663);
      expect(pool.chainIds).toEqual([ROBINHOOD_MAINNET_CAIP]);
      expect(ROBINHOOD_NATIVE_CURRENCY).toEqual({ name: "Ether", symbol: "ETH", decimals: 18 });
      expect(pool.endpoints.map(({ url }) => url)).toEqual(ROBINHOOD_MAINNET_ENDPOINTS);
      expect(pool.endpoints).toHaveLength(1);
      expect(pool.snapshot()[0]?.tokens).toBeNull();
      expect(ROBINHOOD_MAINNET_REGISTRY[0].sourceUrls).toContain("https://docs.robinhood.com/chain/connecting/");
      expect(ROBINHOOD_MAINNET_REGISTRY[0].capabilities).toMatchObject({ archive: false, pinning: false, batch: false });
      expect(mock.calls).toEqual([]);
    } finally { pool.close(); }
  });

  test.each(Object.entries(ROBINHOOD_INFRASTRUCTURE).filter(([role]) => role !== "rpc"))(
    "rejects the %s service as a full JSON-RPC provider", (_role, url) => {
      expect(() => robinhood({ endpoints: [url], headLag: noTimer })).toThrow(/not general JSON-RPC/);
    },
  );

  test("quarantines a testnet response before sending a user request", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xb626" : "0x1");
    const pool = robinhood({ fetchFn: mock.fetchFn, headLag: noTimer });
    try {
      await expect(pool.request({ method: "eth_blockNumber" })).rejects.toThrow();
      expect(mock.calls.map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(pool.snapshot()[0]?.quarantined).toBe(true);
    } finally { pool.close(); }
  });

  test("verifies identity before a successful mainnet read", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x1237" : "0xabc");
    const pool = robinhood({ fetchFn: mock.fetchFn, headLag: noTimer });
    try {
      await expect(pool.request({ method: "eth_blockNumber" })).resolves.toBe("0xabc");
      expect(mock.calls.map(({ method }) => method)).toEqual(["eth_chainId", "eth_blockNumber"]);
    } finally { pool.close(); }
  });

  test("replaces defaults with a dedicated provider and forwards its headers", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x1237" : "0x1");
    const pool = robinhood({
      endpoints: [{ url: "https://provider.example/rpc", headers: { authorization: "Bearer fixture" } }],
      fetchFn: mock.fetchFn, headLag: noTimer,
    });
    try {
      await expect(pool.request({ method: "eth_blockNumber" })).resolves.toBe("0x1");
      expect(mock.calls.every(({ url, headers }) => url === "https://provider.example/rpc" && headers.get("authorization") === "Bearer fixture")).toBe(true);
    } finally { pool.close(); }
  });

  test("keeps latest state reads unpinned on the public endpoint after a successful probe", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x1237" : method === "eth_blockNumber" ? "0x100" : "0x1");
    const pool = robinhood({ endpoints: [ROBINHOOD_RPC_URL], fetchFn: mock.fetchFn, headLag: noTimer });
    try {
      await pool.probe();
      await pool.request({ method: "eth_getBalance", params: [address, "latest"] });
      expect(mock.calls.find(({ method }) => method === "eth_getBalance")?.params).toEqual([address, "latest"]);
      expect(pool.snapshot()[0]?.methods.eth_blockNumber?.n ?? 0).toBe(0);
    } finally { pool.close(); }
  });

  test.each(["safe", "finalized", "0x1"])('does not downgrade "%s" state requests on the public endpoint', async (tag) => {
    const mock = mockRpc(() => "0x1237");
    const pool = robinhood({ fetchFn: mock.fetchFn, headLag: noTimer });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: [address, tag] })).rejects.toThrow();
      expect(mock.calls.some(({ method }) => method === "eth_getBalance")).toBe(false);
    } finally { pool.close(); }
  });

  test("routes archive reads only to a capable provider and preserves the requested block", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x1237" : "0xfeed");
    const pool = robinhood({
      endpoints: [ROBINHOOD_RPC_URL, { url: "https://archive.example/rpc", capabilities: { archive: true } }],
      fetchFn: mock.fetchFn, headLag: noTimer, race: false, routing: "best",
    });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: [address, "0x1"] })).resolves.toBe("0xfeed");
      const read = mock.calls.find(({ method }) => method === "eth_getBalance");
      expect(read?.url).toBe("https://archive.example/rpc");
      expect(read?.params).toEqual([address, "0x1"]);
    } finally { pool.close(); }
  });

  test("preserves Nitro receipt fee fields and precompile call data", async () => {
    const receipt = { transactionHash: "0xdead", gasUsed: "0x2100", gasUsedForL1: "0x200", l1BlockNumber: "0x100", status: "0x1" };
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x1237" : method === "eth_getTransactionReceipt" ? receipt : "0x1234");
    const pool = robinhood({ fetchFn: mock.fetchFn, headLag: noTimer });
    try {
      await expect(pool.request({ method: "eth_getTransactionReceipt", params: ["0xdead"] })).resolves.toEqual(receipt);
      const params = [{ to: address, data: "0xa3b1b31d", value: "0x0" }, "latest"];
      await expect(pool.request({ method: "eth_call", params })).resolves.toBe("0x1234");
      expect(mock.calls.find(({ method }) => method === "eth_call")?.params).toEqual(params);
    } finally { pool.close(); }
  });

  test("never coalesces or races raw transaction submissions", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x1237" : "0xhash");
    const pool = robinhood({ endpoints: ["https://a.example", "https://b.example"], fetchFn: mock.fetchFn, headLag: noTimer });
    try {
      await Promise.all([pool.request({ method: "eth_sendRawTransaction", params: ["0x01"] }), pool.request({ method: "eth_sendRawTransaction", params: ["0x01"] })]);
      expect(mock.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(2);
    } finally { pool.close(); }
  });

  test("rejects cancellation without sending a request or poisoning endpoint health", async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = mockRpc(() => "0x1237");
    const pool = robinhood({ fetchFn: mock.fetchFn, headLag: noTimer });
    try {
      await expect(pool.request({ method: "eth_blockNumber", signal: controller.signal })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
      expect(pool.snapshot()[0]?.ejected).toBe(false);
    } finally { pool.close(); }
  });

  test("retains individual batch errors beside successful results", async () => {
    const mock = mockRpc(({ id, method }) => method === "eth_chainId" ? "0x1237" : method === "eth_blockNumber" ? "0xabc" : new Response(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "invalid params" } }),
      { headers: { "content-type": "application/json" } },
    ));
    const pool = robinhood({ fetchFn: mock.fetchFn, headLag: noTimer, race: false });
    try {
      const results = await pool.requestBatch([{ method: "eth_blockNumber" }, { method: "eth_getBalance", params: ["invalid", "latest"] }]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "0xabc" });
      expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(Error) });
    } finally { pool.close(); }
  });

  test("bounds upstream work across identity verification and retries", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x1237" : new Response("unavailable", { status: 503 }));
    const pool = robinhood({
      endpoints: ["https://a.example", "https://b.example"], fetchFn: mock.fetchFn, headLag: noTimer,
      race: false, retryCount: 5, operationBudget: { maxRequests: 2 },
    });
    try {
      await expect(pool.request({ method: "eth_blockNumber" })).rejects.toThrow();
      expect(mock.calls).toHaveLength(2);
      expect(mock.calls.map(({ method }) => method)).toEqual(["eth_chainId", "eth_blockNumber"]);
    } finally { pool.close(); }
  });

  test("successful probes do not clear a caller failure streak", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x1237" : method === "eth_blockNumber" ? "0x100" : new Response("unavailable", { status: 503 }));
    const pool = robinhood({ fetchFn: mock.fetchFn, headLag: noTimer, race: false, retryCount: 0, cache: false });
    try {
      for (let i = 0; i < 3; i++) {
        await expect(pool.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
        if (i < 2) await pool.probe();
      }
      expect(pool.snapshot()[0]?.ejected).toBe(true);
      expect(pool.snapshot()[0]?.methods.eth_blockNumber?.n ?? 0).toBe(0);
      expect(pool.snapshot()[0]?.methods.eth_getBalance?.n).toBe(3);
    } finally { pool.close(); }
  });

  test("stale full-block heads stop influencing lag scoring", async () => {
    let now = 0;
    const mock = mockRpc(({ url, method }) => method === "eth_chainId" ? "0x1237" : url.includes("a.example") ? "0x100" : "0x103");
    const pool = robinhood({
      endpoints: ["https://a.example", "https://b.example"], fetchFn: mock.fetchFn,
      headLag: { probeInterval: false, staleMs: 1_000 }, now: () => now,
    });
    try {
      await pool.probe();
      expect(pool.snapshot()[0]?.lag).toBe(3);
      now = 2_000;
      expect(pool.snapshot().every(({ lag }) => lag === null)).toBe(true);
    } finally { pool.close(); }
  });
});
