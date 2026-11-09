import { afterEach, describe, expect, test, vi } from "vitest";
import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";
import type { RpcPool } from "@smart-rpc/core";

import {
  BSC_CHAIN_ID,
  BSC_EXTENSION_METHODS,
  BSC_MAINNET_CAIP,
  BSC_MAINNET_ENDPOINTS,
  BSC_MAINNET_REGISTRY,
  BSC_NATIVE_CURRENCY,
  BSC_PUBLIC_RATE_LIMIT,
  BSC_RPC_URL,
  bsc,
  type BscOptions,
} from "../src/index.js";

interface Call { url: string; method: string; params: unknown[]; headers: Headers }
interface WireRequest { id: number; method: string; params: unknown[] }

function mockRpc(answer: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const batches: number[] = [];
  return {
    calls,
    batches,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = (typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).replace(/\/$/, "");
      const body = JSON.parse(String(init?.body)) as WireRequest | WireRequest[];
      async function respond(request: WireRequest) {
        const call = { url, method: request.method, params: request.params, headers: new Headers(init?.headers) };
        calls.push(call);
        const result = await answer(call);
        if (result instanceof Response) return result;
        if (typeof result === "object" && result !== null && "rpcError" in result) {
          return { jsonrpc: "2.0", id: request.id, error: result.rpcError };
        }
        return { jsonrpc: "2.0", id: request.id, result };
      }
      if (Array.isArray(body)) {
        batches.push(body.length);
        return Response.json(await Promise.all(body.map(respond)));
      }
      const result = await respond(body);
      return result instanceof Response ? result : Response.json(result);
    },
  };
}

const clients: RpcPool[] = [];
const officialDataseeds = [BSC_RPC_URL, "https://bsc-dataseed-public.bnbchain.org"];
function client(options: BscOptions = {}): RpcPool {
  const pool = bsc({ headLag: { probeInterval: false }, ...options });
  clients.push(pool);
  return pool;
}
afterEach(() => { for (const pool of clients.splice(0)) pool.close(); vi.useRealTimers(); });

describe("BNB Smart Chain defaults", () => {
  test("registers BSC mainnet and documented public defaults without network side effects", () => {
    const mock = mockRpc(() => "0x38");
    const pool = client({ fetchFn: mock.fetchFn });
    expect(BSC_CHAIN_ID).toBe(56);
    expect(pool.chainIds).toEqual([BSC_MAINNET_CAIP]);
    expect(BSC_NATIVE_CURRENCY).toEqual({ name: "BNB", symbol: "BNB", decimals: 18 });
    expect(BSC_MAINNET_REGISTRY.map(({ url }) => url)).toEqual(BSC_MAINNET_ENDPOINTS);
    expect(BSC_MAINNET_ENDPOINTS.length).toBeLessThanOrEqual(5);
    expect(pool.endpoints.map(({ url }) => url)).toEqual(BSC_MAINNET_ENDPOINTS);
    expect(BSC_PUBLIC_RATE_LIMIT).toEqual({ requests: 10_000, windowMs: 300_000 });
    expect(BSC_MAINNET_REGISTRY.every(({ sourceUrls }) => sourceUrls.length > 0)).toBe(true);
    expect(mock.calls).toEqual([]);
  });

  test("quarantines an Ethereum endpoint before sending it a BSC user call", async () => {
    const mock = mockRpc(({ url, method }) => method === "eth_chainId" ? url === BSC_RPC_URL ? "0x1" : "0x38" : "0x10");
    const pool = client({ endpoints: officialDataseeds, fetchFn: mock.fetchFn, routing: "best", race: false });
    await expect(pool.request({ method: "eth_blockNumber" })).resolves.toBe("0x10");
    expect(mock.calls.filter(({ url }) => url === BSC_RPC_URL).map(({ method }) => method)).toEqual(["eth_chainId"]);
    expect(pool.snapshot().find(({ url }) => url === BSC_RPC_URL)?.quarantined).toBe(true);
  });

  test("routes logs only to an explicitly added capable provider", async () => {
    const logs = [{ address: "0x0000000000000000000000000000000000000001", topics: [], data: "0x" }];
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x38" : logs);
    const pool = client({
      endpoints: [BSC_RPC_URL, "https://logs.example/rpc"],
      fetchFn: mock.fetchFn,
      routing: "best",
      race: false,
    });
    await expect(pool.request({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2" }] })).resolves.toEqual(logs);
    expect(mock.calls.every(({ url }) => url === "https://logs.example/rpc")).toBe(true);
    expect(pool.snapshot().find(({ url }) => url === BSC_RPC_URL)?.ejected).toBe(false);
  });

  test("routes logs to registry peers that serve them, never to the dataseeds", async () => {
    const logs = [{ address: "0x0000000000000000000000000000000000000001", topics: [], data: "0x" }];
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x38" : logs);
    const thirdweb = "https://56.rpc.thirdweb.com";
    const pool = client({ endpoints: [...officialDataseeds, thirdweb], fetchFn: mock.fetchFn, routing: "best", race: false });
    await expect(pool.request({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2" }] })).resolves.toEqual(logs);
    const logCalls = mock.calls.filter(({ method }) => method === "eth_getLogs");
    expect(logCalls.length).toBeGreaterThan(0);
    expect(logCalls.every(({ url }) => url === thirdweb)).toBe(true);
  });

  test("enables historical state only on live-verified archive defaults", () => {
    expect(BSC_MAINNET_REGISTRY.filter(({ capabilities }) => capabilities?.archive).map(({ id }) => id)).toEqual(["bsc-thirdweb"]);
    expect(BSC_MAINNET_REGISTRY.every(({ capabilities }) => capabilities?.batch === false && capabilities.pinning === false)).toBe(true);
    // Pocket's BSC suppliers reject address-less log filters with a terminal -32602.
    expect(BSC_MAINNET_REGISTRY.filter(({ unsupportedMethods }) => !unsupportedMethods?.includes("eth_getLogs")).map(({ id }) => id))
      .toEqual(["bsc-publicnode", "bsc-thirdweb"]);
  });

  test.each(["eth_getLogs", ...BSC_EXTENSION_METHODS, "debug_traceTransaction", "trace_block"])("rejects unsupported public %s without an upstream call or endpoint penalty", async (method) => {
    const mock = mockRpc(() => "0x38");
    const pool = client({ endpoints: officialDataseeds, fetchFn: mock.fetchFn });
    await expect(pool.request({ method, params: [] })).rejects.toThrow();
    expect(mock.calls).toEqual([]);
    expect(pool.snapshot().every(({ ejected }) => !ejected)).toBe(true);
  });

  test("retains latest on public dataseeds and refuses unverified historical/finalized state", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x38" : method === "eth_blockNumber" ? "0x100" : "0x42");
    const pool = client({ endpoints: officialDataseeds, fetchFn: mock.fetchFn, routing: "best", race: false });
    await pool.probe();
    const address = "0x0000000000000000000000000000000000000001";
    await pool.request({ method: "eth_getBalance", params: [address, "latest"] });
    expect(mock.calls.find(({ method }) => method === "eth_getBalance")?.params).toEqual([address, "latest"]);
    await expect(pool.request({ method: "eth_getBalance", params: [address, "0x10"] })).rejects.toThrow();
    await expect(pool.request({ method: "eth_getBalance", params: [address, "finalized"] })).rejects.toThrow();
    expect(mock.calls.filter(({ method }) => method === "eth_getBalance")).toHaveLength(1);
  });
});

describe("configured BSC providers", () => {
  test("preserves BSC finality parameters and blob sidecar fields", async () => {
    const finality = { number: "0x123", hash: "0xabc", extraData: "0x123456", validators: ["0x1"] };
    const sidecars = [{ blockHash: "0xabc", blobSidecar: { blobs: ["0x123"], commitments: ["0x456"], proofs: ["0x789"] } }];
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x38" : method === "eth_getFinalizedHeader" ? finality : sidecars);
    const pool = client({ endpoints: [{
      url: "https://dedicated.example/rpc",
      supportedMethods: ["eth_chainId", "eth_blockNumber", "eth_getFinalizedHeader", "eth_getBlobSidecars"],
    }], fetchFn: mock.fetchFn });
    await expect(pool.request({ method: "eth_getFinalizedHeader", params: [-2] })).resolves.toEqual(finality);
    await expect(pool.request({ method: "eth_getBlobSidecars", params: ["finalized", false] })).resolves.toEqual(sidecars);
    expect(mock.calls.filter(({ method }) => method !== "eth_chainId").map(({ params }) => params)).toEqual([[-2], ["finalized", false]]);
  });

  test("passes dedicated provider headers without adding them to public labels", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x38" : "0x10");
    const pool = client({ endpoints: [{ url: "https://dedicated.example/rpc", headers: { Authorization: "Bearer test-fixture" } }], fetchFn: mock.fetchFn });
    await pool.request({ method: "eth_blockNumber" });
    expect(mock.calls.every(({ headers }) => headers.get("authorization") === "Bearer test-fixture")).toBe(true);
    expect(JSON.stringify(pool.snapshot())).not.toContain("test-fixture");
  });

  test("shares the provider budget between public URLs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const mock = mockRpc(() => "0x10");
    const endpoints: EthereumEndpointConfig[] = officialDataseeds.map((url, index) => ({
      url, rps: 100, burst: 100,
      providerBudget: { rps: 1, burst: 2 },
      supportedMethods: [index === 0 ? "eth_blockNumber" : "eth_gasPrice"],
    }));
    const pool = client({ endpoints, fetchFn: mock.fetchFn, verifyIdentity: false, race: false, cache: false, coalesce: false, pinLatest: false });
    await pool.request({ method: "eth_blockNumber" });
    await pool.request({ method: "eth_gasPrice" });
    const pending = pool.request({ method: "eth_blockNumber" });
    await vi.advanceTimersByTimeAsync(999);
    expect(mock.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("0x10");
    expect(mock.calls).toHaveLength(3);
    expect(new Set(mock.calls.map(({ url }) => url)).size).toBe(2);
  });

  test("retains per-item errors in a configured JSON-RPC batch", async () => {
    const mock = mockRpc(({ method }) => method === "eth_gasPrice" ? { rpcError: { code: -32602, message: "invalid gas fixture" } } : "0x10");
    const pool = client({
      endpoints: [{ url: "https://batch.example/rpc", capabilities: { batch: true, maxBatchSize: 2 } }],
      fetchFn: mock.fetchFn, batch: { batchSize: 2, wait: 1 }, verifyIdentity: false, cache: false, race: false,
    });
    const results = await Promise.allSettled([
      pool.request({ method: "eth_blockNumber" }),
      pool.request({ method: "eth_gasPrice" }),
    ]);
    expect(results[0]).toEqual({ status: "fulfilled", value: "0x10" });
    expect(results[1]?.status).toBe("rejected");
    expect(mock.calls).toHaveLength(2);
    expect(mock.batches).toEqual([2]);
  });

  test("never races or coalesces finalized-header filter creation", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x38" : "0xfilter");
    const pool = client({ endpoints: ["https://a.example", "https://b.example"].map((url) => ({
      url, supportedMethods: ["eth_chainId", "eth_blockNumber", "eth_newFinalizedHeaderFilter"],
    })), fetchFn: mock.fetchFn });
    await Promise.all([
      pool.request({ method: "eth_newFinalizedHeaderFilter", params: [] }),
      pool.request({ method: "eth_newFinalizedHeaderFilter", params: [] }),
    ]);
    expect(mock.calls.filter(({ method }) => method === "eth_newFinalizedHeaderFilter")).toHaveLength(2);
  });

  test("cancelling one coalesced caller preserves the other caller and endpoint health", async () => {
    let release: (value: string) => void = () => undefined;
    const result = new Promise<string>((resolve) => { release = resolve; });
    const mock = mockRpc(() => result);
    const pool = client({ endpoints: ["https://a.example"], fetchFn: mock.fetchFn, verifyIdentity: false, cache: false });
    const abort = new AbortController();
    const first = pool.request({ method: "eth_getBalance", params: ["0x1", "latest"], signal: abort.signal });
    const second = pool.request({ method: "eth_getBalance", params: ["0x1", "latest"] });
    abort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    release("0x10");
    await expect(second).resolves.toBe("0x10");
    expect(mock.calls).toHaveLength(1);
    expect(pool.snapshot()[0]?.ejected).toBe(false);
  });

  test("caps transient retries at the shared initial attempt plus two retries", async () => {
    const mock = mockRpc(() => new Response("unavailable", { status: 503 }));
    const pool = client({
      endpoints: ["https://a.example", "https://b.example", "https://c.example"],
      fetchFn: mock.fetchFn, verifyIdentity: false, race: false, cache: false, random: () => 0,
    });
    await expect(pool.request({ method: "eth_getBalance", params: ["0x1", "latest"] })).rejects.toThrow();
    expect(mock.calls).toHaveLength(3);
  });

  test("successful head probes do not clear failed-call breaker history or add latency samples", async () => {
    const mock = mockRpc(({ method }) => method === "eth_blockNumber" ? "0x10" : new Response("unavailable", { status: 503 }));
    const pool = client({ endpoints: ["https://a.example"], fetchFn: mock.fetchFn, verifyIdentity: false, race: false, retryCount: 0 });
    for (let n = 0; n < 3; n++) {
      await expect(pool.request({ method: "eth_getBalance", params: ["0x1", "latest"] })).rejects.toThrow();
      if (n < 2) await pool.probe();
    }
    expect(pool.snapshot()[0]?.ejected).toBe(true);
    expect(pool.snapshot()[0]?.methods.eth_blockNumber?.n ?? 0).toBe(0);
    expect(mock.calls.filter(({ method }) => method === "eth_blockNumber")).toHaveLength(2);
  });

  test("ignores stale head samples after the configured BSC freshness window", async () => {
    let now = 0;
    const mock = mockRpc(({ url }) => url === "https://a.example" ? "0x10" : "0x20");
    const pool = client({
      endpoints: ["https://a.example", "https://b.example"],
      fetchFn: mock.fetchFn,
      verifyIdentity: false,
      now: () => now,
      headLag: { probeInterval: false, staleMs: 100, maxAhead: 100 },
    });
    await pool.probe();
    expect(pool.snapshot().find(({ url }) => url === "https://a.example")?.lag).toBe(16);
    now = 101;
    expect(pool.snapshot().every(({ lag }) => lag === null)).toBe(true);
  });
});
