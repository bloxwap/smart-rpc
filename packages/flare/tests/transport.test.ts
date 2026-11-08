import { describe, expect, test } from "vitest";

import {
  flare, FLARE_CHAIN_ID, FLARE_MAINNET_CAIP, FLARE_NATIVE_CURRENCY, FLARE_MAINNET_REGISTRY,
  FLARE_MAINNET_ENDPOINTS, FLARE_RPC_URL, FLARE_WS_URL, FLARE_QUICKNODE_RPC_URL, FLARE_QUICKNODE_WS_URL,
} from "../src/index.js";

interface Call { url: string; method: string; params: unknown[]; headers: Headers }
class RpcFailure { constructor(readonly code: number, readonly message: string) {} }
function fixture(answer: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  return {
    calls,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
      const call = { url, method: body.method, params: body.params ?? [], headers: new Headers(init?.headers) };
      calls.push(call);
      const result = await answer(call);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result instanceof RpcFailure
        ? { jsonrpc: "2.0", id: body.id, error: { code: result.code, message: result.message } }
        : { jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
    },
  };
}
const offline = { headLag: { probeInterval: false as const }, race: false, cache: false };
const address = "0x0000000000000000000000000000000000001000";

describe("Flare execution transport", () => {
  test("constructs all exported HTTP defaults lazily with FLR metadata", () => {
    const mock = fixture(() => { throw new Error("unexpected network"); });
    const pool = flare({ ...offline, fetchFn: mock.fetchFn });
    try {
      expect(pool.chainIds).toEqual([FLARE_MAINNET_CAIP]);
      expect(FLARE_CHAIN_ID).toBe(14);
      expect(FLARE_NATIVE_CURRENCY).toEqual({ name: "Flare", symbol: "FLR", decimals: 18 });
      expect(pool.endpoints.map(({ url }) => url)).toEqual(FLARE_MAINNET_ENDPOINTS);
      expect(FLARE_MAINNET_ENDPOINTS).toEqual(FLARE_MAINNET_REGISTRY.map(({ url }) => url));
      expect(FLARE_MAINNET_ENDPOINTS).toEqual(expect.arrayContaining([FLARE_RPC_URL, FLARE_QUICKNODE_RPC_URL]));
      expect(FLARE_MAINNET_ENDPOINTS.length).toBeLessThanOrEqual(5);
      expect(FLARE_WS_URL).toBe("wss://flare-api.flare.network/ext/C/ws");
      expect(FLARE_QUICKNODE_WS_URL).toBe("wss://stylish-light-theorem.flare-mainnet.quiknode.pro/ext/bc/C/ws");
      expect(mock.calls).toHaveLength(0);
      expect(pool.snapshot().every(({ tokens }) => tokens === null)).toBe(true);
    } finally { pool.close(); }
  });

  test.each([
    "https://flr-data-availability.flare.network/api/v0/attestation-client/request",
    "https://fdc-verifiers-mainnet.flare.network/verifier/eth/api-doc",
    "https://flare-api.flare.network/ext/P",
  ])("rejects separate API endpoint %s", (url) => {
    expect(() => flare({ endpoints: [url] })).toThrow(/separate services/);
  });

  test("keeps attestation/verifier namespaces out of the public RPC pool", async () => {
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xe" : "0x1");
    const pool = flare({ ...offline, fetchFn: mock.fetchFn });
    try {
      for (const method of ["fdc_requestAttestation", "ftso_getFeed", "da_getProof"]) {
        await expect(pool.request({ method })).rejects.toThrow(/No RPC endpoint supports/);
      }
      expect(mock.calls).toHaveLength(0);
      // FTSO smart-contract calls are ordinary EVM calls and remain supported.
      await expect(pool.request({ method: "eth_call", params: [{ to: address, data: "0x12345678" }, "latest"] })).resolves.toBe("0x1");
    } finally { pool.close(); }
  });

  test("quarantines another chain before any user call", async () => {
    const mock = fixture(({ url, method }) => method === "eth_chainId" ? url.includes("wrong") ? "0x13" : "0xe" : "0x100");
    const pool = flare({ ...offline, routing: "best", endpoints: ["https://wrong.example/rpc", "https://flare.example/rpc"], fetchFn: mock.fetchFn });
    try {
      await expect(pool.request({ method: "eth_blockNumber" })).resolves.toBe("0x100");
      expect(mock.calls.filter(({ url }) => url.includes("wrong")).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(pool.snapshot()[0]?.quarantined).toBe(true);
    } finally { pool.close(); }
  });

  test("passes dedicated headers and opaque provider paths unchanged", async () => {
    const url = "https://dedicated.example/custom/provider/path";
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xe" : "0x100");
    const pool = flare({ ...offline, endpoints: [{ url, headers: { "x-api-key": "fixture-only" } }], fetchFn: mock.fetchFn });
    try {
      await pool.request({ method: "eth_blockNumber" });
      expect(mock.calls.every((call) => call.url === url && call.headers.get("x-api-key") === "fixture-only")).toBe(true);
    } finally { pool.close(); }
  });

  test("routes explicit finality and historical state only to opted-in capabilities without tag rewriting", async () => {
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xe" : "0x0");
    const pool = flare({ ...offline, routing: "best", endpoints: [FLARE_RPC_URL, {
      url: "https://archive.example/rpc", capabilities: { archive: true, blockTags: ["latest", "safe", "finalized"] },
    }], fetchFn: mock.fetchFn });
    try {
      for (const tag of ["safe", "finalized", "0x1"]) await pool.request({ method: "eth_getBalance", params: [address, tag] });
      const reads = mock.calls.filter(({ method }) => method === "eth_getBalance");
      expect(reads.map(({ url }) => url)).toEqual(Array(3).fill("https://archive.example/rpc"));
      expect(reads.map(({ params }) => params[1])).toEqual(["safe", "finalized", "0x1"]);
    } finally { pool.close(); }
  });

  test("public numeric pinning and advanced debug/trace calls remain disabled", async () => {
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xe" : "0x100");
    const pool = flare({ ...offline, endpoints: [FLARE_RPC_URL], fetchFn: mock.fetchFn });
    try {
      await pool.probe();
      await pool.request({ method: "eth_call", params: [{ to: address, data: "0x5c5d5e" }, "latest"] });
      expect(mock.calls.find(({ method }) => method === "eth_call")?.params[1]).toBe("latest");
      for (const method of ["debug_traceCall", "trace_call"]) await expect(pool.request({ method })).rejects.toThrow();
      expect(mock.calls.some(({ method }) => method.startsWith("debug_") || method.startsWith("trace_"))).toBe(false);
    } finally { pool.close(); }
  });

  test("enabling one verified capability retains other public restrictions", async () => {
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xe" : { gas: "0x5208", failed: false });
    const pool = flare({ ...offline, endpoints: [{
      url: FLARE_RPC_URL,
      capabilities: { debug: true },
      supportedMethods: ["eth_chainId", "debug_traceCall", "eth_getBalance"],
    }], fetchFn: mock.fetchFn });
    try {
      await expect(pool.request({ method: "debug_traceCall", params: [{ to: address }, "latest", {}] }))
        .resolves.toEqual({ gas: "0x5208", failed: false });
      await expect(pool.request({ method: "eth_getBalance", params: [address, "0x1"] })).rejects.toThrow();
      expect(mock.calls.some(({ method }) => method === "eth_getBalance")).toBe(false);
    } finally { pool.close(); }
  });

  test.each(["0x0", "0x2"])("preserves receipt type %s and gas fields without Ethereum fee reconstruction", async (type) => {
    const receipt = { type, status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x5d21dba00", cumulativeGasUsed: "0xa410", feeBurned: "0x1234", logs: [{ address, topics: [], data: "0x" }] };
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xe" : receipt);
    const pool = flare({ ...offline, endpoints: ["https://provider.example/rpc"], fetchFn: mock.fetchFn });
    try { await expect(pool.request({ method: "eth_getTransactionReceipt", params: ["0xhash"] })).resolves.toEqual(receipt); }
    finally { pool.close(); }
  });

  test("preserves Cancun call data/state overrides and sends raw signed writes once per caller", async () => {
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xe" : "0x1");
    const pool = flare({ ...offline, race: true, endpoints: ["https://one.example/rpc", "https://two.example/rpc"], fetchFn: mock.fetchFn });
    const call = { to: address, data: "0x5c5d5e", value: "0x0", maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1" };
    const overrides = { [address]: { code: "0x600160005d60005c60005260206000f3" } };
    try {
      await pool.request({ method: "eth_call", params: [call, "latest", overrides] });
      expect(mock.calls.find(({ method }) => method === "eth_call")?.params).toEqual([call, "latest", overrides]);
      await Promise.all([1, 2].map(() => pool.request({ method: "eth_sendRawTransaction", params: ["0x02abcdef"] })));
      expect(mock.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(2);
    } finally { pool.close(); }
  });

  test("keeps batch successes alongside terminal per-item failures", async () => {
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xe" : method === "eth_blockNumber" ? "0x100" : new RpcFailure(-32602, "invalid parameters"));
    const pool = flare({ ...offline, endpoints: ["https://provider.example/rpc"], fetchFn: mock.fetchFn });
    try {
      const results = await pool.requestBatch([{ method: "eth_blockNumber" }, { method: "eth_getBalance", params: [] }]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "0x100" });
      expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(Error) });
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance")).toHaveLength(1);
    } finally { pool.close(); }
  });

  test("cancellation before sending does not affect endpoint health", async () => {
    const mock = fixture(() => "0xe");
    const pool = flare({ ...offline, fetchFn: mock.fetchFn });
    const controller = new AbortController(); controller.abort();
    try {
      await expect(pool.request({ method: "eth_blockNumber", signal: controller.signal })).rejects.toThrow();
      expect(mock.calls).toHaveLength(0);
      expect(pool.snapshot().every(({ ejected, methods }) => !ejected && methods["*"]?.n === 0)).toBe(true);
    } finally { pool.close(); }
  });

  test("bounds retries using one total operation budget", async () => {
    const mock = fixture(() => new Response("unavailable", { status: 503 }));
    const pool = flare({ ...offline, endpoints: ["https://one.example/rpc", "https://two.example/rpc"], verifyIdentity: false, retryCount: 5, operationBudget: { maxRequests: 1 }, fetchFn: mock.fetchFn });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
      expect(mock.calls).toHaveLength(1);
    } finally { pool.close(); }
  });

  test("expires head comparisons after eighteen seconds, independently of finality", async () => {
    let now = 0;
    const mock = fixture(({ method, url }) => method === "eth_chainId" ? "0xe" : url.includes("behind") ? "0x100" : "0x108");
    const pool = flare({ ...offline, endpoints: ["https://behind.example/rpc", "https://ahead.example/rpc"], now: () => now, fetchFn: mock.fetchFn });
    try {
      await pool.probe();
      expect(pool.snapshot()[0]?.lag).toBe(8);
      now = 18_001;
      expect(pool.snapshot().every(({ lag }) => lag === null)).toBe(true);
      expect(pool.snapshot().every(({ methods }) => methods["*"]?.n === 0)).toBe(true);
    } finally { pool.close(); }
  });

  test("successful probes cannot heal failed calls or count as latency samples", async () => {
    const mock = fixture(({ method }) => method === "eth_chainId" ? "0xe" : method === "eth_blockNumber" ? "0x100" : new Response("unavailable", { status: 503 }));
    const pool = flare({ ...offline, endpoints: ["https://provider.example/rpc"], retryCount: 0, fetchFn: mock.fetchFn });
    try {
      for (let index = 0; index < 3; index += 1) {
        await expect(pool.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
        await pool.probe();
      }
      expect(pool.snapshot()[0]?.ejected).toBe(true);
      expect(pool.snapshot()[0]?.methods["*"]?.n).toBe(3);
    } finally { pool.close(); }
  });
});
