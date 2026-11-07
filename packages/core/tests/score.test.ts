import { describe, expect, test } from "vitest";

import {
  defaultScoreConfig,
  emptyStat,
  endpointScore,
  inflation,
  observe,
  serviceMs,
} from "../src/score.js";

describe("score constants", () => {
  test("match the HyperEVM reference at 092b8f9", () => {
    expect(defaultScoreConfig).toEqual({
      latencyMix: 0.6,
      ewmaAlphaUp: 0.4,
      ewmaAlphaDown: 0.2,
      tailAlphaUp: 0.5,
      tailAlphaDown: 0.05,
      errorAlpha: 0.3,
      livenessAlpha: 0.15,
      errorWeight: 8,
      lagWeight: 1,
      priorMs: 250,
      confidenceSamples: 5,
      methodBlendSamples: 3,
      queueWeight: 0.25,
    });
  });

  test("in-flight penalty is 1 + n + 0.25 n^2", () => {
    expect(inflation(0)).toBe(1);
    expect(inflation(1)).toBeCloseTo(1 + 1 + 0.25);
    expect(inflation(2)).toBeCloseTo(1 + 2 + 0.25 * 4);
    expect(inflation(4)).toBeCloseTo(1 + 4 + 0.25 * 16);
    expect(inflation(4) - inflation(2)).toBeGreaterThan(inflation(2) - inflation(0));
  });
});

describe("endpointScore", () => {
  test("a slower sample, an error, lag, in-flight work, and lower weight each worsen the score", () => {
    const fast = emptyStat();
    const slow = emptyStat();
    observe(fast, 40, true);
    observe(slow, 400, true);
    const base = { perMethod: false, inflight: 0, lagPenalty: 1, weight: 1 };
    expect(endpointScore({ ...base, global: slow, method: undefined })).toBeGreaterThan(
      endpointScore({ ...base, global: fast, method: undefined }),
    );

    const failing = emptyStat();
    observe(failing, 40, false);
    expect(endpointScore({ ...base, global: failing, method: undefined })).toBeGreaterThan(
      endpointScore({ ...base, global: fast, method: undefined }),
    );
    expect(1 + defaultScoreConfig.errorWeight * failing.error).toBe(1 + 8);

    expect(endpointScore({ ...base, global: fast, method: undefined, inflight: 3 })).toBeGreaterThan(
      endpointScore({ ...base, global: fast, method: undefined, inflight: 0 }),
    );
    expect(endpointScore({ ...base, global: fast, method: undefined, lagPenalty: 4 })).toBeGreaterThan(
      endpointScore({ ...base, global: fast, method: undefined, lagPenalty: 1 }),
    );
    expect(endpointScore({ ...base, global: fast, method: undefined, weight: 1 })).toBeGreaterThan(
      endpointScore({ ...base, global: fast, method: undefined, weight: 2 }),
    );
  });

  test("per-method stats take over once they have enough samples", () => {
    const global = emptyStat();
    observe(global, 50, true);
    const method = emptyStat();
    observe(method, 20, true);
    observe(method, 20, true);
    observe(method, 20, true);
    const shared = { global, perMethod: true, inflight: 0, lagPenalty: 1, weight: 1 };
    const blended = endpointScore({ ...shared, method });
    const onlyGlobal = endpointScore({ ...shared, method: undefined, perMethod: false });
    expect(blended).toBeLessThan(onlyGlobal);
    expect(serviceMs(method)).toBeLessThan(serviceMs(global));
    expect(defaultScoreConfig.methodBlendSamples).toBe(3);
  });

  test("the tail remembers a slow sample longer than the mean", () => {
    const stat = emptyStat();
    observe(stat, 50, true);
    observe(stat, 50, true);
    observe(stat, 50, true);
    const before = stat.tail;
    observe(stat, 500, true);
    const spiked = stat.tail;
    observe(stat, 50, true);
    expect(spiked).toBeGreaterThan(before);
    expect(stat.tail).toBeGreaterThan(stat.ewma);
  });
});
