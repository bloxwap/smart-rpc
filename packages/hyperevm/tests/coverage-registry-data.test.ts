import { describe, expect, test } from "vitest";

import liveHistory from "../registry/history.json" with { type: "json" };
import liveRanking from "../registry/mainnet.json" with { type: "json" };
import {
  assertMainnetRegistryFile,
  assertObservationDocument,
  assertRankPolicy,
  assertRegistryHistoryFile,
  refreshMainnetRegistry,
  type MainnetRegistryFile,
  type RegistryHistoryFile,
} from "../src/registry/data.js";
import { defaultRankPolicy, rankRegistry, type ProbeObservation } from "../src/registry/policy.js";

const NOW = Date.parse("2026-10-30T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const stats = {
  observations: 4, successes: 3, uptime: 0.75, latencyMs: 120.5, tailMs: 300, medianLag: 0.5,
  established: false, precompileOk: true,
};

/** A valid document as plain JSON, so one field at a time can be corrupted. */
function validDocument(): Record<string, unknown> & { policy: Record<string, unknown>; endpoints: Record<string, unknown>[] } {
  return {
    version: 1,
    chainId: 999,
    updatedAt: "2026-10-30T00:00:00.000Z",
    policy: { ...defaultRankPolicy },
    endpoints: [
      { url: "https://a.example/evm", eligible: true, weight: 0.15, rank: 1, stats: { ...stats } },
      { url: "https://b.example/evm", eligible: false, weight: 0, rank: null, stats: null },
    ],
  };
}

type Document = ReturnType<typeof validDocument>;

function corrupt(change: (document: Document) => void): Document {
  const document = validDocument();
  change(document);
  return document;
}

const row = (document: Document): Record<string, unknown> => document.endpoints[0]!;
const rowStats = (document: Document): Record<string, unknown> => row(document).stats as Record<string, unknown>;

describe("mainnet registry document validation", () => {
  test("accepts the committed ranking and history files", () => {
    expect(() => assertMainnetRegistryFile(liveRanking)).not.toThrow();
    expect(() => assertRegistryHistoryFile(liveHistory)).not.toThrow();
  });

  test("accepts a valid document, including a never-probed row without stats", () => {
    expect(() => assertMainnetRegistryFile(validDocument())).not.toThrow();
    expect(() => assertMainnetRegistryFile(corrupt((document) => { rowStats(document).precompileOk = null; }))).not.toThrow();
    expect(() => assertMainnetRegistryFile(corrupt((document) => {
      Object.assign(rowStats(document), { latencyMs: null, tailMs: null, medianLag: null });
    }))).not.toThrow();
  });

  test.each<[string, unknown | ((document: Document) => void), string]>([
    ["a non-object", null, "Registry must be a version-1 HyperEVM mainnet document."],
    ["an array", [validDocument()], "Registry must be a version-1 HyperEVM mainnet document."],
    ["another version", (d: Document) => { d.version = 2; }, "Registry must be a version-1 HyperEVM mainnet document."],
    ["the testnet chain", (d: Document) => { d.chainId = 998; }, "Registry must be a version-1 HyperEVM mainnet document."],
    ["a numeric updatedAt", (d: Document) => { d.updatedAt = NOW; }, "Registry updatedAt must be an ISO date."],
    ["an unparseable updatedAt", (d: Document) => { d.updatedAt = "last tuesday"; }, "Registry updatedAt must be an ISO date."],
    ["endpoints that are not an array", (d: Document) => { Object.assign(d, { endpoints: {} }); }, "Registry endpoints must be a non-empty array."],
    ["no endpoints", (d: Document) => { d.endpoints = []; }, "Registry endpoints must be a non-empty array."],
    ["a row that is not an object", (d: Document) => { Object.assign(d, { endpoints: ["https://a.example/evm"] }); }, "Registry endpoints[0] must have a URL."],
    ["a row without a URL", (d: Document) => { delete d.endpoints[1]!.url; }, "Registry endpoints[1] must have a URL."],
    ["a row with an empty URL", (d: Document) => { row(d).url = ""; }, "Registry endpoints[0] must have a URL."],
    [
      "the same endpoint under two spellings",
      (d: Document) => { d.endpoints[1]!.url = "https://A.example/evm/"; },
      "Registry lists https://A.example/evm/ more than once.",
    ],
    ["a non-boolean eligible flag", (d: Document) => { row(d).eligible = "yes"; }, "Registry endpoints[0].eligible must be boolean."],
    ["a string weight", (d: Document) => { row(d).weight = "0.15"; }, "endpoints[0].weight must be a finite number."],
    ["an infinite weight", (d: Document) => { row(d).weight = Number.POSITIVE_INFINITY; }, "endpoints[0].weight must be a finite number."],
    ["a negative weight", (d: Document) => { row(d).weight = -0.1; }, "Registry weight cannot be negative."],
    ["a zero rank", (d: Document) => { row(d).rank = 0; }, "Registry endpoints[0].rank must be a positive integer or null."],
    ["a fractional rank", (d: Document) => { row(d).rank = 1.5; }, "Registry endpoints[0].rank must be a positive integer or null."],
    ["a string rank", (d: Document) => { row(d).rank = "1"; }, "Registry endpoints[0].rank must be a positive integer or null."],
    ["an eligible row without weight", (d: Document) => { row(d).weight = 0; }, "Registry endpoints[0] has inconsistent eligibility, weight, and rank."],
    ["an eligible row without a rank", (d: Document) => { row(d).rank = null; }, "Registry endpoints[0] has inconsistent eligibility, weight, and rank."],
    ["an ineligible row with weight and rank", (d: Document) => { row(d).eligible = false; }, "Registry endpoints[0] has inconsistent eligibility, weight, and rank."],
  ])("rejects %s", (_label, change, message) => {
    const document = typeof change === "function" ? corrupt(change as (document: Document) => void) : change;
    expect(() => assertMainnetRegistryFile(document)).toThrow(message);
  });

  test.each<[string, (stats: Record<string, unknown>) => void, string]>([
    ["a missing observation count", (s) => { delete s.observations; }, "endpoints[0].stats.observations must be a finite number."],
    ["a negative observation count", (s) => { s.observations = -1; }, "endpoints[0].stats.observations must be a non-negative integer."],
    ["a fractional success count", (s) => { s.successes = 2.5; }, "endpoints[0].stats.successes must be a non-negative integer."],
    ["a NaN uptime", (s) => { s.uptime = Number.NaN; }, "endpoints[0].stats.uptime must be a finite number."],
    ["an uptime above one", (s) => { s.uptime = 1.01; }, "endpoints[0].stats.uptime must be between zero and one."],
    ["a negative uptime", (s) => { s.uptime = -0.01; }, "endpoints[0].stats.uptime must be between zero and one."],
    ["a string latency", (s) => { s.latencyMs = "120"; }, "endpoints[0].stats.latencyMs must be a finite number."],
    ["a missing tail latency", (s) => { delete s.tailMs; }, "endpoints[0].stats.tailMs must be a finite number."],
    ["a boolean median lag", (s) => { s.medianLag = false; }, "endpoints[0].stats.medianLag must be a finite number."],
    ["a numeric established flag", (s) => { s.established = 1; }, "endpoints[0].stats.established must be boolean."],
    ["a string HyperCore verdict", (s) => { s.precompileOk = "yes"; }, "endpoints[0].stats.precompileOk must be boolean or null."],
    ["a missing HyperCore verdict", (s) => { delete s.precompileOk; }, "endpoints[0].stats.precompileOk must be boolean or null."],
  ])("rejects stats with %s", (_label, change, message) => {
    expect(() => assertMainnetRegistryFile(corrupt((document) => change(rowStats(document))))).toThrow(message);
  });

  test.each([["a string", "none"], ["an array", []], ["undefined", undefined]])("rejects stats that are %s", (_label, value) => {
    expect(() => assertMainnetRegistryFile(corrupt((document) => { row(document).stats = value; })))
      .toThrow("endpoints[0].stats must be an object or null.");
  });
});

describe("rank policy validation", () => {
  test("accepts the default policy and boundary values", () => {
    expect(() => assertRankPolicy({ ...defaultRankPolicy })).not.toThrow();
    expect(() => assertRankPolicy({
      ...defaultRankPolicy, minObservations: 1, minSpanMs: 0, minUptime: 0, minEligibleUptime: 1, newNodeWeightCap: 1, maxNewNodeShare: 1,
    })).not.toThrow();
  });

  test.each<[string, unknown, string]>([
    ["a missing policy", undefined, "Registry policy must be an object."],
    ["an array policy", [], "Registry policy must be an object."],
    ["a missing window", { ...defaultRankPolicy, windowMs: undefined }, "policy.windowMs must be a finite number."],
    ["a zero window", { ...defaultRankPolicy, windowMs: 0 }, "policy.windowMs must be positive."],
    ["zero minimum observations", { ...defaultRankPolicy, minObservations: 0 }, "policy.minObservations must be positive."],
    ["fractional minimum observations", { ...defaultRankPolicy, minObservations: 2.5 }, "policy.minObservations must be positive."],
    ["a negative minimum span", { ...defaultRankPolicy, minSpanMs: -1 }, "policy.minSpanMs cannot be negative."],
    ["a minimum uptime above one", { ...defaultRankPolicy, minUptime: 1.2 }, "policy.minUptime must be between zero and one."],
    ["a negative eligible uptime", { ...defaultRankPolicy, minEligibleUptime: -0.1 }, "policy.minEligibleUptime must be between zero and one."],
    ["a string new-node cap", { ...defaultRankPolicy, newNodeWeightCap: "0.15" }, "policy.newNodeWeightCap must be a finite number."],
    ["a new-node share above one", { ...defaultRankPolicy, maxNewNodeShare: 2 }, "policy.maxNewNodeShare must be between zero and one."],
    ["a zero new-node cap", { ...defaultRankPolicy, newNodeWeightCap: 0 }, "New-node weight and share caps must be positive."],
    ["a zero new-node share", { ...defaultRankPolicy, maxNewNodeShare: 0 }, "New-node weight and share caps must be positive."],
  ])("rejects %s", (_label, policy, message) => {
    expect(() => assertRankPolicy(policy)).toThrow(message);
    expect(() => assertMainnetRegistryFile({ ...validDocument(), policy })).toThrow(message);
  });
});

function probe(url: string, hoursAgo: number, overrides: Partial<ProbeObservation> = {}): ProbeObservation {
  return {
    at: new Date(NOW - hoursAgo * HOUR).toISOString(),
    url,
    ok: true,
    chainIdOk: true,
    head: 1_000,
    lag: 0,
    methods: { eth_chainId: { ms: 20, ok: true }, eth_blockNumber: { ms: 30, ok: true } },
    ...overrides,
  };
}

describe("observation history validation", () => {
  const history = (observations: unknown[]): unknown => ({ version: 1, chainId: 999, observations });
  const sample = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ ...probe("https://a.example/evm", 1), ...overrides });

  test("accepts well-formed observations, with or without a head timestamp", () => {
    expect(() => assertRegistryHistoryFile(history([]))).not.toThrow();
    expect(() => assertRegistryHistoryFile(history([
      sample(),
      sample({ headAt: "2026-10-29T23:00:00.000Z" }),
      sample({ ok: false, chainIdOk: false, head: null, lag: null, methods: {} }),
    ]))).not.toThrow();
  });

  test.each<[string, unknown]>([
    ["null", null],
    ["another version", { version: 2, chainId: 999, observations: [] }],
    ["a missing chain id", { version: 1, observations: [] }],
    ["observations that are not an array", { version: 1, chainId: 999, observations: {} }],
  ])("rejects a history document that is %s", (_label, document) => {
    expect(() => assertRegistryHistoryFile(document)).toThrow("History must be a version-1 HyperEVM mainnet document.");
  });

  test.each<[string, unknown, string]>([
    ["is not an object", "observation", "observations[1] is not a valid probe observation."],
    ["has no URL", sample({ url: undefined }), "observations[1] is not a valid probe observation."],
    ["has a numeric timestamp", sample({ at: NOW }), "observations[1] is not a valid probe observation."],
    ["has an unparseable timestamp", sample({ at: "yesterday" }), "observations[1] is not a valid probe observation."],
    ["has a non-boolean ok flag", sample({ ok: 1 }), "observations[1] is not a valid probe observation."],
    ["has a non-boolean chain verdict", sample({ chainIdOk: "0x3e7" }), "observations[1] is not a valid probe observation."],
    ["has a negative head", sample({ head: -1 }), "observations[1].head is invalid."],
    ["has a hex-string head", sample({ head: "0x10" }), "observations[1].head must be a finite number."],
    ["has a negative lag", sample({ lag: -2 }), "observations[1].lag is invalid."],
    ["has no lag field", sample({ lag: undefined }), "observations[1].lag must be a finite number."],
    ["has a numeric head timestamp", sample({ headAt: NOW }), "observations[1].headAt is invalid."],
    ["has an unparseable head timestamp", sample({ headAt: "soon" }), "observations[1].headAt is invalid."],
    ["has no method samples", sample({ methods: undefined }), "observations[1].methods must be an object."],
    ["lists method samples as an array", sample({ methods: [] }), "observations[1].methods must be an object."],
    ["has a method sample that is not an object", sample({ methods: { eth_call: 12 } }), "observations[1].methods.eth_call is invalid."],
    ["has a method sample without a verdict", sample({ methods: { eth_call: { ms: 12 } } }), "observations[1].methods.eth_call is invalid."],
    ["has a method sample with negative latency", sample({ methods: { eth_call: { ms: -1, ok: true } } }), "observations[1].methods.eth_call is invalid."],
    ["has a method sample without latency", sample({ methods: { eth_call: { ok: true } } }), "observations[1].methods.eth_call.ms must be a finite number."],
  ])("rejects an observation that %s", (_label, observation, message) => {
    expect(() => assertRegistryHistoryFile(history([sample(), observation]))).toThrow(message);
    expect(() => assertObservationDocument({ version: 1, observations: [sample(), observation] })).toThrow(message);
  });

  test("an imported fixture may omit the chain id but not name another chain", () => {
    const observations = [sample()];
    expect(() => assertObservationDocument({ version: 1, observations })).not.toThrow();
    expect(() => assertObservationDocument({ version: 1, chainId: 999, observations })).not.toThrow();
    expect(() => assertObservationDocument({ version: 1, chainId: 998, observations }))
      .toThrow("Fixture observations are for another chain.");
    for (const invalid of [null, [], { version: 2, observations }, { version: 1, observations: "none" }]) {
      expect(() => assertObservationDocument(invalid)).toThrow("Fixture must be a version-1 observation document.");
    }
  });
});

describe("registry refresh edge cases", () => {
  const a = { url: "https://a.example/evm" };
  const b = { url: "https://b.example/evm" };

  function previous(endpoints: readonly { url: string }[], observations: readonly ProbeObservation[]): MainnetRegistryFile {
    return {
      version: 1,
      chainId: 999,
      updatedAt: new Date(NOW).toISOString(),
      policy: { ...defaultRankPolicy },
      endpoints: rankRegistry(endpoints, observations, NOW).map(({ url, eligible, weight, rank, stats: rowStats }) => ({
        url, eligible, weight, rank, stats: rowStats,
      })),
    };
  }
  const historyOf = (observations: ProbeObservation[]): RegistryHistoryFile => ({ version: 1, chainId: 999, observations });

  test("refuses a source registry that lists one endpoint under two spellings", () => {
    const healthy = probe(a.url, 0);
    expect(() => refreshMainnetRegistry(
      [a, { url: "https://A.example/evm/" }], previous([a], [healthy]), historyOf([]), [healthy], NOW,
    )).toThrow("The source registry contains duplicate endpoint URLs.");
  });

  test("refuses to write a first ranking in which nothing is eligible", () => {
    const down = probe(a.url, 0, { ok: false });
    const empty = previous([a], []);
    expect(empty.endpoints.some((endpoint) => endpoint.eligible)).toBe(false);
    expect(() => refreshMainnetRegistry([a], empty, historyOf([]), [down], NOW))
      .toThrow("Ranking left no endpoint eligible. Refusing to write an empty default pool.");
  });

  test("orders same-instant observations by endpoint and drops those outside the window or the source list", () => {
    const old = probe(a.url, 24);
    const expired = probe(a.url, 29 * 24);
    const future = probe(a.url, -1);
    const removed = probe("https://removed.example/evm", 2);
    const nowB = probe(b.url, 0);
    const nowA = probe(a.url, 0);
    const result = refreshMainnetRegistry(
      [b, a],
      previous([a, b], [old]),
      historyOf([expired, removed, future, old]),
      [nowB, nowA, probe("https://stranger.example/evm", 0)],
      NOW,
    );
    expect(result.history.observations).toEqual([old, nowA, nowB]);
    expect(result.registry.updatedAt).toBe(new Date(NOW).toISOString());
    expect(result.registry.endpoints.map(({ url, eligible }) => [url, eligible]).sort()).toEqual([[a.url, true], [b.url, true]]);
    expect(result.registry.endpoints.find(({ url }) => url === a.url)?.stats).toMatchObject({ observations: 2, successes: 2 });
    expect(result.ranked.map(({ url }) => url)).toEqual(result.registry.endpoints.map(({ url }) => url));
  });
});
