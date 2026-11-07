import { describe, expect, test } from "vitest";

import {
  defaultRankPolicy,
  LOGS_RANGE_PROBE,
  PRECOMPILE_PROBE,
  rankRegistry,
  refuseRegistryRewrite,
  type ProbeObservation,
} from "../src/registry/policy.js";

const NOW = Date.parse("2026-10-30T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const endpoint = (url: string) => ({ url });

function observation(url: string, daysAgo: number, ms: number, ok = true, chainIdOk = true): ProbeObservation {
  return {
    at: new Date(NOW - daysAgo * DAY).toISOString(),
    url,
    ok: ok && chainIdOk,
    chainIdOk,
    head: chainIdOk ? 1_000 : null,
    lag: 0,
    methods: {
      eth_chainId: { ms, ok: chainIdOk },
      eth_blockNumber: { ms, ok },
      eth_call: { ms: ms + 5, ok },
      eth_getLogs: { ms: ms + 50, ok },
    },
  };
}

function withProbes(url: string, daysAgo: number, probes: { precompile?: boolean; range?: boolean }, ms = 40): ProbeObservation {
  const sample = observation(url, daysAgo, ms);
  if (probes.precompile !== undefined) sample.methods[PRECOMPILE_PROBE] = { ms, ok: probes.precompile };
  if (probes.range !== undefined) sample.methods[LOGS_RANGE_PROBE] = { ms: ms + 100, ok: probes.range };
  return sample;
}

describe("HyperEVM registry ranking", () => {
  test("caps a single new-node observation", () => {
    const url = "https://new.example/evm";
    const [ranked] = rankRegistry([endpoint(url)], [observation(url, 0, 40)], NOW);
    expect(ranked).toMatchObject({ eligible: true, weight: defaultRankPolicy.newNodeWeightCap, rank: 1 });
    expect(ranked?.stats?.established).toBe(false);
  });

  test("requires three successes spread over two weeks for full weight", () => {
    const url = "https://veteran.example/evm";
    const established = rankRegistry([endpoint(url)], [20, 10, 1].map((days) => observation(url, days, 80)), NOW)[0];
    expect(established).toMatchObject({ weight: 1 });
    expect(established?.stats?.established).toBe(true);

    const burst = rankRegistry([endpoint(url)], [0, 0, 0].map(() => observation(url, 0, 30)), NOW)[0];
    expect(burst?.stats?.established).toBe(false);
    expect(burst?.weight).toBe(defaultRankPolicy.newNodeWeightCap);
  });

  test("keeps low-uptime, wrong-chain, unobserved, and expired endpoints ineligible", () => {
    const flaky = "https://flaky.example/evm";
    const wrong = "https://wrong.example/evm";
    const old = "https://old.example/evm";
    const missing = "https://missing.example/evm";
    const observations = [
      observation(flaky, 0, 40, true), observation(flaky, 0, 40, false), observation(flaky, 0, 40, false),
      observation(wrong, 0, 10, true, false), observation(old, 40, 20),
    ];
    const ranked = rankRegistry([flaky, wrong, old, missing].map(endpoint), observations, NOW);
    for (const url of [flaky, wrong, old, missing]) {
      expect(ranked.find((row) => row.url === url)).toMatchObject({ eligible: false, weight: 0, rank: null });
    }
    expect(ranked.find((row) => row.url === old)?.stats?.observations).toBe(0);
  });

  test("uses the worst per-method median and the successful tail", () => {
    const url = "https://slow-logs.example/evm";
    const first = observation(url, 2, 20);
    const second = observation(url, 1, 30);
    for (const sample of [first, second]) {
      sample.methods.eth_chainId = { ms: 15, ok: true };
      sample.methods.eth_getLogs = { ms: 900, ok: true };
    }
    second.methods.eth_call = { ms: 1_200, ok: true };
    const [ranked] = rankRegistry([endpoint(url)], [first, second], NOW);
    expect(ranked?.stats?.latencyMs).toBe(900);
    expect(ranked?.stats?.tailMs).toBe(1_200);
  });

  test("ignores two blocks of lag but penalizes a stale head", () => {
    const fresh = "https://fresh.example/evm";
    const fast = "https://fast.example/evm";
    const behind = "https://behind.example/evm";
    const freshObs = observation(fresh, 0, 200);
    const fastObs = observation(fast, 0, 40);
    fastObs.lag = 2;
    expect(rankRegistry([fresh, fast].map(endpoint), [freshObs, fastObs], NOW)[0]?.url).toBe(fast);
    const behindObs = observation(behind, 0, 40);
    behindObs.lag = 10;
    expect(rankRegistry([fresh, behind].map(endpoint), [freshObs, behindObs], NOW)[0]?.url).toBe(fresh);
  });

  test("caps newcomers collectively without reducing established weight", () => {
    const veteran = "https://veteran.example/evm";
    const fresh = Array.from({ length: 10 }, (_, index) => `https://new-${index}.example/evm`);
    const observations = [
      ...[20, 10, 1].map((days) => observation(veteran, days, 100)),
      ...fresh.map((url) => observation(url, 0, 10)),
    ];
    const ranked = rankRegistry([veteran, ...fresh].map(endpoint), observations, NOW);
    const established = ranked.find((row) => row.url === veteran);
    const newcomers = ranked.filter((row) => row.url !== veteran && row.eligible);
    const newWeight = newcomers.reduce((sum, row) => sum + row.weight, 0);
    expect(established?.weight).toBe(1);
    expect(newWeight / ((established?.weight ?? 0) + newWeight)).toBeLessThanOrEqual(defaultRankPolicy.maxNewNodeShare + 0.001);
    expect(newcomers.every((row) => row.weight < defaultRankPolicy.newNodeWeightCap)).toBe(true);
  });

  test("makes equal-score ordering deterministic", () => {
    const urls = ["https://b.example/evm", "https://a.example/evm"];
    const observations = urls.map((url) => observation(url, 0, 20));
    expect(rankRegistry(urls.map(endpoint), observations, NOW).map((row) => row.url)).toEqual([...urls].reverse());
  });
});

describe("HyperEVM capability probes", () => {
  test("vetoes an endpoint whose latest live HyperCore probe failed", () => {
    const url = "https://lost-core.example/evm";
    const observations = [
      withProbes(url, 20, { precompile: true, range: true }),
      withProbes(url, 10, { precompile: true, range: true }),
      withProbes(url, 1, { precompile: false, range: true }),
    ];
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked).toMatchObject({ eligible: false, weight: 0, rank: null });
    expect(ranked?.stats?.precompileOk).toBe(false);
  });

  test("restores eligibility after a later HyperCore success", () => {
    const url = "https://recovered.example/evm";
    const observations = [
      withProbes(url, 20, { precompile: true, range: true }),
      withProbes(url, 10, { precompile: false, range: true }),
      withProbes(url, 1, { precompile: true, range: true }),
    ];
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.eligible).toBe(true);
    expect(ranked?.stats).toMatchObject({ precompileOk: true, successes: 2 });
  });

  test("does not treat a down node as a HyperCore verdict", () => {
    const url = "https://blip.example/evm";
    const down = withProbes(url, 1, { precompile: false, range: false });
    down.ok = false;
    const observations = [withProbes(url, 20, { precompile: true, range: true }), withProbes(url, 10, {}), down];
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.stats?.precompileOk).toBe(true);
    expect(ranked?.eligible).toBe(true);
  });

  test("counts failed 999-block log pages as missed probes", () => {
    const url = "https://range-capped.example/evm";
    const observations = [20, 10, 1].map((days) => withProbes(url, days, { precompile: true, range: false }));
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.stats).toMatchObject({ successes: 0, uptime: 0 });
    expect(ranked?.eligible).toBe(false);
  });

  test("does not punish legacy observations that predate capability probes", () => {
    const url = "https://legacy.example/evm";
    const observations = [20, 10, 1].map((days) => observation(url, days, 80));
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.stats).toMatchObject({ established: true, precompileOk: null, uptime: 1 });
    expect(ranked?.weight).toBe(1);
  });
});

describe("rewrite safeguards", () => {
  test("refuses to replace a healthy pool with an empty one", () => {
    const urls = ["https://a.example/evm", "https://b.example/evm"];
    const healthy = rankRegistry(urls.map(endpoint), urls.map((url) => withProbes(url, 3, { precompile: true, range: true })), NOW);
    const blip = rankRegistry(urls.map(endpoint), [
      ...urls.map((url) => withProbes(url, 3, { precompile: true, range: true })),
      ...urls.map((url) => withProbes(url, 0, { precompile: false, range: true })),
    ], NOW);
    expect(blip.some((row) => row.eligible)).toBe(false);
    expect(refuseRegistryRewrite(healthy, blip)).toMatch(/no endpoint eligible/i);
    expect(refuseRegistryRewrite(healthy, healthy)).toBeUndefined();
    expect(refuseRegistryRewrite(blip, blip)).toBeUndefined();
  });
});
