import { afterEach, describe, expect, test, vi } from "vitest";

import {
  canonicalLogFilterKey,
  completeLogResult,
  LogIndex,
  planLogQuery,
  resolveLogRange,
  type LogFilter,
  type LogIndexMiss,
  type LogValue,
  type RollingLogQueryPlan,
} from "../src/log-index.js";

const ADDRESS = "0xAbCd000000000000000000000000000000000000";
const HASH = `0x${"ab".repeat(32)}`;
const T0 = `0x${"00".repeat(31)}a0`;
const T1 = `0x${"00".repeat(31)}a1`;
const T2 = `0x${"00".repeat(31)}a2`;
const T3 = `0x${"00".repeat(31)}a3`;

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

function rolling(filter: LogFilter): RollingLogQueryPlan {
  const plan = planLogQuery([filter]);
  if (plan?.kind !== "rolling") throw new Error("expected a rolling log plan");
  return plan;
}

function miss(index: LogIndex, filter: LogFilter, head = 100, now = 0): LogIndexMiss {
  const lookup = index.lookup(rolling(filter), { head, now });
  if (!lookup || lookup.hit) throw new Error("expected a log index miss");
  return lookup;
}

/** Whether a response of `logs` is accepted for `filter` on an empty index. */
function accepts(filter: LogFilter, logs: unknown): boolean {
  const index = new LogIndex();
  return miss(index, { fromBlock: "0x1", toBlock: "0xa", ...filter }).fetch.fill(logs, 0);
}

/** A JSON value that cannot be serialized into a canonical key: its `toJSON` answers with itself. */
function unserializable(): LogFilter {
  return {
    toJSON(this: unknown): unknown {
      return this;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("log query planning rejects filters it cannot identify", () => {
  test("a cyclic filter has no plan and no canonical key", () => {
    const cyclic: LogFilter = { address: ADDRESS, fromBlock: "0x1" };
    cyclic.self = cyclic;
    expect(planLogQuery([cyclic])).toBeUndefined();
    expect(canonicalLogFilterKey(cyclic)).toBeUndefined();

    const topics: unknown[] = [T0];
    topics.push(topics);
    expect(planLogQuery([{ address: ADDRESS, topics }])).toBeUndefined();

    // The same object reached twice without a cycle is still a valid filter.
    const shared = [T0];
    expect(planLogQuery([{ address: ADDRESS, topics: [shared, shared] }])?.kind).toBe("rolling");
  });

  test("a block-hash filter that cannot be serialized has no plan", () => {
    expect(planLogQuery([{ blockHash: HASH, address: ADDRESS }])).toMatchObject({ kind: "blockHash" });
    expect(planLogQuery([{ blockHash: HASH, address: unserializable() }])).toBeUndefined();
  });

  test("only filter objects have a canonical rolling key", () => {
    expect(canonicalLogFilterKey("0x1")).toBeUndefined();
    expect(canonicalLogFilterKey(null)).toBeUndefined();
    expect(canonicalLogFilterKey([{ address: ADDRESS }])).toBeUndefined();
    expect(canonicalLogFilterKey({ address: ADDRESS, fromBlock: "0x1" })).toBe(
      canonicalLogFilterKey({ address: ADDRESS.toLowerCase(), toBlock: "0x9" }),
    );
  });

  test("an invalid head resolves no range and answers no lookup", () => {
    const plan = rolling({ address: ADDRESS, fromBlock: "0x1", toBlock: "0x5" });
    expect(resolveLogRange(plan, 10)).toEqual({ from: 1, to: 5 });
    expect(resolveLogRange(plan, -1)).toBeUndefined();
    expect(resolveLogRange(plan, 1.5)).toBeUndefined();
    expect(resolveLogRange(plan, Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    expect(new LogIndex().lookup(plan, { head: -1 })).toBeUndefined();
  });
});

describe("log index freshness uses the wall clock by default", () => {
  test("a latest-ended hit ages out against Date.now() when no clock reading is supplied", () => {
    const index = new LogIndex();
    const filter = { address: ADDRESS, fromBlock: "0x5a", toBlock: "latest" };
    expect(miss(index, filter).fetch.fill([log(95, 0)], 1_000)).toBe(true);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_400);
    expect(index.lookup(rolling(filter), { head: 100, maxAgeMs: 500 })).toMatchObject({
      hit: true,
      stale: 0,
      range: { from: 90, to: 100 },
    });
    clock.mockReturnValue(1_501);
    expect(index.lookup(rolling(filter), { head: 100, maxAgeMs: 500 })).toMatchObject({
      hit: false,
      fetch: { kind: "refresh", from: 90, to: 100 },
    });
  });
});

describe("a fetched response must match the filter it was fetched for", () => {
  test("an empty address list matches nothing, and a log needs a string address", () => {
    expect(accepts({ address: [] }, [])).toBe(true);
    expect(accepts({ address: [] }, [log(2, 0)])).toBe(false);
    expect(accepts({ address: ADDRESS }, [log(2, 0, { address: 7 })])).toBe(false);
    expect(accepts({ address: ADDRESS }, [log(2, 0, { address: ADDRESS.toUpperCase().replace("0X", "0x") })])).toBe(
      true,
    );
  });

  test("topics must be arrays on both sides", () => {
    expect(accepts({ topics: T0 }, [log(2, 0, { topics: [T0] })])).toBe(false);
    expect(accepts({ topics: [T0] }, [log(2, 0, { topics: T0 })])).toBe(false);
    expect(accepts({ topics: [T0] }, [log(2, 0, { topics: [T0] })])).toBe(true);
  });

  test("wildcard positions are skipped and later positions still checked", () => {
    const filter = { topics: [null, T1] };
    expect(accepts(filter, [log(2, 0, { topics: [T0, T1] })])).toBe(true);
    expect(accepts(filter, [log(2, 0, { topics: [T0, T2] })])).toBe(false);
    // The log is too short to carry the constrained position.
    expect(accepts(filter, [log(2, 0, { topics: [T0] })])).toBe(false);
    expect(accepts(filter, [log(2, 0, { topics: [T0, 5] })])).toBe(false);
  });

  test("an alternatives position matches any listed topic, case-insensitively", () => {
    const filter = { topics: [[T1, T2]] };
    expect(accepts(filter, [log(2, 0, { topics: [T2.toUpperCase().replace("0X", "0x")] })])).toBe(true);
    expect(accepts(filter, [log(2, 0, { topics: [T3] })])).toBe(false);
    // Non-string alternatives never match, but do not hide a later string that does.
    expect(accepts({ topics: [[5, T1]] }, [log(2, 0, { topics: [T1] })])).toBe(true);
    expect(accepts({ topics: [[5]] }, [log(2, 0, { topics: [T1] })])).toBe(false);
    // A position that is neither a topic, a wildcard, nor a list matches nothing.
    expect(accepts({ topics: [5] }, [log(2, 0, { topics: [T1] })])).toBe(false);
  });
});

describe("malformed responses are never stored", () => {
  test("a response holding a non-object entry is rejected and leaves the index empty", () => {
    const index = new LogIndex();
    const pending = miss(index, { address: ADDRESS, fromBlock: "0x1", toBlock: "0xa" });
    expect(pending.fetch.fill(["0x1"], 0)).toBe(false);
    expect(pending.fetch.fill([null], 0)).toBe(false);
    expect(pending.fetch.fill([[log(2, 0)]], 0)).toBe(false);
    expect(index.stats()).toEqual({ entries: 0, logs: 0, bytes: 0 });
  });

  test.each([true, false])("a cyclic log is rejected (copyResults: %s)", (copyResults) => {
    const index = new LogIndex({ copyResults });
    const pending = miss(index, { address: ADDRESS, fromBlock: "0x1", toBlock: "0xa" });
    const cyclic = log(2, 0);
    cyclic.self = cyclic;
    expect(pending.fetch.fill([log(1, 0), cyclic], 0)).toBe(false);
    const nested = log(3, 0);
    nested.topics = [nested];
    expect(pending.fetch.fill([nested], 0)).toBe(false);
    expect(index.stats()).toEqual({ entries: 0, logs: 0, bytes: 0 });
    // The same request can still be filled by a well-formed response.
    expect(pending.fetch.fill([log(1, 0)], 0)).toBe(true);
    expect(index.stats()).toMatchObject({ entries: 1, logs: 1 });
  });

  test("completeLogResult normalizes a complete response and refuses a malformed one", () => {
    const first = log(4, 1, { topics: [T0] });
    const second = log(4, 0);
    const copied = completeLogResult([first, second, { ...first }], 1, 10, true);
    expect(copied).toEqual([second, first]);
    expect(copied?.[1]).not.toBe(first);
    const shared = completeLogResult([first, second], 1, 10, false);
    expect(shared?.[0]).toBe(second);
    expect(shared?.[1]).toBe(first);

    expect(completeLogResult("0x", 1, 10, true)).toBeUndefined();
    expect(completeLogResult({ logs: [] }, 1, 10, true)).toBeUndefined();
    // A log outside the requested range proves the response is not for this query.
    expect(completeLogResult([log(11, 0)], 1, 10, true)).toBeUndefined();
  });
});

describe("shared and copied results are accounted identically", () => {
  test("copyResults: false shares the provider's logs and charges the same bytes as a copy", () => {
    const filter = { address: ADDRESS, fromBlock: "0x1", toBlock: "0xa" };
    const logs = [
      log(2, 0, { topics: [T0, T1], removed: false, meta: { tags: ["a", null, 3] } }),
      log(3, 1, { data: "0xdeadbeef" }),
    ];
    const shared = new LogIndex({ copyResults: false });
    const copied = new LogIndex({ copyResults: true });
    expect(miss(shared, filter).fetch.fill(logs, 0)).toBe(true);
    expect(miss(copied, filter).fetch.fill(logs, 0)).toBe(true);

    expect(shared.stats().logs).toBe(2);
    expect(shared.stats().bytes).toBeGreaterThan(0);
    expect(shared.stats().bytes).toBe(copied.stats().bytes);

    const fromShared = shared.lookup(rolling(filter), { head: 100, now: 0 });
    const fromCopied = copied.lookup(rolling(filter), { head: 100, now: 0 });
    if (!fromShared?.hit || !fromCopied?.hit) throw new Error("expected hits");
    expect(fromShared.result[0]).toBe(logs[0]);
    expect(fromCopied.result[0]).not.toBe(logs[0]);
    expect(fromCopied.result).toEqual(logs);
  });
});
