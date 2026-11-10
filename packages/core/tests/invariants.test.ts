import { describe, expect, test } from "vitest";

import { BudgetExhaustedError, ChainMismatchError } from "../src/errors.js";
import { createPoolScope } from "../src/share.js";
import { backoffMs } from "../src/retry.js";
import { parseQuantity } from "../src/quantity.js";
import { evmPolicy, pool } from "./helpers.js";

const HASH_A = `0x${"aa".repeat(32)}`;
const HASH_B = `0x${"bb".repeat(32)}`;
const PARENT = `0x${"cc".repeat(32)}`;

describe("sharing fingerprints", () => {
  test("a repeated sharing key with a different endpoint url is rejected", () => {
    const scope = createPoolScope();
    const now = (): number => 0;
    const first = pool([{ id: "a", url: "https://a.example", call: async () => "0x1" }], {
      now,
      sharing: { scope, key: "app" },
    });
    expect(() => pool([{ id: "a", url: "https://b.example", call: async () => "0x1" }], {
      now,
      sharing: { scope, key: "app" },
    })).toThrow(/sharing key/);
    first.close();
    scope.close();
  });

  test("a repeated budgetKey with a different rps is rejected", () => {
    const scope = createPoolScope();
    const now = (): number => 0;
    const first = pool([{
      id: "limited",
      url: "https://limited.example",
      rps: 10,
      burst: 10,
      call: async () => "0x1",
    }], { now, sharing: { scope, key: "slow", budgetKey: "provider" } });
    expect(() => pool([{
      id: "limited",
      url: "https://limited.example",
      rps: 1,
      burst: 1,
      call: async () => "0x1",
    }], { now, sharing: { scope, key: "fast", budgetKey: "provider" } })).toThrow(/Conflicting request budgets/);
    first.close();
    scope.close();
  });

  test("a second acquire with a different now() is rejected", () => {
    const scope = createPoolScope();
    const first = pool([{ id: "a", url: "https://a.example", call: async () => "0x1" }], {
      now: () => 0,
      sharing: { scope, key: "app" },
    });
    expect(() => pool([{ id: "a", url: "https://a.example", call: async () => "0x1" }], {
      now: () => 1,
      sharing: { scope, key: "app" },
    })).toThrow(/now\(\)/);
    first.close();
    scope.close();
  });
});

describe("validated pool inputs", () => {
  test("retryCount rejects -1, 1.5, and NaN", () => {
    const endpoint = { id: "a", url: "https://a.example", call: async () => "0x1" };
    expect(() => pool([endpoint], { retryCount: -1 })).toThrow(/retryCount/);
    expect(() => pool([endpoint], { retryCount: 1.5 })).toThrow(/retryCount/);
    expect(() => pool([endpoint], { retryCount: Number.NaN })).toThrow(/retryCount/);
  });

  test("breaker rejects a non-positive cooldown that would hide a down endpoint", () => {
    const endpoint = { id: "a", url: "https://a.example", call: async () => "0x1" };
    expect(() => pool([endpoint], { breaker: { threshold: Number.NaN } })).toThrow(/threshold/);
    expect(() => pool([endpoint], { breaker: { cooldown: -1 } })).toThrow(/cooldown/);
    expect(() => pool([endpoint], { breaker: { maxCooldown: 0 } })).toThrow(/maxCooldown/);
    expect(() => pool([endpoint], { breaker: { threshold: 0 } })).toThrow(/threshold/);
    expect(() => pool([endpoint], { breaker: { cooldown: 120_000 } })).toThrow(/maxCooldown/);
  });

  test("a negative lagWeight is rejected", () => {
    const endpoint = { id: "a", url: "https://a.example", call: async () => "0x1" };
    expect(() => pool([endpoint], { score: { lagWeight: -1 } })).toThrow(/lagWeight/);
    expect(() => pool([endpoint], { score: { errorAlpha: -1 } })).toThrow(/errorAlpha/);
    expect(() => pool([endpoint], { score: { queueWeight: -1 } })).toThrow(/queueWeight/);
    expect(() => pool([endpoint], { score: { confidenceSamples: -1 } })).toThrow(/confidenceSamples/);
  });

  test("NaN maxUnitsPerSecond is rejected before a lying head can become the reference", () => {
    const endpoint = { id: "a", url: "https://a.example", call: async () => "0x1" };
    const policy = evmPolicy();
    policy.maxUnitsPerSecond = Number.NaN;
    expect(() => pool([endpoint], {}, policy)).toThrow(/maxUnitsPerSecond/);
    expect(() => pool([endpoint], { headLag: { maxLag: Number.NaN } })).toThrow(/maxLag/);
    expect(() => pool([endpoint], { headLag: { staleMs: -1 } })).toThrow(/staleMs/);
    expect(() => pool([endpoint], { headLag: { maxAhead: -1 } })).toThrow(/maxAhead/);
    const pinned = evmPolicy(1, { freshMs: -1 });
    expect(() => pool([endpoint], {}, pinned)).toThrow(/freshMs/);
  });

  test("timeout 3e9 and an infinite hedge delay are rejected", () => {
    const endpoint = { id: "a", url: "https://a.example", call: async () => "0x1" };
    expect(() => pool([endpoint], { timeout: 3e9 })).toThrow(/timeout/);
    expect(() => pool([endpoint], { hedge: { minDelay: Number.POSITIVE_INFINITY } })).toThrow(/minDelay/);
  });

  test("random() above 1 stays within the backoff cap", () => {
    expect(backoffMs(0, 2_000, () => 3)).toBeLessThanOrEqual(2_000);
    expect(backoffMs(0, 2_000, () => 3)).toBeGreaterThan(0);
    expect(backoffMs(0, 2_000, () => 1)).toBe(2_000);
  });
});

describe("clock, heads, and identity", () => {
  test("a NaN clock does not poison a burst of 1", async () => {
    let now = Number.NaN;
    let calls = 0;
    const client = pool([{
      id: "a",
      url: "https://a.example",
      rps: 1,
      burst: 1,
      call: async () => {
        calls += 1;
        return "0x1";
      },
    }], { now: () => now });
    await expect(client.request({ method: "eth_chainId" })).resolves.toBe("0x1");
    expect(client.snapshot()[0]?.tokens).toBe(0);
    await expect(client.request({ method: "eth_chainId" })).rejects.toBeInstanceOf(BudgetExhaustedError);
    now = 1_000;
    await expect(client.request({ method: "eth_chainId" })).resolves.toBe("0x1");
    expect(calls).toBe(2);
    client.close();
  });

  test("a negative or fractional head is ignored", async () => {
    let reported: unknown = -1;
    const policy = evmPolicy();
    policy.parseHead = (result: unknown) => typeof result === "number" ? result : parseQuantity(result);
    const client = pool([{
      id: "a",
      url: "https://a.example",
      call: async ({ method }) => method === "eth_blockNumber" ? reported : "0x1",
    }], { headLag: { probeInterval: false } }, policy);
    await client.probe();
    expect(client.snapshot()[0]?.head).toBeNull();
    reported = 1.5;
    await client.probe();
    expect(client.snapshot()[0]?.head).toBeNull();
    reported = 10;
    await client.probe();
    expect(client.snapshot()[0]?.head).toBe(10);
    client.close();
  });

  test("a second eth_chainId that returns a different number quarantines the endpoint", async () => {
    let now = 0;
    let chain = "0x1";
    const client = pool([{
      id: "a",
      url: "https://a.example",
      call: async ({ method }) => method === "eth_chainId" ? chain : "0x1",
    }], {
      now: () => now,
      verifyIdentity: true,
      headLag: { probeInterval: false },
      retryCount: 0,
      race: false,
    });
    await expect(client.request({ method: "eth_chainId" })).resolves.toBe("0x1");
    chain = "0x2";
    now = 4_000;
    await client.probe();
    await expect(client.request({ method: "eth_getBalance", params: ["0x1", "latest"] })).rejects.toBeInstanceOf(ChainMismatchError);
    expect(client.snapshot()[0]?.quarantined).toBe(true);
    client.close();
  });

  test("a forward-only reorg invalidates cached state when the next block has a new parent", async () => {
    const blocks = [
      { number: "0x64", hash: HASH_A, parentHash: PARENT },
      { number: "0x65", hash: HASH_B, parentHash: `0x${"dd".repeat(32)}` },
    ];
    let blockIndex = 0;
    let reads = 0;
    const policy = evmPolicy();
    policy.blockHashProbe = true;
    const client = pool([{
      id: "a",
      url: "https://a.example",
      call: async ({ method }) => {
        if (method === "eth_getBlockByNumber") return blocks[Math.min(blockIndex, blocks.length - 1)];
        if (method === "eth_getBalance") {
          reads += 1;
          return "0x1";
        }
        return "0x1";
      },
    }], {
      now: () => 0,
      cache: { refreshInterval: false, maxAgeMs: 60_000 },
      headLag: { probeInterval: false },
      race: false,
      retryCount: 0,
    }, policy);
    await client.probe();
    await client.request({ method: "eth_getBalance", params: ["0xabc", "0x64"] });
    await client.request({ method: "eth_getBalance", params: ["0xabc", "0x64"] });
    expect(reads).toBe(1);
    blockIndex = 1;
    await client.probe();
    await client.request({ method: "eth_getBalance", params: ["0xabc", "0x64"] });
    expect(reads).toBe(2);
    client.close();
  });
});

describe("coalesced cancellation", () => {
  test("an abort inside the coalesce listener does not keep the joiner waiting", async () => {
    let release: (value: string) => void = () => undefined;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const client = pool([{
      id: "a",
      url: "https://a.example",
      call: () => gate,
    }], { coalesce: true });
    const joiner = new AbortController();
    const stop = client.onEvent((event) => {
      if (event.type === "coalesce") joiner.abort();
    });
    const leader = client.request({ method: "eth_chainId", params: [] });
    const joined = client.request({ method: "eth_chainId", params: [], signal: joiner.signal });
    await expect(joined).rejects.toMatchObject({ name: "AbortError" });
    release("0x1");
    await expect(leader).resolves.toBe("0x1");
    stop();
    client.close();
  });
});

describe("power of two choices with a bad random source", () => {
  test("NaN random() still serves a healthy endpoint", async () => {
    const client = pool([
      { id: "a", url: "https://a.example", call: async () => "0x1" },
      { id: "b", url: "https://b.example", call: async () => "0x2" },
    ], { random: () => Number.NaN, routing: "p2c", retryCount: 0 });
    await expect(client.request({ method: "eth_chainId" })).resolves.toMatch(/^0x/);
    client.close();
  });
});
