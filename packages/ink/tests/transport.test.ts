import { describe, expect, test } from "vitest";
import {
  ink,
  INK_CHAIN_ID,
  INK_MAINNET_CAIP,
  INK_MAINNET_ENDPOINTS,
  INK_MAINNET_REGISTRY,
  INK_NATIVE_CURRENCY,
  INK_RPC_URL,
  INK_SECONDARY_RPC_URL,
  INK_SUBBLOCKS_URL,
} from "../src/index.js";

interface Call {
  url: string;
  method: string;
  params: unknown[];
  headers: Headers;
}

function mockRpc(answer: (call: Call) => unknown = () => "0x10") {
  const calls: Call[] = [];
  return {
    calls,
    fetchFn: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = (typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).replace(/\/$/, "");
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const call: Call = { url, method: body.method, params: body.params ?? [], headers: new Headers(init?.headers) };
      calls.push(call);
      const result = await answer(call);
      return result instanceof Response ? result : Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  };
}

const identity = `0x${INK_CHAIN_ID.toString(16)}`;
const noProbes = { probeInterval: false } as const;
const customUrl = "https://ink.example/rpc";

describe("Ink mainnet", () => {
  test("uses documented HTTP defaults without opening a connection during construction", () => {
    const mock = mockRpc();
    const client = ink({ fetchFn: mock.fetchFn, headLag: noProbes });
    try {
      expect(client.chainIds).toEqual([INK_MAINNET_CAIP]);
      expect(INK_MAINNET_REGISTRY.length).toBeGreaterThan(0);
      expect(INK_MAINNET_REGISTRY.length).toBeLessThanOrEqual(5);
      expect(client.endpoints.map(({ url }) => url)).toEqual(INK_MAINNET_ENDPOINTS);
      expect(INK_MAINNET_ENDPOINTS).toEqual(INK_MAINNET_REGISTRY.map(({ url }) => url));
      expect(INK_NATIVE_CURRENCY).toEqual({ name: "Ether", symbol: "ETH", decimals: 18 });
      expect(mock.calls).toEqual([]);
      expect(INK_MAINNET_REGISTRY[0].websocketUrls).toContain("wss://ws-gel.inkonchain.com");
      expect(INK_MAINNET_REGISTRY[1].websocketUrls).toEqual(["wss://rpc-qnd.inkonchain.com"]);
      expect(client.snapshot().every(({ tokens }) => tokens === null)).toBe(true);
    } finally { client.close(); }
  });

  test.each([INK_SUBBLOCKS_URL, "https://subblocks.inkonchain.com/ws", "wss://subblocks-sepolia.inkonchain.com/ws", "wss://SUBBLOCKS.inkonchain.com./ws"])(
    "rejects stream endpoint %s before creating a connection", (url) => {
      expect(() => ink({ endpoints: [url] })).toThrow(/preconfirmation streams/);
      expect(() => ink({ endpoints: [{ url }] })).toThrow(/preconfirmation streams/);
    },
  );

  test("quarantines a wrong chain before a user call and verifies the replacement", async () => {
    const mock = mockRpc(({ url, method }) => method === "eth_chainId"
      ? url === INK_RPC_URL ? "0x1" : identity : "0x10");
    const client = ink({
      endpoints: [INK_RPC_URL, INK_SECONDARY_RPC_URL], fetchFn: mock.fetchFn, headLag: noProbes, routing: "best", race: false,
    });
    try {
      await expect(client.request({ method: "eth_blockNumber" })).resolves.toBe("0x10");
      expect(mock.calls.filter(({ url }) => url === INK_RPC_URL).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(client.snapshot().find(({ url }) => url === INK_RPC_URL)?.quarantined).toBe(true);
      expect(mock.calls.filter(({ url }) => url === INK_SECONDARY_RPC_URL).map(({ method }) => method)).toEqual([
        "eth_chainId", "eth_blockNumber",
      ]);
    } finally { client.close(); }
  });

  test("replaces public providers and passes dedicated provider headers", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : "0x10");
    const client = ink({
      endpoints: [{ url: customUrl, headers: { "x-provider-test": "fixture-only" } }],
      fetchFn: mock.fetchFn, headLag: noProbes,
    });
    try {
      await client.request({ method: "eth_blockNumber" });
      expect(mock.calls.every(({ url, headers }) => url === customUrl && headers.get("x-provider-test") === "fixture-only")).toBe(true);
    } finally { client.close(); }
  });

  test("requires explicit advanced capabilities without retrying or degrading finality", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : "0x10");
    const client = ink({
      endpoints: [{ url: INK_RPC_URL, capabilities: INK_MAINNET_REGISTRY[0].capabilities }],
      fetchFn: mock.fetchFn, headLag: noProbes,
    });
    try {
      for (const request of [
        { method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", "finalized"] },
        { method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", "0x1"] },
        { method: "debug_traceTransaction", params: ["0x01"] },
        { method: "trace_transaction", params: ["0x01"] },
        { method: "eth_subscribe", params: ["newHeads"] },
      ]) await expect(client.request(request)).rejects.toThrow();
      expect(mock.calls.filter(({ method }) => method !== "eth_chainId")).toEqual([]);
    } finally { client.close(); }
  });

  test("preserves distinct unsafe/safe/finalized tags and coalescing keys", async () => {
    const mock = mockRpc(({ method, params }) => method === "eth_chainId" ? identity : params[1]);
    const client = ink({
      endpoints: [{ url: customUrl, capabilities: { blockTags: ["latest", "safe", "finalized"], pinning: false } }],
      fetchFn: mock.fetchFn, headLag: noProbes,
    });
    try {
      const tags = ["latest", "safe", "finalized"];
      const values = await Promise.all(tags.map((tag) => client.request({
        method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", tag],
      })));
      expect(values).toEqual(tags);
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance").map(({ params }) => params[1])).toEqual(tags);
    } finally { client.close(); }
  });

  test("does not cache pending preconfirmations or use them as a full-block head", async () => {
    let calls = 0;
    const mock = mockRpc(({ method }) => {
      if (method === "eth_chainId") return identity;
      if (method === "eth_blockNumber") return "0x10";
      calls++;
      return { number: "0x100000", hash: null, nonce: null, pendingSequence: calls };
    });
    const client = ink({ endpoints: [customUrl], fetchFn: mock.fetchFn, headLag: noProbes, race: false });
    try {
      await client.probe();
      const request = { method: "eth_getBlockByNumber", params: ["pending", false] };
      await expect(client.request(request)).resolves.toMatchObject({ pendingSequence: 1 });
      await expect(client.request(request)).resolves.toMatchObject({ pendingSequence: 2 });
      expect(client.snapshot()[0]?.head).toBe(16);
    } finally { client.close(); }
  });

  test("retains L1 publication and L2 execution fee fields without converting hex quantities", async () => {
    const receipt = {
      transactionHash: "0x1234", blockNumber: "0x10", gasUsed: "0x5208", effectiveGasPrice: "0xf4240",
      l1GasPrice: "0xabcdef", l1GasUsed: "0x123", l1Fee: "0x456", l1BlobBaseFee: "0x7",
      l1BaseFeeScalar: "0x8", l1BlobBaseFeeScalar: "0x9", operatorFeeScalar: "0xa", operatorFeeConstant: "0xb",
    };
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : receipt);
    const client = ink({ endpoints: [customUrl], fetchFn: mock.fetchFn, headLag: noProbes });
    try {
      await expect(client.request({ method: "eth_getTransactionReceipt", params: [receipt.transactionHash] })).resolves.toEqual(receipt);
    } finally { client.close(); }
  });

  test("never races or coalesces raw transaction writes", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : "0xhash");
    const client = ink({ endpoints: [customUrl, "https://ink-backup.example/rpc"], fetchFn: mock.fetchFn, headLag: noProbes });
    try {
      const request = { method: "eth_sendRawTransaction", params: ["0xdeadbeef"] };
      await Promise.all([client.request(request), client.request(request)]);
      expect(mock.calls.filter(({ method }) => method === "eth_sendRawTransaction")).toHaveLength(2);
    } finally { client.close(); }
  });

  test("honors cancellation before sending an identity check or user request", async () => {
    const mock = mockRpc();
    const client = ink({ endpoints: [INK_RPC_URL], fetchFn: mock.fetchFn, headLag: noProbes });
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(client.request({ method: "eth_blockNumber", signal: controller.signal })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
    } finally { client.close(); }
  });

  test("returns partial batch errors and successes as separate outcomes", async () => {
    const mock = mockRpc(({ method }) => {
      if (method === "eth_chainId") return identity;
      if (method === "eth_call") return Response.json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } });
      return "0x10";
    });
    const client = ink({ endpoints: [customUrl], fetchFn: mock.fetchFn, headLag: noProbes, race: false });
    try {
      const result = await client.requestBatch([
        { method: "eth_blockNumber" },
        { method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000001" }, "latest"] },
      ]);
      expect(result[0]).toEqual({ status: "fulfilled", value: "0x10" });
      expect(result[1]).toMatchObject({ status: "rejected", reason: expect.any(Error) });
      expect(mock.calls.filter(({ method }) => method === "eth_call")).toHaveLength(1);
    } finally { client.close(); }
  });

  test("counts retries against one bounded operation budget", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId"
      ? identity : new Response("upstream unavailable", { status: 503 }));
    const client = ink({
      endpoints: [customUrl, "https://ink-backup.example/rpc"], fetchFn: mock.fetchFn,
      headLag: noProbes, race: false, verifyIdentity: false, retryCount: 20,
      operationBudget: { maxRequests: 2 },
    });
    try {
      await expect(client.request({ method: "eth_blockNumber" })).rejects.toThrow();
      expect(mock.calls).toHaveLength(2);
    } finally { client.close(); }
  });

  test("successful probes do not clear failed calls or add latency samples", async () => {
    const mock = mockRpc(({ method }) => {
      if (method === "eth_chainId") return identity;
      if (method === "eth_blockNumber") return "0x10";
      return new Response("upstream unavailable", { status: 503 });
    });
    const client = ink({ endpoints: [customUrl], fetchFn: mock.fetchFn, headLag: noProbes, retryCount: 0, race: false });
    try {
      for (let i = 0; i < 3; i++) {
        await expect(client.request({ method: "eth_getBalance", params: ["0x01", "latest"] })).rejects.toThrow();
        if (i < 2) await client.probe();
      }
      expect(client.snapshot()[0]?.ejected).toBe(true);
      expect(client.snapshot()[0]?.methods.eth_blockNumber?.n ?? 0).toBe(0);
      expect(client.snapshot()[0]?.methods.eth_getBalance?.n).toBe(3);
    } finally { client.close(); }
  });

  test("stale full-block heads stop contributing to lag scores", async () => {
    let now = 0;
    const mock = mockRpc(({ method, url }) => method === "eth_chainId" ? identity : url === customUrl ? "0x10" : "0x20");
    const client = ink({
      endpoints: [customUrl, "https://ink-backup.example/rpc"], fetchFn: mock.fetchFn,
      headLag: { probeInterval: false, staleMs: 500 }, now: () => now,
    });
    try {
      await client.probe();
      expect(client.snapshot().find(({ url }) => url === customUrl)?.lag).toBe(16);
      now = 501;
      expect(client.snapshot().every(({ lag }) => lag === null)).toBe(true);
    } finally { client.close(); }
  });
});
