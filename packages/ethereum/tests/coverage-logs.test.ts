import { describe, expect, test, vi } from "vitest";

import type { RpcPool } from "@smart-rpc/core";

import { requestLogs } from "../src/logs.js";

type LogPool = Pick<RpcPool, "request" | "requestBatch">;

function fakePool(overrides: { request?: unknown; batch?: PromiseSettledResult<unknown>[] } = {}) {
  const request = vi.fn(async () => overrides.request);
  const requestBatch = vi.fn(async () => overrides.batch ?? []);
  return { pool: { request, requestBatch } as unknown as LogPool, request, requestBatch };
}

describe("requestLogs limits", () => {
  test.each([
    { maxBlockRange: 0 },
    { maxBlockRange: 1.5 },
    { maxBlockRange: Number.POSITIVE_INFINITY },
    { maxBlockRange: 10, maxRequests: 0 },
    { maxBlockRange: 10, maxRequests: 2.5 },
  ])("rejects %o before sending anything", async (options) => {
    const { pool, request, requestBatch } = fakePool();
    await expect(requestLogs(pool, { fromBlock: "0x1", toBlock: "0x2" }, options))
      .rejects.toThrow("requestLogs limits must be positive safe integers.");
    expect(request).not.toHaveBeenCalled();
    expect(requestBatch).not.toHaveBeenCalled();
  });
});

describe("requestLogs with a range it cannot split", () => {
  test.each([
    { name: "a block hash", filter: { blockHash: "0xabc", fromBlock: "0x1", toBlock: "0x64" } },
    { name: "a tag as the lower bound", filter: { fromBlock: "earliest", toBlock: "0x64" } },
    { name: "a missing upper bound", filter: { fromBlock: "0x1" } },
    { name: "an inverted range", filter: { fromBlock: "0x64", toBlock: "0x1" } },
  ])("sends $name unchanged as one request", async ({ filter }) => {
    const logs = [{ logIndex: "0x0" }, { logIndex: "0x1" }];
    const { pool, request, requestBatch } = fakePool({ request: logs });
    const controller = new AbortController();
    await expect(requestLogs(pool, filter, { maxBlockRange: 10, chainId: "eip155:1", signal: controller.signal })).resolves.toBe(logs);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ chainId: "eip155:1", method: "eth_getLogs", params: [filter], signal: controller.signal });
    expect(requestBatch).not.toHaveBeenCalled();
  });

  test("rejects a non-array answer rather than returning it as logs", async () => {
    const { pool } = fakePool({ request: { logs: [] } });
    await expect(requestLogs(pool, { fromBlock: "latest", toBlock: "latest" }, { maxBlockRange: 10 }))
      .rejects.toThrow("eth_getLogs returned a non-array result.");
  });
});

describe("requestLogs with a split range", () => {
  test("concatenates each window in block order", async () => {
    const { pool, requestBatch } = fakePool({
      batch: [{ status: "fulfilled", value: [{ n: 1 }, { n: 2 }] }, { status: "fulfilled", value: [] }, { status: "fulfilled", value: [{ n: 3 }] }],
    });
    await expect(requestLogs(pool, { fromBlock: "0x1", toBlock: "0x5", address: "0xabc" }, { maxBlockRange: 2 }))
      .resolves.toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(requestBatch).toHaveBeenCalledWith([
      { chainId: undefined, method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2", address: "0xabc" }], signal: undefined },
      { chainId: undefined, method: "eth_getLogs", params: [{ fromBlock: "0x3", toBlock: "0x4", address: "0xabc" }], signal: undefined },
      { chainId: undefined, method: "eth_getLogs", params: [{ fromBlock: "0x5", toBlock: "0x5", address: "0xabc" }], signal: undefined },
    ]);
  });

  test("rejects the whole call when one window answers with a non-array", async () => {
    const { pool } = fakePool({
      batch: [{ status: "fulfilled", value: [{ n: 1 }] }, { status: "fulfilled", value: null }],
    });
    await expect(requestLogs(pool, { fromBlock: "0x1", toBlock: "0x4" }, { maxBlockRange: 2 }))
      .rejects.toThrow("eth_getLogs returned a non-array result.");
  });

  test("reports every failed window's reason and returns no partial logs", async () => {
    const first = new Error("range one failed");
    const second = new Error("range three failed");
    const { pool } = fakePool({
      batch: [{ status: "rejected", reason: first }, { status: "fulfilled", value: [{ n: 1 }] }, { status: "rejected", reason: second }],
    });
    const error: unknown = await requestLogs(pool, { fromBlock: "0x1", toBlock: "0x6" }, { maxBlockRange: 2 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([first, second]);
  });
});
