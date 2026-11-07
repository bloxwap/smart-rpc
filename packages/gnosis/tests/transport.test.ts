import { describe, expect, test } from "vitest";
import type { RpcEvent } from "@smart-rpc/core";
import { gnosis, GNOSIS_CHAIN_ID, GNOSIS_MAINNET_REGISTRY, GNOSIS_NATIVE_CURRENCY, GNOSIS_WEBSOCKET_URL, GNOSIS_CONSENSUS } from "../src/index.js";

interface Call { url: string; method: string; params: unknown[]; headers: Headers }
interface Body { id: number; method: string; params?: unknown[] }
function mock(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  return { calls, async fetchFn(input: string | URL | Request, init?: RequestInit) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body)) as Body | Body[];
    const run = (request: Body) => {
      const call = { url, method: request.method, params: request.params ?? [], headers: new Headers(init?.headers) };
      calls.push(call);
      const result = answer(call);
      if (result instanceof Error) return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: result.message } };
      return { jsonrpc: "2.0", id: request.id, result };
    };
    return Response.json(Array.isArray(body) ? body.map(run) : run(body));
  } };
}
const idle = { probeInterval: false } as const;
const address = "0x1111111111111111111111111111111111111111";
const identity = (method: string) => method === "eth_chainId" ? "0x64" : "0x100";

describe("Gnosis execution transport", () => {
  test("defaults to mainnet execution RPCs with xDAI and the documented slot cadence", () => {
    const wire = mock(() => "0x64");
    const pool = gnosis({ fetchFn: wire.fetchFn, headLag: idle });
    try {
      expect(pool.chainIds).toEqual(["eip155:100"]);
      expect(GNOSIS_CHAIN_ID).toBe(100);
      expect(GNOSIS_NATIVE_CURRENCY).toEqual({ name: "xDAI", symbol: "xDAI", decimals: 18 });
      expect(GNOSIS_CONSENSUS).toEqual({ slotSeconds: 5, slotsPerEpoch: 16, approximateFinalizationSeconds: 162 });
      expect(pool.endpoints.map(({ url }) => url)).toEqual(GNOSIS_MAINNET_REGISTRY.map(({ url }) => url));
      expect(GNOSIS_MAINNET_REGISTRY.every(({ rps }) => rps === undefined)).toBe(true);
      expect(GNOSIS_WEBSOCKET_URL).toBe("wss://rpc.gnosischain.com/wss");
      expect(wire.calls).toEqual([]);
    } finally { pool.close(); }
  });

  test.each(["https://rpc-gbc.gnosischain.com", "https://RPC-GBC.GNOSISCHAIN.COM./eth/v1/beacon/headers", "https://custom.example/eth/v2/beacon/blocks", "wss://rpc.gnosischain.com"])("rejects consensus or guessed socket endpoint %s", (url) => {
    expect(() => gnosis({ endpoints: [url] })).toThrow(/consensus|documented Gnosis WebSocket/);
  });

  test("quarantines a different chain before user calls", async () => {
    const wire = mock(({ method, url }) => method === "eth_chainId" ? url.includes("wrong") ? "0x1" : "0x64" : "0x100");
    const pool = gnosis({ endpoints: ["https://wrong.example", "https://right.example"], fetchFn: wire.fetchFn, headLag: idle, race: false, routing: "best" });
    try {
      expect(await pool.request({ method: "eth_blockNumber" })).toBe("0x100");
      expect(wire.calls.filter(({ url }) => url.includes("wrong")).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(pool.snapshot().find(({ url }) => url.includes("wrong"))?.quarantined).toBe(true);
    } finally { pool.close(); }
  });

  test("keeps safe and finalized selectors distinct when a provider opts in", async () => {
    const wire = mock(({ method, params }) => method === "eth_chainId" ? "0x64" : params[1] === "safe" ? "0x20" : "0x10");
    const pool = gnosis({ endpoints: [{ url: "https://finality.example", capabilities: { blockTags: ["latest", "safe", "finalized"] } }], fetchFn: wire.fetchFn, headLag: idle });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await pool.request({ method: "eth_getBalance", params: [address, "safe"] })).toBe("0x20");
        expect(await pool.request({ method: "eth_getBalance", params: [address, "finalized"] })).toBe("0x10");
      }
      expect(wire.calls.filter(({ method }) => method === "eth_getBalance").map(({ params }) => params[1])).toEqual(["safe", "finalized"]);
    } finally { pool.close(); }
  });

  test.each(["safe", "finalized", "0x1"])("does not silently degrade unsupported state selector %s", async (tag) => {
    const wire = mock(({ method }) => identity(method));
    const pool = gnosis({ fetchFn: wire.fetchFn, headLag: idle });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: [address, tag] })).rejects.toThrow();
      expect(wire.calls).toEqual([]);
    } finally { pool.close(); }
  });

  test("routes historical state and debug to configured capable providers with headers", async () => {
    const wire = mock(({ method }) => identity(method));
    const pool = gnosis({
      endpoints: [
        { url: "https://limited.example", capabilities: { archive: false, debug: false } },
        { url: "https://archive.example", headers: { "x-api-key": "fixture-key" }, capabilities: { archive: true, debug: true } },
      ], fetchFn: wire.fetchFn, headLag: idle, race: false,
    });
    try {
      expect(await pool.request({ method: "eth_getBalance", params: [address, "0x1"] })).toBe("0x100");
      expect(await pool.request({ method: "debug_traceTransaction", params: ["0x1234"] })).toBe("0x100");
      expect(wire.calls.every(({ url, headers }) => url.includes("archive") && headers.get("x-api-key") === "fixture-key")).toBe(true);
      expect(wire.calls[1]?.params).toEqual([address, "0x1"]);
    } finally { pool.close(); }
  });

  test("preserves execution quantities and extra receipt fields without token conversion", async () => {
    const receipt = { blockNumber: "0x100", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", status: "0x1", extraFeeAccounting: { nativeToken: "xDAI", amount: "0xde0b6b3a7640000" } };
    const wire = mock(({ method }) => method === "eth_chainId" ? "0x64" : receipt);
    const pool = gnosis({ fetchFn: wire.fetchFn, headLag: idle });
    try { expect(await pool.request({ method: "eth_getTransactionReceipt", params: ["0x1234"] })).toEqual(receipt); }
    finally { pool.close(); }
  });

  test("returns batch partial errors without losing successful siblings", async () => {
    const wire = mock(({ method, params }) => method === "eth_chainId" ? "0x64" : params[0] === "invalid" ? new Error("invalid address") : "0x10");
    const pool = gnosis({ endpoints: [{ url: "https://batch.example", capabilities: { batch: true, maxBatchSize: 2 } }], batch: { batchSize: 2, wait: 1 }, fetchFn: wire.fetchFn, headLag: idle, race: false });
    try {
      const results = await pool.requestBatch([{ method: "eth_getBalance", params: [address, "latest"] }, { method: "eth_getBalance", params: ["invalid", "latest"] }]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "0x10" });
      expect(results[1]?.status).toBe("rejected");
    } finally { pool.close(); }
  });

  test("cancels before dispatch and bounds upstream work by operation budget", async () => {
    const wire = mock(({ method }) => identity(method));
    const pool = gnosis({ endpoints: ["https://bounded.example"], fetchFn: wire.fetchFn, headLag: idle, operationBudget: { maxRequests: 1 } });
    try {
      const controller = new AbortController(); controller.abort();
      await expect(pool.request({ method: "eth_blockNumber", signal: controller.signal })).rejects.toThrow();
      expect(wire.calls).toEqual([]);
      await expect(pool.request({ method: "eth_blockNumber" })).rejects.toThrow();
      expect(wire.calls.map(({ method }) => method)).toEqual(["eth_chainId"]);
    } finally { pool.close(); }
  });

  test("does not use probes as latency samples and expires stale execution heads", async () => {
    let now = 100;
    const wire = mock(({ method, url }) => method === "eth_chainId" ? "0x64" : url.includes("a.example") ? "0x100" : "0x101");
    const pool = gnosis({ endpoints: ["https://a.example", "https://b.example"], fetchFn: wire.fetchFn, now: () => now, headLag: { probeInterval: false, staleMs: 1_000 } });
    try {
      await pool.probe();
      expect(pool.snapshot().map(({ head }) => head)).toEqual([256, 257]);
      expect(pool.snapshot().every(({ methods }) => (methods["*"]?.n ?? 0) === 0)).toBe(true);
      now += 1_001;
      expect(pool.snapshot().every(({ lag }) => lag === null)).toBe(true);
    } finally { pool.close(); }
  });

  test("successful probes cannot clear an outstanding call failure streak", async () => {
    const events: RpcEvent[] = [];
    const pool = gnosis({ endpoints: ["https://failure.example"], headLag: idle, retryCount: 0, race: false, onEvent: (event) => events.push(event),
      fetchFn: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Body;
        return body.method === "eth_getBalance" ? new Response("Unavailable", { status: 503 }) : Response.json({ jsonrpc: "2.0", id: body.id, result: identity(body.method) });
      },
    });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
      await pool.probe();
      await expect(pool.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
      await expect(pool.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
      expect(events.some((event) => event.type === "eject" && event.failures === 3)).toBe(true);
    } finally { pool.close(); }
  });
});
