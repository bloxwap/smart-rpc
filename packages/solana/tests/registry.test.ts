import { describe, expect, test } from "vitest";

import {
  DEVNET_ENDPOINTS,
  DEVNET_REGISTRY,
  MAINNET_ENDPOINTS,
  MAINNET_GENESIS_HASH,
  MAINNET_REGISTRY,
  TESTNET_ENDPOINTS,
  TESTNET_REGISTRY,
  defaultEndpoints,
  solana,
} from "../src/index.js";

const clusters = [
  { cluster: "mainnet", endpoints: MAINNET_ENDPOINTS, registry: MAINNET_REGISTRY },
  { cluster: "devnet", endpoints: DEVNET_ENDPOINTS, registry: DEVNET_REGISTRY },
  { cluster: "testnet", endpoints: TESTNET_ENDPOINTS, registry: TESTNET_REGISTRY },
] as const;

describe("Solana public registry", () => {
  test.each(clusters)("$cluster defaults preserve config arrays and enforce endpoint budgets", ({ cluster, endpoints, registry }) => {
    const pool = solana({ cluster, headLag: false, now: () => 0 });
    try {
      expect(defaultEndpoints(cluster)).toBe(endpoints);
      expect(pool.endpoints.map((endpoint) => endpoint.url)).toEqual(registry.map((endpoint) => endpoint.url));
      expect(pool.snapshot().map((endpoint) => ({ id: endpoint.id, tokens: endpoint.tokens }))).toEqual(
        registry.map((endpoint) => ({ id: endpoint.id, tokens: endpoint.burst })),
      );
      for (const endpoint of endpoints) {
        expect(endpoint.url).toMatch(/^https:\/\//);
        expect(endpoint.rps).toBeGreaterThan(0);
      }
    } finally {
      pool.close();
    }
  });

  test("registries have unique public URLs and provider provenance without credentials", () => {
    const entries = clusters.flatMap(({ registry }) => registry);
    expect(new Set(entries.map((endpoint) => endpoint.url)).size).toBe(entries.length);
    expect(new Set(entries.map((endpoint) => endpoint.id)).size).toBe(entries.length);
    for (const entry of entries) {
      const url = new URL(entry.url);
      expect(url.protocol).toBe("https:");
      expect(url.username).toBe("");
      expect(url.password).toBe("");
      expect(url.search).toBe("");
      expect(entry.provider.length).toBeGreaterThan(0);
      expect(entry.sourceUrls.length).toBeGreaterThan(0);
      expect(entry.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.burst).toBeGreaterThanOrEqual(1);
    }
  });

  test("explicit endpoint configuration completely replaces public defaults", () => {
    const pool = solana({
      endpoints: [{ label: "private", url: "https://private.example/rpc", rps: 7, burst: 9 }],
      headLag: false,
    });
    try {
      expect(pool.endpoints).toEqual([{ id: "private", url: "https://private.example/rpc", weight: 1 }]);
      expect(pool.snapshot()[0]?.tokens).toBe(9);
    } finally {
      pool.close();
    }
  });

  test("budget false disables registry limits", () => {
    const pool = solana({ budget: false, headLag: false });
    try {
      expect(pool.snapshot().every((endpoint) => endpoint.tokens === null)).toBe(true);
    } finally {
      pool.close();
    }
  });

  test("known method restrictions skip Pocket during default failover", async () => {
    const calls: { url: string; method: string }[] = [];
    const first = MAINNET_ENDPOINTS[0]!.url;
    const pocket = MAINNET_REGISTRY.find((endpoint) => endpoint.id === "pocket")!;
    const pool = solana({
      routing: "best",
      race: false,
      headLag: false,
      cache: false,
      budget: false,
      fetchFn: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = JSON.parse(String(init?.body)) as { id: number; method: string };
        calls.push({ url, method: body.method });
        if (url === first && body.method === "getTokenAccountsByOwner") {
          return new Response("unavailable", { status: 503 });
        }
        const result = body.method === "getGenesisHash" ? MAINNET_GENESIS_HASH : { context: { slot: 12 }, value: [] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      await expect(pool.request({ method: "getTokenAccountsByOwner", params: ["owner", { programId: "token" }] }))
        .resolves.toEqual({ context: { slot: 12 }, value: [] });
      expect(calls.filter((call) => call.method === "getTokenAccountsByOwner")).toHaveLength(2);
      expect(calls.some((call) => call.url === pocket.url)).toBe(false);
    } finally {
      pool.close();
    }
  });
});
