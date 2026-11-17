import { describe, expect, test } from "vitest";

import type { RpcEvent } from "@smart-rpc/core";

import {
  HYPEREVM_MAINNET_CAIP,
  HYPEREVM_MAINNET_ENDPOINTS,
  HYPEREVM_TESTNET_CAIP,
  HYPEREVM_TESTNET_ENDPOINTS,
  hyperevm,
} from "../src/index.js";

const href = (url: string): string => new URL(url).href;
const mainnet = new Set(HYPEREVM_MAINNET_ENDPOINTS.map(href));
const HEAD = 0x10;
const block = { number: `0x${HEAD.toString(16)}`, hash: `0x${"ab".repeat(32)}`, parentHash: `0x${"cd".repeat(32)}` };

/** Both default networks answer with their own chain id and the same head block. */
function networks() {
  const calls: { url: string; method: string }[] = [];
  return {
    calls,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = href(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      calls.push({ url, method: body.method });
      const result = body.method === "eth_chainId"
        ? mainnet.has(url) ? "0x3e7" : "0x3e6"
        : body.method === "eth_getBlockByNumber" ? block : block.number;
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  };
}

function dual(mock: ReturnType<typeof networks>) {
  return hyperevm({ fetchFn: mock.fetchFn, headLag: { probeInterval: false }, race: false, cache: false });
}

describe("dual-network HyperEVM transport", () => {
  test("a request that names no network is rejected without reaching either pool", async () => {
    const mock = networks();
    const client = dual(mock);
    try {
      await expect(client.request({ method: "eth_blockNumber" })).rejects.toThrow(/chain/i);
      const [settled] = await client.requestBatch([{ method: "eth_blockNumber" }]);
      expect(settled?.status).toBe("rejected");
      expect(mock.calls).toEqual([]);
    } finally { client.close?.(); }
  });

  test("probe() reads the head block from every default endpoint on both networks", async () => {
    const mock = networks();
    const client = dual(mock);
    try {
      expect(client.snapshot?.().map((row) => row.head)).toEqual(
        [...HYPEREVM_MAINNET_ENDPOINTS, ...HYPEREVM_TESTNET_ENDPOINTS].map(() => null),
      );
      await expect(client.probe?.()).resolves.toBeUndefined();
      const probed = mock.calls.filter((call) => call.method === "eth_getBlockByNumber").map((call) => call.url).sort();
      expect(probed).toEqual([...HYPEREVM_MAINNET_ENDPOINTS, ...HYPEREVM_TESTNET_ENDPOINTS].map(href).sort());
      const rows = client.snapshot?.() ?? [];
      expect(rows.map((row) => row.url)).toEqual([...HYPEREVM_MAINNET_ENDPOINTS, ...HYPEREVM_TESTNET_ENDPOINTS]);
      expect(rows.map((row) => row.head)).toEqual(rows.map(() => HEAD));
    } finally { client.close?.(); }
  });

  test("onEvent listens to both pools until its single unsubscribe is called", async () => {
    const mock = networks();
    const client = dual(mock);
    const events: RpcEvent[] = [];
    try {
      const stop = client.onEvent?.((event) => events.push(event));
      expect(stop).toBeTypeOf("function");
      await client.request({ chainId: HYPEREVM_MAINNET_CAIP, method: "eth_blockNumber" });
      await client.request({ chainId: HYPEREVM_TESTNET_CAIP, method: "eth_blockNumber" });
      const served = events.flatMap((event) => event.type === "success" && event.method === "eth_blockNumber" ? [href(event.endpoint)] : []);
      expect(served).toHaveLength(2);
      expect(mainnet.has(served[0] ?? "")).toBe(true);
      expect(HYPEREVM_TESTNET_ENDPOINTS.map(href)).toContain(served[1]);

      stop?.();
      const seen = events.length;
      await client.request({ chainId: HYPEREVM_MAINNET_CAIP, method: "eth_gasPrice" });
      await client.request({ chainId: HYPEREVM_TESTNET_CAIP, method: "eth_gasPrice" });
      expect(mock.calls.filter((call) => call.method === "eth_gasPrice")).toHaveLength(2);
      expect(events).toHaveLength(seen);
    } finally { client.close?.(); }
  });
});
