import { describe, expect, test } from "vitest";

import { Scoreboard } from "../src/scoreboard.js";

const endpoints = ["fast", "slow"].map((id, index) => ({
  id,
  url: id,
  weight: 1,
  index,
  supports: (): boolean => true,
}));

function trained(): Scoreboard {
  const board = new Scoreboard(endpoints, {
    perMethod: true,
    headLag: true,
    maxLag: 2,
    staleMs: 30_000,
    now: () => 0,
  });
  for (let sample = 0; sample < 5; sample += 1) {
    board.success("fast", "eth_call", 40, true);
    board.success("slow", "eth_call", 400, true);
  }
  return board;
}

describe("power of two choices", () => {
  test("keeps the better of the two draws, then switches when in-flight load flips the score", () => {
    const board = trained();
    let draw = 0;
    const random = (): number => {
      const value = draw % 2 === 0 ? 0 : 0.99;
      draw += 1;
      return value;
    };
    expect(board.pick("eth_call", new Set(), "p2c", random)?.id).toBe("fast");
    for (let inflight = 0; inflight < 5; inflight += 1) board.begin("fast", 10_000);
    draw = 0;
    expect(board.pick("eth_call", new Set(), "p2c", random)?.id).toBe("slow");
    expect(board.pick("eth_call", new Set(), "best", random)?.id).toBe("slow");
  });

  test("a health probe does not teach the latency EWMA", () => {
    const board = trained();
    const before = board.snapshot("eth_call").find((row) => row.id === "fast");
    board.success("fast", "eth_blockNumber", 5_000, false);
    const after = board.snapshot("eth_call").find((row) => row.id === "fast");
    expect(after?.methods["*"]?.ewma).toBe(before?.methods["*"]?.ewma);
    expect(after?.methods["*"]?.n).toBe(before?.methods["*"]?.n);
  });

  test("a seeded prior cannot set a hedge delay and the first live sample replaces it", () => {
    const board = new Scoreboard(endpoints, {
      perMethod: true,
      headLag: false,
      maxLag: 2,
      staleMs: 30_000,
      now: () => 0,
    });
    const prior = { ewma: 20, tail: 20, error: 0, n: 2 };
    expect(board.seed("fast", "*", prior, 123)).toBe(true);
    expect(board.seed("fast", "eth_call", prior, 123)).toBe(true);
    expect(board.hedgeDelay("fast", "eth_call", 250, 2)).toBe(250);
    expect(board.books().filter((entry) => entry.id === "fast").every((entry) => entry.at === 123)).toBe(true);
    board.success("fast", "eth_call", 300, true);
    expect(board.snapshot("eth_call").find((row) => row.id === "fast")?.methods).toEqual({
      "*": { ewma: 300, tail: 300, error: 0, n: 1 },
      eth_call: { ewma: 300, tail: 300, error: 0, n: 1 },
    });
    expect(board.books().filter((entry) => entry.id === "fast").every((entry) => entry.at === undefined)).toBe(true);
  });
});

describe("heads", () => {
  test("rejects a stale head and an outlier that leads the others by more than maxAhead", () => {
    let now = 1_000;
    const board = new Scoreboard(
      ["a", "b", "c"].map((id, index) => ({ id, url: id, weight: 1, index, supports: () => true })),
      { perMethod: false, headLag: true, maxLag: 2, staleMs: 30_000, maxAhead: 1_000, now: () => now },
    );
    board.noteHead("a", 100);
    board.noteHead("b", 101);
    board.noteHead("c", 5_000);
    const fresh = board.heads(Number.POSITIVE_INFINITY);
    expect(fresh.find((head) => head.id === "c")?.trusted).toBe(false);
    expect(fresh.find((head) => head.id === "b")?.trusted).toBe(true);
    const liar = board.snapshot("eth_call").find((row) => row.id === "c");
    const honest = board.snapshot("eth_call").find((row) => row.id === "b");
    expect(liar?.lag).toBeNull();
    expect(liar?.score).toBeGreaterThan(honest?.score ?? 0);

    now = 1_000 + 30_001;
    expect(board.heads(Number.POSITIVE_INFINITY)).toEqual([]);
    const aged = board.snapshot("eth_call").find((row) => row.id === "a");
    expect(aged?.lag).toBeNull();
  });

  test("lag is time-aligned: an older sample is not lag, a head behind what peers had already reported is", () => {
    let now = 0;
    const board = new Scoreboard(
      ["early", "late", "behind"].map((id, index) => ({ id, url: id, weight: 1, index, supports: () => true })),
      { perMethod: false, headLag: true, maxLag: 2, staleMs: 30_000, now: () => now },
    );
    for (const id of ["early", "late", "behind"]) {
      for (let sample = 0; sample < 5; sample += 1) board.success(id, "eth_call", 50, true);
    }
    board.noteHead("early", 100);
    now = 8_000;
    // Eight seconds later on a fast chain the tip moved on. "early" was not sampled again, which is not lag.
    expect(board.noteHead("late", 116).lag).toBe(0);
    expect(board.noteHead("behind", 106).lag).toBe(10);
    const rows = new Map(board.snapshot("eth_call").map((row) => [row.id, row]));
    expect(rows.get("early")?.lag).toBe(0);
    expect(rows.get("behind")?.lag).toBe(10);
    expect(board.lagging("early")).toBe(false);
    expect(board.lagging("behind")).toBe(true);
    expect(rows.get("early")?.score).toBe(rows.get("late")?.score);
    expect(board.pick("eth_call", new Set(), "best", () => 0)?.id).toBe("early");
  });

  test("a fast lagging endpoint whose head lands just before its peer's is still lagging", () => {
    let now = 0;
    const board = new Scoreboard(
      ["stale", "current"].map((id, index) => ({ id, url: id, weight: 1, index, supports: () => true })),
      { perMethod: false, headLag: true, maxLag: 2, staleMs: 30_000, now: () => now },
    );
    board.noteHead("current", 90);
    board.noteHead("stale", 85);
    now = 5_000;
    // A race: "stale" answers first, its rival 100ms later. The rival's head carried back at 2/s is 99.
    board.noteHead("stale", 95);
    now = 5_100;
    board.noteHead("current", 100);
    expect(board.snapshot("eth_call").find((row) => row.id === "stale")?.lag).toBe(4);
    expect(board.lagging("stale")).toBe(true);
  });

  test("two fresh heads more than maxAhead apart are not a reference", () => {
    const board = new Scoreboard(
      ["a", "b"].map((id, index) => ({ id, url: id, weight: 1, index, supports: () => true })),
      { perMethod: false, headLag: true, maxLag: 2, staleMs: 30_000, maxAhead: 1_000, now: () => 0 },
    );
    board.noteHead("a", 100);
    board.noteHead("b", 5_000);
    for (const head of board.heads(Number.POSITIVE_INFINITY)) expect(head.trusted).toBe(false);
  });
});
