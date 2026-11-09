import { describe, expect, test } from "vitest";

import { BLOCK_RATE_HEADROOM, blockCadence, type ChainPolicy, type PoolEndpointConfig, type RpcEvent } from "../src/index.js";
import { evmPolicy, pool } from "./helpers.js";

describe("blockCadence", () => {
  test.each([
    [100, 10],
    [200, 5],
    [250, 4],
    [300, 3],
    [450, 2],
    [500, 2],
    [1_000, 1],
    [1_200, 1],
    [2_000, 1],
    [12_000, 1],
  ])("%ims blocks allow %i units of lag, about one second", (blockTimeMs, maxLag) => {
    const cadence = blockCadence(blockTimeMs);
    expect(cadence.maxLag).toBe(maxLag);
    expect(cadence.maxUnitsPerSecond).toBeCloseTo((1_000 / blockTimeMs) * BLOCK_RATE_HEADROOM);
  });

  test("rejects a block time that is not a positive number", () => {
    expect(() => blockCadence(0)).toThrow("blockTimeMs");
    expect(() => blockCadence(Number.NaN)).toThrow("blockTimeMs");
  });
});

/** Two endpoints with fixed heads. "lagging" answers in 10ms and leads unless it is held back for lag. */
function pair(lag: number, policy: ChainPolicy, headLag: { maxLag?: number } = {}) {
  let now = 0;
  const seen: { id: string; params: unknown }[] = [];
  const make = (id: string, head: number, latencyMs: number): PoolEndpointConfig => ({
    id,
    url: id,
    call: async ({ method, params }) => {
      if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
      now += latencyMs;
      seen.push({ id, params });
      return "0x1";
    },
  });
  const events: RpcEvent[] = [];
  const rpc = pool([make("lagging", 1_000 - lag, 10), make("fresh", 1_000, 100)], {
    routing: "best",
    now: () => now,
    onEvent: (event) => events.push(event),
    headLag: { probeInterval: false, ...headLag },
  }, policy);
  return { rpc, seen, events };
}

async function leader(lag: number, policy: ChainPolicy, headLag: { maxLag?: number } = {}): Promise<string | undefined> {
  const { rpc, seen } = pair(lag, policy, headLag);
  await rpc.probe();
  // Teach both latencies on fixed-number reads, then ask for the head.
  for (let index = 0; index < 6; index += 1) await rpc.request({ method: "eth_getBalance", params: [`0x${index}`, "0x1"] });
  seen.length = 0;
  await rpc.request({ method: "eth_getBalance", params: ["0xaa", "latest"] });
  rpc.close();
  return seen[0]?.id;
}

describe("block-time-aware lag", () => {
  test("a 250ms chain tolerates four blocks of lag, where the block-count default tolerates two", async () => {
    const quarterSecond = { ...evmPolicy(), blockTimeMs: 250 };
    expect(await leader(4, quarterSecond)).toBe("lagging");
    expect(await leader(5, quarterSecond)).toBe("fresh");
    expect(await leader(2, evmPolicy())).toBe("lagging");
    expect(await leader(3, evmPolicy())).toBe("fresh");
  });

  test("a 1s chain tolerates one block, and a 100ms chain ten", async () => {
    expect(await leader(1, { ...evmPolicy(), blockTimeMs: 1_000 })).toBe("lagging");
    expect(await leader(2, { ...evmPolicy(), blockTimeMs: 1_000 })).toBe("fresh");
    expect(await leader(10, { ...evmPolicy(), blockTimeMs: 100 })).toBe("lagging");
    expect(await leader(11, { ...evmPolicy(), blockTimeMs: 100 })).toBe("fresh");
  });

  test("an explicit maxLag wins over the block time", async () => {
    expect(await leader(5, { ...evmPolicy(), blockTimeMs: 1_000 }, { maxLag: 6 })).toBe("lagging");
  });

  test("pinning keeps the default two-block window on a 1s chain, so an earlier-probed holder is not barred", async () => {
    const { rpc, seen } = pair(2, { ...evmPolicy(1, true), blockTimeMs: 1_000 });
    await rpc.probe();
    seen.length = 0;
    await rpc.request({ method: "eth_getBalance", params: ["0xbb", "latest"] });
    // "latest" is pinned to the lower head, which both endpoints hold.
    expect(seen[0]?.params).toEqual(["0xbb", `0x${(998).toString(16)}`]);
    rpc.close();
  });
});
