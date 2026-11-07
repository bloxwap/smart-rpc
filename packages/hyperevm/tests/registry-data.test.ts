import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  assertMainnetRegistryFile,
  assertObservationDocument,
  refreshMainnetRegistry,
  type MainnetRegistryFile,
  type RegistryHistoryFile,
} from "../src/registry/data.js";
import {
  defaultRankPolicy,
  LOGS_RANGE_PROBE,
  PRECOMPILE_PROBE,
  rankRegistry,
  type ProbeObservation,
  type RankedEndpoint,
} from "../src/registry/policy.js";

const NOW = Date.parse("2026-10-30T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function observation(url: string, daysAgo: number, options: { ok?: boolean; chain?: boolean; core?: boolean } = {}): ProbeObservation {
  const ok = options.ok ?? true;
  const chain = options.chain ?? true;
  return {
    at: new Date(NOW - daysAgo * DAY).toISOString(),
    url,
    ok: ok && chain,
    chainIdOk: chain,
    head: chain ? 1_000 : null,
    lag: chain ? 0 : null,
    methods: {
      eth_chainId: { ms: 20, ok: chain },
      eth_blockNumber: { ms: 30, ok },
      [PRECOMPILE_PROBE]: { ms: 40, ok: options.core ?? true },
      [LOGS_RANGE_PROBE]: { ms: 100, ok },
    },
  };
}

function document(endpoints: readonly { url: string }[], observations: readonly ProbeObservation[]): MainnetRegistryFile {
  const ranked = rankRegistry(endpoints, observations, NOW);
  return {
    version: 1,
    chainId: 999,
    updatedAt: new Date(NOW).toISOString(),
    policy: { ...defaultRankPolicy },
    endpoints: ranked.map((row) => ({
      url: row.url, eligible: row.eligible, weight: row.weight, rank: row.rank, stats: row.stats,
    })),
  };
}

function history(observations: ProbeObservation[]): RegistryHistoryFile {
  return { version: 1, chainId: 999, observations };
}

describe("registry refresh safety", () => {
  test("refuses a wrong-chain-only run even when old history is healthy", () => {
    const endpoints = [{ url: "https://node.example/evm" }];
    const healthy = observation(endpoints[0]!.url, 1);
    const wrong = observation(endpoints[0]!.url, 0, { ok: false, chain: false });
    expect(() => refreshMainnetRegistry(endpoints, document(endpoints, [healthy]), history([healthy]), [wrong], NOW))
      .toThrow(/valid chain 999 identity and head/i);
  });

  test("refuses a capability blip that would empty the previous pool", () => {
    const endpoints = [{ url: "https://node.example/evm" }];
    const healthy = observation(endpoints[0]!.url, 1);
    const noCore = observation(endpoints[0]!.url, 0, { core: false });
    expect(() => refreshMainnetRegistry(endpoints, document(endpoints, [healthy]), history([healthy]), [noCore], NOW))
      .toThrow(/no endpoint eligible/i);
  });

  test("refuses missing sources and missing source observations", () => {
    const endpoint = { url: "https://node.example/evm" };
    const healthy = observation(endpoint.url, 0);
    const previous = document([endpoint], [healthy]);
    expect(() => refreshMainnetRegistry([], previous, history([]), [healthy], NOW)).toThrow(/no endpoints/i);
    expect(() => refreshMainnetRegistry([endpoint], previous, history([]), [observation("https://unknown.example/evm", 0)], NOW))
      .toThrow(/no source observations/i);
  });

  test("retains only in-window source history and preserves source metadata", () => {
    const endpoint = { url: "https://node.example/", marker: "capabilities-and-budgets" };
    const old = observation(endpoint.url, 40);
    const prior = observation("https://removed.example/evm", 1);
    const current = observation("https://node.example", 0);
    const previous = document([endpoint], [current]);
    const refreshed = refreshMainnetRegistry([endpoint], previous, history([old, prior]), [current], NOW);
    expect(refreshed.history.observations.map((row) => row.url)).toEqual([current.url]);
    expect((refreshed.ranked[0] as RankedEndpoint<typeof endpoint>).marker).toBe(endpoint.marker);
    expect(refreshed.registry.endpoints[0]?.url).toBe(endpoint.url);
  });

  test("validates eligibility, weight, and rank together", () => {
    const endpoint = { url: "https://node.example/evm" };
    const valid = document([endpoint], [observation(endpoint.url, 0)]);
    expect(() => assertMainnetRegistryFile(valid)).not.toThrow();
    expect(() => assertMainnetRegistryFile({ ...valid, endpoints: [{ ...valid.endpoints[0]!, weight: 0 }] }))
      .toThrow(/inconsistent eligibility/i);
  });
});

test("ranks the checked-in multi-day fixture without live RPCs", async () => {
  const fixture: unknown = JSON.parse(await readFile(new URL("./fixtures/mainnet-observations.json", import.meta.url), "utf8"));
  assertObservationDocument(fixture);
  const endpoints = [{ url: "https://veteran.example/evm" }, { url: "https://new.example/evm" }];
  const ranked = rankRegistry(endpoints, fixture.observations, NOW);
  expect(ranked.find((row) => row.url.endsWith("veteran.example/evm"))?.stats?.established).toBe(true);
  expect(ranked.find((row) => row.url.endsWith("veteran.example/evm"))?.weight).toBe(1);
  expect(ranked.find((row) => row.url.endsWith("new.example/evm"))?.weight).toBe(defaultRankPolicy.newNodeWeightCap);
});
