import { describe, expect, test } from "vitest";

import { Scoreboard } from "../src/scoreboard.js";

function board(ids: readonly string[] = ["a", "b"]) {
  const clock = { now: 0 };
  const endpoints = ids.map((id, index) => ({
    id,
    url: `https://${id}.example`,
    weight: 1,
    index,
    supports: (): boolean => true,
  }));
  const scoreboard = new Scoreboard(endpoints, {
    perMethod: true,
    headLag: false,
    maxLag: 2,
    staleMs: 30_000,
    now: () => clock.now,
  });
  return { clock, scoreboard };
}

describe("scoreboard edges", () => {
  test("an unknown endpoint cannot be seeded and cannot be recorded against", () => {
    const { scoreboard } = board();
    expect(scoreboard.seed("ghost", "*", { ewma: 10, tail: 10, error: 0, n: 2 }, 0)).toBe(false);
    expect(scoreboard.books()).toEqual([]);
    expect(() => scoreboard.success("ghost", "eth_call", 10, true)).toThrow("Unknown RPC endpoint: ghost");
    expect(() => scoreboard.begin("ghost", 1_000)).toThrow("Unknown RPC endpoint: ghost");
    expect(() => scoreboard.noteHead("ghost", 5)).toThrow("Unknown RPC endpoint: ghost");
  });

  test("the hedge delay follows the measured tail once there are three samples, and never drops below the floor", () => {
    const { scoreboard } = board();
    scoreboard.success("a", "eth_call", 100, true);
    scoreboard.success("a", "eth_call", 100, true);
    expect(scoreboard.hedgeDelay("a", "eth_call", 50, 2)).toBe(50);
    scoreboard.success("a", "eth_call", 100, true);
    expect(scoreboard.hedgeDelay("a", "eth_call", 50, 2)).toBe(200);
    expect(scoreboard.hedgeDelay("a", "eth_call", 500, 2)).toBe(500);
    // A method with no book of its own uses the endpoint's global book.
    expect(scoreboard.hedgeDelay("a", "eth_getLogs", 50, 3)).toBe(300);
  });

  test("the hedge delay uses the mean when the book has no tail", () => {
    const { scoreboard } = board();
    expect(scoreboard.seed("a", "eth_call", { ewma: 80, tail: 0, error: 0, n: 4 }, 0)).toBe(true);
    expect(scoreboard.hedgeDelay("a", "eth_call", 10, 2)).toBe(160);
  });

  test("a call past its deadline stops counting as in flight", () => {
    const { clock, scoreboard } = board();
    scoreboard.begin("a", 1_000);
    const endLong = scoreboard.begin("a", 5_000);
    const inflight = (): number | undefined => scoreboard.snapshot("eth_call").find((row) => row.id === "a")?.inflight;
    expect(inflight()).toBe(2);
    clock.now = 999;
    expect(inflight()).toBe(2);
    clock.now = 1_000;
    expect(inflight()).toBe(1);
    endLong();
    endLong();
    expect(inflight()).toBe(0);
  });

  test("a random draw of exactly 1 picks the last candidate instead of running off the end", () => {
    const { scoreboard } = board(["a", "b", "c"]);
    for (let sample = 0; sample < 5; sample += 1) {
      scoreboard.success("a", "eth_call", 300, true);
      scoreboard.success("b", "eth_call", 10, true);
      scoreboard.success("c", "eth_call", 100, true);
    }
    // Both draws land on c, so the second moves to the next slot (a). b is never drawn, though it is the best.
    expect(scoreboard.pick("eth_call", new Set(), "p2c", () => 1)?.id).toBe("c");
    expect(scoreboard.pick("eth_call", new Set(), "best", () => 1)?.id).toBe("b");
    for (let inflight = 0; inflight < 5; inflight += 1) scoreboard.begin("c", 10_000);
    expect(scoreboard.pick("eth_call", new Set(), "p2c", () => 1)?.id).toBe("a");
  });
});
