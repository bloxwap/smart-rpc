import { describe, expect, test } from "vitest";
import type { RpcEvent } from "@smart-rpc/core";

import {
  arc, ARC_CHAIN_ID, ARC_MAINNET_CAIP, ARC_MAINNET_REGISTRY, ARC_MAINNET_ENDPOINTS,
  ARC_NATIVE_CURRENCY, ARC_NATIVE_TRANSFER_EMITTER, ARC_RPC_URL, ARC_USDC_ERC20_ADDRESS, ARC_USDC_ERC20_DECIMALS,
} from "../src/index.js";

const address = "0x1111111111111111111111111111111111111111";
const zero = "0x0000000000000000000000000000000000000000";
const idle = { probeInterval: false } as const;
interface Call { url: string; method: string; params: unknown[]; headers: Headers }
interface Wire { id: number; method: string; params?: unknown[] }
interface RpcFailure { error: { code: number; message: string; data?: string } }

function mockRpc(answer: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const batches: number[] = [];
  return {
    calls, batches,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body)) as Wire | Wire[];
      const run = async (wire: Wire) => {
        const call = { url, method: wire.method, params: wire.params ?? [], headers: new Headers(init?.headers) };
        calls.push(call);
        const value = await answer(call);
        if (value instanceof Response) return value;
        const error = value && typeof value === "object" && "error" in value ? (value as RpcFailure).error : undefined;
        return { jsonrpc: "2.0", id: wire.id, ...(error ? { error } : { result: value }) };
      };
      if (Array.isArray(body)) { batches.push(body.length); return Response.json(await Promise.all(body.map(run))); }
      const result = await run(body);
      return result instanceof Response ? result : Response.json(result);
    },
  };
}

describe("Arc", () => {
  test("has a fixed chain identity, USDC native units, and lazy documented HTTP defaults", () => {
    const mock = mockRpc(() => "0x13b2");
    const client = arc({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(ARC_CHAIN_ID).toBe(5042);
      expect(client.chainIds).toEqual([ARC_MAINNET_CAIP]);
      expect(ARC_NATIVE_CURRENCY).toEqual({ name: "USDC", symbol: "USDC", decimals: 18 });
      expect(ARC_USDC_ERC20_DECIMALS).toBe(6);
      expect(client.endpoints.map(({ url }) => url)).toEqual(ARC_MAINNET_REGISTRY.map(({ url }) => url));
      expect(ARC_MAINNET_REGISTRY.map(({ url }) => url)).toEqual(ARC_MAINNET_ENDPOINTS);
      expect(ARC_MAINNET_REGISTRY.length).toBeLessThanOrEqual(5);
      expect(ARC_MAINNET_ENDPOINTS.length).toBeLessThanOrEqual(5);
      expect(ARC_MAINNET_REGISTRY.every((entry) => entry.rps === undefined && entry.capabilities?.maxBatchSize === undefined)).toBe(true);
      expect(ARC_MAINNET_REGISTRY.find(({ provider }) => provider === "Blockdaemon")?.webSocketUrl)
        .toBe("wss://rpc.blockdaemon.mainnet.arc.io/websocket");
      expect(ARC_MAINNET_REGISTRY.find(({ url }) => url === ARC_RPC_URL)?.webSocketUrl).toBeUndefined();
      const drpc = ARC_MAINNET_REGISTRY.find(({ provider }) => provider === "dRPC");
      expect(drpc?.sourceUrls).toContain("https://drpc.org/docs/howitworks/ratelimiting");
      expect(drpc?.unsupportedMethods).toEqual([
        "eth_newFilter", "eth_newBlockFilter", "eth_newPendingTransactionFilter",
        "eth_getFilterChanges", "eth_getFilterLogs", "eth_uninstallFilter",
      ]);
      expect(mock.calls).toHaveLength(0);
    } finally { client.close(); }
  });

  test("quarantines a different chain before sending a user request", async () => {
    const mock = mockRpc(({ url, method }) => method === "eth_chainId" ? url.includes("wrong") ? "0x1" : "0x13b2" : "0x64");
    const client = arc({ endpoints: ["https://wrong.example", "https://arc.example"], fetchFn: mock.fetchFn, headLag: idle, race: false, routing: "best" });
    try {
      expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
      expect(mock.calls.filter(({ url }) => url.includes("wrong")).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(client.snapshot().find(({ url }) => url.includes("wrong"))?.quarantined).toBe(true);
    } finally { client.close(); }
  });

  test("preserves native balance hex without applying ERC-20 decimal conversion", async () => {
    const native = `0x${(10n ** 18n + 1n).toString(16)}`;
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x13b2" : native);
    const client = arc({ endpoints: [ARC_RPC_URL], fetchFn: mock.fetchFn, headLag: idle, race: false });
    try {
      expect(await client.request({ method: "eth_getBalance", params: [address, "latest"] })).toBe(native);
    } finally { client.close(); }
  });

  test("relays Arc gas estimates and fee fields without imposing Ethereum gas policy", async () => {
    const tx = { from: address, to: ARC_USDC_ERC20_ADDRESS, value: "0x1", maxFeePerGas: "0x4a817c800", authorizationList: [] };
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x13b2" : "0xb71b");
    const client = arc({ endpoints: [ARC_RPC_URL], fetchFn: mock.fetchFn, headLag: idle, race: false });
    try {
      expect(await client.request({ method: "eth_estimateGas", params: [tx] })).toBe("0xb71b");
      expect(mock.calls.find(({ method }) => method === "eth_estimateGas")?.params).toEqual([tx]);
    } finally { client.close(); }
  });

  test.each(["Zero address not allowed", "Native value transfer blocked"])("returns deterministic native transfer revert: %s", async (message) => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x13b2" : { error: { code: 3, message: `execution reverted: ${message}`, data: "0xdeadbeef" } });
    const client = arc({ endpoints: ["https://a.example", "https://b.example"], fetchFn: mock.fetchFn, headLag: idle, race: false, retryCount: 2 });
    try {
      await expect(client.request({ method: "eth_estimateGas", params: [{ from: address, to: zero, value: "0x1" }] })).rejects.toThrow(message);
      expect(mock.calls.filter(({ method }) => method === "eth_estimateGas")).toHaveLength(1);
      expect(client.snapshot().every(({ ejected }) => !ejected)).toBe(true);
    } finally { client.close(); }
  });

  test("preserves system and ERC-20 transfer logs with their separate unit encodings", async () => {
    const topic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const topics = [topic, `0x${zero.slice(2).padStart(64, "0")}`, `0x${address.slice(2).padStart(64, "0")}`];
    const logs = [
      { address: ARC_NATIVE_TRANSFER_EMITTER, topics, data: `0x${(10n ** 18n).toString(16).padStart(64, "0")}`, logIndex: "0x0" },
      { address: ARC_USDC_ERC20_ADDRESS, topics, data: `0x${(10n ** 6n).toString(16).padStart(64, "0")}`, logIndex: "0x1" },
    ];
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x13b2" : logs);
    const client = arc({ endpoints: [ARC_RPC_URL], fetchFn: mock.fetchFn, headLag: idle, race: false });
    try {
      const filter = { address: [ARC_NATIVE_TRANSFER_EMITTER, ARC_USDC_ERC20_ADDRESS], fromBlock: "0x10", toBlock: "0x10" };
      expect(await client.request({ method: "eth_getLogs", params: [filter] })).toEqual(logs);
      expect(mock.calls.at(-1)?.params).toEqual([filter]);
    } finally { client.close(); }
  });

  test("requires configured archive, debug and finality-tag capabilities without downgrading state", async () => {
    const mock = mockRpc(() => "0x13b2");
    const primary = ARC_MAINNET_REGISTRY.find(({ url }) => url === ARC_RPC_URL)!;
    const client = arc({ endpoints: [primary], fetchFn: mock.fetchFn, headLag: idle });
    try {
      for (const tag of ["0x1", "safe", "finalized"]) {
        await expect(client.request({ method: "eth_getBalance", params: [address, tag] })).rejects.toThrow();
      }
      await expect(client.request({ method: "debug_traceTransaction", params: ["0x01"] })).rejects.toThrow();
      expect(mock.calls).toHaveLength(0);
    } finally { client.close(); }
  });

  test("dedicated headers and explicitly enabled finality tags are preserved", async () => {
    const mock = mockRpc(({ method, params }) => method === "eth_chainId" ? "0x13b2" : params[1] === "finalized" ? "0x1" : "0x2");
    const client = arc({
      endpoints: [{ url: "https://private.example", headers: { "x-api-key": "fixture" }, capabilities: { archive: true, blockTags: ["safe", "finalized"] } }],
      fetchFn: mock.fetchFn, headLag: idle,
    });
    try {
      expect(await client.request({ method: "eth_getBalance", params: [address, "finalized"] })).toBe("0x1");
      expect(await client.request({ method: "eth_getBalance", params: [address, "safe"] })).toBe("0x2");
      expect(mock.calls.every(({ headers }) => headers.get("x-api-key") === "fixture")).toBe(true);
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance").map(({ params }) => params[1])).toEqual(["finalized", "safe"]);
    } finally { client.close(); }
  });

  test("retains per-item batch errors", async () => {
    const mock = mockRpc(({ method, params }) => method === "eth_chainId" ? "0x13b2" : params[0] === "bad" ? { error: { code: -32602, message: "invalid address" } } : "0x1");
    const client = arc({ endpoints: [{ url: "https://batch.example", capabilities: { batch: true, maxBatchSize: 2 } }], batch: true, fetchFn: mock.fetchFn, headLag: idle, race: false });
    try {
      const results = await client.requestBatch([
        { method: "eth_getBalance", params: [address, "latest"] },
        { method: "eth_getBalance", params: ["bad", "latest"] },
      ]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "0x1" });
      expect(results[1]?.status).toBe("rejected");
      expect(mock.batches.every((size) => size <= 2)).toBe(true);
    } finally { client.close(); }
  });

  test("bounds retries and all upstream requests within one operation", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x13b2" : new Response("Unavailable", { status: 503 }));
    const client = arc({ endpoints: ["https://arc.example"], fetchFn: mock.fetchFn, headLag: idle, race: false, retryCount: 10, retryDelay: 1, operationBudget: { maxRequests: 3 } });
    try {
      await expect(client.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
      expect(mock.calls).toHaveLength(3);
    } finally { client.close(); }
  });

  test("a pre-cancelled call sends no identity or user request", async () => {
    const mock = mockRpc(() => "0x13b2");
    const client = arc({ endpoints: [ARC_RPC_URL], fetchFn: mock.fetchFn, headLag: idle });
    const controller = new AbortController(); controller.abort();
    try {
      await expect(client.request({ method: "eth_blockNumber", signal: controller.signal })).rejects.toThrow();
      expect(mock.calls).toHaveLength(0);
    } finally { client.close(); }
  });

  test("probes update liveness without latency and expire stale block heads", async () => {
    let now = 100;
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x13b2" : "0x64");
    const client = arc({ endpoints: ["https://arc.example"], fetchFn: mock.fetchFn, now: () => now, headLag: { probeInterval: false, staleMs: 1000 } });
    try {
      await client.probe();
      expect(client.snapshot()[0]?.head).toBe(100);
      expect(client.snapshot()[0]?.methods["*"]?.n ?? 0).toBe(0);
      now += 1001;
      expect(client.snapshot()[0]?.lag).toBeNull();
    } finally { client.close(); }
  });

  test("writes are neither raced nor coalesced", async () => {
    const events: RpcEvent[] = [];
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x13b2" : `0x${"a".repeat(64)}`);
    const client = arc({ endpoints: ["https://a.example", "https://b.example"], fetchFn: mock.fetchFn, headLag: idle, onEvent: (event) => events.push(event) });
    try {
      await Promise.all([client.request({ method: "eth_sendRawTransaction", params: ["0x1234"] }), client.request({ method: "eth_sendRawTransaction", params: ["0x1234"] })]);
      expect(mock.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(2);
      expect(events.some(({ type }) => type === "race" || type === "coalesce")).toBe(false);
    } finally { client.close(); }
  });

  test("successful liveness probes do not heal a user-call failure streak", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x13b2" : method === "eth_blockNumber" ? "0x64" : new Response("Unavailable", { status: 503 }));
    const client = arc({ endpoints: ["https://arc.example"], fetchFn: mock.fetchFn, headLag: idle, race: false, retryCount: 0 });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(client.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
        if (attempt < 2) await client.probe();
      }
      expect(client.snapshot()[0]?.ejected).toBe(true);
    } finally { client.close(); }
  });
});
