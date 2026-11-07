import { describe, expect, test } from "vitest";
import type { RpcEvent } from "@smart-rpc/core";

import {
  etherlink, requestLogs, ETHERLINK_CHAIN_ID, ETHERLINK_MAINNET_CAIP,
  ETHERLINK_MAINNET_REGISTRY, ETHERLINK_MAINNET_ENDPOINTS, ETHERLINK_NATIVE_CURRENCY,
  ETHERLINK_PRECOMPILES, ETHERLINK_PUBLIC_LIMITS, ETHERLINK_RELAY_URL, ETHERLINK_RPC_URL,
} from "../src/index.js";

interface Call { id: number; url: string; method: string; params: unknown[]; headers: Headers }
interface Body { id: number; method: string; params?: unknown[] }
const chain = "0xa729";
const account = "0x1111111111111111111111111111111111111111";
const idle = { probeInterval: false } as const;

function mockRpc(answer: (call: Call) => unknown | Promise<unknown> = ({ method }) => method === "eth_chainId" ? chain : "0x64") {
  const calls: Call[] = [];
  const batches: number[] = [];
  return {
    calls, batches,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body)) as Body | Body[];
      const run = async (request: Body) => {
        const call = { id: request.id, url, method: request.method, params: request.params ?? [], headers: new Headers(init?.headers) };
        calls.push(call);
        const result = await answer(call);
        return result instanceof Response ? result : { jsonrpc: "2.0", id: request.id, result };
      };
      if (Array.isArray(body)) {
        batches.push(body.length);
        const results = await Promise.all(body.map(run));
        return Response.json(await Promise.all(results.map((result) => result instanceof Response ? result.json() : result)));
      }
      const result = await run(body);
      return result instanceof Response ? result : Response.json(result);
    },
  };
}

describe("Etherlink EVM transport", () => {
  test("is lazy and uses documented identity, XTZ decimals, provider limits and full RPC", () => {
    const mock = mockRpc();
    const pool = etherlink({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(ETHERLINK_CHAIN_ID).toBe(42793);
      expect(ETHERLINK_NATIVE_CURRENCY).toEqual({ name: "Tez", symbol: "XTZ", decimals: 18 });
      expect(pool.chainIds).toEqual([ETHERLINK_MAINNET_CAIP]);
      expect(pool.endpoints.map(({ url }) => url)).toEqual(ETHERLINK_MAINNET_ENDPOINTS);
      expect(ETHERLINK_MAINNET_ENDPOINTS).toEqual([ETHERLINK_RPC_URL]);
      expect(ETHERLINK_PUBLIC_LIMITS).toEqual({ requestsPerMinute: 1000, maxLogBlockRange: 500, maxLogResults: 5000 });
      const entry = ETHERLINK_MAINNET_REGISTRY[0]!;
      expect(entry.rps! * 60 + entry.burst!).toBeLessThan(1000);
      expect(entry.providerBudget).toEqual({ rps: entry.rps, burst: entry.burst });
      expect(entry.capabilities?.maxBatchSize).toBeUndefined();
      expect(mock.calls).toEqual([]);
    } finally { pool.close(); }
  });

  test.each([ETHERLINK_RELAY_URL, `${ETHERLINK_RELAY_URL}/?token=test`, "https://RELAY.MAINNET.ETHERLINK.COM./rpc"])(
    "rejects restricted relay %s before identity or health probes", (url) => {
      const mock = mockRpc();
      expect(() => etherlink({ endpoints: [url], fetchFn: mock.fetchFn })).toThrow(/relay endpoints/);
      expect(mock.calls).toEqual([]);
    },
  );

  test.each(["https://michelson.etherlink.mainnet.octez.io", "https://self.example/tezlink", "https://self.example/michelson/chains/main"])(
    "rejects the Michelson interface %s", (url) => {
      expect(() => etherlink({ endpoints: [url] })).toThrow(/EVM interface only/);
    },
  );

  test("does not synthesize a public WebSocket endpoint", () => {
    expect(() => etherlink({ endpoints: ["wss://node.mainnet.etherlink.com"] })).toThrow(/no public WebSocket/);
    const pool = etherlink({ endpoints: ["wss://verified-provider.example/etherlink/ws"], headLag: idle });
    expect(pool.endpoints[0]?.url).toBe("wss://verified-provider.example/etherlink/ws");
    pool.close();
  });

  test("verifies identity before reads and quarantines an Ethereum endpoint", async () => {
    const events: RpcEvent[] = [];
    const mock = mockRpc(({ method, url }) => method === "eth_chainId" ? url.includes("wrong") ? "0x1" : chain : "0x64");
    const pool = etherlink({ endpoints: ["https://wrong.example", "https://correct.example"], fetchFn: mock.fetchFn, headLag: idle, race: false, routing: "best", onEvent: (event) => events.push(event) });
    try {
      expect(await pool.request({ method: "eth_blockNumber" })).toBe("0x64");
      expect(mock.calls.filter(({ url }) => url.includes("wrong")).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(events.some((event) => event.type === "quarantine" && event.expected === 42793)).toBe(true);
      await expect(pool.request({ chainId: "tezos:NetXohUVN5QWR4f", method: "eth_blockNumber" })).rejects.toThrow();
    } finally { pool.close(); }
  });

  test("keeps public default restrictions when callers supply its URL directly", async () => {
    const mock = mockRpc();
    const pool = etherlink({ endpoints: [`${ETHERLINK_RPC_URL}/`], fetchFn: mock.fetchFn, headLag: idle });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: [account, "0x1"] })).rejects.toThrow();
      await expect(pool.request({ method: "eth_getBalance", params: [account, "finalized"] })).rejects.toThrow();
      await expect(pool.request({ method: "debug_traceTransaction", params: ["0x1234"] })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
    } finally { pool.close(); }
  });

  test("routes archive requests only to a configured provider and preserves HTTP headers", async () => {
    const mock = mockRpc();
    const pool = etherlink({
      endpoints: [ETHERLINK_RPC_URL, { url: "https://archive.example", headers: { "x-api-key": "fixture-only" }, capabilities: { archive: true, blockTags: ["latest", "safe", "finalized"] } }],
      fetchFn: mock.fetchFn, headLag: idle, race: false,
    });
    try {
      expect(await pool.request({ method: "eth_getBalance", params: [account, "0x1"] })).toBe("0x64");
      expect(mock.calls.every(({ url }) => url.includes("archive.example"))).toBe(true);
      expect(mock.calls.at(-1)?.params).toEqual([account, "0x1"]);
      expect(mock.calls.every(({ headers }) => headers.get("x-api-key") === "fixture-only")).toBe(true);
    } finally { pool.close(); }
  });

  test("keeps latest, safe and finalized distinct on a verified dedicated provider", async () => {
    const mock = mockRpc(({ method, params }) => method === "eth_chainId" ? chain : params[1]);
    const pool = etherlink({ endpoints: [{ url: "https://tags.example", capabilities: { blockTags: ["latest", "safe", "finalized"], archive: true } }], fetchFn: mock.fetchFn, headLag: idle });
    try {
      for (const tag of ["latest", "safe", "finalized"]) expect(await pool.request({ method: "eth_getBalance", params: [account, tag] })).toBe(tag);
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance").map(({ params }) => params[1])).toEqual(["latest", "safe", "finalized"]);
    } finally { pool.close(); }
  });

  test("does not numerically pin public latest-only defaults after health probing", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? chain : "0x64");
    const pool = etherlink({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      await pool.probe();
      await pool.request({ method: "eth_getBalance", params: [account, "latest"] });
      expect(mock.calls.at(-1)?.params).toEqual([account, "latest"]);
    } finally { pool.close(); }
  });

  test("rejects a 501-block public log request before upstream and splits explicitly into bounded ranges", async () => {
    const mock = mockRpc(({ method, params }) => method === "eth_chainId" ? chain : method === "eth_getLogs" ? [{ range: params[0] }] : "0x64");
    const pool = etherlink({ fetchFn: mock.fetchFn, headLag: idle, race: false });
    const filter = { address: account, fromBlock: "0x1", toBlock: "0x1f5", topics: ["0x1234"] };
    try {
      await expect(pool.request({ method: "eth_getLogs", params: [filter] })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
      const logs = await requestLogs(pool, filter, { maxBlockRange: ETHERLINK_PUBLIC_LIMITS.maxLogBlockRange });
      expect(logs).toHaveLength(2);
      const ranges = mock.calls.filter(({ method }) => method === "eth_getLogs").map(({ params }) => params[0]);
      expect(ranges).toEqual([{ ...filter, toBlock: "0x1f4" }, { ...filter, fromBlock: "0x1f5" }]);
    } finally { pool.close(); }
  });

  test("preserves provider too-many-logs errors without returning a partial split result", async () => {
    const mock = mockRpc(({ id, method, params }) => method === "eth_chainId" ? chain : method === "eth_getLogs" && (params[0] as { fromBlock: string }).fromBlock === "0x1f5"
      ? Response.json({ jsonrpc: "2.0", id, error: { code: -32005, message: "more than 5000 logs" } })
      : [{ data: "0x12" }]);
    const pool = etherlink({ fetchFn: mock.fetchFn, headLag: idle, race: false, retryCount: 0 });
    try {
      await expect(requestLogs(pool, { fromBlock: "0x1", toBlock: "0x1f5" }, { maxBlockRange: 500 })).rejects.toThrow(/no partial result/);
      expect(mock.calls.filter(({ method }) => method === "eth_getLogs")).toHaveLength(2);
    } finally { pool.close(); }
  });

  test.each(Object.values(ETHERLINK_PRECOMPILES))("preserves EVM precompile destination, calldata and native value for %s", async (to) => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? chain : "0x002a");
    const pool = etherlink({ endpoints: ["https://precompile.example"], fetchFn: mock.fetchFn, headLag: idle });
    const transaction = { to, data: "0x12345678002a", value: "0xde0b6b3a7640000" };
    try {
      expect(await pool.request({ method: "eth_call", params: [transaction, "latest"] })).toBe("0x002a");
      expect(mock.calls.at(-1)?.params).toEqual([transaction, "latest"]);
      expect(mock.calls.every(({ url }) => new URL(url).origin === "https://precompile.example")).toBe(true);
    } finally { pool.close(); }
  });

  test("preserves NAC callMichelsonView ABI bytes and Micheline result bytes", async () => {
    // ABI encoding of callMichelsonView(string,string,bytes), with a KT1 string,
    // view 'balance' and Micheline Unit 0x030b. The transport performs no conversion.
    const data = "0x8326329c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000244b5431576a385355476d6e455046717961684841636a634e5177653659476845584a623500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000762616c616e6365000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002030b000000000000000000000000000000000000000000000000000000000000";
    const result = `0x${"20".padStart(64, "0")}${"02".padStart(64, "0")}${"002a".padEnd(64, "0")}`;
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? chain : result);
    const pool = etherlink({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(await pool.request({ method: "eth_call", params: [{ to: ETHERLINK_PRECOMPILES.nativeAtomicGateway, data }, "latest"] })).toBe(result);
      expect(mock.calls.at(-1)?.params).toEqual([{ to: ETHERLINK_PRECOMPILES.nativeAtomicGateway, data }, "latest"]);
    } finally { pool.close(); }
  });

  test("does not race, coalesce or cache signed bridge submissions", async () => {
    const events: RpcEvent[] = [];
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? chain : `0x${"ab".repeat(32)}`);
    const pool = etherlink({ endpoints: ["https://a.example", "https://b.example"], fetchFn: mock.fetchFn, headLag: idle, onEvent: (event) => events.push(event) });
    try {
      const request = { method: "eth_sendRawTransaction", params: ["0x1234"] };
      await Promise.all([pool.request(request), pool.request(request)]);
      await pool.request(request);
      expect(mock.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(3);
      expect(events.filter(({ type }) => ["race", "coalesce", "cache"].includes(type))).toEqual([]);
    } finally { pool.close(); }
  });

  test("retains per-item errors and respects explicit HTTP batch caps", async () => {
    const mock = mockRpc(({ id, method }) => method === "eth_chainId" ? chain : method === "eth_call"
      ? Response.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "invalid input" } }) : "0x64");
    const pool = etherlink({ endpoints: [{ url: "https://batch.example", capabilities: { batch: true, maxBatchSize: 2 } }], fetchFn: mock.fetchFn, headLag: idle, race: false, batch: { batchSize: 10, wait: 1 } });
    try {
      const results = await pool.requestBatch([{ method: "eth_blockNumber" }, { method: "eth_call", params: [{ to: account }, "latest"] }]);
      expect(results).toMatchObject([{ status: "fulfilled", value: "0x64" }, { status: "rejected", reason: expect.any(Error) }]);
      expect(mock.batches.every((size) => size <= 2)).toBe(true);
      expect(mock.calls.filter(({ method }) => method === "eth_call")).toHaveLength(1);
    } finally { pool.close(); }
  });

  test("cancellation before dispatch sends no request and does not poison health", async () => {
    const mock = mockRpc();
    const pool = etherlink({ fetchFn: mock.fetchFn, headLag: idle });
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(pool.request({ method: "eth_blockNumber", signal: controller.signal })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
      expect(pool.snapshot()[0]).toMatchObject({ ejected: false, quarantined: false, inflight: 0 });
    } finally { pool.close(); }
  });

  test("bounds retries and identity checks by a total operation budget", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? chain : new Response("unavailable", { status: 503 }));
    const pool = etherlink({ endpoints: ["https://retry.example"], fetchFn: mock.fetchFn, headLag: idle, race: false, retryCount: 10, retryDelay: 1, operationBudget: { maxRequests: 3 } });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: [account, "latest"] })).rejects.toThrow();
      expect(mock.calls).toHaveLength(3);
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance")).toHaveLength(2);
    } finally { pool.close(); }
  });

  test("charges the documented public allowance for identity, probes and caller traffic", async () => {
    const mock = mockRpc();
    const pool = etherlink({ fetchFn: mock.fetchFn, headLag: idle, now: () => 1000, cache: false });
    try {
      await pool.probe();
      expect(pool.snapshot()[0]?.tokens).toBe(2);
      await pool.request({ method: "eth_getBalance", params: [account, "latest"] });
      await pool.request({ method: "eth_getCode", params: [account, "latest"] });
      expect(pool.snapshot()[0]?.tokens).toBe(0);
      expect(mock.calls.map(({ method }) => method)).toEqual(["eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_getCode"]);
    } finally { pool.close(); }
  });

  test("probes do not train call latency or erase failed call streaks", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? chain : method === "eth_blockNumber" ? "0x64" : new Response("unavailable", { status: 503 }));
    const pool = etherlink({ endpoints: ["https://probe.example"], fetchFn: mock.fetchFn, headLag: idle, race: false, retryCount: 0 });
    const request = { method: "eth_getBalance", params: [account, "latest"] };
    try {
      await expect(pool.request(request)).rejects.toThrow();
      const before = pool.snapshot()[0]?.methods["*"];
      await pool.probe();
      expect(pool.snapshot()[0]?.methods["*"]?.n).toBe(before?.n);
      expect(pool.snapshot()[0]?.methods["*"]?.ewma).toBe(before?.ewma);
      await expect(pool.request(request)).rejects.toThrow();
      await expect(pool.request(request)).rejects.toThrow();
      expect(pool.snapshot()[0]?.ejected).toBe(true);
    } finally { pool.close(); }
  });

  test("expires stale full-block heads using the configured clock", async () => {
    let now = 1000;
    const mock = mockRpc(({ method, url }) => method === "eth_chainId" ? chain : url.includes("first") ? "0x64" : "0x65");
    const pool = etherlink({ endpoints: ["https://first.example", "https://second.example"], fetchFn: mock.fetchFn, now: () => now, headLag: { probeInterval: false, staleMs: 1000 } });
    try {
      await pool.probe();
      expect(pool.snapshot().map(({ lag }) => lag)).toEqual([1, 0]);
      now += 1001;
      expect(pool.snapshot().map(({ lag }) => lag)).toEqual([null, null]);
    } finally { pool.close(); }
  });
});
