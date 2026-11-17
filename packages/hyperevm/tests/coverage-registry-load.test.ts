import { afterEach, describe, expect, test, vi } from "vitest";

import liveRanking from "../registry/mainnet.json" with { type: "json" };
import type { MainnetRegistryFile, MainnetRegistryRow } from "../src/registry/data.js";

const RANKING_MODULE = "../registry/mainnet.json";
const SOURCE_URLS = [
  "https://rpc.hyperliquid.xyz/evm",
  "https://rpc.hypurrscan.io",
  "https://hyperliquid.drpc.org",
  "https://hyperliquid-json-rpc.stakely.io",
  "https://hyperliquid-rpc.publicnode.com",
] as const;

const offline = (url: string): MainnetRegistryRow => ({ url, eligible: false, weight: 0, rank: null, stats: null });
const ranked = (url: string, rank: number, weight: number): MainnetRegistryRow => ({ url, eligible: true, weight, rank, stats: null });

function ranking(endpoints: MainnetRegistryRow[]): MainnetRegistryFile {
  return { version: 1, chainId: 999, updatedAt: "2026-11-01T00:00:00.000Z", policy: liveRanking.policy, endpoints };
}

/** Load the registry module against a substitute for the committed ranking document. */
async function loadWith(document: unknown): Promise<typeof import("../src/registry.js")> {
  vi.resetModules();
  vi.doMock(RANKING_MODULE, () => ({ default: document }));
  return import("../src/registry.js");
}

afterEach(() => {
  vi.doUnmock(RANKING_MODULE);
  vi.resetModules();
});

describe("HyperEVM registry loading", () => {
  test("the committed ranking covers exactly the source registry", () => {
    expect(liveRanking.endpoints.map(({ url }) => url).sort()).toEqual([...SOURCE_URLS].sort());
  });

  test("orders ranked endpoints first and lists unranked ones by URL, outside the default pool", async () => {
    const registry = await loadWith(ranking([
      offline(SOURCE_URLS[0]),
      ranked(SOURCE_URLS[1], 2, 0.15),
      offline(SOURCE_URLS[2]),
      ranked(SOURCE_URLS[3], 1, 1),
      offline(SOURCE_URLS[4]),
    ]));
    expect(registry.HYPEREVM_MAINNET_REGISTRY.map(({ url, rank, weight }) => ({ url, rank, weight }))).toEqual([
      { url: "https://hyperliquid-json-rpc.stakely.io", rank: 1, weight: 1 },
      { url: "https://rpc.hypurrscan.io", rank: 2, weight: 0.15 },
      { url: "https://hyperliquid-rpc.publicnode.com", rank: null, weight: 0 },
      { url: "https://hyperliquid.drpc.org", rank: null, weight: 0 },
      { url: "https://rpc.hyperliquid.xyz/evm", rank: null, weight: 0 },
    ]);
    expect(registry.HYPEREVM_MAINNET_ENDPOINTS).toEqual(["https://hyperliquid-json-rpc.stakely.io", "https://rpc.hypurrscan.io"]);
    // Source metadata survives the merge with ranking data.
    expect(registry.HYPEREVM_MAINNET_REGISTRY.find(({ id }) => id === "hyperliquid-mainnet")).toMatchObject({
      provider: "Hyperliquid", rps: 1.5, burst: 3, eligible: false,
    });
  });

  test("matches ranking rows to sources despite host case and a trailing slash", async () => {
    const registry = await loadWith(ranking([
      ranked("https://RPC.hyperliquid.xyz/evm/", 1, 1),
      ...SOURCE_URLS.slice(1).map(offline),
    ]));
    expect(registry.HYPEREVM_MAINNET_REGISTRY[0]).toMatchObject({ id: "hyperliquid-mainnet", rank: 1, eligible: true, weight: 1 });
    expect(registry.HYPEREVM_MAINNET_ENDPOINTS).toHaveLength(1);
  });

  test("refuses to load a ranking with fewer endpoints than the source registry", async () => {
    await expect(loadWith(ranking(SOURCE_URLS.slice(0, 4).map(offline))))
      .rejects.toThrow("HyperEVM ranking data and source registry contain different endpoint counts.");
  });

  test("refuses to load a ranking with more endpoints than the source registry", async () => {
    await expect(loadWith(ranking([...SOURCE_URLS, "https://extra.example/evm"].map(offline))))
      .rejects.toThrow("HyperEVM ranking data and source registry contain different endpoint counts.");
  });

  test("refuses to load a ranking that swaps a source endpoint for an unknown URL", async () => {
    await expect(loadWith(ranking([...SOURCE_URLS.slice(0, 4), "https://unknown.example/evm"].map(offline))))
      .rejects.toThrow("HyperEVM ranking data is missing https://hyperliquid-rpc.publicnode.com.");
  });

  test("refuses to load a ranking document that fails validation", async () => {
    await expect(loadWith({ ...ranking(SOURCE_URLS.map(offline)), chainId: 998 }))
      .rejects.toThrow("Registry must be a version-1 HyperEVM mainnet document.");
  });
});
