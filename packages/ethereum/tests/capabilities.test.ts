import { describe, expect, test } from "vitest";
import { supportsEvmRequest, ethereum, requestLogs } from "../src/index.js";

type Wire = { id: number; method: string; params: unknown[] };
function fixture(resolve: (request: Wire, url: string) => unknown = () => "0x2a") {
  const calls: { url: string; request: Wire; headers: Headers }[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body)) as Wire | Wire[];
    const respond = (request: Wire) => {
      calls.push({ url, request, headers: new Headers(init?.headers) });
      const result = request.method === "eth_chainId" ? "0x1" : resolve(request, url);
      if (result instanceof Error) return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: result.message } };
      return { jsonrpc: "2.0", id: request.id, result };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(respond) : respond(body)), { headers: { "content-type": "application/json" } });
  };
  return { calls, fetchFn };
}

describe("endpoint capability routing", () => {
  test("denies only known unsupported selectors, not unrelated transaction fields or historical metadata", () => {
    const caps = { archive: false, blockTags: ["latest", "pending"] as const, debug: false, trace: false, maxLogBlockRange: 50, maxLogTopics: 4 };
    expect(supportsEvmRequest(caps, { method: "eth_call", params: [{ value: "0x123" }, "latest"] })).toBe(true);
    expect(supportsEvmRequest(caps, { method: "eth_call", params: [{}, "0x1"] })).toBe(false);
    expect(supportsEvmRequest(caps, { method: "eth_call", params: [{}, { blockHash: "0xab", requireCanonical: true }] })).toBe(false);
    expect(supportsEvmRequest(caps, { method: "eth_getBalance", params: ["0xabc", "finalized"] })).toBe(false);
    expect(supportsEvmRequest(caps, { method: "eth_getBlockByNumber", params: ["0x1", false] })).toBe(true);
    expect(supportsEvmRequest(caps, { method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x32" }] })).toBe(true);
    expect(supportsEvmRequest(caps, { method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x33" }] })).toBe(false);
    expect(supportsEvmRequest(caps, { method: "eth_getLogs", params: [{ topics: [null, null, null, null, null] }] })).toBe(false);
    expect(supportsEvmRequest(caps, { method: "debug_traceTransaction" })).toBe(false);
    expect(supportsEvmRequest(caps, { method: "trace_block", params: ["latest"] })).toBe(false);
  });

  test("routes historical state to a capable endpoint before dispatch, with dedicated headers", async () => {
    const { calls, fetchFn } = fixture();
    const pool = ethereum({
      endpoints: [
        { url: "https://latest.example", capabilities: { archive: false, pinning: false } },
        { url: "https://archive.example", capabilities: { archive: true }, headers: { authorization: "Bearer fixture" } },
      ], fetchFn, race: false, headLag: false, cache: false,
    });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: ["0x00", "0x1"] })).resolves.toBe("0x2a");
      expect(calls.every((entry) => entry.url === "https://archive.example/")).toBe(true);
      expect(calls.every((entry) => entry.headers.get("authorization") === "Bearer fixture")).toBe(true);
      expect(pool.snapshot().every((entry) => !entry.ejected && !entry.quarantined)).toBe(true);
    } finally { pool.close(); }
  });

  test("quarantines a wrong-chain endpoint before any user request", async () => {
    const calls: string[] = [];
    const pool = ethereum({ endpoints: ["https://wrong.example"], headLag: false, retryCount: 0,
      fetchFn: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as Wire;
        calls.push(request.method);
        return Response.json({ jsonrpc: "2.0", id: request.id, result: "0x2" });
      },
    });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: ["0x00", "latest"] })).rejects.toThrow();
      expect(calls).toEqual(["eth_chainId"]);
      expect(pool.snapshot()[0]?.quarantined).toBe(true);
    } finally { pool.close(); }
  });

  test("preserves finality tags, EIP-1898 and type-3 fee fields without formatting", async () => {
    const { calls, fetchFn } = fixture((request) => request.params);
    const pool = ethereum({ endpoints: ["https://fields.example"], fetchFn, headLag: false, race: false, cache: false });
    const tx = { type: "0x3", data: "0x004200", maxFeePerBlobGas: "0x7", blobVersionedHashes: ["0x0100"], maxFeePerGas: "0x2", feeCurrency: "0xabc" };
    try {
      for (const tag of ["pending", "safe", "finalized", { blockHash: "0x123", requireCanonical: true }]) {
        await expect(pool.request({ method: "eth_call", params: [tx, tag] })).resolves.toEqual([tx, tag]);
      }
      expect(calls.filter((call) => call.request.method === "eth_call")).toHaveLength(4);
    } finally { pool.close(); }
  });

  test("never races or coalesces relay writes even when called concurrently", async () => {
    const { calls, fetchFn } = fixture();
    const pool = ethereum({ endpoints: ["https://relay-a.example", "https://relay-b.example"], fetchFn, headLag: false, race: true, safeMethods: ["eth_sendBundle"] });
    try {
      await Promise.all([pool.request({ method: "eth_sendBundle", params: [{ txs: ["0x01"] }] }), pool.request({ method: "eth_sendBundle", params: [{ txs: ["0x01"] }] })]);
      expect(calls.filter((entry) => entry.request.method === "eth_sendBundle")).toHaveLength(2);
    } finally { pool.close(); }
  });

  test("keeps batch partial errors per item", async () => {
    const { fetchFn } = fixture((request) => request.method === "eth_getCode" ? new Error("bad account") : "0x2a");
    const pool = ethereum({ endpoints: [{ url: "https://batch.example", capabilities: { batch: true, maxBatchSize: 2 } }], fetchFn, batch: true, headLag: false, race: false });
    try {
      const results = await pool.requestBatch([
        { method: "eth_getBalance", params: ["0x00", "latest"] },
        { method: "eth_getCode", params: ["0x00", "latest"] },
      ]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "0x2a" });
      expect(results[1]?.status).toBe("rejected");
    } finally { pool.close(); }
  });

  test("bounded log splits preserve params and reject partial results", async () => {
    const { calls, fetchFn } = fixture((request) => request.method === "eth_getLogs" ? [{ filter: request.params[0] }] : "0x2a");
    const pool = ethereum({ endpoints: [{ url: "https://logs.example", capabilities: { maxLogBlockRange: 50 } }], fetchFn, headLag: false, race: false });
    try {
      const filter = { fromBlock: "0x1", toBlock: "0x65", address: "0xabc", topics: ["0x01"] };
      await expect(requestLogs(pool, filter, { maxBlockRange: 50 })).resolves.toHaveLength(3);
      expect(calls.filter((entry) => entry.request.method === "eth_getLogs").map((entry) => entry.request.params[0])).toEqual([
        { ...filter, fromBlock: "0x1", toBlock: "0x32" }, { ...filter, fromBlock: "0x33", toBlock: "0x64" }, { ...filter, fromBlock: "0x65", toBlock: "0x65" },
      ]);
      expect(filter.toBlock).toBe("0x65");
      await expect(requestLogs(pool, filter, { maxBlockRange: 1, maxRequests: 2 })).rejects.toThrow("exceeding maxRequests");
    } finally { pool.close(); }
  });

  test("does not return partial logs when a split rejects", async () => {
    const { fetchFn } = fixture((request) => {
      const filter = request.params[0] as { fromBlock: string };
      return filter.fromBlock === "0x33" ? new Error("rejected range") : [{ blockNumber: filter.fromBlock }];
    });
    const pool = ethereum({ endpoints: ["https://partial.example"], fetchFn, headLag: false, race: false });
    try {
      await expect(requestLogs(pool, { fromBlock: "0x1", toBlock: "0x65" }, { maxBlockRange: 50 })).rejects.toThrow("no partial result");
    } finally { pool.close(); }
  });

  test("cancels an HTTP call without recording an endpoint failure", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let cancelled = false;
    const pool = ethereum({ endpoints: ["https://cancel.example"], verifyIdentity: false, headLag: false,
      fetchFn: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { cancelled = true; reject(init.signal?.reason); }, { once: true });
        started();
      }),
    });
    const controller = new AbortController();
    try {
      const request = pool.request({ method: "eth_getBalance", params: ["0x00", "latest"], signal: controller.signal });
      const rejected = expect(request).rejects.toThrow();
      await ready;
      controller.abort();
      await rejected;
      expect(cancelled).toBe(true);
      expect(pool.snapshot().every((entry) => !entry.ejected && !entry.quarantined && entry.inflight === 0)).toBe(true);
    } finally { pool.close(); }
  });
});
