import { afterEach, describe, expect, test, vi } from "vitest";
import { Budgets } from "../src/budget.js";
import { blockCadence } from "../src/cadence.js";
import { classifyRpcError } from "../src/evm-methods.js";
import { isHeadSensitiveRead } from "../src/pin.js";
import { pool } from "./helpers.js";

afterEach(() => vi.useRealTimers());

const invalid = (message: string): Error => Object.assign(new Error(message), { code: -32602 });

describe("routing integration boundaries", () => {
  test.each([0, -1, Infinity, NaN])("rejects an invalid lag tolerance %s", (tolerance) => {
    expect(() => blockCadence(1_000, tolerance)).toThrow(/lag tolerance/);
  });

  test("concurrent rate-limit responses share one cooldown and one rate cut", () => {
    let now = 0;
    const budget = new Budgets(() => now);
    budget.configure("a", { rps: 10, burst: 20 });
    expect(budget.rateLimited("a")).toEqual({ cooldownMs: 1_000, rps: 5 });
    now = 100;
    expect(budget.take("a")).toBe(false);
    expect(budget.rateLimited("a")).toEqual({ cooldownMs: 900, rps: 5 });
    // An unsolicited throttling response still teaches an unbudgeted endpoint a conservative rate.
    expect(budget.rateLimited("unknown").rps).toBeGreaterThan(0);
  });

  test.each([
    ["", "terminal"], ["request per sec", "rate-limit"], ["requests per minute", "rate-limit"],
    ["request per min", "rate-limit"], ["requests per secondX", "terminal"],
    ["request per nope", "terminal"], ["request", "terminal"],
    ["1rps", "rate-limit"], ["rps", "terminal"], ["x rps", "terminal"],
    ["1 rps_more", "terminal"], ["1 rps1", "terminal"], ["rpsx", "terminal"],
    ["quota exhausted", "rate-limit"], ["credits reached", "rate-limit"],
    ["quota not exhausted", "terminal"], ["quota", "terminal"],
    ["exceeded the quota", "rate-limit"], ["exceeded your capacity", "rate-limit"],
    ["exceeded compute units", "rate-limit"], ["exceeded request limit", "rate-limit"],
    ["exceeded your cap", "terminal"], ["exceeded", "terminal"],
    ["range", "terminal"], ["range over no", "terminal"],
    ["more than 10 results", "restriction"], ["more than 10 blocks", "restriction"],
    ["more than 10 logs", "restriction"], ["more than ten logs", "terminal"],
    ["more than 10logs", "terminal"], ["more than 10", "terminal"],
    ["more than 10 apples", "terminal"], ["limited to 10 blocks", "restriction"],
    ["limited to ten blocks", "restriction"], ["limited to 10 apples", "restriction"],
    ["limited to", "restriction"], ["exceed max results", "restriction"],
    ["exceeds maximum results", "restriction"], ["exceeds max apples", "terminal"],
    ["exceeded", "terminal"], ["exceeds", "terminal"],
  ] as const)("classifies provider wording %j as %s", (message, kind) => {
    expect(classifyRpcError(invalid(message))).toBe(kind);
  });

  test("numeric rate wording accepts the JavaScript whitespace set", () => {
    for (const code of [9,10,11,12,13,32,0xa0,0x1680,0x2000,0x200a,0x2028,0x2029,0x202f,0x205f,0x3000,0xfeff]) {
      expect(classifyRpcError(invalid(`1${String.fromCharCode(code)}rps`))).toBe("rate-limit");
    }
  });

  test("malformed error details cannot crash classification", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(classifyRpcError(Object.assign(new Error("unknown"), { data: cyclic, cause: {} }))).toBe("failure");
    expect(classifyRpcError(Object.assign(new Error("unknown"), { cause: { message: 123 } }))).toBe("failure");
  });

  test.each([
    ["eth_getLogs", undefined, false], ["eth_getLogs", [null], false],
    ["eth_getLogs", [[]], false], ["eth_getLogs", [{ blockHash: "0xabc" }], false],
    ["eth_getLogs", [{ blockHash: null }], true],
    ["eth_getLogs", [{ blockHash: undefined, fromBlock: "0x1" }], true],
    ["eth_estimateGas", [{}, "latest"], true],
    ["eth_createAccessList", [{}], true],
    ["eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }], false],
    ["eth_getLogs", [{ fromBlock: "0x1", toBlock: "latest" }], true],
    ["eth_getLogs", [{ fromBlock: "latest", toBlock: "0x2" }], true],
    ["eth_call", [], true], ["eth_getBalance", undefined, true],
    ["eth_estimateGas", [], true], ["eth_custom", ["latest"], true],
    ["eth_custom", [], false],
  ] as const)("recognizes head-sensitive %s %j", (method, params, sensitive) => {
    expect(isHeadSensitiveRead(method, params)).toBe(sensitive);
  });

  test("provider restrictions expire and distinguish request shapes", async () => {
    let now = 0;
    let refusals = 0;
    const client = pool([
      { id: "restricted", url: "restricted", weight: 100, call: async () => { refusals++; throw invalid("Request blocked"); } },
      { id: "ok", url: "ok", call: async () => { now += 10; return "0x1"; } },
    ], { now: () => now, routing: "best" });
    try {
      const shapes = [undefined, ["latest"], ["0x1"], ["address"], [null], [5],
        [{ fromBlock: "latest", toBlock: "0x2" }], [{ fromBlock: "0x1", toBlock: "latest", address: "0xabc" }]];
      for (const params of shapes) {
        const before = refusals;
        expect(await client.request({ method: "eth_getBalance", params })).toBe("0x1");
        expect(refusals, JSON.stringify(params)).toBe(before + 1);
        await client.request({ method: "eth_getBalance", params });
        expect(refusals, JSON.stringify(params)).toBe(before + 1);
      }
      await client.request({ method: "eth_getBalance", params: [[]] });
      expect(refusals).toBe(shapes.length);
      now += 60_001;
      await client.request({ method: "eth_getBalance", params: ["latest"] });
      expect(refusals).toBe(shapes.length + 1);
      // Old shapes are evicted rather than letting an arbitrary provider grow the pool without bound.
      for (let i = 0; i < 257; i++) await client.request({ method: "eth_getBalance", params: [{ [`key${i}`]: 1 }] });
      const before = refusals;
      await client.request({ method: "eth_getBalance", params: [{ key0: 1 }] });
      expect(refusals).toBe(before + 1);
    } finally { client.close(); }
  });
});

test("a rejected identity refresh can throttle without quarantining a verified node", async () => {
  let now = 0;
  let checks = 0;
  const client = pool([{ id: "a", url: "a", call: async ({ method }) => {
    if (method === "eth_chainId") {
      if (++checks > 1) throw Object.assign(new Error("too many requests"), { status: 429 });
      return "0x1";
    }
    return "0x10";
  } }], { verifyIdentity: true, now: () => now });
  try {
    await client.request({ method: "eth_getBalance", params: ["0x1", "latest"] });
    now = 10_000;
    await client.probe();
    expect(client.snapshot()[0]).toMatchObject({ quarantined: false, ejected: false, throttledMs: 1_000 });
  } finally { client.close(); }
});

test.each([false, true])("background cache reads reserve foreground tokens with an alternate eligible=%s", async (eligible) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let head = 100;
  let reads = 0;
  const client = pool([
    { id: "a", url: "a", weight: 100, budget: { rps: 0.0001, burst: 2 }, call: async ({ method }) => {
      if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
      reads++; return "a";
    } },
    { id: "b", url: "b", supportsRequest: ({ method }) => method !== "eth_getBalance" || eligible, call: async ({ method }) => {
      if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
      reads++; return "b";
    } },
  ], { cache: { refreshInterval: false, maxStaleBlocks: 0 }, now: () => Date.now(), routing: "best" });
  try {
    await client.request({ method: "eth_getBalance", params: ["0x1", "latest"] });
    head++;
    await client.probe();
    await vi.advanceTimersByTimeAsync(10);
    expect(reads).toBe(eligible ? 2 : 1);
    expect(client.snapshot().find(({ id }) => id === "a")?.tokens).toBe(0);
  } finally { client.close(); }
});

test("an alternative failure does not immediately retry a provider's remembered restriction", async () => {
  let healthy = true;
  let refusals = 0;
  const client = pool([
    { id: "a", url: "a", weight: 100, call: async () => { refusals++; throw invalid("Request blocked"); } },
    { id: "b", url: "b", call: async () => { if (!healthy) throw new Error("unavailable"); return "ok"; } },
  ], { routing: "best", now: () => 0, retryCount: 1 });
  try {
    const request = { method: "eth_getBalance", params: ["0x1", "latest"] };
    await client.request(request);
    healthy = false;
    await expect(client.request(request)).rejects.toThrow();
    expect(refusals).toBe(1);
  } finally { client.close(); }
});

test.each([1, 3])("cold verification preserves the last shared provider token (burst %s)", async (burst) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let coldChecks = 0;
  const client = pool([
    { id: "warm", url: "warm", call: ({ method }) => method === "eth_chainId" ? Promise.resolve("0x1") : new Promise((resolve) => setTimeout(() => resolve("warm"), 400)) },
    { id: "cold", url: "cold", providerGroup: "shared", providerBudget: { rps: 0.0001, burst }, call: async ({ method }) => { if (method === "eth_chainId") coldChecks++; return "0x1"; } },
  ], { verifyIdentity: true, routing: "best", now: () => Date.now() });
  try {
    for (let i = 0; i < 2; i++) {
      const pending = client.request({ method: "eth_getBalance", params: [String(i), "latest"] });
      await vi.advanceTimersByTimeAsync(500);
      expect(await pending).toBe("warm");
    }
    expect(coldChecks).toBe(burst === 1 ? 0 : 1);
  } finally { client.close(); }
});
