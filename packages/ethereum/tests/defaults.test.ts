import { describe, expect, test } from "vitest";

import { ETHEREUM_MAINNET_REGISTRY, ethereum, supportsEvmRequest } from "../src/index.js";

describe("default Ethereum pool", () => {
  test("routes with the registry's capabilities, so historical state never reaches a latest-only node", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (body.method === "eth_getBalance") urls.push(new URL(String(input)).href);
      const result = body.method === "eth_chainId" ? "0x1" : "0x0";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const pool = ethereum({ fetchFn, headLag: { probeInterval: false }, race: false, cache: false, retryCount: 0 });
    const archive = { method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000000", "0x1"] };
    const capable = new Set(ETHEREUM_MAINNET_REGISTRY.filter(({ capabilities }) => supportsEvmRequest(capabilities, archive)).map(({ url }) => new URL(url).href));
    try {
      expect(capable.size).toBeLessThan(ETHEREUM_MAINNET_REGISTRY.length);
      for (let index = 0; index < 6; index += 1) await pool.request(archive);
      expect(urls.length).toBe(6);
      expect(urls.filter((url) => !capable.has(url))).toEqual([]);
    } finally {
      pool.close();
    }
  });
});
