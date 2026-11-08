import { describe, expect, test } from "vitest";

import { plasma, PLASMA_CHAIN_ID, PLASMA_MAINNET, PLASMA_MAINNET_CAIP, PLASMA_MAINNET_ENDPOINTS, PLASMA_MAINNET_REGISTRY } from "../src/index.js";

interface Call {
  url: string;
  method: string;
  params: unknown[];
  headers: Headers;
}

class RpcFailure {
  constructor(readonly code: number, readonly message: string) {}
}

function mockRpc(answer: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  return {
    calls,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const call = { url, method: body.method, params: body.params, headers: new Headers(init?.headers) };
      calls.push(call);
      const result = await answer(call);
      const payload = result instanceof RpcFailure
        ? { jsonrpc: "2.0", id: body.id, error: { code: result.code, message: result.message } }
        : { jsonrpc: "2.0", id: body.id, result };
      return result instanceof Response ? result : new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
      });
    },
  };
}

const identity = `0x${PLASMA_CHAIN_ID.toString(16)}`;
const offline = { headLag: { probeInterval: false as const }, race: false, cache: false };
const address = "0x0000000000000000000000000000000000001000";

describe("Plasma transport", () => {
  test("creates the documented mainnet lazily with XPL and conservative public capabilities", () => {
    const mock = mockRpc(() => { throw new Error("construction must not fetch"); });
    const client = plasma({ ...offline, fetchFn: mock.fetchFn });
    try {
      expect(client.chainIds).toEqual([PLASMA_MAINNET_CAIP]);
      expect(client.endpoints.map(({ url }) => url)).toEqual(PLASMA_MAINNET_ENDPOINTS);
      expect(PLASMA_MAINNET_ENDPOINTS).toEqual(PLASMA_MAINNET_REGISTRY.map(({ url }) => url));
      expect(client.endpoints.length).toBeLessThanOrEqual(5);
      expect(PLASMA_MAINNET.nativeCurrency).toEqual({ name: "Plasma", symbol: "XPL", decimals: 18 });
      expect(PLASMA_MAINNET.blockTime).toBe(1_000);
      expect(PLASMA_MAINNET_REGISTRY[0].capabilities).toMatchObject({ archive: true, pinning: false, batch: false, subscriptions: false });
      expect(PLASMA_MAINNET_REGISTRY.map(({ provider }) => provider)).toEqual(["Plasma", "Tenderly", "thirdweb"]);
      expect(PLASMA_MAINNET_ENDPOINTS.some((url) => url.includes("tatum.io"))).toBe(false);
      expect(client.snapshot()[0]?.tokens).toBeNull();
      expect(mock.calls).toHaveLength(0);
    } finally { client.close(); }
  });

  test("checks the Plasma identity and quarantines a wrong chain before sending user calls", async () => {
    const mock = mockRpc(({ url, method }) => method === "eth_chainId"
      ? url.includes("wrong") ? "0x1" : identity
      : "0x42");
    const client = plasma({ ...offline, endpoints: ["https://wrong.example/rpc", "https://plasma.example/rpc"], fetchFn: mock.fetchFn, routing: "best" });
    try {
      await expect(client.request({ method: "eth_blockNumber" })).resolves.toBe("0x42");
      expect(mock.calls.filter(({ url }) => url.includes("wrong")).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(client.snapshot()[0]?.quarantined).toBe(true);
    } finally { client.close(); }
  });

  test("replaces defaults and forwards provider authentication headers", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : "0x42");
    const client = plasma({ ...offline, endpoints: [{ url: "https://dedicated.example/rpc", headers: { "x-api-key": "fixture-only" } }], fetchFn: mock.fetchFn });
    try {
      await client.request({ method: "eth_blockNumber" });
      expect(mock.calls.every(({ url, headers }) => url === "https://dedicated.example/rpc" && headers.get("x-api-key") === "fixture-only")).toBe(true);
    } finally { client.close(); }
  });

  test("keeps latest state unpinned on the conservative public endpoint", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : method === "eth_blockNumber" ? "0x42" : "0x0");
    const client = plasma({ ...offline, endpoints: [PLASMA_MAINNET_REGISTRY[0]], fetchFn: mock.fetchFn });
    try {
      await client.probe();
      await client.request({ method: "eth_getBalance", params: [address, "latest"] });
      expect(mock.calls.find(({ method }) => method === "eth_getBalance")?.params).toEqual([address, "latest"]);
    } finally { client.close(); }
  });

  test("routes historical/finalized state only to configured capable providers without degrading the tag", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : "0x0");
    const thirdweb = PLASMA_MAINNET_REGISTRY.find(({ provider }) => provider === "thirdweb")!;
    const client = plasma({ ...offline, endpoints: [thirdweb, {
      url: "https://archive.example/rpc",
      capabilities: { archive: true, blockTags: ["latest", "pending", "safe", "finalized"], pinning: true },
    }], routing: "best", fetchFn: mock.fetchFn });
    try {
      for (const tag of ["0x10", "safe", "finalized"]) {
        await client.request({ method: "eth_getBalance", params: [address, tag] });
      }
      const reads = mock.calls.filter(({ method }) => method === "eth_getBalance");
      expect(reads.map(({ url }) => url)).toEqual(Array(3).fill("https://archive.example/rpc"));
      expect(reads.map(({ params }) => params[1])).toEqual(["0x10", "safe", "finalized"]);
    } finally { client.close(); }
  });

  test("preserves opaque transaction fields and never adds stablecoin sponsorship or fee currency", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : "0x5208");
    const client = plasma({ ...offline, endpoints: ["https://provider.example/rpc"], fetchFn: mock.fetchFn });
    const tx = { from: address, to: address, value: "0x1", maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1", data: "0x" };
    try {
      await client.request({ method: "eth_estimateGas", params: [tx] });
      expect(mock.calls.find(({ method }) => method === "eth_estimateGas")?.params).toEqual([tx]);
      expect(PLASMA_MAINNET.nativeCurrency.symbol).toBe("XPL");
    } finally { client.close(); }
  });

  test("does not coalesce or race raw transaction submissions", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : "0xhash");
    const client = plasma({ ...offline, race: true, endpoints: ["https://one.example/rpc", "https://two.example/rpc"], fetchFn: mock.fetchFn });
    try {
      await Promise.all([1, 2].map(() => client.request({ method: "eth_sendRawTransaction", params: ["0x1234"] })));
      expect(mock.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(2);
    } finally { client.close(); }
  });

  test("cancelling one coalesced reader leaves its peer and endpoint health intact", async () => {
    let release!: (value: string) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const result = new Promise<string>((resolve) => { release = resolve; });
    const mock = mockRpc(({ method }) => {
      if (method === "eth_chainId") return identity;
      started();
      return result;
    });
    const client = plasma({ ...offline, endpoints: ["https://provider.example/rpc"], fetchFn: mock.fetchFn });
    const controller = new AbortController();
    try {
      const cancelled = client.request({ method: "eth_getBalance", params: [address, "latest"], signal: controller.signal });
      const remaining = client.request({ method: "eth_getBalance", params: [address, "latest"] });
      await began;
      const rejection = expect(cancelled).rejects.toThrow();
      controller.abort();
      await rejection;
      release("0x2");
      await expect(remaining).resolves.toBe("0x2");
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance")).toHaveLength(1);
      expect(client.snapshot()[0]?.ejected).toBe(false);
      expect(client.snapshot()[0]?.methods["*"]?.error).toBe(0);
    } finally { release("0x2"); client.close(); }
  });

  test("shares configured tokens between identity and caller traffic", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : "0x1");
    const client = plasma({ ...offline, endpoints: [{ url: "https://provider.example/rpc", rps: 0.1, burst: 2 }], now: () => 0, fetchFn: mock.fetchFn });
    try {
      await client.request({ method: "eth_blockNumber" });
      await expect(client.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow(/budget exhausted/i);
      expect(mock.calls.map(({ method }) => method)).toEqual(["eth_chainId", "eth_blockNumber"]);
    } finally { client.close(); }
  });

  test("expires head comparisons after three normal probe intervals", async () => {
    let now = 0;
    const mock = mockRpc(({ url, method }) => method === "eth_chainId" ? identity : url.includes("slow") ? "0x10" : "0x20");
    const client = plasma({ ...offline, endpoints: ["https://slow.example/rpc", "https://fast.example/rpc"], now: () => now, fetchFn: mock.fetchFn });
    try {
      await client.probe();
      expect(client.snapshot()[0]?.lag).toBe(16);
      now = 12_001;
      expect(client.snapshot().every(({ lag }) => lag === null)).toBe(true);
      expect(client.snapshot().every(({ methods }) => methods["*"]?.n === 0)).toBe(true);
    } finally { client.close(); }
  });

  test("successful probes do not heal failed calls or contribute latency samples", async () => {
    const mock = mockRpc(({ method }) => {
      if (method === "eth_chainId") return identity;
      if (method === "eth_blockNumber") return "0x42";
      return new Response("upstream unavailable", { status: 503 });
    });
    const client = plasma({ ...offline, endpoints: ["https://provider.example/rpc"], retryCount: 0, fetchFn: mock.fetchFn });
    try {
      for (let i = 0; i < 3; i += 1) {
        await expect(client.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
        await client.probe();
      }
      expect(client.snapshot()[0]?.ejected).toBe(true);
      expect(client.snapshot()[0]?.methods["*"]?.n).toBe(3);
    } finally { client.close(); }
  });

  test("retains individual batch errors alongside successful results", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity
      : method === "eth_blockNumber" ? "0x42"
      : new RpcFailure(-32602, "invalid balance parameters"));
    const client = plasma({ ...offline, endpoints: ["https://provider.example/rpc"], fetchFn: mock.fetchFn });
    try {
      const result = await client.requestBatch([
        { method: "eth_blockNumber" },
        { method: "eth_getBalance", params: [] },
      ]);
      expect(result[0]).toEqual({ status: "fulfilled", value: "0x42" });
      expect(result[1]).toMatchObject({ status: "rejected", reason: expect.any(Error) });
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance")).toHaveLength(1);
    } finally { client.close(); }
  });

  test("bounds retries with a single shared operation request budget", async () => {
    const mock = mockRpc(() => new Response("upstream unavailable", { status: 503 }));
    const client = plasma({
      ...offline,
      endpoints: ["https://one.example/rpc", "https://two.example/rpc"],
      fetchFn: mock.fetchFn,
      verifyIdentity: false,
      retryCount: 5,
      operationBudget: { maxRequests: 1 },
    });
    try {
      await expect(client.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
      expect(mock.calls).toHaveLength(1);
    } finally { client.close(); }
  });
});
