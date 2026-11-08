import { describe, expect, test } from "vitest";

import { createPoolScope, type RpcEvent } from "@smart-rpc/core";

import {
  HYPEREVM_MAINNET_CAIP,
  HYPEREVM_MAINNET_ENDPOINTS,
  HYPEREVM_MAINNET_REGISTRY,
  HYPEREVM_RPC_URL,
  HYPEREVM_TESTNET_CAIP,
  HYPEREVM_TESTNET_ENDPOINTS,
  HYPEREVM_TESTNET_REGISTRY,
  HYPEREVM_TESTNET_RPC_URL,
  hyperevm,
} from "../src/index.js";

interface Call {
  url: string;
  method: string;
  params: unknown[];
}

function mockRpc(answer: (call: Call) => unknown | Response): {
  calls: Call[];
  fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
} {
  const calls: Call[] = [];
  return {
    calls,
    async fetchFn(input, init): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const call = { url, method: body.method, params: body.params };
      calls.push(call);
      const result = answer(call);
      return result instanceof Response
        ? result
        : new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
            headers: { "content-type": "application/json" },
          });
    },
  };
}

describe("hyperevm public defaults", () => {
  test("loads separate source-backed mainnet and testnet pools without making requests", () => {
    const mock = mockRpc(() => "0x1");
    const client = hyperevm({ fetchFn: mock.fetchFn, headLag: { probeInterval: false } });
    try {
      expect(client.chainIds).toEqual([HYPEREVM_MAINNET_CAIP, HYPEREVM_TESTNET_CAIP]);
      expect(HYPEREVM_MAINNET_ENDPOINTS.length).toBeGreaterThan(1);
      const rankedMainnet = HYPEREVM_MAINNET_REGISTRY.filter((endpoint) => endpoint.eligible);
      expect(rankedMainnet.map((endpoint) => endpoint.rank)).toEqual(rankedMainnet.map((_, index) => index + 1));
      expect(HYPEREVM_MAINNET_ENDPOINTS).toEqual(rankedMainnet.map((endpoint) => endpoint.url));
      expect(HYPEREVM_TESTNET_ENDPOINTS.length).toBeGreaterThan(1);
      expect(HYPEREVM_TESTNET_ENDPOINTS).toContain(HYPEREVM_TESTNET_RPC_URL);
      const rows = client.snapshot?.() ?? [];
      expect(rows.map((row) => row.url)).toEqual([
        ...HYPEREVM_MAINNET_ENDPOINTS,
        ...HYPEREVM_TESTNET_ENDPOINTS,
      ]);
      for (const endpoint of [...HYPEREVM_MAINNET_REGISTRY, ...HYPEREVM_TESTNET_REGISTRY]) {
        expect(endpoint.sourceUrls.length).toBeGreaterThan(0);
        const row = rows.find((item) => item.url === endpoint.url);
        if (!endpoint.eligible) {
          expect(row).toBeUndefined();
          continue;
        }
        expect(row?.tokens).toBe(endpoint.burst);
        expect(row?.weight).toBe(endpoint.weight);
      }
      expect(mock.calls).toEqual([]);
    } finally {
      client.close?.();
    }
  });

  test.each([
    { chainId: 999 as const, primary: HYPEREVM_MAINNET_ENDPOINTS[0]!, identity: "0x3e7" },
    { chainId: 998 as const, primary: HYPEREVM_TESTNET_ENDPOINTS[0]!, identity: "0x3e6" },
  ])("fails over a default RPC's rate limit on chain $chainId and verifies its replacement", async ({ chainId, primary, identity }) => {
    const events: RpcEvent[] = [];
    const mock = mockRpc(({ url, method }) => {
      if (method === "eth_chainId") return identity;
      if (new URL(url).href === new URL(primary).href) return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "5" },
      });
      return "0x10";
    });
    const client = hyperevm({
      chainId,
      fetchFn: mock.fetchFn,
      headLag: { probeInterval: false },
      routing: "best",
      race: false,
      onEvent: (event) => events.push(event),
    });
    try {
      await expect(client.request({ method: "eth_blockNumber" })).resolves.toBe("0x10");
      const reads = mock.calls.filter((call) => call.method === "eth_blockNumber");
      expect(reads).toHaveLength(2);
      expect(reads[0]?.url).toBe(new URL(primary).href);
      expect(reads[1]?.url).not.toBe(new URL(primary).href);
      expect(mock.calls.some((call) => call.url === reads[1]?.url && call.method === "eth_chainId")).toBe(true);
      expect(client.snapshot?.().find((row) => new URL(row.url).href === new URL(primary).href)?.ejected).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: "failover", from: primary }));
    } finally {
      client.close?.();
    }
  });

  test("quarantines a wrong-network default before sending it a user read", async () => {
    const primary = HYPEREVM_MAINNET_ENDPOINTS[0]!;
    const mock = mockRpc(({ url, method }) => {
      if (method === "eth_chainId") return new URL(url).href === new URL(primary).href ? "0x3e6" : "0x3e7";
      return "0x10";
    });
    const client = hyperevm({
      chainId: 999,
      fetchFn: mock.fetchFn,
      headLag: { probeInterval: false },
      routing: "best",
      race: false,
    });
    try {
      await expect(client.request({ method: "eth_blockNumber" })).resolves.toBe("0x10");
      expect(mock.calls.filter((call) => new URL(call.url).href === new URL(primary).href).map((call) => call.method)).toEqual([
        "eth_chainId",
      ]);
      expect(client.snapshot?.().find((row) => new URL(row.url).href === new URL(primary).href)?.quarantined).toBe(true);
    } finally {
      client.close?.();
    }
  });

  test("never routes disabled filter methods to the default dRPC endpoint", async () => {
    let now = 0;
    const mock = mockRpc(({ url, method }) => {
      if (method === "eth_blockNumber") return "0x10";
      if (url.endsWith(".drpc.org")) throw new Error("A disabled filter method reached dRPC.");
      if (method === "eth_newFilter") return "0x1";
      return [];
    });
    const client = hyperevm({
      chainId: 998,
      fetchFn: mock.fetchFn,
      headLag: { probeInterval: false },
      routing: "best",
      verifyIdentity: false,
      race: false,
      cache: false,
      budget: false,
      now: () => now,
    });
    try {
      // First make the official RPC slower, so dRPC would otherwise win the next selection.
      const unsubscribe = client.onEvent?.((event) => {
        if (event.type === "request" && event.endpoint === HYPEREVM_TESTNET_RPC_URL) now += 1_000;
      });
      await client.request({ method: "eth_blockNumber" });
      unsubscribe?.();
      const handle = await client.request({ method: "eth_newFilter", params: [{}] });
      mock.calls.length = 0;
      await expect(client.request({ method: "eth_getFilterLogs", params: [handle] })).resolves.toEqual([]);
      expect(mock.calls.map((call) => call.url)).toEqual([HYPEREVM_TESTNET_RPC_URL]);
    } finally {
      client.close?.();
    }
  });

  test("keeps default requests inside their own network pool", async () => {
    const mainnet = new Set(HYPEREVM_MAINNET_ENDPOINTS.map((url) => new URL(url).href));
    const testnet = new Set(HYPEREVM_TESTNET_ENDPOINTS.map((url) => new URL(url).href));
    const mock = mockRpc(({ url, method }) => method === "eth_chainId"
      ? mainnet.has(url) ? "0x3e7" : "0x3e6"
      : "0x10");
    const client = hyperevm({
      fetchFn: mock.fetchFn,
      headLag: { probeInterval: false },
      routing: "best",
      race: false,
    });
    try {
      await expect(client.request({ chainId: HYPEREVM_TESTNET_CAIP, method: "eth_blockNumber" })).resolves.toBe("0x10");
      expect(mock.calls.every((call) => testnet.has(call.url))).toBe(true);
      mock.calls.length = 0;
      await expect(client.request({ chainId: HYPEREVM_MAINNET_CAIP, method: "eth_blockNumber" })).resolves.toBe("0x10");
      expect(mock.calls.every((call) => mainnet.has(call.url))).toBe(true);
    } finally {
      client.close?.();
    }
  });
});

describe("hyperevm configuration", () => {
  test("explicit endpoints replace the registries for both networks", async () => {
    const mainnetUrl = "https://mainnet.example/rpc";
    const testnetUrl = "https://testnet.example/rpc";
    const mock = mockRpc(({ url, method }) => method === "eth_chainId"
      ? url === mainnetUrl ? "0x3e7" : "0x3e6"
      : "0x10");
    const client = hyperevm({
      endpoints: [{ url: mainnetUrl, weight: 0.4 }],
      testnetEndpoints: [{ url: testnetUrl, weight: 0.6 }],
      fetchFn: mock.fetchFn,
      headLag: { probeInterval: false },
    });
    try {
      expect(client.snapshot?.().map((row) => row.url)).toEqual([mainnetUrl, testnetUrl]);
      expect(client.snapshot?.().map((row) => row.weight)).toEqual([0.4, 0.6]);
      await client.request({ chainId: HYPEREVM_MAINNET_CAIP, method: "eth_blockNumber" });
      await client.request({ chainId: HYPEREVM_TESTNET_CAIP, method: "eth_blockNumber" });
      expect(new Set(mock.calls.map((call) => call.url))).toEqual(new Set([mainnetUrl, testnetUrl]));
    } finally {
      client.close?.();
    }

    const selected = hyperevm({
      chainId: 998,
      endpoints: [testnetUrl],
      testnetEndpoints: ["https://unused.example/rpc"],
      headLag: { probeInterval: false },
    });
    try {
      expect(selected.chainIds).toEqual([HYPEREVM_TESTNET_CAIP]);
      expect(selected.snapshot?.().map((row) => row.url)).toEqual([testnetUrl]);
    } finally {
      selected.close?.();
    }
  });

  test("preserves the official mainnet budget, caller overrides, and budget opt-out", async () => {
    let now = 0;
    const mock = mockRpc(() => "0x3e7");
    const client = hyperevm({
      chainId: 999,
      endpoints: [HYPEREVM_RPC_URL],
      fetchFn: mock.fetchFn,
      headLag: { probeInterval: false },
      now: () => now,
      verifyIdentity: false,
      race: false,
      cache: false,
    });
    try {
      expect(client.snapshot?.()[0]?.tokens).toBe(3);
      await client.request({ method: "eth_chainId" });
      await client.request({ method: "eth_chainId" });
      expect(client.snapshot?.()[0]?.tokens).toBe(1);
      now = 1_000;
      expect(client.snapshot?.()[0]?.tokens).toBe(2);
    } finally {
      client.close?.();
    }

    const overridden = hyperevm({
      chainId: 999,
      endpoints: [{ url: HYPEREVM_RPC_URL, rps: 8, burst: 9 }],
      headLag: { probeInterval: false },
    });
    const disabled = hyperevm({ chainId: 999, budget: false, headLag: { probeInterval: false } });
    try {
      expect(overridden.snapshot?.()[0]?.tokens).toBe(9);
      expect(disabled.snapshot?.().every((row) => row.tokens === null)).toBe(true);
    } finally {
      overridden.close?.();
      disabled.close?.();
    }
  });

  test("keeps HyperCore precompile calls unpinned while pinning ordinary reads", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x3e7" : method === "eth_blockNumber" ? "0x10" : "0x");
    const client = hyperevm({
      chainId: 999,
      endpoints: ["https://custom.example/rpc"],
      fetchFn: mock.fetchFn,
      headLag: { probeInterval: false },
      now: () => 0,
    });
    try {
      await client.probe?.();
      const precompile = { to: "0x0000000000000000000000000000000000000800", data: "0x" };
      const ordinary = { to: "0x0000000000000000000000000000000000001000", data: "0x" };
      await client.request({ method: "eth_call", params: [precompile, "latest"] });
      await client.request({ method: "eth_call", params: [ordinary, "latest"] });
      expect(mock.calls.filter((call) => call.method === "eth_call").map((call) => call.params)).toEqual([
        [precompile, "latest"],
        [ordinary, "0x10"],
      ]);
    } finally {
      client.close?.();
    }
  });

  test("uses timed precompile entries and immutable confirmed results through chain policy", async () => {
    let now = 0;
    let head = 100;
    const hash = `0x${"ab".repeat(32)}`;
    const precompile = { to: "0x0000000000000000000000000000000000000809", data: "0x" };
    const mock = mockRpc(({ method }) => {
      if (method === "eth_chainId") return "0x3e7";
      if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
      if (method === "eth_getTransactionByHash") return { hash, blockNumber: null };
      return "0x1";
    });
    const client = hyperevm({
      chainId: 999,
      endpoints: ["https://custom.example/rpc"],
      fetchFn: mock.fetchFn,
      verifyIdentity: false,
      race: false,
      cache: { refreshInterval: false },
      headLag: { probeInterval: false },
      now: () => now,
    });
    try {
      await client.probe();
      await client.request({ method: "eth_call", params: [precompile, "latest"] });
      await client.request({ method: "eth_call", params: [precompile, "0x1"] });
      expect(mock.calls.filter((call) => call.method === "eth_call")).toHaveLength(1);

      await client.request({ method: "eth_getBalance", params: [hash, "0x10"] });
      await client.request({ method: "eth_getBalance", params: [hash, "0x10"] });
      now = 100_000;
      head = 200;
      await client.probe();
      await client.request({ method: "eth_getBalance", params: [hash, "0x10"] });
      expect(mock.calls.filter((call) => call.method === "eth_getBalance")).toHaveLength(1);

      await client.request({ method: "eth_getTransactionByHash", params: [hash] });
      await client.request({ method: "eth_getTransactionByHash", params: [hash] });
      expect(mock.calls.filter((call) => call.method === "eth_getTransactionByHash")).toHaveLength(2);
    } finally {
      client.close();
    }
  });

  test("keeps latest-only public log providers on unchanged latest queries", async () => {
    const mock = mockRpc(({ method, params }) => {
      if (method === "eth_blockNumber") return "0x64";
      if (method === "eth_getLogs") {
        const filter = params[0] as { toBlock?: string };
        if (filter.toBlock !== "latest") throw new Error("latest-only provider received a generated numeric range");
        return [{ blockNumber: "0x64", logIndex: "0x0" }];
      }
      return "0x3e7";
    });
    const client = hyperevm({
      chainId: 999,
      endpoints: [HYPEREVM_RPC_URL],
      fetchFn: mock.fetchFn,
      verifyIdentity: false,
      race: false,
      retryCount: 0,
      budget: false,
      cache: { refreshInterval: false },
      headLag: { probeInterval: false },
      isActive: () => false,
      now: () => 0,
    });
    try {
      await client.probe();
      const params = [{ address: `0x${"ab".repeat(20)}`, fromBlock: "0x5a", toBlock: "latest" }];
      await client.request({ method: "eth_getLogs", params });
      await client.request({ method: "eth_getLogs", params });
      expect(mock.calls.filter((call) => call.method === "eth_getLogs")).toHaveLength(2);
      expect(client.cacheStats().entries).toBe(0);
    } finally {
      client.close();
    }
  });
});


describe("hyperevm scoped sharing", () => {
  test("one key remains isolated between mainnet and testnet", async () => {
    const mainnetUrl = "https://shared-mainnet.example/rpc";
    const testnetUrl = "https://shared-testnet.example/rpc";
    const mock = mockRpc(({ url, method }) => method === "eth_chainId"
      ? url === mainnetUrl ? "0x3e7" : "0x3e6"
      : "0x10");
    const scope = createPoolScope();
    const client = hyperevm({
      endpoints: [mainnetUrl],
      testnetEndpoints: [testnetUrl],
      fetchFn: mock.fetchFn,
      headLag: false,
      race: false,
      sharing: { scope, key: "dual-network" },
    });
    try {
      expect(client.chainIds).toEqual([HYPEREVM_MAINNET_CAIP, HYPEREVM_TESTNET_CAIP]);
      await expect(client.request({ chainId: HYPEREVM_MAINNET_CAIP, method: "eth_blockNumber" })).resolves.toBe("0x10");
      await expect(client.request({ chainId: HYPEREVM_TESTNET_CAIP, method: "eth_blockNumber" })).resolves.toBe("0x10");
      expect(new Set(mock.calls.map((call) => call.url))).toEqual(new Set([mainnetUrl, testnetUrl]));
    } finally {
      client.close?.();
      scope.close();
    }
  });
});
