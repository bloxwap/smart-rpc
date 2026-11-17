import { afterEach, describe, expect, test, vi } from "vitest";

import { AllEndpointsFailedError, TimeoutError } from "../src/errors.js";
import { createPool } from "../src/pool.js";
import { parseQuantity } from "../src/quantity.js";
import type { RpcEvent } from "../src/events.js";
import type { ChainPolicy, PoolEndpointConfig, PoolOptions, RpcPool } from "../src/types.js";
import { evmPolicy, pool } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

const TX = { to: "0x000000000000000000000000000000000000dead", data: "0x" };
const ADDRESS = "0xabcd000000000000000000000000000000000000";
const balance = { method: "eth_getBalance", params: ["0x1", "latest"] };

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

interface Node {
  config: PoolEndpointConfig;
  calls: string[];
  count: (method: string) => number;
}

/** An endpoint on chain 1 at `head.value`. Other methods come from `read`; a thrown value fails the call. */
function node(
  id: string,
  head: { value: number },
  read: (method: string, params: unknown, nth: number) => unknown = () => undefined,
  extra: Partial<PoolEndpointConfig> = {},
): Node {
  const calls: string[] = [];
  const count = (method: string): number => calls.filter((call) => call === method).length;
  return {
    calls,
    count,
    config: {
      id,
      url: id,
      call: async ({ method, params }) => {
        calls.push(method);
        const answer = read(method, params, count(method));
        if (answer !== undefined) return answer;
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_blockNumber") return hex(head.value);
        return "0x1";
      },
      ...extra,
    },
  };
}

function recorder(): { events: RpcEvent[]; onEvent: (event: RpcEvent) => void; of: (type: RpcEvent["type"]) => RpcEvent[] } {
  const events: RpcEvent[] = [];
  return {
    events,
    onEvent: (event) => events.push(event),
    of: (type) => events.filter((event) => event.type === type),
  };
}

/** A pool with the read cache and pinning on, and no cache timer unless a test asks for one. */
function cached(nodes: readonly Node[], overrides: Partial<PoolOptions> = {}, policy: ChainPolicy = evmPolicy(1, true)): RpcPool {
  return pool(nodes.map((item) => item.config), {
    cache: { refreshInterval: false },
    coalesce: true,
    routing: "best",
    ...overrides,
  }, policy);
}

describe("reorganizations seen in results", () => {
  /**
   * `a` leads at block 100 and serves blocks from `block.value`. `b` is one block behind.
   * `seenAfterwards` asks for the block number through `b` once the pin is stale: a pool that saw no
   * reorganization keeps the 100 it already returned, and one that did starts again from what `b` reports.
   */
  async function chain(): Promise<{ client: RpcPool; getBlock: (value: unknown) => Promise<unknown>; seenAfterwards: () => Promise<unknown> }> {
    let clock = 0;
    let headDown = false;
    let block: unknown = null;
    const a = node("a", { value: 100 }, (method) => {
      if (method === "eth_getBlockByNumber") return block;
      if (method === "eth_blockNumber" && headDown) throw new Error("a down");
      return undefined;
    });
    const b = node("b", { value: 99 });
    const client = pool([a.config, b.config], { routing: "best", breaker: false, now: () => clock }, evmPolicy(1, true));
    await expect(client.request({ method: "eth_blockNumber" })).resolves.toBe("0x64");
    return {
      client,
      getBlock: async (value) => {
        block = value;
        return client.request({ method: "eth_getBlockByNumber", params: ["0x1", false] });
      },
      seenAfterwards: async () => {
        clock += 2_000;
        headDown = true;
        return client.request({ method: "eth_blockNumber" });
      },
    };
  }

  const blockAt = (height: number, hash: string): Record<string, unknown> => ({
    number: hex(height),
    hash,
    parentHash: height === 0 ? `0x${"00".repeat(32)}` : `0xhash${height - 1}`,
  });

  test("without a reorganization the block number never steps back to a lagging endpoint", async () => {
    const { client, getBlock, seenAfterwards } = await chain();
    await getBlock(blockAt(5, "0xhash5"));
    await getBlock(blockAt(6, "0xhash6"));
    await expect(seenAfterwards()).resolves.toBe("0x64");
    client.close();
  });

  test("a result whose block number cannot be read is passed through and proves nothing", async () => {
    const { client, getBlock, seenAfterwards } = await chain();
    const first = { number: "pending", hash: "0xone" };
    await expect(getBlock(first)).resolves.toEqual(first);
    await expect(getBlock({ number: "pending", hash: "0xother" })).resolves.toEqual({ number: "pending", hash: "0xother" });
    await expect(getBlock({ number: "0x5", hash: "" })).resolves.toEqual({ number: "0x5", hash: "" });
    await expect(seenAfterwards()).resolves.toBe("0x64");
    client.close();
  });

  test("a second hash for the genesis block is a reorganization", async () => {
    const { client, getBlock, seenAfterwards } = await chain();
    await getBlock(blockAt(0, "0xgenesis"));
    await getBlock(blockAt(0, "0xother"));
    await expect(seenAfterwards()).resolves.toBe("0x63");
    client.close();
  });

  test("only the newest 128 block hashes are remembered", async () => {
    const forgotten = await chain();
    for (let height = 1; height <= 129; height += 1) await forgotten.getBlock(blockAt(height, `0xhash${height}`));
    // Block 1 was dropped when block 129 arrived, so a different hash for it is not a known replacement.
    await forgotten.getBlock({ number: "0x1", hash: "0xreplaced" });
    await expect(forgotten.seenAfterwards()).resolves.toBe("0x64");
    forgotten.client.close();

    const remembered = await chain();
    for (let height = 1; height <= 128; height += 1) await remembered.getBlock(blockAt(height, `0xhash${height}`));
    await remembered.getBlock({ number: "0x1", hash: "0xreplaced" });
    await expect(remembered.seenAfterwards()).resolves.toBe("0x63");
    remembered.client.close();
  });

  test("an endpoint whose own head steps back resets the block number the pool holds callers to", async () => {
    let clock = 0;
    const head = { value: 0x10 };
    const a = node("a", head);
    const client = pool([a.config], { now: () => clock }, evmPolicy(1, true));
    await expect(client.request({ method: "eth_blockNumber" })).resolves.toBe("0x10");
    clock = 2_000;
    head.value = 0xf;
    await expect(client.request({ method: "eth_blockNumber" })).resolves.toBe("0xf");
    expect(a.count("eth_blockNumber")).toBe(2);
    client.close();
  });
});

describe("cache lookups", () => {
  test("a head on an endpoint that cannot serve the method does not make its cached answers stale", async () => {
    const a = node("a", { value: 100 }, (method) => (method === "eth_getBalance" ? "0xbalance" : undefined));
    const ahead = node("ahead", { value: 105 }, () => undefined, { supports: (method) => method !== "eth_getBalance" });
    const client = cached([a, ahead], { now: () => 0 });
    await client.probe();
    await expect(client.request(balance)).resolves.toBe("0xbalance");
    await expect(client.request(balance)).resolves.toBe("0xbalance");
    expect(a.count("eth_getBalance")).toBe(1);
    expect(client.cacheStats()).toMatchObject({ hits: 1, misses: 1 });
    client.close();
  });

  test("answers eth_blockNumber from the cached head once the pin is no longer fresh", async () => {
    let clock = 0;
    const a = node("a", { value: 100 });
    const client = cached([a], { now: () => clock });
    await client.probe();
    await expect(client.request({ method: "eth_blockNumber" })).resolves.toBe("0x64");
    // Older than the pin's 1s freshness, still inside the cache's 2s.
    clock = 1_500;
    await expect(client.request({ method: "eth_blockNumber" })).resolves.toBe("0x64");
    expect(a.count("eth_blockNumber")).toBe(1);
    clock = 2_500;
    await expect(client.request({ method: "eth_blockNumber" })).resolves.toBe("0x64");
    expect(a.count("eth_blockNumber")).toBe(2);
    client.close();
  });

  test("a cached probe method other than eth_blockNumber is still held to the block already returned", async () => {
    let clock = 0;
    let aDown = false;
    const endpoint = (id: string, slot: string, isDown: () => boolean): PoolEndpointConfig => ({
      id,
      url: id,
      call: async () => {
        if (isDown()) throw new Error(`${id} down`);
        return slot;
      },
    });
    const client = createPool({
      endpoints: [endpoint("a", "0x10", () => aDown), endpoint("b", "0xf", () => false)],
      policy: {
        chainIds: ["test:1"],
        probeMethod: "getSlot",
        parseHead: parseQuantity,
        identityMethod: "getGenesisHash",
        expectedIdentity: "genesis",
        parseIdentity: (result) => result,
        isSafeMethod: () => true,
        cachePolicy: { classify: () => "fresh" },
        pin: true,
      },
      verifyIdentity: false,
      headLag: { probeInterval: false },
      cache: { refreshInterval: false },
      race: false,
      routing: "best",
      now: () => clock,
    });
    await expect(client.request({ method: "getSlot" })).resolves.toBe("0x10");
    expect(client.cacheStats()).toMatchObject({ misses: 1, entries: 1 });
    clock = 3_000;
    aDown = true;
    await expect(client.request({ method: "getSlot" })).resolves.toBe("0x10");
    expect(client.cacheStats()).toMatchObject({ misses: 2, hits: 0 });
    client.close();
  });

  test("a caller that aborts when told of the cache miss reaches no endpoint", async () => {
    const controller = new AbortController();
    const a = node("a", { value: 100 });
    const client = cached([a], {
      coalesce: false,
      now: () => 0,
      onEvent: (event) => {
        if (event.type === "cache" && event.outcome === "miss") controller.abort();
      },
    });
    await expect(client.request({ ...balance, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(a.calls).toEqual([]);
    client.close();
  });
});

describe("log fetches that finish as the caller stops waiting", () => {
  const log = { address: ADDRESS, blockHash: `0x${"ab".repeat(32)}`, blockNumber: hex(95), logIndex: "0x0", topics: [], data: "0x" };
  const query = { method: "eth_getLogs", params: [{ address: ADDRESS, fromBlock: hex(90), toBlock: "latest" }] };
  const logsNode = (): Node => node("a", { value: 100 }, (method) => (method === "eth_getLogs" ? [log] : undefined));

  test("an abort in the tick the logs arrive rejects the call and stores nothing", async () => {
    const controller = new AbortController();
    const a = logsNode();
    const client = cached([a], {
      coalesce: false,
      isActive: () => false,
      now: () => 0,
      onEvent: (event) => {
        if (event.type === "success" && event.method === "eth_getLogs") controller.abort();
      },
    });
    await client.probe();
    await expect(client.request({ ...query, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(a.count("eth_getLogs")).toBe(1);
    expect(client.cacheStats().entries).toBe(0);
    // The discarded answer was not kept: the same query is fetched again.
    await expect(client.request(query)).resolves.toEqual([log]);
    expect(a.count("eth_getLogs")).toBe(2);
    expect(client.cacheStats().entries).toBe(1);
    client.close();
  });

  test("a batch deadline that passes in the tick the logs arrive rejects the item with the timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const a = logsNode();
    let expire = true;
    const client = cached([a], {
      isActive: () => false,
      now: () => 0,
      operationBudget: { timeout: 1_000 },
      onEvent: (event) => {
        if (expire && event.type === "success" && event.method === "eth_getLogs") vi.advanceTimersByTime(1_000);
      },
    });
    await client.probe();
    const results = await client.requestBatch([query]);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("rejected");
    const reason: unknown = results[0]?.status === "rejected" ? results[0].reason : undefined;
    expect(reason).toBeInstanceOf(TimeoutError);
    expect(reason).toMatchObject({ timeoutMs: 1_000 });
    expect(client.cacheStats().entries).toBe(0);
    expire = false;
    await expect(client.requestBatch([query])).resolves.toEqual([{ status: "fulfilled", value: [log] }]);
    expect(a.count("eth_getLogs")).toBe(2);
    client.close();
  });
});

describe("the cache's head probe", () => {
  function ticking(
    a: Node,
    overrides: Partial<PoolOptions> = {},
    policy: ChainPolicy = evmPolicy(1, true),
  ): { client: RpcPool; log: ReturnType<typeof recorder> } {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const log = recorder();
    const client = cached([a], { now: () => Date.now(), onEvent: log.onEvent, ...overrides }, policy);
    return { client, log };
  }

  test("a failed head probe is reported and the next tick probes again", async () => {
    const a = node("a", { value: 100 }, (method, _params, nth) => {
      if (method === "eth_blockNumber" && nth === 1) throw new Error("probe down");
      return undefined;
    });
    const { client, log } = ticking(a, { cache: { refreshInterval: 10 } });
    await client.request({ method: "eth_call", params: [TX] });
    await vi.advanceTimersByTimeAsync(10);
    expect(a.count("eth_blockNumber")).toBe(1);
    expect(log.of("error")).toMatchObject([{ method: "eth_blockNumber", endpoint: "a", terminal: false }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(a.count("eth_blockNumber")).toBe(2);
    expect(log.of("head")).toMatchObject([{ endpoint: "a", head: 100 }]);
    client.close();
  });

  test("sends nothing when the endpoint that could take the read cannot take the block probe", async () => {
    const policy = evmPolicy(1, true);
    policy.blockHashProbe = true;
    const a = node("a", { value: 100 }, () => undefined, { supports: (method) => method !== "eth_getBlockByNumber" });
    const { client } = ticking(a, { cache: { refreshInterval: 10 } }, policy);
    await client.request({ method: "eth_call", params: [TX] });
    expect(client.cacheStats().hotKeys).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(a.calls).toEqual(["eth_call"]);
    client.close();
  });

  async function oneTick(burst: number, identity: (nth: number) => string): Promise<{ a: Node; log: ReturnType<typeof recorder> }> {
    const a = node(
      "a",
      { value: 100 },
      (method, _params, nth) => (method === "eth_chainId" ? identity(nth) : undefined),
      { budget: { rps: 0.0001, burst } },
    );
    const { client, log } = ticking(a, { verifyIdentity: true, cache: { refreshInterval: 4_000 } });
    await client.request({ method: "eth_call", params: [TX] });
    expect(a.calls).toEqual(["eth_chainId", "eth_call"]);
    await vi.advanceTimersByTimeAsync(4_000);
    client.close();
    return { a, log };
  }

  test("reserves its last token for a foreground caller", async () => {
    const { a } = await oneTick(3, () => "0x1");
    expect(a.calls).toEqual(["eth_chainId", "eth_call"]);
  });

  test("refreshes identity and head when three tokens remain", async () => {
    const { a, log } = await oneTick(5, () => "0x1");
    expect(a.calls).toEqual(["eth_chainId", "eth_call", "eth_chainId", "eth_blockNumber"]);
    expect(log.of("quarantine")).toEqual([]);
  });

  test("an identity refresh that reports another chain quarantines the endpoint instead of probing it", async () => {
    const { a, log } = await oneTick(4, (nth) => (nth === 1 ? "0x1" : "0x2"));
    expect(a.calls).toEqual(["eth_chainId", "eth_call", "eth_chainId"]);
    expect(log.of("quarantine")).toMatchObject([{ endpoint: "a", reported: 2, expected: 1 }]);
  });
});

describe("a token that arrives while an unverified endpoint is being selected", () => {
  /**
   * `a` is unverified and out of tokens: two probes each spent one on an identity check that failed.
   * The clock then jumps far enough to refill the bucket on its `jumpAt`-th reading during the request,
   * so the refill lands at every possible point of the selection, including between its two budget reads.
   */
  async function run(jumpAt: number, heals: boolean): Promise<{ outcome: unknown; calls: string[] }> {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let armed = false;
    let reads = 0;
    let healed = false;
    const a = node(
      "a",
      { value: 100 },
      (method) => {
        if (method === "eth_chainId" && !healed) throw new Error("identity down");
        return method === "eth_getBalance" ? "0xa" : undefined;
      },
      { budget: { rps: 1, burst: 2 } },
    );
    const client = pool([a.config], {
      verifyIdentity: true,
      breaker: false,
      retryCount: 0,
      random: () => 0,
      now: () => {
        if (!armed) return 0;
        reads += 1;
        return reads >= jumpAt ? 10_000 : 0;
      },
    });
    await client.probe();
    await client.probe();
    expect(a.calls).toEqual(["eth_chainId", "eth_chainId"]);
    expect(client.snapshot()[0]?.tokens).toBe(0);
    healed = heals;
    armed = true;
    const pending = client.request(balance).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await pending;
    client.close();
    vi.useRealTimers();
    return { outcome, calls: a.calls.slice(2) };
  }

  /** Clock readings covered: the first selection pass and the one after its first refill wait. */
  const READS = 12;

  test("the endpoint is verified before the call is sent, whenever the token lands", async () => {
    for (let jumpAt = 1; jumpAt <= READS; jumpAt += 1) {
      const { outcome, calls } = await run(jumpAt, true);
      expect({ jumpAt, outcome, calls }).toEqual({ jumpAt, outcome: "0xa", calls: ["eth_chainId", "eth_getBalance"] });
    }
  });

  test("an endpoint that still fails its identity check is never sent the call", async () => {
    for (let jumpAt = 1; jumpAt <= READS; jumpAt += 1) {
      const { outcome, calls } = await run(jumpAt, false);
      expect(outcome).toBeInstanceOf(AllEndpointsFailedError);
      expect((outcome as AllEndpointsFailedError).errors.map((error) => error.message)).toEqual([
        "identity down",
        "identity down",
      ]);
      // One check when the token lands, one more after the backoff, and never the call itself.
      expect({ jumpAt, calls }).toEqual({ jumpAt, calls: ["eth_chainId", "eth_chainId"] });
    }
  });
});
