import { describe, expect, test } from "vitest";
import type { RpcEvent } from "@smart-rpc/core";

import {
  xlayer,
  XLAYER_CHAIN_ID,
  XLAYER_MAINNET_CAIP,
  XLAYER_MAINNET_ENDPOINTS,
  XLAYER_MAINNET_REGISTRY,
  XLAYER_MAINNET_WEBSOCKET_ENDPOINTS,
  XLAYER_NATIVE_CURRENCY,
  XLAYER_PUBLIC_PROVIDER_GROUP,
  XLAYER_PUBLIC_RPC_BUDGET,
  XLAYER_RPC_URL,
} from "../src/index.js";

interface Call {
  id: number;
  url: string;
  method: string;
  params: unknown[];
  headers: Headers;
}

function mockRpc(answer: (call: Call) => unknown = ({ method }) => method === "eth_chainId" ? "0xc4" : "0x64") {
  const calls: Call[] = [];
  return {
    calls,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const body = JSON.parse(String(init?.body)) as Pick<Call, "id" | "method" | "params">;
      const call: Call = {
        ...body,
        url: (typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).replace(/\/$/, ""),
        headers: new Headers(init?.headers),
      };
      calls.push(call);
      const result = answer(call);
      return result instanceof Response ? result : new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    },
  };
}

const noTimer = { probeInterval: false } as const;

describe("X Layer defaults", () => {
  test("registers only mainnet and does not connect during construction", () => {
    const mock = mockRpc();
    const client = xlayer({ fetchFn: mock.fetchFn, headLag: noTimer });
    try {
      expect(XLAYER_CHAIN_ID).toBe(196);
      expect(client.chainIds).toEqual([XLAYER_MAINNET_CAIP]);
      expect(XLAYER_NATIVE_CURRENCY).toEqual({ name: "OKB", symbol: "OKB", decimals: 18 });
      expect(client.endpoints.map(({ url }) => url)).toEqual(XLAYER_MAINNET_ENDPOINTS);
      expect(mock.calls).toEqual([]);
      expect(XLAYER_MAINNET_REGISTRY.every((entry) => entry.providerGroup === XLAYER_PUBLIC_PROVIDER_GROUP)).toBe(true);
      expect(XLAYER_PUBLIC_RPC_BUDGET).toEqual({ rps: 100, burst: 100 });
      expect(XLAYER_MAINNET_WEBSOCKET_ENDPOINTS).toEqual(["wss://xlayerws.okx.com", "wss://ws.xlayer.tech"]);
    } finally { client.close(); }
  });

  test("quarantines another chain before any caller request reaches it", async () => {
    const mock = mockRpc(({ method, url }) => method === "eth_chainId" ? url === XLAYER_RPC_URL ? "0x1" : "0xc4" : "0x64");
    const client = xlayer({ fetchFn: mock.fetchFn, headLag: noTimer, routing: "best", race: false });
    try {
      await expect(client.request({ method: "eth_blockNumber" })).resolves.toBe("0x64");
      expect(mock.calls.filter(({ url }) => url === XLAYER_RPC_URL).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(client.snapshot()[0]?.quarantined).toBe(true);
    } finally { client.close(); }
  });

  test("uses block height for liveness and preserves empty txpool and zero protocol results", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xc4"
      : method === "txpool_content" ? {} : method === "eth_protocolVersion" ? "0x0" : "0x64");
    const client = xlayer({ fetchFn: mock.fetchFn, headLag: noTimer, budget: false, race: false });
    try {
      await client.probe();
      expect(new Set(mock.calls.map(({ method }) => method))).toEqual(new Set(["eth_chainId", "eth_blockNumber"]));
      expect(client.snapshot().every(({ head, methods }) => head === 100 && Object.values(methods).every(({ n }) => n === 0))).toBe(true);
      await expect(client.request({ method: "txpool_content" })).resolves.toEqual({});
      await expect(client.request({ method: "eth_protocolVersion" })).resolves.toBe("0x0");
      expect(client.snapshot().every(({ head }) => head === 100)).toBe(true);
    } finally { client.close(); }
  });

  test.each([
    { method: "debug_traceTransaction", params: ["0xabc"] },
    { method: "trace_block", params: ["latest"] },
    { method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", "finalized"] },
    { method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", "0x1"] },
    { method: "eth_subscribe", params: ["newHeads"] },
    { method: "xlayer_undocumentedMethod", params: [] },
  ])("rejects unconfigured public capability $method without a network call", async ({ method, params }) => {
    const mock = mockRpc();
    const client = xlayer({ fetchFn: mock.fetchFn, headLag: noTimer });
    try {
      await expect(client.request({ method, params })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
      expect(client.snapshot().every(({ ejected }) => !ejected)).toBe(true);
    } finally { client.close(); }
  });

  test("keeps latest state requests unpinned on unverified public archive endpoints", async () => {
    const mock = mockRpc();
    const client = xlayer({ fetchFn: mock.fetchFn, headLag: noTimer, budget: false, race: false });
    try {
      await client.probe();
      await client.request({ method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", "latest"] });
      expect(mock.calls.find(({ method }) => method === "eth_getBalance")?.params[1]).toBe("latest");
    } finally { client.close(); }
  });

  test("shares the 100-token public ceiling across both URLs, including explicit public configs", async () => {
    const mock = mockRpc();
    const client = xlayer({
      endpoints: XLAYER_MAINNET_ENDPOINTS.map((url, index) => ({
        url,
        rps: 1_000,
        burst: 1_000,
        supportedMethods: ["eth_chainId", index === 0 ? "eth_blockNumber" : "eth_gasPrice"],
      })),
      fetchFn: mock.fetchFn,
      headLag: noTimer,
      verifyIdentity: false,
      race: false,
      cache: false,
      timeout: 1,
      now: () => 0,
    });
    try {
      for (let index = 0; index < 100; index++) {
        await client.request({ method: index % 2 === 0 ? "eth_blockNumber" : "eth_gasPrice" });
      }
      expect(new Set(mock.calls.map(({ url }) => url))).toEqual(new Set(XLAYER_MAINNET_ENDPOINTS));
      await expect(client.request({ method: "eth_gasPrice" })).rejects.toThrow();
      expect(mock.calls).toHaveLength(100);
    } finally { client.close(); }
  });
});

describe("X Layer dedicated providers", () => {
  test("replaces public URLs, passes headers, and preserves trace and transaction extensions", async () => {
    const payload = { gas: "0x52ff", returnValue: "0x", xlayerExtension: { arbitrary: "0x01" } };
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xc4" : payload);
    const client = xlayer({
      endpoints: [{ url: "https://private.example/rpc", headers: { "x-api-key": "test-only" }, capabilities: { debug: true } }],
      fetchFn: mock.fetchFn, headLag: noTimer,
    });
    try {
      await expect(client.request({ method: "debug_traceTransaction", params: ["0xabc", { tracer: "callTracer" }] })).resolves.toEqual(payload);
      expect(mock.calls.every(({ url, headers }) => url === "https://private.example/rpc" && headers.get("x-api-key") === "test-only")).toBe(true);
      expect(mock.calls.find(({ method }) => method === "debug_traceTransaction")?.params).toEqual(["0xabc", { tracer: "callTracer" }]);
    } finally { client.close(); }
  });

  test("keeps per-item batch errors and successes", async () => {
    const mock = mockRpc(({ method, id }) => method === "eth_chainId" ? "0xc4" : method === "eth_call"
      ? new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } }), { headers: { "content-type": "application/json" } })
      : "0x64");
    const client = xlayer({ endpoints: ["https://private.example/rpc"], fetchFn: mock.fetchFn, headLag: noTimer });
    try {
      const result = await client.requestBatch([
        { method: "eth_blockNumber" },
        { method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000001" }, "latest"] },
      ]);
      expect(result[0]).toEqual({ status: "fulfilled", value: "0x64" });
      expect(result[1]).toEqual({ status: "rejected", reason: expect.any(Error) });
    } finally { client.close(); }
  });

  test("does not send or penalize pre-cancelled requests", async () => {
    const mock = mockRpc();
    const client = xlayer({ endpoints: ["https://private.example/rpc"], fetchFn: mock.fetchFn, headLag: noTimer });
    try {
      await expect(client.request({ method: "eth_blockNumber", signal: AbortSignal.abort() })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
      expect(client.snapshot()[0]).toMatchObject({ ejected: false, inflight: 0, methods: {} });
    } finally { client.close(); }
  });

  test("bounds failed safe reads by the shared operation budget", async () => {
    const mock = mockRpc(() => new Response("temporarily unavailable", { status: 503 }));
    const client = xlayer({
      endpoints: ["https://one.example/rpc", "https://two.example/rpc", "https://three.example/rpc"],
      fetchFn: mock.fetchFn, headLag: noTimer, verifyIdentity: false, race: false, retryCount: 10,
      operationBudget: { maxRequests: 2 },
    });
    try {
      await expect(client.request({ method: "eth_blockNumber" })).rejects.toThrow();
      expect(mock.calls).toHaveLength(2);
    } finally { client.close(); }
  });

  test("expires stale peer heads and keeps probes out of latency samples", async () => {
    let now = 0;
    const mock = mockRpc(({ method, url }) => method === "eth_chainId" ? "0xc4" : url.includes("one") ? "0x64" : "0x68");
    const client = xlayer({
      endpoints: ["https://one.example/rpc", "https://two.example/rpc"],
      fetchFn: mock.fetchFn, headLag: { probeInterval: false, staleMs: 5_000 }, now: () => now,
    });
    try {
      await client.probe();
      expect(client.snapshot()[0]?.lag).toBe(4);
      expect(client.snapshot().every(({ methods }) => Object.values(methods).every(({ n }) => n === 0))).toBe(true);
      now = 5_001;
      expect(client.snapshot().every(({ lag }) => lag === null)).toBe(true);
    } finally { client.close(); }
  });

  test("successful probes do not heal failed caller requests", async () => {
    const events: RpcEvent[] = [];
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xc4" : method === "eth_blockNumber" ? "0x64" : new Response("unavailable", { status: 503 }));
    const client = xlayer({
      endpoints: ["https://private.example/rpc"], fetchFn: mock.fetchFn, headLag: noTimer,
      retryCount: 0, cache: false, onEvent: (event) => events.push(event),
    });
    try {
      for (let index = 0; index < 3; index++) {
        await expect(client.request({ method: "eth_gasPrice" })).rejects.toThrow();
        if (index < 2) await client.probe();
      }
      expect(client.snapshot()[0]?.ejected).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: "eject", failures: 3 }));
    } finally { client.close(); }
  });
});
