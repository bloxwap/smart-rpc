import { describe, expect, test } from "vitest";

import {
  ETHEREUM_MAINNET_ENDPOINTS,
  ETHEREUM_MAINNET_REGISTRY,
  ethereum,
} from "../src/index.js";

describe("Ethereum public registry defaults", () => {
  test("installs the complete registry with provider budgets and URL identities", () => {
    const pool = ethereum({ headLag: { probeInterval: false }, now: () => 0 });
    try {
      expect(pool.endpoints.map((endpoint) => endpoint.url)).toEqual(ETHEREUM_MAINNET_ENDPOINTS);
      expect(pool.snapshot().map(({ id, tokens }) => ({ id, tokens }))).toEqual(
        ETHEREUM_MAINNET_REGISTRY.map(({ url, burst }) => ({ id: url, tokens: burst })),
      );
      expect(ETHEREUM_MAINNET_REGISTRY.map(({ url }) => url)).toEqual(ETHEREUM_MAINNET_ENDPOINTS);
      expect(ETHEREUM_MAINNET_REGISTRY.length).toBeLessThanOrEqual(5);
      expect(ETHEREUM_MAINNET_ENDPOINTS.length).toBeLessThanOrEqual(5);
      expect(ETHEREUM_MAINNET_ENDPOINTS).not.toContain("https://rpc.ankr.com/eth");
      expect(ETHEREUM_MAINNET_ENDPOINTS).not.toContain("https://cloudflare-eth.com");
    } finally {
      pool.close();
    }
  });

  test("explicit endpoints replace defaults and preserve caller budgets", () => {
    const pool = ethereum({
      chainId: 8453,
      endpoints: [{ url: "https://base.example/rpc", rps: 7, burst: 11 }],
      headLag: { probeInterval: false },
      now: () => 0,
    });
    try {
      expect(pool.chainIds).toEqual(["eip155:8453"]);
      expect(pool.endpoints).toEqual([{ id: "https://base.example/rpc", url: "https://base.example/rpc", weight: 1 }]);
      expect(pool.snapshot()[0]?.tokens).toBe(11);
    } finally {
      pool.close();
    }
    expect(() => ethereum({ chainId: 8453 })).toThrow("has no default endpoints");
  });

  test("budget:false disables registry budgets", () => {
    const pool = ethereum({ budget: false, headLag: { probeInterval: false } });
    try {
      expect(pool.snapshot().every((endpoint) => endpoint.tokens === null)).toBe(true);
    } finally {
      pool.close();
    }
  });

  test("a failing endpoint falls back after verifying the next provider's chain", async () => {
    const first = "https://first.example/rpc";
    const second = "https://second.example/rpc";
    const calls: { url: string; method: string }[] = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      calls.push({ url, method: request.method });
      if (url === first && request.method === "eth_getBalance") {
        return new Response("Unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: request.method === "eth_chainId" ? "0x1" : "0x2a",
      }), { headers: { "content-type": "application/json" } });
    };
    const pool = ethereum({
      endpoints: [first, second],
      fetchFn,
      routing: "best",
      race: false,
      cache: false,
      headLag: { probeInterval: false },
    });
    try {
      await expect(pool.request({
        method: "eth_getBalance",
        params: ["0x0000000000000000000000000000000000000000", "latest"],
      })).resolves.toBe("0x2a");
      expect(calls).toEqual([
        { url: first, method: "eth_chainId" },
        { url: first, method: "eth_getBalance" },
        { url: second, method: "eth_chainId" },
        { url: second, method: "eth_getBalance" },
      ]);
    } finally {
      pool.close();
    }
  });
});
