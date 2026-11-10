import { describe, expect, test } from "vitest";

import {
  canonicalLogFilterKey,
  LogIndex,
  planLogQuery,
  resolveLogIndexConfig,
  resolveLogRange,
  type LogFilter,
  type LogIndexLookupContext,
  type LogIndexMiss,
  type LogValue,
  type RollingLogQueryPlan,
} from "../src/log-index.js";

const ADDRESS = "0xAbCd000000000000000000000000000000000000";
const HASH = `0x${"ab".repeat(32)}`;

function hex(block: number): string {
  return `0x${block.toString(16)}`;
}

function log(block: number, logIndex: number, extra: LogFilter = {}): LogValue {
  return {
    address: ADDRESS.toLowerCase(),
    blockNumber: hex(block),
    logIndex: hex(logIndex),
    topics: [],
    data: "0x",
    ...extra,
  };
}

function range(from: number, to: number | "latest" = "latest", extra: LogFilter = {}): LogFilter {
  return {
    address: ADDRESS,
    fromBlock: hex(from),
    toBlock: to === "latest" ? to : hex(to),
    ...extra,
  };
}

function rolling(filter: LogFilter): RollingLogQueryPlan {
  const plan = planLogQuery([filter]);
  if (plan?.kind !== "rolling") throw new Error("expected a rolling log plan");
  return plan;
}

function miss(
  index: LogIndex,
  filter: LogFilter,
  head: number | undefined = 100,
  context: Partial<LogIndexLookupContext> = {},
): LogIndexMiss {
  const lookup = index.lookup(rolling(filter), { head, now: 0, ...context });
  if (!lookup || lookup.hit) throw new Error("expected a log index miss");
  return lookup;
}

function seed(
  index: LogIndex,
  from: number,
  to: number,
  logs: LogValue[],
  filter: LogFilter = range(from, to),
  at = 0,
): RollingLogQueryPlan {
  const plan = rolling(filter);
  const pending = miss(index, filter, to);
  expect(pending.fetch.fill(logs, at)).toBe(true);
  return plan;
}

describe("log query planning", () => {
  test("canonical identity excludes ranges and normalizes nested hex and object key order", () => {
    const first = rolling({
      topics: [HASH.toUpperCase(), null, [ADDRESS.toUpperCase()]],
      address: ADDRESS.toUpperCase(),
      fromBlock: "0x1",
      toBlock: "latest",
    });
    const second = rolling({
      toBlock: "0x20",
      address: ADDRESS.toLowerCase(),
      fromBlock: "0x0",
      topics: [HASH, null, [ADDRESS.toLowerCase()]],
    });
    expect(first.key).toBe(second.key);
    expect(first.filter).not.toHaveProperty("fromBlock");
    expect(first.filter).not.toHaveProperty("toBlock");
    expect(second.from).toBe(0);
    expect(second.to).toBe(32);
    expect(
      canonicalLogFilterKey({
        address: ADDRESS,
        topics: [HASH, null, [ADDRESS]],
        fromBlock: "0x1",
        toBlock: "0x2",
      }),
    ).toBe(first.key);
    expect(canonicalLogFilterKey({ blockHash: HASH })).toBeUndefined();
  });

  test("block-hash filters are separate and unsupported bounds never enter the rolling index", () => {
    const byHash = planLogQuery([{ address: ADDRESS, blockHash: HASH.toUpperCase() }]);
    expect(byHash).toMatchObject({ kind: "blockHash", filter: { blockHash: HASH } });
    expect(planLogQuery([{ fromBlock: "pending" }])).toBeUndefined();
    expect(planLogQuery([{ fromBlock: "earliest", toBlock: "0x20" }])).toBeUndefined();
    expect(planLogQuery([{ blockHash: 1 }])).toBeUndefined();
    expect(planLogQuery([])).toBeUndefined();
    expect(planLogQuery([{}, {}])).toBeUndefined();
    expect(resolveLogRange(rolling(range(10, 9)), 20)).toBeUndefined();
    expect(resolveLogRange(rolling({}), undefined)).toBeUndefined();
  });

  test("validates retention bounds", () => {
    expect(resolveLogIndexConfig({ window: 5, maxEntries: 0, maxBytes: 0 })).toMatchObject({
      window: 5,
      maxEntries: 0,
      maxBytes: 0,
      copyResults: true,
    });
    expect(() => resolveLogIndexConfig({ window: 0 })).toThrow("logIndex.window");
    expect(() => resolveLogIndexConfig({ maxEntries: -1 })).toThrow("logIndex.maxEntries");
    expect(() => resolveLogIndexConfig({ maxBytes: Number.NaN })).toThrow("logIndex.maxBytes");
  });
});

describe("rolling log index", () => {
  test("seeds from a complete range, deduplicates, orders, and copies JSON values on input and output", () => {
    const index = new LogIndex();
    const filter = range(90, 100);
    const pending = miss(index, filter);
    expect(pending.fetch).toMatchObject({
      kind: "seed",
      from: 90,
      to: 100,
      params: [{ address: ADDRESS.toLowerCase(), fromBlock: "0x5a", toBlock: "0x64" }],
    });
    const nested = { ids: ["0x01", 2, null, true] };
    const input = [log(100, 1), log(95, 0, { nested }), log(100, 0), log(95, 0, { nested })];
    expect(pending.fetch.fill(input, 10)).toBe(true);
    nested.ids[0] = "0xff";

    const hit = index.lookup(rolling(range(95, 100)), { head: 500, now: 20 });
    expect(hit).toMatchObject({ hit: true, stale: 0, range: { from: 95, to: 100 } });
    if (!hit?.hit) throw new Error("expected a hit");
    expect(hit.result).toEqual([log(95, 0, { nested: { ids: ["0x01", 2, null, true] } }), log(100, 0), log(100, 1)]);
    (hit.result[0]?.nested as { ids: string[] }).ids[0] = "0xee";
    const again = index.lookup(rolling(range(95, 95)), { head: 500, now: 20 });
    expect(again).toMatchObject({ hit: true, result: [{ nested: { ids: ["0x01", 2, null, true] } }] });
    expect(index.stats()).toMatchObject({ entries: 1, logs: 3 });
    expect(index.stats().bytes).toBeGreaterThan(0);
  });

  test("extends a latest-ended query with only the missing numeric tail", () => {
    const index = new LogIndex();
    seed(index, 90, 100, [log(95, 0), log(100, 1), log(100, 0)]);
    const pending = miss(index, range(90), 103);
    expect(pending.fetch).toMatchObject({
      kind: "tail",
      from: 101,
      to: 103,
      params: [{ fromBlock: "0x65", toBlock: "0x67" }],
    });
    expect(pending.fetch.fill([log(103, 2), log(101, 0), log(103, 0)])).toBe(true);
    expect(index.lookup(rolling(range(90)), { head: 103, now: 0 })).toMatchObject({
      hit: true,
      result: [log(95, 0), log(100, 0), log(100, 1), log(101, 0), log(103, 0), log(103, 2)],
    });
  });

  test("overlapping ranges replace answered blocks without duplicates", () => {
    const index = new LogIndex();
    seed(index, 90, 100, [log(90, 0), log(95, 0), log(100, 0)]);
    const pending = miss(index, range(80, 101), 101);
    expect(pending.fetch.kind).toBe("range");
    expect(pending.fetch.fill([log(80, 0), log(95, 0), log(100, 0), log(101, 0)])).toBe(true);
    expect(index.lookup(rolling(range(80, 101)), { head: 101, now: 0 })).toMatchObject({
      hit: true,
      result: [log(80, 0), log(95, 0), log(100, 0), log(101, 0)],
    });
    expect(index.stats().logs).toBe(4);
  });

  test("merges concurrent first seeds into a sibling-created base in the same generation", () => {
    const index = new LogIndex();
    const first = miss(index, range(1, 50), 50);
    const second = miss(index, range(51, 100), 100);
    expect(first.fetch.fill([log(1, 0)])).toBe(true);
    expect(second.fetch.fill([log(100, 0)])).toBe(true);
    expect(index.lookup(rolling(range(1, 100)), { head: 100, now: 0 })).toMatchObject({
      hit: true,
      result: [log(1, 0), log(100, 0)],
    });
  });

  test("prepends an adjacent earlier range while preserving order", () => {
    const index = new LogIndex();
    seed(index, 90, 100, [log(95, 0), log(100, 0)]);
    const pending = miss(index, range(80, 89));
    expect(pending.fetch).toMatchObject({ kind: "range", from: 80, to: 89 });
    expect(pending.fetch.fill([log(80, 0)])).toBe(true);
    expect(index.lookup(rolling(range(80, 100)), { head: 100, now: 0 })).toMatchObject({
      hit: true,
      result: [log(80, 0), log(95, 0), log(100, 0)],
    });
  });

  test("a disjoint response replaces the index instead of bridging an unfetched gap", () => {
    const index = new LogIndex();
    seed(index, 90, 100, [log(95, 0)]);
    const pending = miss(index, range(110, 110), 110);
    expect(pending.fetch.fill([log(110, 0)])).toBe(true);
    expect(index.metadata(rolling(range(90, 100)).key)).toMatchObject({ from: 110, to: 110, logCount: 1 });
    const gap = miss(index, range(95, 100));
    expect(gap.fetch).toMatchObject({ kind: "range", from: 95, to: 100 });
  });

  test("trims logs and coverage to the configured rolling window", () => {
    const index = new LogIndex({ window: 5 });
    seed(index, 90, 100, [log(95, 0), log(96, 0), log(100, 0)]);
    expect(index.metadata(rolling(range(90, 100)).key)).toMatchObject({ from: 96, to: 100, logCount: 2 });
    expect(index.lookup(rolling(range(96, 100)), { head: 100, now: 0 })?.hit).toBe(true);
    expect(miss(index, range(95, 100)).fetch).toMatchObject({ from: 95, to: 100 });
  });

  test("latest hits honor stale and age bounds while exact numeric ranges remain fully covered", () => {
    const index = new LogIndex();
    seed(index, 90, 100, [log(100, 0)], range(90, 100), 10);
    expect(index.lookup(rolling(range(90)), { head: 101, now: 100, maxStaleBlocks: 1, maxAgeMs: 100 })).toMatchObject({
      hit: true,
      stale: 1,
      range: { from: 90, to: 100 },
    });
    expect(miss(index, range(90), 101, { maxStaleBlocks: 0 }).fetch).toMatchObject({ kind: "tail", from: 101, to: 101 });
    expect(miss(index, range(90), 100, { now: 111, maxAgeMs: 100 }).fetch).toMatchObject({
      kind: "refresh",
      from: 90,
      to: 100,
    });
    expect(index.lookup(rolling(range(90, 100)), { head: 500, now: 10_000, maxAgeMs: 0 })?.hit).toBe(true);
    expect(index.lookup(rolling(range(90)), { head: undefined, now: 0 })).toBeUndefined();
  });

  test("failed, malformed, or out-of-range tail fetches leave the previous index intact", () => {
    const index = new LogIndex();
    seed(index, 90, 100, [log(100, 0)]);
    const pending = miss(index, range(90), 103);
    expect(index.lookup(rolling(range(95, 100)), { head: 103, now: 0 })?.hit).toBe(true);
    expect(pending.fetch.fill(null)).toBe(false);
    expect(pending.fetch.fill([log(104, 0)])).toBe(false);
    expect(pending.fetch.fill([log(101, 0, { data: "0x01" }), log(101, 0, { data: "0x02" })])).toBe(false);
    expect(index.metadata(rolling(range(90)).key)).toMatchObject({ from: 90, to: 100, logCount: 1 });
    expect(pending.fetch.fill([log(101, 0)])).toBe(true);
    expect(index.metadata(rolling(range(90)).key)).toMatchObject({ from: 90, to: 103, logCount: 2 });
  });

  test("a fill based on a replaced index or an invalidated generation is rejected", () => {
    const index = new LogIndex();
    seed(index, 90, 100, [log(100, 0)]);
    const tail = miss(index, range(90), 101);
    const widening = miss(index, range(80, 100));
    expect(widening.fetch.fill([log(80, 0), log(100, 0)])).toBe(true);
    expect(tail.fetch.fill([log(101, 0)])).toBe(false);

    const outstanding = index.lookup(rolling(range(90)), { head: 105, now: 0 });
    if (!outstanding || outstanding.hit) throw new Error("expected another tail");
    index.invalidate();
    expect(outstanding.fetch.fill([log(101, 0)])).toBe(false);
    expect(index.stats()).toEqual({ entries: 0, logs: 0, bytes: 0 });
    index.reset();
    expect(miss(index, range(102, 102), 102).fetch.fill([log(102, 0)])).toBe(true);
  });

  test("evicts whole filter indexes by LRU count and byte budget with accurate accounting", () => {
    const index = new LogIndex({ maxEntries: 1 });
    const first = rolling(range(1, 1, { address: "0x01" }));
    seed(index, 1, 1, [log(1, 0, { address: "0x01" })], range(1, 1, { address: "0x01" }));
    expect(index.metadata(first.key)).toBeDefined();
    seed(index, 2, 2, [log(2, 0, { address: "0x02" })], range(2, 2, { address: "0x02" }));
    expect(index.metadata(first.key)).toBeUndefined();
    expect(index.stats()).toMatchObject({ entries: 1, logs: 1 });
    const bytes = index.stats().bytes;
    index.invalidate();
    expect(index.stats().bytes).toBeLessThan(bytes);

    const noBytes = new LogIndex({ maxBytes: 1 });
    expect(miss(noBytes, range(1, 1), 1).fetch.fill([log(1, 0)])).toBe(true);
    expect(noBytes.stats()).toEqual({ entries: 0, logs: 0, bytes: 0 });
  });

  test("copyResults false explicitly shares immutable log values", () => {
    const index = new LogIndex({ copyResults: false });
    const input = log(1, 0);
    expect(miss(index, range(1, 1), 1).fetch.fill([input])).toBe(true);
    const hit = index.lookup(rolling(range(1, 1)), { head: 1, now: 0 });
    if (!hit?.hit) throw new Error("expected a hit");
    expect(hit.result[0]).toBe(input);
    expect(hit.result).not.toBe(input);
  });

  test("rejects an eth_getLogs body that includes an address or topic outside the filter", () => {
    const index = new LogIndex();
    const pending = miss(index, range(1, 2));
    const foreign = log(1, 0, { address: `0x${"11".repeat(20)}` });
    expect(pending.fetch.fill([foreign, log(1, 1)], 0)).toBe(false);
    expect(index.stats().logs).toBe(0);
    const topic = `0x${"cd".repeat(32)}`;
    const filtered = miss(index, range(1, 2, { topics: [topic] }));
    expect(filtered.fetch.fill([log(1, 0, { topics: [`0x${"ee".repeat(32)}`] })], 0)).toBe(false);
    expect(filtered.fetch.fill([log(1, 0, { topics: [topic] })], 0)).toBe(true);
    expect(index.stats().logs).toBe(1);
  });
});
