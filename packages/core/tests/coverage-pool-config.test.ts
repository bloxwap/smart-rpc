import { afterEach, describe, expect, test, vi } from "vitest";

import { MAX_TIMER_MS } from "../src/constants.js";
import { TransportClosedError } from "../src/errors.js";
import { createPool } from "../src/pool.js";
import { parseQuantity } from "../src/quantity.js";
import { createPoolScope } from "../src/share.js";
import type { RpcEvent } from "../src/events.js";
import type { ChainPolicy, PoolEndpointConfig, PoolOptions } from "../src/types.js";
import { evmPolicy, pool } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The smallest policy a chain package may pass: no pin, cache, rebroadcast, or classifier overrides. */
function barePolicy(overrides: Partial<ChainPolicy> = {}): ChainPolicy {
  return {
    chainIds: ["test:1"],
    probeMethod: "getSlot",
    parseHead: parseQuantity,
    identityMethod: "getGenesisHash",
    expectedIdentity: undefined,
    parseIdentity: (result) => result,
    isSafeMethod: (method) => method.startsWith("get"),
    ...overrides,
  };
}

function answering(id: string, result: unknown = "0x1"): { config: PoolEndpointConfig; calls: string[]; closed: () => number } {
  const calls: string[] = [];
  let closed = 0;
  return {
    calls,
    closed: () => closed,
    config: {
      id,
      url: `https://${id}.example`,
      call: async ({ method }) => {
        calls.push(method);
        return result;
      },
      close: () => {
        closed += 1;
      },
    },
  };
}

describe("option validation", () => {
  const a = answering("a");

  test("rejects an operation deadline that a timer cannot hold", () => {
    expect(() => pool([a.config], { timeout: 600_000_000 })).toThrow(
      `smart-rpc operationBudget.timeout must be from 1 to ${MAX_TIMER_MS} milliseconds. Four attempt timeouts is 2400000000`,
    );
    expect(() => pool([a.config], { operationBudget: { timeout: 0 } })).toThrow("operationBudget.timeout");
    expect(() => pool([a.config], { operationBudget: { timeout: Number.NaN } })).toThrow("operationBudget.timeout");
    // A large attempt timeout is fine once the operation deadline is set explicitly.
    const client = pool([a.config], { timeout: 600_000_000, operationBudget: { timeout: MAX_TIMER_MS } });
    client.close();
  });

  test.each([-1, Number.POSITIVE_INFINITY, Number.NaN, MAX_TIMER_MS + 1])(
    "rejects headLag.probeInterval %s",
    (probeInterval) => {
      expect(() => pool([a.config], { headLag: { probeInterval } })).toThrow(
        `smart-rpc headLag.probeInterval must be a finite delay from 0 to ${MAX_TIMER_MS} milliseconds, or false, got ${String(probeInterval)}.`,
      );
    },
  );

  test.each([-1, Number.POSITIVE_INFINITY, Number.NaN])("rejects hedge.multiplier %s", (multiplier) => {
    expect(() => pool([a.config], { hedge: { multiplier } })).toThrow(
      `smart-rpc hedge.multiplier must be a finite number, 0 or more, got ${String(multiplier)}.`,
    );
  });

  test("rejects an empty endpoint list, blank or repeated ids, and weights that are not above 0", () => {
    expect(() => pool([])).toThrow("smart-rpc requires at least one endpoint.");
    expect(() => pool([a.config, { ...a.config, id: "  " }])).toThrow("smart-rpc endpoints[1].id must not be empty.");
    expect(() => pool([a.config, { ...a.config }])).toThrow('smart-rpc endpoint "a" is used more than once.');
    for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => pool([{ ...a.config, weight }])).toThrow("smart-rpc endpoints[0].weight must be a finite number above 0.");
    }
  });
});

describe("a pool built from the smallest policy", () => {
  test("routes without a pin, cache policy, or rebroadcast classifier and reports an empty cache", async () => {
    const a = answering("a", "0x10");
    const client = createPool({
      endpoints: [a.config],
      policy: barePolicy(),
      verifyIdentity: false,
      headLag: { probeInterval: false },
    });
    await expect(client.request({ method: "getBalance", params: ["abc"] })).resolves.toBe("0x10");
    expect(client.cacheStats()).toEqual({ hits: 0, misses: 0, refreshes: 0, entries: 0, bytes: 0, hotKeys: 0 });
    // Nothing is answered from memory: the second identical read goes upstream again.
    await client.request({ method: "getBalance", params: ["abc"] });
    expect(a.calls).toEqual(["getBalance", "getBalance"]);
    client.close();
  });

  test("sends an unsafe method once when the policy has no rebroadcast classifier", async () => {
    const seen: string[] = [];
    const failing = (id: string): PoolEndpointConfig => ({
      id,
      url: id,
      call: async () => {
        seen.push(id);
        throw new Error(`${id} down`);
      },
    });
    const client = createPool({
      endpoints: [failing("a"), failing("b")],
      policy: barePolicy(),
      verifyIdentity: false,
      headLag: false,
      routing: "best",
    });
    await expect(client.request({ method: "sendTransaction", params: ["0xsigned"] })).rejects.toThrow("a down");
    expect(seen).toEqual(["a"]);
    client.close();
  });

  test("keeps a probe method other than eth_blockNumber from stepping back across endpoints", async () => {
    const calls: string[] = [];
    let aDown = false;
    const endpoint = (id: string, head: string, down: () => boolean): PoolEndpointConfig => ({
      id,
      url: id,
      call: async ({ method }) => {
        calls.push(`${id}:${method}`);
        if (down()) throw new Error(`${id} down`);
        return head;
      },
    });
    const client = createPool({
      endpoints: [endpoint("a", "0x10", () => aDown), endpoint("b", "0xf", () => false)],
      policy: barePolicy({ pin: true }),
      verifyIdentity: false,
      headLag: { probeInterval: false },
      race: false,
      routing: "best",
      now: () => 0,
    });
    await expect(client.request({ method: "getSlot" })).resolves.toBe("0x10");
    aDown = true;
    // `b` is one slot behind. The caller already saw 0x10 and `a` still holds it.
    await expect(client.request({ method: "getSlot" })).resolves.toBe("0x10");
    expect(calls).toEqual(["a:getSlot", "a:getSlot", "b:getSlot"]);
    client.close();
  });
});

describe("stateful handles", () => {
  test("rejects a follow-up whose params carry no handle", async () => {
    const a = answering("a", "0xupstream");
    const policy = evmPolicy();
    policy.statefulMethods = {
      create: ["eth_newFilter"],
      use: ["eth_getFilterChanges"],
      release: ["eth_uninstallFilter"],
    };
    const client = pool([a.config], {}, policy);
    for (const params of [undefined, [], [7], { handle: "0x1" }]) {
      await expect(client.request({ method: "eth_getFilterChanges", params })).rejects.toThrow(
        "Unknown or expired RPC stateful handle.",
      );
    }
    expect(a.calls).toEqual([]);
    const handle = await client.request({ method: "eth_newFilter", params: [{}] });
    expect(handle).toBe("0x1");
    await expect(client.request({ method: "eth_getFilterChanges", params: [handle] })).resolves.toBe("0xupstream");
    client.close();
  });
});

describe("close", () => {
  test("rejects later requests, sends no later probe, and releases each endpoint once", async () => {
    const a = answering("a");
    const client = pool([a.config]);
    await client.request({ method: "eth_getBalance", params: ["0x1", "latest"] });
    client.close();
    client.close();
    expect(a.closed()).toBe(1);
    await expect(client.request({ method: "eth_getBalance", params: ["0x1", "latest"] })).rejects.toBeInstanceOf(
      TransportClosedError,
    );
    await expect(client.probe()).resolves.toBeUndefined();
    expect(a.calls).toEqual(["eth_getBalance"]);
  });
});

describe("the pool clock", () => {
  test("holds its last finite reading through a non-finite sample and a step backwards", async () => {
    let clock = 1_000;
    const events: RpcEvent[] = [];
    const client = pool(
      [{
        id: "a",
        url: "a",
        call: async () => {
          throw new Error("down");
        },
      }],
      { now: () => clock, retryCount: 0, breaker: { threshold: 1, cooldown: 5_000 }, onEvent: (event) => events.push(event) },
    );
    await expect(client.request({ method: "eth_getBalance", params: ["0x1", "latest"] })).rejects.toThrow("down");
    expect(events.filter((event) => event.type === "eject")).toMatchObject([{ cooldownMs: 5_000, failures: 1 }]);
    expect(client.snapshot()[0]?.ejected).toBe(true);

    clock = Number.NaN;
    expect(client.snapshot()[0]?.ejected).toBe(true);
    clock = Number.POSITIVE_INFINITY;
    expect(client.snapshot()[0]?.ejected).toBe(true);
    // A clock that jumps back does not extend the ejection, and one that later catches up ends it on time.
    clock = 0;
    expect(client.snapshot()[0]?.ejected).toBe(true);
    clock = 5_999;
    expect(client.snapshot()[0]?.ejected).toBe(true);
    clock = 6_000;
    expect(client.snapshot()[0]?.ejected).toBe(false);
    client.close();
  });
});

describe("score snapshot labels", () => {
  test("an unlabeled endpoint never takes a label another endpoint chose as its id", async () => {
    const url = "https://user:secret@rpc.example/v1/key";
    const first = pool([{ url, call: async () => "0x1" }]);
    await first.request({ method: "eth_getBalance", params: ["0x1", "latest"] });
    const labels = Object.keys(first.scores().endpoints);
    expect(labels).toHaveLength(1);
    const label = labels[0] ?? "";
    expect(label).toMatch(/^endpoint:[0-9a-f]{16}$/);
    first.close();

    // Other endpoints are explicitly named with that hash label, and with the first fallback too.
    const down = async (): Promise<never> => {
      throw new Error("down");
    };
    const client = pool(
      [
        { id: label, url: "https://named.example", call: down },
        { id: `${label}:2`, url: "https://second.example", call: down },
        { url, call: async () => "0xplain" },
      ],
      { routing: "best" },
    );
    await expect(client.request({ method: "eth_getBalance", params: ["0x1", "latest"] })).resolves.toBe("0xplain");
    expect(Object.keys(client.scores().endpoints).sort()).toEqual([label, `${label}:2`, `${label}:3`]);
    expect(client.scores().endpoints[`${label}:3`]?.["*"]).toMatchObject({ n: 1, error: 0 });
    expect(client.endpoints.map((item) => item.id)).toEqual([label, `${label}:2`, url]);
    client.close();
  });
});

describe("sharing fingerprint", () => {
  function shared(scope: ReturnType<typeof createPoolScope>, endpoint: PoolEndpointConfig, overrides: Partial<PoolOptions> = {}) {
    return createPool({
      endpoints: [endpoint],
      policy: barePolicy(),
      verifyIdentity: false,
      headLag: false,
      sharing: { scope, key: "shared" },
      ...overrides,
    });
  }

  test("pools with the same unset options share one pool and release the duplicate's endpoints", async () => {
    const scope = createPoolScope();
    const a = answering("a", "0xfirst");
    const b = answering("a", "0xsecond");
    const first = shared(scope, a.config);
    const second = shared(scope, b.config);
    expect(b.closed()).toBe(1);
    expect(a.closed()).toBe(0);
    await expect(second.request({ method: "getBalance" })).resolves.toBe("0xfirst");
    expect(b.calls).toEqual([]);

    // Each of these changes routing or identity, so the key cannot be reused for it.
    const variants: Partial<PoolOptions>[] = [
      { perMethod: false },
      { policy: barePolicy({ expectedIdentity: "genesis" }) },
      { policy: barePolicy({ probeParams: [] }) },
      { policy: barePolicy({ identityParams: [] }) },
      { policy: barePolicy({ pin: true }) },
    ];
    for (const variant of variants) {
      const c = answering("a");
      expect(() => shared(scope, c.config, variant)).toThrow(
        "smart-rpc sharing key is already used by a pool with different endpoints, credentials, or policy.",
      );
      expect(c.closed()).toBe(1);
    }
    first.close();
    second.close();
    expect(a.closed()).toBe(1);
    scope.close();
  });

  test("tells a non-finite number from a missing one", () => {
    const scope = createPoolScope();
    const a = answering("a");
    const b = answering("a");
    const c = answering("a");
    // `headLag` is left at its default here, like every other unset option.
    const options = { headLag: undefined, policy: barePolicy({ probeParams: [Number.POSITIVE_INFINITY] }) };
    const first = shared(scope, a.config, options);
    const same = shared(scope, b.config, options);
    expect(b.closed()).toBe(1);
    // JSON alone would write both as `null`.
    expect(() => shared(scope, c.config, { headLag: undefined, policy: barePolicy({ probeParams: [null] }) })).toThrow(
      "smart-rpc sharing key is already used",
    );
    first.close();
    same.close();
    scope.close();
  });
});

describe("runtimes whose timers are plain numbers", () => {
  test("requests, deadlines, and the probe timer work without unref", async () => {
    const realTimeout = globalThis.setTimeout;
    const realInterval = globalThis.setInterval;
    let timers = 0;
    vi.stubGlobal("setTimeout", (callback: () => void, ms?: number): number => {
      timers += 1;
      return Number(realTimeout(callback, ms));
    });
    vi.stubGlobal("setInterval", (callback: () => void, ms?: number): number => {
      timers += 1;
      return Number(realInterval(callback, ms));
    });
    const a = answering("a", "0x1");
    const client = pool([a.config], { verifyIdentity: true, headLag: { probeInterval: 60_000 }, hedge: true });
    await expect(client.request({ method: "eth_getBalance", params: ["0x1", "latest"] })).resolves.toBe("0x1");
    expect(a.calls).toEqual(["eth_chainId", "eth_getBalance"]);
    // The identity deadline, the attempt deadline, the hedge delay and the probe interval were all scheduled.
    expect(timers).toBeGreaterThanOrEqual(4);
    client.close();
  });
});
