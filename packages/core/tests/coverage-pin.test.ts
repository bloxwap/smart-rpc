import { describe, expect, test } from "vitest";

import {
  DEFAULT_PIN_FRESH_MS,
  isPrecompileCall,
  LatestPin,
  pinParams,
  resolvePin,
  type HeadReading,
  type PinSource,
} from "../src/pin.js";

const PRECOMPILE = "0x0000000000000000000000000000000000000801";
const CONTRACT = "0x00000000000000000000000000000000000000aa";

function reading(id: string, head: number, ageMs = 0, trusted = true): HeadReading {
  return { id, head, ageMs, trusted };
}

function source(readings: readonly HeadReading[], maxLag = 2, unservable: readonly string[] = []): PinSource {
  return {
    heads: () => readings,
    maxLag,
    servable: (id, method) => !unservable.includes(`${id}:${method}`) && !unservable.includes(id),
  };
}

describe("resolvePin", () => {
  test("defaults", () => {
    expect(resolvePin(undefined)).toEqual({
      enabled: true,
      freshMs: DEFAULT_PIN_FRESH_MS,
      blockNumber: true,
      skipPrecompiles: false,
    });
    expect(resolvePin(true, true)).toMatchObject({ enabled: true, skipPrecompiles: true });
    expect(resolvePin(false)).toMatchObject({ enabled: false, freshMs: DEFAULT_PIN_FRESH_MS });
  });

  test("options override the defaults, including the chain's precompile default", () => {
    expect(resolvePin({ freshMs: 0, blockNumber: false, skipPrecompiles: false }, true)).toEqual({
      enabled: true,
      freshMs: 0,
      blockNumber: false,
      skipPrecompiles: false,
    });
  });

  test("freshMs must be finite and not negative", () => {
    expect(() => resolvePin({ freshMs: -1 })).toThrow("smart-rpc pin.freshMs must be a finite number, 0 or more, got -1.");
    expect(() => resolvePin({ freshMs: Number.POSITIVE_INFINITY })).toThrow("got Infinity.");
    expect(() => resolvePin({ freshMs: Number.NaN })).toThrow("got NaN.");
  });
});

describe("isPrecompileCall", () => {
  test("matches only objects whose `to` is in the HyperCore read precompile range", () => {
    expect(isPrecompileCall({ to: PRECOMPILE })).toBe(true);
    expect(isPrecompileCall({ to: "0x00000000000000000000000000000000000008FF" })).toBe(true);
    expect(isPrecompileCall({ to: "0x0000000000000000000000000000000000000900" })).toBe(false);
    expect(isPrecompileCall({ to: CONTRACT })).toBe(false);
    expect(isPrecompileCall({ to: 0x800 })).toBe(false);
    expect(isPrecompileCall({ data: "0x" })).toBe(false);
    expect(isPrecompileCall(null)).toBe(false);
    expect(isPrecompileCall(PRECOMPILE)).toBe(false);
    expect(isPrecompileCall(undefined)).toBe(false);
  });
});

describe("pinParams", () => {
  test("params that are not an array come back untouched", () => {
    const params = { to: CONTRACT };
    expect(pinParams("eth_call", params, 16)).toBe(params);
    expect(pinParams("eth_call", undefined, 16)).toBeUndefined();
  });

  test("a method without a block slot comes back untouched", () => {
    const params = ["0xabc"];
    expect(pinParams("eth_getTransactionReceipt", params, 16)).toBe(params);
  });

  test("an explicit latest tag is replaced in a copy", () => {
    const params = [{ to: CONTRACT }, "latest"];
    expect(pinParams("eth_call", params, 16)).toEqual([{ to: CONTRACT }, "0x10"]);
    expect(params).toEqual([{ to: CONTRACT }, "latest"]);
    expect(pinParams("eth_getStorageAt", ["0x1", "0x0", "latest"], 255)).toEqual(["0x1", "0x0", "0xff"]);
    expect(pinParams("eth_getBlockByNumber", ["latest", false], 16)).toEqual(["0x10", false]);
    expect(pinParams("eth_feeHistory", ["0x4", "latest", []], 16)).toEqual(["0x4", "0x10", []]);
  });

  test("an omitted tag is pinned only where it implies latest", () => {
    expect(pinParams("eth_getBalance", ["0x1"], 16)).toEqual(["0x1", "0x10"]);
    expect(pinParams("eth_getStorageAt", ["0x1", "0x0"], 16)).toEqual(["0x1", "0x0", "0x10"]);
    const estimate = [{ to: CONTRACT }];
    expect(pinParams("eth_estimateGas", estimate, 16)).toBe(estimate);
  });

  test("params too short to reach the block slot come back untouched", () => {
    const params = ["0x1"];
    expect(pinParams("eth_getStorageAt", params, 16)).toBe(params);
    const empty: unknown[] = [];
    expect(pinParams("eth_call", empty, 16)).toBe(empty);
  });

  test("other tags are left alone", () => {
    for (const tag of ["0x5", "earliest", "pending", "safe", "finalized", null, 5, ["latest"]]) {
      const params = ["0x1", tag];
      expect(pinParams("eth_getBalance", params, 16)).toBe(params);
    }
  });

  test("an EIP-1898 object tag is pinned only when it names latest by number", () => {
    expect(pinParams("eth_call", [{}, { blockNumber: "latest" }], 16)).toEqual([{}, { blockNumber: "0x10" }]);
    expect(pinParams("eth_call", [{}, { blockNumber: "latest", requireCanonical: true }], 16)).toEqual([
      {},
      { blockNumber: "0x10", requireCanonical: true },
    ]);
    for (const tag of [
      { blockHash: "0xabc" },
      { blockHash: "0xabc", blockNumber: "latest" },
      { requireCanonical: true },
      { blockNumber: "0x5" },
    ]) {
      const params = [{}, tag];
      expect(pinParams("eth_call", params, 16)).toBe(params);
    }
  });

  test("precompile calls are skipped only when asked", () => {
    const params = [{ to: PRECOMPILE }, "latest"];
    expect(pinParams("eth_call", params, 16, true)).toBe(params);
    expect(pinParams("eth_call", params, 16)).toEqual([{ to: PRECOMPILE }, "0x10"]);
    expect(pinParams("eth_call", [{ to: CONTRACT }, "latest"], 16, true)).toEqual([{ to: CONTRACT }, "0x10"]);
    // The skip is for eth_call alone.
    expect(pinParams("eth_estimateGas", params, 16, true)).toEqual([{ to: PRECOMPILE }, "0x10"]);
  });

  describe("eth_getLogs", () => {
    test("a filter that is not a plain object comes back untouched", () => {
      for (const filter of [undefined, null, "latest", ["latest"]]) {
        const params = [filter];
        expect(pinParams("eth_getLogs", params, 16)).toBe(params);
      }
      const empty: unknown[] = [];
      expect(pinParams("eth_getLogs", empty, 16)).toBe(empty);
    });

    test("a blockHash filter is never pinned, but a null or undefined blockHash is ignored", () => {
      const byHash = [{ blockHash: "0xabc" }];
      expect(pinParams("eth_getLogs", byHash, 16)).toBe(byHash);
      expect(pinParams("eth_getLogs", [{ blockHash: null }], 16)).toEqual([
        { blockHash: null, fromBlock: "0x10", toBlock: "0x10" },
      ]);
      expect(pinParams("eth_getLogs", [{ blockHash: undefined, address: CONTRACT }], 16)).toEqual([
        { blockHash: undefined, address: CONTRACT, fromBlock: "0x10", toBlock: "0x10" },
      ]);
    });

    test("omitted and explicit latest bounds are both pinned, and later params are kept", () => {
      const filter = { address: CONTRACT };
      expect(pinParams("eth_getLogs", [filter, "extra"], 16)).toEqual([
        { address: CONTRACT, fromBlock: "0x10", toBlock: "0x10" },
        "extra",
      ]);
      expect(filter).toEqual({ address: CONTRACT });
      expect(pinParams("eth_getLogs", [{ fromBlock: "latest", toBlock: "latest" }], 16)).toEqual([
        { fromBlock: "0x10", toBlock: "0x10" },
      ]);
      expect(pinParams("eth_getLogs", [{ fromBlock: null, toBlock: null }], 16)).toEqual([
        { fromBlock: "0x10", toBlock: "0x10" },
      ]);
    });

    test("only the latest side of a mixed range is pinned", () => {
      expect(pinParams("eth_getLogs", [{ fromBlock: "0x5", toBlock: "latest" }], 16)).toEqual([
        { fromBlock: "0x5", toBlock: "0x10" },
      ]);
      expect(pinParams("eth_getLogs", [{ fromBlock: "0x5" }], 16)).toEqual([{ fromBlock: "0x5", toBlock: "0x10" }]);
      expect(pinParams("eth_getLogs", [{ fromBlock: "latest", toBlock: "0x20" }], 16)).toEqual([
        { fromBlock: "0x10", toBlock: "0x20" },
      ]);
      // A named tag on the other side cannot be compared, so the latest side still pins.
      expect(pinParams("eth_getLogs", [{ fromBlock: "earliest", toBlock: "latest" }], 16)).toEqual([
        { fromBlock: "earliest", toBlock: "0x10" },
      ]);
      expect(pinParams("eth_getLogs", [{ fromBlock: "latest", toBlock: "pending" }], 16)).toEqual([
        { fromBlock: "0x10", toBlock: "pending" },
      ]);
    });

    test("a range with no latest side comes back untouched", () => {
      const params = [{ fromBlock: "0x1", toBlock: "0x2" }];
      expect(pinParams("eth_getLogs", params, 16)).toBe(params);
    });

    test("a pin that would invert the range is abandoned", () => {
      const ahead = [{ fromBlock: "0x20", toBlock: "latest" }];
      expect(pinParams("eth_getLogs", ahead, 16)).toBe(ahead);
      const behind = [{ fromBlock: "latest", toBlock: "0x5" }];
      expect(pinParams("eth_getLogs", behind, 16)).toBe(behind);
    });
  });
});

describe("LatestPin", () => {
  const config = resolvePin(true);

  describe("target", () => {
    test("is null without any head, and without a fresh one", () => {
      expect(new LatestPin(config, source([])).target("eth_call")).toBeNull();
      const stale = new LatestPin(config, source([reading("a", 100, 1_001)]));
      expect(stale.target("eth_call")).toBeNull();
      expect(stale.target("eth_call", { fresh: false })).toEqual({ block: 100, holders: new Set(["a"]) });
      expect(stale.target("eth_call", { fresh: true })).toBeNull();
    });

    test("one fresh head is enough; stale heads still count as blocks held", () => {
      const pin = new LatestPin(config, source([reading("old", 99, 5_000), reading("new", 100, 1_000)]));
      expect(pin.target("eth_call")).toEqual({ block: 99, holders: new Set(["old", "new"]) });
    });

    test("the floor is the lowest head within maxLag of the top; laggards are not holders", () => {
      const pin = new LatestPin(config, source([reading("a", 100), reading("b", 98), reading("c", 97), reading("d", 99)]));
      expect(pin.target("eth_call")).toEqual({ block: 98, holders: new Set(["a", "b", "d"]) });
      expect(pin.target("eth_call", { top: true })).toEqual({ block: 100, holders: new Set(["a"]) });
    });

    test("untrusted heads and endpoints that cannot serve the method are ignored", () => {
      const pin = new LatestPin(
        config,
        source([reading("liar", 500, 0, false), reading("a", 100), reading("b", 99)], 2, ["b:eth_getLogs"]),
      );
      expect(pin.target("eth_call")).toEqual({ block: 99, holders: new Set(["a", "b"]) });
      expect(pin.target("eth_getLogs")).toEqual({ block: 100, holders: new Set(["a"]) });
    });

    test("the heads are read without an age limit", () => {
      const asked: number[] = [];
      const pin = new LatestPin(config, {
        heads: (maxAgeMs) => {
          asked.push(maxAgeMs);
          return [];
        },
        maxLag: 0,
        servable: () => true,
      });
      pin.target("eth_call");
      expect(asked).toEqual([Number.POSITIVE_INFINITY]);
    });
  });

  describe("pin", () => {
    const heads = source([reading("a", 16), reading("b", 15)]);

    test("pins a safe read to the floor and names the holders", () => {
      const pin = new LatestPin(config, heads);
      expect(pin.pin("eth_getBalance", ["0x1", "latest"], true)).toEqual({
        params: ["0x1", "0xf"],
        holders: new Set(["a", "b"]),
        block: 15,
      });
      expect(pin.pin("eth_getLogs", [{}], true)).toEqual({
        params: [{ fromBlock: "0xf", toBlock: "0xf" }],
        holders: new Set(["a", "b"]),
        block: 15,
      });
    });

    test("does nothing when disabled, for unsafe calls, unpinnable methods, or explicit blocks", () => {
      const params = ["0x1", "latest"];
      const off = { params, holders: undefined, block: undefined };
      expect(new LatestPin(resolvePin(false), heads).pin("eth_getBalance", params, true)).toEqual(off);
      const pin = new LatestPin(config, heads);
      expect(pin.pin("eth_getBalance", params, false)).toEqual(off);
      expect(pin.pin("eth_getTransactionByHash", params, true)).toEqual(off);
      const explicit = ["0x1", "0x5"];
      const result = pin.pin("eth_getBalance", explicit, true);
      expect(result.params).toBe(explicit);
      expect(result.holders).toBeUndefined();
      expect(result.block).toBeUndefined();
    });

    test("does nothing without a target", () => {
      const params = ["0x1", "latest"];
      const pin = new LatestPin(config, source([reading("a", 16, 9_999)]));
      expect(pin.pin("eth_getBalance", params, true)).toEqual({ params, holders: undefined, block: undefined });
    });

    test("honours the configured precompile skip", () => {
      const params = [{ to: PRECOMPILE }, "latest"];
      const skipping = new LatestPin(resolvePin(true, true), heads);
      expect(skipping.pin("eth_call", params, true)).toEqual({ params, holders: undefined, block: undefined });
      expect(new LatestPin(config, heads).pin("eth_call", params, true).block).toBe(15);
    });
  });

  describe("pinTop", () => {
    test("pins to the newest head even when pinning is off and no head is fresh", () => {
      const pin = new LatestPin(resolvePin(false), source([reading("a", 16, 60_000), reading("b", 15, 60_000)]));
      expect(pin.pinTop("eth_call", [{ to: CONTRACT }])).toEqual({
        params: [{ to: CONTRACT }, "0x10"],
        holders: new Set(["a"]),
        block: 16,
      });
      const other = ["0xabc"];
      expect(pin.pinTop("eth_getTransactionReceipt", other)).toEqual({ params: other, holders: undefined, block: undefined });
    });
  });

  describe("blockNumber and observe", () => {
    test("answersBlockNumber needs both pinning and the blockNumber option", () => {
      const heads = source([reading("a", 16)]);
      expect(new LatestPin(config, heads).answersBlockNumber).toBe(true);
      const disabled = new LatestPin(resolvePin(false), heads);
      expect(disabled.answersBlockNumber).toBe(false);
      expect(disabled.blockNumber()).toBeUndefined();
      const optedOut = new LatestPin(resolvePin({ blockNumber: false }), heads);
      expect(optedOut.answersBlockNumber).toBe(false);
      expect(optedOut.blockNumber()).toBeUndefined();
    });

    test("blockNumber answers the floor, or nothing without a target", () => {
      expect(new LatestPin(config, source([reading("a", 16), reading("b", 15)])).blockNumber()).toBe("0xf");
      expect(new LatestPin(config, source([])).blockNumber()).toBeUndefined();
    });

    test("the target is asked for the probe method", () => {
      const heads = source([reading("a", 16), reading("b", 15)], 2, ["b:custom_head"]);
      expect(new LatestPin(config, heads, "custom_head").blockNumber()).toBe("0x10");
      expect(new LatestPin(config, heads).blockNumber()).toBe("0xf");
    });

    test("answers never go backwards, and a served block above the floor raises the pin", () => {
      const readings = [reading("a", 16), reading("b", 16)];
      const pin = new LatestPin(config, source(readings));
      expect(pin.blockNumber()).toBe("0x10");

      // One endpoint falls behind: the floor drops to 15 but 16 was already returned and "a" still holds it.
      readings[1] = reading("b", 15);
      expect(pin.target("eth_call")).toEqual({ block: 16, holders: new Set(["a"]) });
      expect(pin.blockNumber()).toBe("0x10");
      expect(pin.pin("eth_getBalance", ["0x1"], true)).toEqual({
        params: ["0x1", "0x10"],
        holders: new Set(["a"]),
        block: 16,
      });

      // Nobody holds the served block any more: the pin follows the floor, but the probe answer holds.
      readings[0] = reading("a", 15);
      expect(pin.target("eth_call")).toEqual({ block: 15, holders: new Set(["a", "b"]) });
      expect(pin.blockNumber()).toBe("0x10");

      // A reorganization forgets the monotonic answer.
      pin.reset();
      expect(pin.blockNumber()).toBe("0xf");
    });

    test("observe passes through anything that is not a quantity", () => {
      const pin = new LatestPin(config, source([reading("a", 16)]));
      const block = { number: "0x10" };
      expect(pin.observe(block)).toBe(block);
      expect(pin.observe(null)).toBeNull();
      expect(pin.observe("latest")).toBe("latest");
    });

    test("observe lowers an upstream answer to the pin", () => {
      const pin = new LatestPin(config, source([reading("a", 16), reading("b", 15)]));
      expect(pin.observe("0x10")).toBe("0xf");
      expect(pin.observe("0xf")).toBe("0xf");
    });

    test("observe raises an upstream answer to the highest one already returned", () => {
      const pin = new LatestPin(config, source([]));
      // Without a target the upstream answer is used as is, and the original value is returned.
      expect(pin.observe("0x010")).toBe("0x010");
      expect(pin.observe("0xe")).toBe("0x10");
      expect(pin.observe("0x11")).toBe("0x11");
    });
  });
});
