import { describe, expect, test } from "vitest";

import {
  endpointKey,
  PRECOMPILE_PROBE,
  rankRegistry,
  type ProbeObservation,
} from "../src/registry/policy.js";

const NOW = Date.parse("2026-10-30T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function observation(url: string, hoursAgo: number, ms: number, overrides: Partial<ProbeObservation> = {}): ProbeObservation {
  return {
    at: new Date(NOW - hoursAgo * HOUR).toISOString(),
    url,
    ok: true,
    chainIdOk: true,
    head: 1_000,
    lag: 0,
    methods: { eth_chainId: { ms, ok: true }, eth_blockNumber: { ms, ok: true } },
    ...overrides,
  };
}

describe("endpoint keys", () => {
  test("a string that is not a URL is its own key", () => {
    expect(endpointKey("not a url")).toBe("not a url");
    expect(endpointKey("")).toBe("");
  });

  test("host case, a trailing slash, and a fragment do not change a URL's key", () => {
    expect(endpointKey("https://Node.Example/evm/#top")).toBe("https://node.example/evm");
    expect(endpointKey("https://node.example")).toBe(endpointKey("https://node.example/"));
    expect(endpointKey("https://node.example/evm?key=1")).not.toBe(endpointKey("https://node.example/evm"));
  });

  test("history recorded under a non-URL label still ranks that label", () => {
    const [row] = rankRegistry([{ url: "local-node" }], [observation("local-node", 1, 40)], NOW);
    expect(row).toMatchObject({ url: "local-node", eligible: true, rank: 1 });
    expect(row?.stats?.observations).toBe(1);
  });
});

describe("HyperCore verdict ordering", () => {
  const url = "https://node.example/evm";
  const precompile = (hoursAgo: number, ok: boolean): ProbeObservation => {
    const sample = observation(url, hoursAgo, 40);
    sample.methods[PRECOMPILE_PROBE] = { ms: 40, ok };
    return sample;
  };

  test("the newest verdict wins even when history lists an older one after it", () => {
    const recovered = rankRegistry([{ url }], [precompile(1, true), precompile(48, false), precompile(72, true)], NOW)[0];
    expect(recovered?.stats?.precompileOk).toBe(true);
    expect(recovered?.stats).toMatchObject({ observations: 3, successes: 2 });
    expect(recovered?.eligible).toBe(true);

    const regressed = rankRegistry([{ url }], [precompile(1, false), precompile(48, true), precompile(72, true)], NOW)[0];
    expect(regressed?.stats?.precompileOk).toBe(false);
    expect(regressed).toMatchObject({ eligible: false, weight: 0, rank: null });
  });
});

describe("ranking without lag data", () => {
  test("an endpoint with no recorded lag is ranked on latency alone", () => {
    const fast = "https://fast.example/evm";
    const slow = "https://slow.example/evm";
    const ranked = rankRegistry(
      [{ url: slow }, { url: fast }],
      [observation(slow, 1, 200, { lag: null }), observation(fast, 1, 50, { lag: null })],
      NOW,
    );
    expect(ranked.map(({ url, rank }) => [url, rank])).toEqual([[fast, 1], [slow, 2]]);
    expect(ranked.map((row) => row.stats?.medianLag)).toEqual([null, null]);
  });
});

describe("ranking order of unranked endpoints", () => {
  test("ineligible endpoints follow every ranked one, sorted by URL", () => {
    const urls = ["https://d-down.example", "https://b-fast.example", "https://c-down.example", "https://a-slow.example", "https://e-unseen.example"];
    const ranked = rankRegistry(
      urls.map((url) => ({ url })),
      [
        observation("https://d-down.example", 1, 10, { ok: false }),
        observation("https://b-fast.example", 1, 20),
        observation("https://c-down.example", 1, 10, { ok: false, chainIdOk: false, head: null, lag: null }),
        observation("https://a-slow.example", 1, 300),
      ],
      NOW,
    );
    expect(ranked.map(({ url, rank }) => [url, rank])).toEqual([
      ["https://b-fast.example", 1],
      ["https://a-slow.example", 2],
      ["https://c-down.example", null],
      ["https://d-down.example", null],
      ["https://e-unseen.example", null],
    ]);
    expect(ranked.slice(2).every((row) => !row.eligible && row.weight === 0)).toBe(true);
    expect(ranked[4]?.stats).toMatchObject({ observations: 0, uptime: 0, latencyMs: null, tailMs: null, precompileOk: null });
  });
});
