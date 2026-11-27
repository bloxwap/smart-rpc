import { describe, expect, test } from "vitest";
import { createPoolScope } from "../src/share.js";
import { Scoreboard, type ScoreboardOptions } from "../src/scoreboard.js";
import type { PoolOptions } from "../src/types.js";
import { pool } from "./helpers.js";

const endpoints = [
  { id: "fast-new", url: "fast-new", index: 0, weight: 0.15, supports: () => true },
  { id: "slow-established", url: "slow-established", index: 1, weight: 1, supports: () => true },
];
const noBar = new Set<string>();
function board(options: Partial<ScoreboardOptions> = {}) {
  return new Scoreboard(endpoints, { perMethod: true, headLag: false, maxLag: 2, staleMs: 30_000, now: () => 0, ...options });
}
const best = (scores: Scoreboard) => scores.pick("eth_call", noBar, "best", Math.random)?.id;
function measure(scores: Scoreboard, samples: number): void {
  for (let index = 0; index < samples; index += 1) {
    scores.success("fast-new", "eth_call", 120, true);
    scores.success("slow-established", "eth_call", 450, true);
  }
}

describe("endpoint weighting", () => {
  test("a fixed weight keeps dividing the score after the pool has measured the endpoint", () => {
    const scores = board();
    measure(scores, 5);
    expect(best(scores)).toBe("slow-established");
  });

  test("a prior weight decides before measurement and yields to measured latency", () => {
    const scores = board({ weighting: "prior" });
    expect(best(scores)).toBe("slow-established");
    measure(scores, 5);
    expect(best(scores)).toBe("fast-new");
    const [fast, slow] = scores.snapshot("eth_call");
    expect(fast!.score).toBeCloseTo(120);
    expect(slow!.score).toBeCloseTo(450);
    // The configured weight is still reported; only its effect on the score fades.
    expect(fast!.weight).toBe(0.15);
  });

  test("a prior weight fades in proportion to the samples collected", () => {
    const scores = board({ weighting: "prior" });
    measure(scores, 1);
    // One of five confidence samples: 1 + (0.15 - 1) * 0.8 = 0.32.
    expect(scores.snapshot("eth_call")[0]!.score).toBeCloseTo(120 / 0.32);
  });

  test("an ordered cold start stays neutral under either mode", () => {
    const scores = board({ weighting: "prior", coldStart: "ordered" });
    expect(best(scores)).toBe("fast-new");
  });

  test("invalid modes and incompatible shared leases are rejected", () => {
    const nodes = [{ id: "node", url: "https://node.example", call: async () => "0x1" }];
    expect(() => pool(nodes, { weighting: "invalid" as PoolOptions["weighting"] })).toThrow(/weighting/);
    const scope = createPoolScope();
    const first = pool(nodes, { weighting: "prior", sharing: { scope, key: "same" } });
    try {
      expect(() => pool(nodes, { weighting: "fixed", sharing: { scope, key: "same" } })).toThrow(/incompatible|different|conflict/i);
    } finally { first.close(); scope.close(); }
  });
});
