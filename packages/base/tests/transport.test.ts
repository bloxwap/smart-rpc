import { describe, expect, test } from "vitest";
import type { RpcEvent } from "@smart-rpc/core";

import {
  base,
  BASE_CHAIN_ID,
  BASE_MAINNET_CAIP,
  BASE_MAINNET_ENDPOINTS,
  BASE_MAINNET_REGISTRY,
  BASE_NATIVE_CURRENCY,
  BASE_RPC_URL,
  BASE_SEQUENCER_URL,
} from "../src/index.js";

interface Call {
  url: string;
  method: string;
  params: unknown[];
  headers: Headers;
}

interface RpcBody {
  id: number;
  method: string;
  params?: unknown[];
}

function mockRpc(answer: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const batches: number[] = [];
  return {
    calls,
    batches,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const request = JSON.parse(String(init?.body)) as RpcBody | RpcBody[];
      const run = async (body: RpcBody) => {
        const call = { url, method: body.method, params: body.params ?? [], headers: new Headers(init?.headers) };
        calls.push(call);
        const result = await answer(call);
        if (result instanceof Response) return result;
        return { jsonrpc: "2.0", id: body.id, result };
      };
      if (Array.isArray(request)) {
        batches.push(request.length);
        const results = await Promise.all(request.map(run));
        return Response.json(results);
      }
      const result = await run(request);
      return result instanceof Response ? result : Response.json(result);
    },
  };
}

const idle = { probeInterval: false } as const;
const address = "0x1111111111111111111111111111111111111111";
const receipt = {
  transactionHash: `0x${"ab".repeat(32)}`,
  blockNumber: "0x64",
  status: "0x1",
  gasUsed: "0x5208",
  effectiveGasPrice: "0x3b9aca00",
  l1GasPrice: "0x174876e800",
  l1GasUsed: "0x684",
  l1Fee: "0x1234",
  l1BlobBaseFee: "0x1",
  l1BaseFeeScalar: "0x44d",
  l1BlobBaseFeeScalar: "0xa3a",
};

describe("Base transport", () => {
  test("registers Base mainnet lazily with documented ETH metadata and RPC defaults", () => {
    const mock = mockRpc(() => "0x1");
    const client = base({ fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(client.chainIds).toEqual([BASE_MAINNET_CAIP]);
      expect(BASE_CHAIN_ID).toBe(8453);
      expect(BASE_NATIVE_CURRENCY).toEqual({ name: "Ether", symbol: "ETH", decimals: 18 });
      expect(BASE_MAINNET_REGISTRY.length).toBeGreaterThan(0);
      expect(BASE_MAINNET_REGISTRY.length).toBeLessThanOrEqual(5);
      expect(BASE_MAINNET_ENDPOINTS).toEqual(BASE_MAINNET_REGISTRY.map(({ url }) => url));
      expect(client.endpoints.map(({ url }) => url)).toEqual(BASE_MAINNET_ENDPOINTS);
      expect(BASE_MAINNET_REGISTRY[0]?.rps).toBeUndefined();
      expect(mock.calls).toEqual([]);
    } finally {
      client.close();
    }
  });

  test("registry records re-verified capabilities, documented budgets and method exclusions", () => {
    const byId = new Map(BASE_MAINNET_REGISTRY.map((endpoint) => [endpoint.id, endpoint]));
    expect(byId.get("base-mainnet")?.unsupportedMethods).toEqual(["eth_getLogs"]);
    expect(byId.get("base-drpc")?.capabilities).toMatchObject({ batch: true, maxBatchSize: 3, maxLogBlockRange: 100 });
    expect(byId.get("base-pocket")?.rps).toBe(33);
    expect(BASE_MAINNET_REGISTRY.filter(({ capabilities }) => capabilities?.archive).map(({ id }) => id))
      .toEqual(["base-mainnet", "base-drpc", "base-tenderly", "base-pocket"]);
    for (const endpoint of BASE_MAINNET_REGISTRY) {
      expect(endpoint.reviewedAt).toBe("2026-11-08");
      expect(endpoint.capabilities).toMatchObject({ batch: true, debug: false, trace: false, subscriptions: false, pinning: false });
      expect(endpoint.capabilities?.maxBatchSize).toBeLessThanOrEqual(10);
      if (endpoint.provider !== "Pocket Network") expect(endpoint.rps).toBeUndefined();
    }
  });

  test("routes registry log queries away from the official endpoint and dRPC's wide spans", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x2105" : method === "eth_getLogs" ? [] : "0x64");
    const client = base({ fetchFn: mock.fetchFn, headLag: idle, race: false, cache: false, routing: "best" });
    try {
      await client.request({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x3e8" }] });
      const logs = mock.calls.filter(({ method }) => method === "eth_getLogs").map(({ url }) => new URL(url).host);
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toBe("mainnet.base.org");
      expect(logs[0]).not.toBe("base.drpc.org");
    } finally {
      client.close();
    }
  });

  test.each([BASE_SEQUENCER_URL, `${BASE_SEQUENCER_URL}/?key=unused`, "https://MAINNET-SEQUENCER.BASE.ORG./rpc"])(
    "rejects the submission-only endpoint %s before probing or reading it", (url) => {
      const mock = mockRpc(() => "0x2105");
      expect(() => base({ endpoints: [url], fetchFn: mock.fetchFn })).toThrow(/transaction submissions only/);
      expect(mock.calls).toEqual([]);
    },
  );

  test("checks chain identity before a user call and quarantines Ethereum mainnet", async () => {
    const events: RpcEvent[] = [];
    const mock = mockRpc(({ url, method }) => method === "eth_chainId"
      ? url.includes("wrong") ? "0x1" : "0x2105"
      : "0x64");
    const client = base({
      endpoints: ["https://wrong.example", "https://base.example"],
      fetchFn: mock.fetchFn, headLag: idle, race: false, routing: "best", onEvent: (event) => events.push(event),
    });
    try {
      expect(await client.request({ method: "eth_blockNumber" })).toBe("0x64");
      expect(mock.calls.filter(({ url }) => url.includes("wrong")).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(mock.calls.filter(({ url }) => url.includes("base.example")).map(({ method }) => method))
        .toEqual(["eth_chainId", "eth_blockNumber"]);
      expect(events.some((event) => event.type === "quarantine" && event.expected === 8453)).toBe(true);
    } finally {
      client.close();
    }
  });

  test("keeps latest, safe and finalized independent in request and cache keys", async () => {
    const values: Record<string, string> = { latest: "0x3", safe: "0x2", finalized: "0x1" };
    const mock = mockRpc(({ method, params }) => method === "eth_chainId" ? "0x2105" : values[String(params[1])]);
    const client = base({ endpoints: [BASE_RPC_URL], fetchFn: mock.fetchFn, headLag: idle });
    try {
      for (const tag of ["latest", "safe", "finalized"] as const) {
        expect(await client.request({ method: "eth_getBalance", params: [address, tag] })).toBe(values[tag]);
      }
      for (const tag of ["latest", "safe", "finalized"] as const) {
        expect(await client.request({ method: "eth_getBalance", params: [address, tag] })).toBe(values[tag]);
      }
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance").map(({ params }) => params[1]))
        .toEqual(["latest", "safe", "finalized"]);
    } finally {
      client.close();
    }
  });

  test("preserves receipt execution gas and independent L1 calldata/blob fee fields", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x2105" : receipt);
    const client = base({ endpoints: [BASE_RPC_URL], fetchFn: mock.fetchFn, headLag: idle });
    try {
      expect(await client.request({ method: "eth_getTransactionReceipt", params: [receipt.transactionHash] })).toEqual(receipt);
    } finally {
      client.close();
    }
  });

  test("does not race, cache or coalesce identical signed submissions", async () => {
    const events: RpcEvent[] = [];
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x2105" : receipt.transactionHash);
    const client = base({
      endpoints: ["https://a.example", "https://b.example"],
      fetchFn: mock.fetchFn, headLag: idle, rebroadcastRawTransactions: false,
      onEvent: (event) => events.push(event),
    });
    try {
      const request = { method: "eth_sendRawTransaction", params: ["0x1234"] };
      await Promise.all([client.request(request), client.request(request)]);
      await client.request(request);
      expect(mock.calls.filter(({ method }) => method === request.method)).toHaveLength(3);
      expect(events.filter((event) => ["race", "coalesce", "cache"].includes(event.type))).toEqual([]);
    } finally {
      client.close();
    }
  });

  test("honors cancellation before dispatch", async () => {
    const mock = mockRpc(() => "0x2105");
    const client = base({ endpoints: [BASE_RPC_URL], fetchFn: mock.fetchFn, headLag: idle });
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(client.request({ method: "eth_blockNumber", signal: controller.signal })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
    } finally {
      client.close();
    }
  });

  test("bounds transient retries by the configured attempt count", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x2105" : new Response("Unavailable", { status: 503 }));
    const client = base({
      endpoints: [BASE_RPC_URL], fetchFn: mock.fetchFn, headLag: idle, retryCount: 1, retryDelay: 1, race: false,
    });
    try {
      await expect(client.request({ method: "eth_getBalance", params: [address, "latest"] })).rejects.toThrow();
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance")).toHaveLength(2);
    } finally {
      client.close();
    }
  });

  test("tracks full-block probe heads without learning user-call latency and expires stale heads", async () => {
    let now = 100;
    const mock = mockRpc(({ method, url }) => method === "eth_chainId" ? "0x2105" : url.includes("a.example") ? "0x64" : "0x65");
    const client = base({
      endpoints: ["https://a.example", "https://b.example"], fetchFn: mock.fetchFn,
      headLag: { probeInterval: false, staleMs: 1_000 }, now: () => now,
    });
    try {
      await client.probe();
      const rows = client.snapshot("eth_getBalance");
      expect(rows.map(({ head }) => head)).toEqual([100, 101]);
      expect(rows.every(({ methods }) => (methods["*"]?.n ?? 0) === 0)).toBe(true);
      now += 1_001;
      expect(client.snapshot().every(({ lag }) => lag === null)).toBe(true);
    } finally {
      client.close();
    }
  });

  test("supports dedicated provider headers and explicit archive capabilities", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x2105" : "0x10");
    const client = base({
      endpoints: [{ url: "https://dedicated.example", headers: { "x-api-key": "test-fixture" }, capabilities: { archive: true } }],
      fetchFn: mock.fetchFn, headLag: idle,
    });
    try {
      expect(await client.request({ method: "eth_getBalance", params: [address, "0x1"] })).toBe("0x10");
      expect(mock.calls.every(({ headers }) => headers.get("x-api-key") === "test-fixture")).toBe(true);
      expect(mock.calls.at(-1)?.params).toEqual([address, "0x1"]);
    } finally {
      client.close();
    }
  });

  test("does not degrade an explicitly unsupported archive read to latest", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x2105" : "0x10");
    const client = base({
      endpoints: [{ url: BASE_RPC_URL, capabilities: BASE_MAINNET_REGISTRY.find(({ id }) => id === "base-publicnode")!.capabilities }],
      fetchFn: mock.fetchFn, headLag: idle,
    });
    try {
      await expect(client.request({ method: "eth_getBalance", params: [address, "0x1"] })).rejects.toThrow();
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance")).toEqual([]);
    } finally {
      client.close();
    }
  });

  test("preserves independent outcomes with explicitly enabled HTTP batching", async () => {
    const batches: RpcBody[][] = [];
    const client = base({
      endpoints: [{ url: "https://batch.example", capabilities: { batch: true, maxBatchSize: 2 } }],
      batch: { batchSize: 2, wait: 1 },
      verifyIdentity: false, headLag: idle, race: false, retryCount: 0,
      async fetchFn(_input, init) {
        const body = JSON.parse(String(init?.body)) as RpcBody | RpcBody[];
        const requests = Array.isArray(body) ? body : [body];
        batches.push(requests);
        const responses = requests.map((request) => request.params?.[0] === "invalid-address"
          ? { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "invalid address" } }
          : { jsonrpc: "2.0", id: request.id, result: "0x42" });
        return Response.json(Array.isArray(body) ? responses : responses[0]);
      },
    });
    try {
      const results = await Promise.allSettled([
        client.request({ method: "eth_getBalance", params: [address, "latest"] }),
        client.request({ method: "eth_getBalance", params: ["invalid-address", "latest"] }),
      ]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "0x42" });
      expect(results[1]?.status).toBe("rejected");
      // viem separates calls with independent AbortSignals into separate wire
      // batches so cancelling one caller cannot cancel an unrelated caller.
      expect(batches.flat()).toHaveLength(2);
      expect(batches.every((requests) => requests.length <= 2)).toBe(true);
    } finally {
      client.close();
    }
  });
});
