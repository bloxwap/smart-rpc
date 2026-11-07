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
