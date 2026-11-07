import { describe, expect, test } from "vitest";
import {
  monad, MONAD_CHAIN_ID, MONAD_MAINNET_CAIP, MONAD_MAINNET_ENDPOINTS,
  MONAD_MAINNET_REGISTRY, MONAD_NATIVE_CURRENCY, MONAD_HEAD_LAG,
} from "../src/index.js";

interface Call { url: string; method: string; params: unknown[]; headers: Headers }
type Answer = unknown | { error: { code: number; message: string } };

function mockRpc(answer: (call: Call) => Answer | Promise<Answer>) {
  const calls: Call[] = [];
  const batches: number[] = [];
  return {
    calls, batches,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = JSON.parse(String(init?.body));
      const items = Array.isArray(body) ? body : [body];
      if (Array.isArray(body)) batches.push(body.length);
      const results = await Promise.all(items.map(async (item: { id: number; method: string; params: unknown[] }) => {
        const call = { url, method: item.method, params: item.params, headers: new Headers(init?.headers) };
        calls.push(call);
        const result = await answer(call);
        if (result instanceof Response) return result;
        return { jsonrpc: "2.0", id: item.id, ...(result && typeof result === "object" && "error" in result ? result : { result }) };
      }));
      if (results[0] instanceof Response) return results[0];
      return new Response(JSON.stringify(Array.isArray(body) ? results : results[0]), {
        headers: { "content-type": "application/json" },
      });
    },
  };
}

const quiet = { headLag: { probeInterval: false as const }, race: false, cache: false, budget: false as const };
const address = "0x0000000000000000000000000000000000000001";

describe("Monad registry and identity", () => {
  test("uses chain 143 and MON metadata with documented per-provider limits", () => {
    const mock = mockRpc(() => "0x8f");
    const rpc = monad({ fetchFn: mock.fetchFn, headLag: { probeInterval: false } });
    try {
      expect(MONAD_CHAIN_ID).toBe(143);
      expect(rpc.chainIds).toEqual([MONAD_MAINNET_CAIP]);
      expect(MONAD_NATIVE_CURRENCY).toEqual({ name: "Monad", symbol: "MON", decimals: 18 });
      expect(rpc.endpoints.map(({ url }) => url)).toEqual(MONAD_MAINNET_ENDPOINTS);
      expect(MONAD_MAINNET_REGISTRY).toHaveLength(5);
      for (const endpoint of MONAD_MAINNET_REGISTRY) {
        expect(endpoint.sourceUrls.length).toBeGreaterThan(0);
        expect(endpoint.capabilities?.maxBatchSize).toBe(endpoint.documentedLimits.batchSize);
        if (endpoint.provider === "Monad Foundation") {
          expect(endpoint.documentedLimits).toEqual({ requests: 20, windowMs: 1_000, batchSize: 100, batchesPerSecond: 5 });
          expect(endpoint.providerGroup).toBe("monad-foundation");
          expect(endpoint.providerBudget).toEqual({ rps: 2, burst: 3 });
        } else {
          expect(endpoint.documentedLimits).toEqual({ requests: 300, windowMs: 10_000, batchSize: 10 });
        }
      }
      expect(mock.calls).toEqual([]);
    } finally { rpc.close(); }
  });

  test("quarantines the wrong chain before any user read and verifies its replacement", async () => {
    const mock = mockRpc(({ url, method }) => method === "eth_chainId" ? url.includes("wrong") ? "0x1" : "0x8f" : "0x10");
    const rpc = monad({ ...quiet, endpoints: ["https://wrong.example", "https://right.example"], fetchFn: mock.fetchFn, routing: "best" });
    try {
      await expect(rpc.request({ method: "eth_blockNumber" })).resolves.toBe("0x10");
      expect(mock.calls.filter(({ url }) => url.includes("wrong")).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(rpc.snapshot().find(({ url }) => url.includes("wrong"))?.quarantined).toBe(true);
    } finally { rpc.close(); }
  });

  test("replaces public defaults with dedicated URLs and caller headers", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x8f" : "0x10");
    const rpc = monad({ ...quiet, endpoints: [{ url: "https://dedicated.example/rpc", headers: { "x-rpc-test": "fixture" } }], fetchFn: mock.fetchFn });
    try {
      await rpc.request({ method: "eth_blockNumber" });
      expect(rpc.endpoints).toHaveLength(1);
      expect(mock.calls.every(({ headers }) => headers.get("x-rpc-test") === "fixture")).toBe(true);
    } finally { rpc.close(); }
  });
});

describe("Monad provider capabilities", () => {
  test("routes historical state and debug requests away from public Ankr", async () => {
    const ankr = MONAD_MAINNET_REGISTRY.find(({ provider }) => provider === "Ankr")!;
    const archive = MONAD_MAINNET_REGISTRY[0]!;
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x8f" : "0x1234");
    const rpc = monad({ ...quiet, endpoints: [ankr, archive], fetchFn: mock.fetchFn, routing: "best" });
    try {
      await rpc.request({ method: "eth_call", params: [{ to: address }, "0x1"] });
      await rpc.request({ method: "debug_traceCall", params: [{ to: address }, "latest", {}] });
      expect(mock.calls.filter(({ method }) => method !== "eth_chainId").map(({ url }) => url)).toEqual([new URL(archive.url).toString(), new URL(archive.url).toString()]);
      expect(rpc.snapshot().find(({ url }) => url === ankr.url)?.ejected).toBe(false);
    } finally { rpc.close(); }
  });

  test("keeps Ankr latest-state calls unpinned after a head probe", async () => {
    const ankr = MONAD_MAINNET_REGISTRY.find(({ provider }) => provider === "Ankr")!;
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x8f" : method === "eth_blockNumber" ? "0x100" : "0x");
    const rpc = monad({ ...quiet, endpoints: [ankr], fetchFn: mock.fetchFn });
    try {
      await rpc.probe();
      await rpc.request({ method: "eth_call", params: [{ to: address }, "latest"] });
      expect(mock.calls.find(({ method }) => method === "eth_call")?.params[1]).toBe("latest");
    } finally { rpc.close(); }
  });

  test("preserves finality tags and Monad response fields", async () => {
    const block = { number: "0x100", commitState: "Finalized", blockId: "0x123", baseFeePerGas: "0x456" };
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x8f" : block);
    const rpc = monad({ ...quiet, endpoints: ["https://dedicated.example"], fetchFn: mock.fetchFn });
    try {
      for (const tag of ["latest", "safe", "finalized", "pending"]) {
        await expect(rpc.request({ method: "eth_getBlockByNumber", params: [tag, false] })).resolves.toEqual(block);
      }
      expect(mock.calls.filter(({ method }) => method === "eth_getBlockByNumber").map(({ params }) => params[0])).toEqual(["latest", "safe", "finalized", "pending"]);
    } finally { rpc.close(); }
  });

  test("retains per-item batch errors and caps Ankr wire batches at ten", async () => {
    const ankr = MONAD_MAINNET_REGISTRY.find(({ provider }) => provider === "Ankr")!;
    const mock = mockRpc(({ params, method }) => method === "eth_chainId" ? "0x8f"
      : params[0] === "invalid" ? { error: { code: -32602, message: "Invalid params" } } : "0x10");
    const rpc = monad({ ...quiet, endpoints: [ankr], fetchFn: mock.fetchFn, batch: { batchSize: 100, wait: 1 }, verifyIdentity: false, coalesce: false, pinLatest: false });
    try {
      const results = await rpc.requestBatch(Array.from({ length: 12 }, (_, index) => ({ method: "eth_getBalance", params: [index === 3 ? "invalid" : address, "latest"] })));
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(11);
      expect(results[3]?.status).toBe("rejected");
      expect(mock.batches.length).toBeGreaterThan(0);
      expect(mock.batches.every((size) => size <= 10)).toBe(true);
    } finally { rpc.close(); }
  });

  test("bounds retries with the shared operation request budget", async () => {
    const mock = mockRpc(() => { throw new Error("connection dropped"); });
    const rpc = monad({ ...quiet, endpoints: ["https://one.example", "https://two.example"], fetchFn: mock.fetchFn, verifyIdentity: false, operationBudget: { maxRequests: 2 }, retryCount: 8 });
    try {
      await expect(rpc.request({ method: "eth_blockNumber" })).rejects.toBeInstanceOf(Error);
      expect(mock.calls).toHaveLength(2);
    } finally { rpc.close(); }
  });

  test("honors cancellation before admission without consuming a provider request", async () => {
    const mock = mockRpc(() => "0x10");
    const controller = new AbortController();
    controller.abort();
    const rpc = monad({ ...quiet, fetchFn: mock.fetchFn });
    try {
      await expect(rpc.request({ method: "eth_blockNumber", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(mock.calls).toEqual([]);
    } finally { rpc.close(); }
  });

  test("discards stale Monad heads without mixing probe time into call latency", async () => {
    let now = 0;
    const mock = mockRpc(({ method }) => {
      now += 1;
      return method === "eth_chainId" ? "0x8f" : "0x100";
    });
    const rpc = monad({ ...quiet, endpoints: ["https://one.example", "https://two.example"], fetchFn: mock.fetchFn, now: () => now });
    try {
      await rpc.probe();
      expect(rpc.snapshot().every(({ methods }) => Object.values(methods).every(({ n }) => n === 0))).toBe(true);
      now += MONAD_HEAD_LAG.staleMs + 1;
      expect(rpc.snapshot().every(({ lag }) => lag === null)).toBe(true);
    } finally { rpc.close(); }
  });

  test("a healthy probe does not heal a failed user-call streak", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x8f" : method === "eth_blockNumber" ? "0x10" : new Response("unavailable", { status: 503 }));
    const rpc = monad({ ...quiet, endpoints: ["https://one.example"], fetchFn: mock.fetchFn, retryCount: 0 });
    try {
      for (let index = 0; index < 3; index++) {
        await expect(rpc.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toBeInstanceOf(Error);
        if (index < 2) await rpc.probe();
      }
      expect(rpc.snapshot()[0]?.ejected).toBe(true);
    } finally { rpc.close(); }
  });
});
