import { describe, expect, test } from "vitest";
import type { RpcEvent } from "@smart-rpc/core";
import {
  celo, CELO_CHAIN_ID, CELO_MAINNET_CAIP, CELO_NATIVE_CURRENCY,
  CELO_MAINNET_REGISTRY, CELO_RPC_URL, CELO_WEBSOCKET_URL,
  CELO_SEPOLIA_CHAIN_ID, CELO_SEPOLIA_CAIP, CELO_SEPOLIA_RPC_URL,
  type CeloOptions,
} from "../src/index.js";

interface Body { id: number; method: string; params?: unknown[] }
interface Call { url: string; method: string; params: unknown[]; headers: Headers }
class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
function fixture(answer: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const batches: number[] = [];
  return {
    calls, batches,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body)) as Body | Body[];
      const run = async (request: Body) => {
        const call = { url, method: request.method, params: request.params ?? [], headers: new Headers(init?.headers) };
        calls.push(call);
        const result = await answer(call);
        if (result instanceof Response) return result;
        return result instanceof RpcError
          ? { jsonrpc: "2.0", id: request.id, error: { code: result.code, message: result.message } }
          : { jsonrpc: "2.0", id: request.id, result };
      };
      if (Array.isArray(body)) { batches.push(body.length); return Response.json(await Promise.all(body.map(run))); }
      const result = await run(body);
      return result instanceof Response ? result : Response.json(result);
    },
  };
}
const idle = { probeInterval: false } as const;
const address = "0x1111111111111111111111111111111111111111";
// Source-backed examples intentionally distinguish adapter and token addresses.
const usdcAdapter = "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B";
const usdcToken = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const usdtAdapter = "0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72";

describe("Celo transport", () => {
  test("uses mainnet CELO metadata and a lazy documented Forno default", () => {
    const mock = fixture(() => "0xa4ec");
    const client = celo({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(CELO_CHAIN_ID).toBe(42220);
      expect(CELO_NATIVE_CURRENCY).toEqual({ name: "Celo", symbol: "CELO", decimals: 18 });
      expect(client.chainIds).toEqual([CELO_MAINNET_CAIP]);
      expect(client.endpoints.map(({ url }) => url)).toEqual([CELO_RPC_URL]);
      expect(CELO_MAINNET_REGISTRY[0]?.rps).toBeUndefined();
      expect(CELO_WEBSOCKET_URL).toBe("wss://forno.celo.org/ws");
      expect(mock.calls).toEqual([]);
    } finally { client.close(); }
  });

  test("selects current Celo Sepolia and rejects retired Alfajores", async () => {
    const mock = fixture(({ method }) => method === "eth_chainId" ? `0x${CELO_SEPOLIA_CHAIN_ID.toString(16)}` : "0x64");
    const client = celo({ chainId: CELO_SEPOLIA_CHAIN_ID, fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(client.chainIds).toEqual([CELO_SEPOLIA_CAIP]);
      expect(client.endpoints[0]?.url).toBe(CELO_SEPOLIA_RPC_URL);
      expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
      expect(() => celo({ chainId: 44787 } as unknown as CeloOptions)).toThrow(/Alfajores is retired/);
    } finally { client.close(); }
  });

  test("quarantines wrong-chain responses before the user call", async () => {
    const events: RpcEvent[] = [];
    const mock = fixture(({ method, url }) => method === "eth_chainId" ? url.includes("wrong") ? "0x1" : "0xa4ec" : "0x64");
    const client = celo({ endpoints: ["https://wrong.example", "https://celo.example"], fetchFn: mock.fetchFn,
      headLag: idle, race: false, routing: "best", onEvent: (event) => events.push(event) });
    try {
      expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
      expect(mock.calls.filter(({ url }) => url.includes("wrong")).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(events.some((event) => event.type === "quarantine" && event.expected === CELO_CHAIN_ID)).toBe(true);
    } finally { client.close(); }
  });

  test("preserves adapter feeCurrency, calldata, value and extra fields in estimates", async () => {
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xa4ec" : "0x186a0");
    const client = celo({ fetchFn: mock.fetchFn, headLag: idle });
    const transaction = { to: usdcToken, from: address, value: "0x0", data: "0xa9059cbb", feeCurrency: usdcAdapter, maxFeePerGas: "0x12" };
    try {
      expect(await client.request({ method: "eth_estimateGas", params: [transaction] })).toBe("0x186a0");
      expect(mock.calls.at(-1)?.params).toEqual([transaction]);
      expect((mock.calls.at(-1)?.params[0] as typeof transaction).feeCurrency).not.toBe(usdcToken);
    } finally { client.close(); }
  });

  test("distinguishes fee currencies in both concurrent coalescing and cached reads", async () => {
    const mock = fixture(async ({ method, params }) => {
      if (method === "eth_chainId") return "0xa4ec";
      await new Promise((resolve) => setTimeout(resolve, 5));
      return (params[0] as { feeCurrency: string }).feeCurrency === usdcAdapter ? "0x01" : "0x02";
    });
    const client = celo({ fetchFn: mock.fetchFn, headLag: idle, race: false });
    const usd = { method: "eth_call", params: [{ to: address, feeCurrency: usdcAdapter }, "latest"] };
    const tether = { method: "eth_call", params: [{ to: address, feeCurrency: usdtAdapter }, "latest"] };
    try {
      expect(await Promise.all([client.request(usd), client.request(tether), client.request(usd)]))
        .toEqual(["0x01", "0x02", "0x01"]);
      expect(mock.calls.filter(({ method }) => method === "eth_call")).toHaveLength(2);
      expect(await client.request(usd)).toBe("0x01");
      expect(await client.request(tether)).toBe("0x02");
      expect(mock.calls.filter(({ method }) => method === "eth_call")).toHaveLength(2);
    } finally { client.close(); }
  });

  test("preserves Celo receipt feeCurrency and OP fee fields without decimal conversions", async () => {
    const receipt = { transactionHash: `0x${"ab".repeat(32)}`, feeCurrency: usdtAdapter, gasUsed: "0x186a0",
      effectiveGasPrice: "0x123456", l1Fee: "0x1234", l1GasUsed: "0x567", type: "0x7b" };
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xa4ec" : receipt);
    const client = celo({ fetchFn: mock.fetchFn, headLag: idle });
    try { expect(await client.request({ method: "eth_getTransactionReceipt", params: [receipt.transactionHash] })).toEqual(receipt); }
    finally { client.close(); }
  });

  test("does not hedge, coalesce or cache signed Celo transactions", async () => {
    const events: RpcEvent[] = [];
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xa4ec" : `0x${"ab".repeat(32)}`);
    const client = celo({ endpoints: ["https://a.example", "https://b.example"], fetchFn: mock.fetchFn,
      headLag: idle, rebroadcastRawTransactions: false, onEvent: (event) => events.push(event) });
    try {
      const request = { method: "eth_sendRawTransaction", params: ["0x7b010203"] };
      await Promise.all([client.request(request), client.request(request)]);
      await client.request(request);
      expect(mock.calls.filter(({ method }) => method === request.method)).toHaveLength(3);
      expect(events.filter((event) => ["race", "coalesce", "cache"].includes(event.type))).toEqual([]);
    } finally { client.close(); }
  });

  test("rejects unsupported Forno signing, archive and finality requests without downgrading state", async () => {
    const mock = fixture(() => "0xa4ec");
    const client = celo({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      for (const request of [
        { method: "eth_sendTransaction", params: [{ to: address, feeCurrency: usdcAdapter }] },
        ...["0x1", "safe", "finalized"].map((tag) => ({ method: "eth_getBalance", params: [address, tag] })),
        { method: "debug_traceTransaction", params: ["0x00"] },
      ]) await expect(client.request(request)).rejects.toThrow();
      expect(mock.calls).toEqual([]);
    } finally { client.close(); }
  });

  test("allows dedicated headers and explicit archive/finality capabilities while preserving tags", async () => {
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xa4ec" : "0x42");
    const client = celo({ endpoints: [{ url: "https://dedicated.example", headers: { "x-api-key": "fixture" },
      capabilities: { archive: true, blockTags: ["latest", "safe", "finalized"] } }], fetchFn: mock.fetchFn, headLag: idle });
    try {
      for (const tag of ["0x1", "safe", "finalized"]) expect(await client.request({ method: "eth_getBalance", params: [address, tag] })).toBe("0x42");
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance").map(({ params }) => params[1])).toEqual(["0x1", "safe", "finalized"]);
      expect(mock.calls.every(({ headers }) => headers.get("x-api-key") === "fixture")).toBe(true);
    } finally { client.close(); }
  });

  test("never pins current-state Forno calls to a historical block", async () => {
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xa4ec" : method === "eth_blockNumber" ? "0x64" : "0x42");
    const client = celo({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      await client.probe();
      await client.request({ method: "eth_call", params: [{ to: address, feeCurrency: usdcAdapter }, "latest"] });
      expect(mock.calls.at(-1)?.params[1]).toBe("latest");
    } finally { client.close(); }
  });

  test("cancels before dispatch without consuming identity budget", async () => {
    const mock = fixture(() => "0xa4ec");
    const client = celo({ fetchFn: mock.fetchFn, headLag: idle });
    const controller = new AbortController(); controller.abort();
    try {
      await expect(client.request({ method: "eth_blockNumber", signal: controller.signal })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
    } finally { client.close(); }
  });

  test("bounds retries and total operation calls including chain verification", async () => {
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xa4ec" : new Response("Unavailable", { status: 503 }));
    const client = celo({ fetchFn: mock.fetchFn, headLag: idle, retryCount: 9, race: false,
      operationBudget: { maxRequests: 3 }, retryDelay: 1, random: () => 0 });
    try {
      await expect(client.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
      expect(mock.calls.map(({ method }) => method)).toEqual(["eth_chainId", "eth_getBalance", "eth_getBalance"]);
    } finally { client.close(); }
  });

  test("retains successful batch siblings and an invalid-parameters error", async () => {
    const mock = fixture(({ method, params }) => method === "eth_chainId" ? "0xa4ec" : params[0] === "invalid" ? new RpcError(-32602, "invalid address") : "0x42");
    const client = celo({ endpoints: [{ url: "https://batch.example", capabilities: { batch: true, maxBatchSize: 2 } }],
      batch: { batchSize: 2, wait: 1 }, fetchFn: mock.fetchFn, headLag: idle, race: false, retryCount: 0 });
    try {
      const results = await client.requestBatch([
        { method: "eth_getBalance", params: [address, "latest"] },
        { method: "eth_getBalance", params: ["invalid", "latest"] },
      ]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "0x42" });
      expect(results[1]?.status).toBe("rejected");
      expect(mock.batches.every((size) => size <= 2)).toBe(true);
    } finally { client.close(); }
  });

  test("probes expire stale heads and do not enter call latency samples", async () => {
    let now = 100;
    const mock = fixture(({ method, url }) => method === "eth_chainId" ? "0xa4ec" : url.includes("a.example") ? "0x64" : "0x65");
    const client = celo({ endpoints: ["https://a.example", "https://b.example"], fetchFn: mock.fetchFn,
      headLag: { probeInterval: false, staleMs: 1_000 }, now: () => now });
    try {
      await client.probe();
      expect(client.snapshot().map(({ head }) => head)).toEqual([100, 101]);
      expect(client.snapshot().every(({ methods }) => (methods["*"]?.n ?? 0) === 0)).toBe(true);
      now += 1_001;
      expect(client.snapshot().every(({ lag }) => lag === null)).toBe(true);
    } finally { client.close(); }
  });

  test("successful probes cannot heal failed caller requests", async () => {
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xa4ec" : method === "eth_blockNumber" ? "0x64" : new Response("Unavailable", { status: 503 }));
    const client = celo({ fetchFn: mock.fetchFn, headLag: idle, retryCount: 0, race: false, cache: false });
    try {
      for (let index = 0; index < 3; index += 1) {
        await expect(client.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
        await client.probe();
      }
      expect(client.snapshot()[0]?.ejected).toBe(true);
    } finally { client.close(); }
  });
});
