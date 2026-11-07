import { describe, expect, test } from "vitest";
import type { RpcEvent } from "@smart-rpc/core";

import {
  arbitrum, ARBITRUM_CHAIN_ID, ARBITRUM_MAINNET_CAIP, ARBITRUM_MAINNET_REGISTRY,
  ARBITRUM_NATIVE_CURRENCY, ARBITRUM_PRECOMPILES, ARBITRUM_RPC_URL,
  ARBITRUM_SEQUENCER_URL, ARBITRUM_SEQUENCER_FEED_URL,
  type ArbitrumBlockFields, type ArbitrumReceiptFields,
} from "../src/index.js";

interface Call { url: string; method: string; params: unknown[]; headers: Headers }
function mockRpc(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  return {
    calls,
    fetchFn: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const call = { url, method: body.method, params: body.params, headers: new Headers(init?.headers) };
      calls.push(call);
      const result = await answer(call);
      return result instanceof Response ? result : Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  };
}

const quiet = { headLag: { probeInterval: false as const }, race: false, cache: false, routing: "best" as const };

describe("Arbitrum One", () => {
  test("registers the official execution RPC and ETH metadata without network I/O", () => {
    const mock = mockRpc(() => "0xa4b1");
    const rpc = arbitrum({ ...quiet, fetchFn: mock.fetchFn });
    try {
      expect(rpc.chainIds).toEqual([ARBITRUM_MAINNET_CAIP]);
      expect(ARBITRUM_CHAIN_ID).toBe(42161);
      expect(ARBITRUM_NATIVE_CURRENCY).toEqual({ name: "Ether", symbol: "ETH", decimals: 18 });
      expect(rpc.endpoints.map(({ url }) => url)).toEqual([ARBITRUM_RPC_URL]);
      expect(ARBITRUM_MAINNET_REGISTRY[0]?.capabilities).toMatchObject({ subscriptions: false, archive: false, batch: false });
      expect(mock.calls).toEqual([]);
    } finally { rpc.close(); }
  });

  test.each([ARBITRUM_SEQUENCER_URL, ARBITRUM_SEQUENCER_FEED_URL, "wss://arb1.arbitrum.io/rpc"])(
    "rejects a non-general-RPC URL before opening a connection: %s", (url) => {
      expect(() => arbitrum({ endpoints: [url] })).toThrow(/write-only|sequencer feed|WebSocket/);
    },
  );

  test("quarantines a wrong chain before any user call and verifies the fallback", async () => {
    const mock = mockRpc(({ url, method }) => method === "eth_chainId"
      ? url.includes("wrong") ? "0x1" : "0xa4b1"
      : "0x123");
    const rpc = arbitrum({ ...quiet, endpoints: ["https://wrong.example", "https://right.example"], fetchFn: mock.fetchFn });
    try {
      await expect(rpc.request({ method: "eth_blockNumber" })).resolves.toBe("0x123");
      expect(mock.calls.filter(({ url }) => url.includes("wrong")).map(({ method }) => method)).toEqual(["eth_chainId"]);
      expect(rpc.snapshot()[0]?.quarantined).toBe(true);
      expect(mock.calls.filter(({ url }) => url.includes("right")).map(({ method }) => method)).toEqual(["eth_chainId", "eth_blockNumber"]);
    } finally { rpc.close(); }
  });

  test("preserves conditional submission constraints and sends each call once", async () => {
    const events: RpcEvent[] = [];
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xa4b1" : "0xabcd");
    const rpc = arbitrum({ ...quiet, race: true, cache: true, coalesce: true,
      endpoints: ["https://one.example", "https://two.example"], fetchFn: mock.fetchFn,
      onEvent: (event) => events.push(event),
    });
    const params = ["0x02f8", { blockNumberMin: "0x100", blockNumberMax: "0x110", timestampMax: "0x1234", knownAccounts: { "0x0000000000000000000000000000000000000001": { "0x0": "0x1" } } }];
    try {
      await Promise.all([0, 1].map(() => rpc.request({ method: "eth_sendRawTransactionConditional", params })));
      const submissions = mock.calls.filter(({ method }) => method === "eth_sendRawTransactionConditional");
      expect(submissions).toHaveLength(2);
      expect(submissions.every((call) => JSON.stringify(call.params) === JSON.stringify(params))).toBe(true);
      expect(events.some((event) => ["coalesce", "race", "cache"].includes(event.type))).toBe(false);
    } finally { rpc.close(); }
  });

  test("does not retry conditional submission after an ambiguous connection failure", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xa4b1" : new Response("unavailable", { status: 503 }));
    const rpc = arbitrum({ ...quiet, retryCount: 4, endpoints: ["https://one.example", "https://two.example"], fetchFn: mock.fetchFn });
    try {
      await expect(rpc.request({ method: "eth_sendRawTransactionConditional", params: ["0x02f8", { blockNumberMax: "0x1" }] })).rejects.toThrow();
      expect(mock.calls.filter(({ method }) => method === "eth_sendRawTransactionConditional")).toHaveLength(1);
    } finally { rpc.close(); }
  });

  test("preserves Nitro receipt fees and block extensions as wire hex", async () => {
    const receipt = { transactionHash: "0x1234", gasUsed: "0x61ff", gasUsedForL1: "0x9f5", l1BlockNumber: "0x979a08", type: "0x6a", status: "0x1" } satisfies ArbitrumReceiptFields & Record<string, unknown>;
    const block = { number: "0x100", l1BlockNumber: "0x10", sendCount: "0x2", sendRoot: "0xabcd", mixHash: "0xabcd", transactions: [] } satisfies ArbitrumBlockFields & Record<string, unknown>;
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xa4b1" : method === "eth_getTransactionReceipt" ? receipt : block);
    const rpc = arbitrum({ ...quiet, endpoints: ["https://provider.example"], fetchFn: mock.fetchFn });
    try {
      await expect(rpc.request({ method: "eth_getTransactionReceipt", params: ["0x1234"] })).resolves.toEqual(receipt);
      await expect(rpc.request({ method: "eth_getBlockByNumber", params: ["latest", false] })).resolves.toEqual(block);
    } finally { rpc.close(); }
  });

  test.each(["latest", "safe", "finalized", "pending"])("keeps the requested %s tag at a capable custom provider", async (tag) => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xa4b1" : { number: "0x100" });
    const rpc = arbitrum({ ...quiet, pinLatest: false, endpoints: ["https://provider.example"], fetchFn: mock.fetchFn });
    try {
      await rpc.request({ method: "eth_getBlockByNumber", params: [tag, false] });
      expect(mock.calls.at(-1)?.params).toEqual([tag, false]);
    } finally { rpc.close(); }
  });

  test.each([
    { name: "ArbSys.arbBlockNumber", to: ARBITRUM_PRECOMPILES.arbSys, data: "0xa3b1b31d", words: [256] },
    { name: "ArbGasInfo.getPricesInWei", to: ARBITRUM_PRECOMPILES.arbGasInfo, data: "0x41b247a8", words: [1, 2, 3, 4, 5, 6] },
    { name: "NodeInterface.gasEstimateComponents", to: ARBITRUM_PRECOMPILES.nodeInterface,
      // gasEstimateComponents(address(1), false, bytes(""))
      data: `0xc94e6eeb${"1".padStart(64, "0")}${"0".repeat(64)}${"60".padStart(64, "0")}${"0".repeat(64)}`,
      words: [21_000, 1_000, 20_000_000, 1_000_000_000] },
  ])(
    "keeps precompile calldata and ABI return words intact for $name", async ({ to, data, words }) => {
      const output = `0x${words.map((word) => word.toString(16).padStart(64, "0")).join("")}`;
      const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xa4b1" : output);
      const rpc = arbitrum({ ...quiet, endpoints: ["https://provider.example"], fetchFn: mock.fetchFn });
      const params = [{ to, data, value: "0x0" }, "latest"];
      try {
        await expect(rpc.request({ method: "eth_call", params })).resolves.toBe(output);
        expect(mock.calls.at(-1)?.params).toEqual(params);
      } finally { rpc.close(); }
    },
  );

  test("rejects a cancelled caller without marking the endpoint unhealthy", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xa4b1" : "0x100");
    const rpc = arbitrum({ ...quiet, fetchFn: mock.fetchFn });
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(rpc.request({ method: "eth_blockNumber", signal: controller.signal })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
      expect(rpc.snapshot()[0]).toMatchObject({ quarantined: false, ejected: false, inflight: 0 });
    } finally { rpc.close(); }
  });

  test("forwards dedicated provider headers through the shared EVM connection", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xa4b1" : "0x100");
    const endpoint = { url: "https://provider.example", headers: { Authorization: "Bearer fixture-token" } };
    const rpc = arbitrum({ ...quiet, endpoints: [endpoint], fetchFn: mock.fetchFn });
    try {
      await rpc.request({ method: "eth_blockNumber" });
      expect(mock.calls.length).toBeGreaterThan(0);
      expect(mock.calls.every(({ headers }) => headers.get("authorization") === "Bearer fixture-token")).toBe(true);
    } finally { rpc.close(); }
  });

  test.each([
    { method: "debug_traceTransaction", params: ["0x1234"] },
    { method: "trace_transaction", params: ["0x1234"] },
    { method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", "0x1"] },
    { method: "eth_getBlockByNumber", params: ["finalized", false] },
  ])("does not send unverified $method capabilities to the public default", async (request) => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xa4b1" : "0x100");
    const rpc = arbitrum({ ...quiet, fetchFn: mock.fetchFn });
    try {
      await expect(rpc.request(request)).rejects.toThrow();
      expect(mock.calls.filter(({ method }) => method === request.method)).toEqual([]);
      expect(rpc.snapshot()[0]?.ejected).toBe(false);
    } finally { rpc.close(); }
  });

  test("keeps per-item batch errors alongside successful reads", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0xa4b1"
      : method === "eth_getBalance" ? Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } })
      : "0x100");
    const rpc = arbitrum({ ...quiet, endpoints: ["https://provider.example"], fetchFn: mock.fetchFn });
    try {
      const results = await rpc.requestBatch([
        { method: "eth_blockNumber" },
        { method: "eth_getBalance", params: ["invalid", "latest"] },
      ]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "0x100" });
      expect(results[1]?.status).toBe("rejected");
      expect(mock.calls.filter(({ method }) => method === "eth_getBalance")).toHaveLength(1);
    } finally { rpc.close(); }
  });
});
