import { describe, expect, test } from "vitest";
import { createSmartRpc, UnknownChainError } from "@smart-rpc/core";

import {
  HYPEREVM_MAINNET_REGISTRY,
  HYPEREVM_NATIVE_CURRENCY,
  HYPEREVM_OFFICIAL_CAPABILITIES,
  HYPEREVM_RPC_URL,
  HYPEREVM_SAFE_METHODS,
  HYPEREVM_TESTNET_REGISTRY,
  HYPEREVM_TESTNET_RPC_URL,
  hyperevm,
  requestLogs,
} from "../src/index.js";

interface Call { url: string; method: string; params: unknown[] }
function mockRpc(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  return {
    calls,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const payload = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const call = { url, method: payload.method, params: payload.params ?? [] };
      calls.push(call);
      const result = answer(call);
      const body = result instanceof Error
        ? { error: { code: 10055, message: result.message } }
        : { result };
      return Response.json({ jsonrpc: "2.0", id: payload.id, ...body });
    },
  };
}

const base = {
  chainId: 999 as const,
  headLag: { probeInterval: false as const },
  race: false,
  cache: false,
  budget: false as const,
  routing: "best" as const,
};
const address = "0x0000000000000000000000000000000000001000";

describe("HyperEVM capabilities", () => {
  test("records HYPE denomination and documented official RPC limits", () => {
    expect(HYPEREVM_NATIVE_CURRENCY).toEqual({ name: "HYPE", symbol: "HYPE", decimals: 18 });
    expect(HYPEREVM_OFFICIAL_CAPABILITIES).toMatchObject({
      archive: false, pinning: false, subscriptions: false, maxLogBlockRange: 50, maxLogTopics: 4,
    });
  });

  test("records probe-verified public log ranges and archive state per provider", () => {
    const byId = new Map([...HYPEREVM_MAINNET_REGISTRY, ...HYPEREVM_TESTNET_REGISTRY].map((endpoint) => [endpoint.id, endpoint.capabilities]));
    expect(byId.get("hyperliquid-mainnet")).toMatchObject({ archive: false, maxLogBlockRange: 50 });
    expect(byId.get("drpc-mainnet")).toMatchObject({ archive: true, pinning: false, maxLogBlockRange: 100 });
    expect(byId.get("drpc-testnet")).toMatchObject({ archive: false, maxLogBlockRange: 100 });
    for (const id of ["hypurrscan-mainnet", "stakely-mainnet", "publicnode-mainnet"]) {
      // These nodes answered numeric selectors with current state, so archive must stay off.
      expect(byId.get(id)).toMatchObject({ archive: false, pinning: false, maxLogBlockRange: 1_000 });
    }
  });

  test.each([
    { chainId: 999 as const, url: HYPEREVM_RPC_URL, identity: "0x3e7" },
    { chainId: 998 as const, url: HYPEREVM_TESTNET_RPC_URL, identity: "0x3e6" },
  ])("keeps official chain $chainId state reads at latest after a head probe", async ({ chainId, url, identity }) => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? identity : method === "eth_blockNumber" ? "0x100" : "0x1");
    const client = hyperevm({ ...base, chainId, endpoints: [url], fetchFn: mock.fetchFn });
    try {
      await client.probe?.();
      await expect(client.request({ method: "eth_getBalance", params: [address, "latest"] })).resolves.toBe("0x1");
      expect(mock.calls.find((call) => call.method === "eth_getBalance")?.params).toEqual([address, "latest"]);
    } finally { client.close?.(); }
  });

  test.each(["0x80", "safe", "finalized", { blockHash: `0x${"11".repeat(32)}`, requireCanonical: true }])(
    "routes requested state %j only to an explicitly capable archive endpoint", async (tag) => {
      const archive = "https://archive.example/evm";
      const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x3e7" : "0x1");
      const client = hyperevm({
        ...base,
        endpoints: [HYPEREVM_RPC_URL, { url: archive, capabilities: { archive: true, blockTags: ["latest", "safe", "finalized"] } }],
        fetchFn: mock.fetchFn,
      });
      try {
        await expect(client.request({ method: "eth_getBalance", params: [address, tag] })).resolves.toBe("0x1");
        const reads = mock.calls.filter((call) => call.method === "eth_getBalance");
        expect(reads).toEqual([{ url: archive, method: "eth_getBalance", params: [address, tag] }]);
      } finally { client.close?.(); }
    },
  );

  test("does not downgrade unsupported historical state when only an official endpoint exists", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x3e7" : "0x1");
    const client = hyperevm({ ...base, endpoints: [HYPEREVM_RPC_URL], fetchFn: mock.fetchFn });
    try {
      await expect(client.request({ method: "eth_call", params: [{ to: address, data: "0x" }, "0x10"] })).rejects.toThrow();
      expect(mock.calls.filter((call) => call.method === "eth_call")).toEqual([]);
    } finally { client.close?.(); }
  });

  test("retains historical block metadata without claiming archive state support", async () => {
    const block = { number: "0x10", hash: `0x${"22".repeat(32)}`, transactions: [] };
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x3e7" : block);
    const client = hyperevm({ ...base, endpoints: [HYPEREVM_RPC_URL], fetchFn: mock.fetchFn });
    try {
      await expect(client.request({ method: "eth_getBlockByNumber", params: ["0x10", false] })).resolves.toEqual(block);
      expect(mock.calls.at(-1)?.params).toEqual(["0x10", false]);
    } finally { client.close?.(); }
  });

  test("splits official log requests within 50 blocks while preserving topic filters", async () => {
    const mock = mockRpc(({ method, params }) => method === "eth_chainId" ? "0x3e7" : [{ blockNumber: (params[0] as { fromBlock: string }).fromBlock }]);
    const client = hyperevm({ ...base, endpoints: [HYPEREVM_RPC_URL], fetchFn: mock.fetchFn });
    const topics = [`0x${"33".repeat(32)}`, null, [`0x${"44".repeat(32)}`], null];
    try {
      const result = await requestLogs(client, { fromBlock: "0x1", toBlock: "0x65", topics, address }, { maxBlockRange: 50 });
      const logs = mock.calls.filter((call) => call.method === "eth_getLogs");
      expect(logs.map((call) => call.params)).toEqual([
        [{ fromBlock: "0x1", toBlock: "0x32", topics, address }],
        [{ fromBlock: "0x33", toBlock: "0x64", topics, address }],
        [{ fromBlock: "0x65", toBlock: "0x65", topics, address }],
      ]);
      expect(result).toEqual([{ blockNumber: "0x1" }, { blockNumber: "0x33" }, { blockNumber: "0x65" }]);
    } finally { client.close?.(); }
  });

  test("rejects more than four topics before sending a log call", async () => {
    const mock = mockRpc(() => "0x3e7");
    const client = hyperevm({ ...base, endpoints: [HYPEREVM_RPC_URL], fetchFn: mock.fetchFn });
    try {
      await expect(client.request({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2", topics: Array(5).fill(null) }] })).rejects.toThrow();
      expect(mock.calls.filter((call) => call.method === "eth_getLogs")).toEqual([]);
    } finally { client.close?.(); }
  });

  test("preserves small/big block fees, zero tip and HyperCore system transaction fields", async () => {
    const systemTx = { hash: "0xab", from: "0xcd", isSystemTx: true, type: "0x7e", hyperCoreAction: { asset: 1 } };
    const fixtures: Record<string, unknown> = {
      eth_chainId: "0x3e7", eth_gasPrice: "0x64", eth_bigBlockGasPrice: "0x96",
      eth_maxPriorityFeePerGas: "0x0", eth_usingBigBlocks: true,
      eth_getSystemTxsByBlockHash: [systemTx], eth_getSystemTxsByBlockNumber: [systemTx],
    };
    const mock = mockRpc(({ method }) => fixtures[method]);
    const client = hyperevm({ ...base, endpoints: [HYPEREVM_RPC_URL], fetchFn: mock.fetchFn });
    try {
      for (const method of ["eth_gasPrice", "eth_maxPriorityFeePerGas", ...HYPEREVM_SAFE_METHODS]) {
        const params = method === "eth_usingBigBlocks" ? [address] : method.endsWith("ByBlockNumber") ? ["0x10"] : method.endsWith("ByBlockHash") ? ["0xab"] : [];
        await expect(client.request({ method, params })).resolves.toEqual(fixtures[method]);
        expect(mock.calls.at(-1)?.params).toEqual(params);
      }
    } finally { client.close?.(); }
  });

  test.each(["nonce too low", "insufficient funds", "replacement transaction underpriced"])(
    "does not retry deterministic HyperCore boundary error 10055: %s", async (message) => {
      const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x3e7" : new Error(message));
      const client = hyperevm({ ...base, endpoints: [HYPEREVM_RPC_URL, "https://secondary.example/evm"], fetchFn: mock.fetchFn });
      try {
        await expect(client.request({ method: "eth_sendRawTransaction", params: ["0x0102"] })).rejects.toThrow();
        expect(mock.calls.filter((call) => call.method === "eth_sendRawTransaction")).toHaveLength(1);
      } finally { client.close?.(); }
    },
  );

  test("selected-network batches retain individual errors and successful extension results", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x3e7" : method === "eth_call" ? new Error("execution reverted") : "0x96");
    const client = hyperevm({ ...base, endpoints: [HYPEREVM_RPC_URL], fetchFn: mock.fetchFn });
    try {
      const results = await client.requestBatch([
        { method: "eth_bigBlockGasPrice" },
        { method: "eth_call", params: [{ to: address, data: "0x" }, "latest"] },
      ]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "0x96" });
      expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(Error) });
      expect(mock.calls.filter((call) => call.method === "eth_call")).toHaveLength(1);
    } finally { client.close?.(); }
  });

  test("dual-network batches preserve ordering while routing valid items and rejecting unknown chains", async () => {
    const mock = mockRpc(({ url, method }) => method === "eth_chainId" ? url === HYPEREVM_RPC_URL ? "0x3e7" : "0x3e6" : url === HYPEREVM_RPC_URL ? "0x999" : "0x998");
    const client = hyperevm({
      endpoints: [HYPEREVM_RPC_URL], testnetEndpoints: [HYPEREVM_TESTNET_RPC_URL],
      headLag: { probeInterval: false }, race: false, cache: false, budget: false, fetchFn: mock.fetchFn,
    });
    try {
      const results = await client.requestBatch([
        { chainId: "eip155:999", method: "eth_bigBlockGasPrice" },
        { chainId: "eip155:1", method: "eth_gasPrice" },
        { chainId: "eip155:998", method: "eth_gasPrice" },
        { method: "eth_gasPrice" },
        { chainId: "eip155:999", method: "eth_gasPrice" },
      ]);
      expect(results).toEqual([
        { status: "fulfilled", value: "0x999" },
        { status: "rejected", reason: expect.any(UnknownChainError) },
        { status: "fulfilled", value: "0x998" },
        { status: "rejected", reason: expect.any(UnknownChainError) },
        { status: "fulfilled", value: "0x999" },
      ]);
      expect(mock.calls.filter((call) => call.method !== "eth_chainId")).toEqual(expect.arrayContaining([
        { url: HYPEREVM_RPC_URL, method: "eth_bigBlockGasPrice", params: [] },
        { url: HYPEREVM_TESTNET_RPC_URL, method: "eth_gasPrice", params: [] },
        { url: HYPEREVM_RPC_URL, method: "eth_gasPrice", params: [] },
      ]));
      expect(mock.calls.filter((call) => call.method !== "eth_chainId")).toHaveLength(3);
      await expect(client.requestBatch([])).resolves.toEqual([]);
    } finally { client.close?.(); }
  });

  test("the root batch router handles both HyperEVM networks and an unknown chain independently", async () => {
    const mock = mockRpc(({ url, method }) => method === "eth_chainId" ? url === HYPEREVM_RPC_URL ? "0x3e7" : "0x3e6" : url === HYPEREVM_RPC_URL ? "0x999" : "0x998");
    const rpc = createSmartRpc({ transports: [hyperevm({
      endpoints: [HYPEREVM_RPC_URL], testnetEndpoints: [HYPEREVM_TESTNET_RPC_URL],
      headLag: { probeInterval: false }, race: false, cache: false, budget: false, fetchFn: mock.fetchFn,
    })] });
    try {
      const results = await rpc.requestBatch([
        { chainId: "eip155:999", method: "eth_bigBlockGasPrice" },
        { chainId: "eip155:998", method: "eth_gasPrice" },
        { chainId: "eip155:1", method: "eth_gasPrice" },
      ]);
      expect(results).toEqual([
        { status: "fulfilled", value: "0x999" },
        { status: "fulfilled", value: "0x998" },
        { status: "rejected", reason: expect.any(UnknownChainError) },
      ]);
      expect(mock.calls.filter((call) => call.method !== "eth_chainId")).toEqual(expect.arrayContaining([
        { url: HYPEREVM_RPC_URL, method: "eth_bigBlockGasPrice", params: [] },
        { url: HYPEREVM_TESTNET_RPC_URL, method: "eth_gasPrice", params: [] },
      ]));
      expect(mock.calls.filter((call) => call.method !== "eth_chainId")).toHaveLength(2);
    } finally { rpc.close(); }
  });

  test("mixed-network batch items share one operation budget per underlying pool", async () => {
    const mock = mockRpc(({ url }) => url === HYPEREVM_RPC_URL ? "0x999" : "0x998");
    const client = hyperevm({
      endpoints: [HYPEREVM_RPC_URL], testnetEndpoints: [HYPEREVM_TESTNET_RPC_URL],
      headLag: false, race: false, cache: false, budget: false, verifyIdentity: false,
      operationBudget: { maxRequests: 1 }, fetchFn: mock.fetchFn,
    });
    try {
      const results = await client.requestBatch([
        { chainId: "eip155:999", method: "eth_bigBlockGasPrice" },
        { chainId: "eip155:998", method: "eth_bigBlockGasPrice" },
        { chainId: "eip155:999", method: "eth_gasPrice" },
        { chainId: "eip155:998", method: "eth_gasPrice" },
      ]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected", "rejected"]);
      expect(mock.calls.filter((call) => call.url === HYPEREVM_RPC_URL)).toHaveLength(1);
      expect(mock.calls.filter((call) => call.url === HYPEREVM_TESTNET_RPC_URL)).toHaveLength(1);
    } finally { client.close?.(); }
  });

  test("an aborted caller sends no identity or user calls and does not damage endpoint health", async () => {
    const mock = mockRpc(() => "0x3e7");
    const client = hyperevm({ ...base, endpoints: [HYPEREVM_RPC_URL], fetchFn: mock.fetchFn });
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(client.request({ method: "eth_bigBlockGasPrice", signal: controller.signal })).rejects.toThrow();
      expect(mock.calls).toEqual([]);
      expect(client.snapshot()[0]).toMatchObject({ quarantined: false, ejected: false });
    } finally { client.close(); }
  });

  test("returns the signed hash when a failover reports a duplicate transaction hash 10055", async () => {
    const mock = mockRpc(({ url, method }) => method === "eth_chainId" ? "0x3e7" : new Error(url === HYPEREVM_RPC_URL ? "temporary gateway failure" : "duplicate transaction hash"));
    const client = hyperevm({ ...base, endpoints: [HYPEREVM_RPC_URL, "https://secondary.example/evm"], fetchFn: mock.fetchFn });
    try {
      await expect(client.request({ method: "eth_sendRawTransaction", params: ["0x0102"] })).resolves.toMatch(/^0x[0-9a-f]{64}$/);
      expect(mock.calls.filter((call) => call.method === "eth_sendRawTransaction")).toHaveLength(2);
    } finally { client.close?.(); }
  });

  test("does not retry a first-attempt duplicate transaction hash 10055", async () => {
    const mock = mockRpc(({ method }) => method === "eth_chainId" ? "0x3e7" : new Error("duplicate transaction hash"));
    const client = hyperevm({ ...base, endpoints: [HYPEREVM_RPC_URL, "https://secondary.example/evm"], fetchFn: mock.fetchFn });
    try {
      await expect(client.request({ method: "eth_sendRawTransaction", params: ["0x0102"] })).rejects.toThrow(/duplicate transaction hash/);
      expect(mock.calls.filter((call) => call.method === "eth_sendRawTransaction")).toHaveLength(1);
    } finally { client.close?.(); }
  });
});
