import { describe, expect, test } from "vitest";
import { createPoolScope } from "../src/share.js";
import { Scoreboard, type ScoreboardOptions } from "../src/scoreboard.js";
import type { PoolOptions } from "../src/types.js";
import { pool } from "./helpers.js";

const endpoints = ["ranked", "established", "backup"].map((id, index) => ({
  id, url: id, index, weight: index === 0 ? 0.15 : 1, supports: () => true,
}));
const noBar = new Set<string>();
function board(options: Partial<ScoreboardOptions> = {}) {
  return new Scoreboard(endpoints, {
    perMethod: true, headLag: false, maxLag: 2, staleMs: 30_000, now: () => 0,
    coldStart: "ordered", ...options,
  });
}
const pick = (scores: Scoreboard) => scores.pick("eth_call", noBar, "p2c", () => 0.99)?.id;

describe("ordered cold routing", () => {
  test("uses curated order before latency samples, then restores the original weights", () => {
    const scores = board();
    expect(pick(scores)).toBe("ranked");
    expect(scores.snapshot("eth_call").map((row) => row.weight)).toEqual([0.15, 1, 1]);
    scores.success("ranked", "eth_call", 100, true);
    expect(scores.pick("eth_call", noBar, "best", Math.random)?.id).toBe("established");
  });

  test("weighted routing retains the existing cold behavior", () => {
    expect(board({ coldStart: "weighted" }).pick("eth_call", noBar, "best", Math.random)?.id).toBe("established");
  });

  test("probes do not end cold routing, but a failed foreground attempt does", () => {
    const scores = board();
    scores.success("ranked", "eth_blockNumber", 100, false);
    expect(pick(scores)).toBe("ranked");
    scores.failure("ranked", "eth_call", 1000, true, 1000);
    expect(scores.snapshot("eth_call")[0]!.score).toBeGreaterThan(1000);
  });

  test("restored latency books take precedence, while empty books do not", () => {
    const scores = board();
    scores.seed("ranked", "*", { ewma: 0, tail: 0, error: 0, n: 0 }, 0);
    expect(pick(scores)).toBe("ranked");
    scores.seed("ranked", "*", { ewma: 100, tail: 100, error: 0, n: 2 }, 0);
    expect(scores.pick("eth_call", noBar, "best", Math.random)?.id).toBe("established");
  });

  test("ejection, budgets, exclusions, capabilities, and in-flight penalties still apply", () => {
    expect(pick(board({ ejected: (id) => id === "ranked" }))).toBe("established");
    expect(pick(board({ spent: (id) => id === "ranked" }))).toBe("established");
    const scores = board();
    expect(scores.pick("eth_call", new Set(["ranked"]), "best", Math.random)?.id).toBe("established");
    const end = scores.begin("ranked", 1000);
    expect(pick(scores)).toBe("established");
    end();
    expect(pick(scores)).toBe("ranked");
    const restricted = new Scoreboard(endpoints.map((entry) => ({ ...entry, supports: () => entry.id !== "ranked" })), {
      perMethod: true, headLag: false, maxLag: 2, staleMs: 30_000, now: () => 0, coldStart: "ordered",
    });
    expect(pick(restricted)).toBe("established");
  });

  test("a wrong-chain first candidate receives no user reads", async () => {
    const calls: string[] = [];
    const client = pool(endpoints.map((entry) => ({ ...entry, call: async ({ method }: { method: string }) => {
      calls.push(`${entry.id}:${method}`);
      return method === "eth_chainId" ? entry.id === "ranked" ? "0x2" : "0x1" : "0x10";
    } })), { coldStart: "ordered", verifyIdentity: true });
    try {
      await expect(client.request({ method: "eth_getBalance", params: ["0x1", "latest"] })).resolves.toBe("0x10");
      expect(calls.filter((call) => call.startsWith("ranked:"))).toEqual(["ranked:eth_chainId"]);
      expect(client.snapshot().find((row) => row.id === "ranked")?.quarantined).toBe(true);
    } finally { client.close(); }
  });

  test("invalid modes and incompatible shared leases are rejected", () => {
    const nodes = [{ id: "node", url: "https://node.example", call: async () => "0x1" }];
    expect(() => pool(nodes, { coldStart: "invalid" as PoolOptions["coldStart"] })).toThrow(/coldStart/);
    const scope = createPoolScope();
    const first = pool(nodes, { coldStart: "ordered", sharing: { scope, key: "same" } });
    try {
      expect(() => pool(nodes, { coldStart: "weighted", sharing: { scope, key: "same" } })).toThrow(/incompatible|different|conflict/i);
    } finally { first.close(); scope.close(); }
  });
});
