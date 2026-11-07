import type { RpcPool } from "@smart-rpc/core";
import { numericBlock } from "./capabilities.js";

export interface LogRangeOptions {
  /** Provider-specific inclusive range limit, not a chain-wide constant. */
  maxBlockRange: number;
  /** Bound memory before allocating split requests. Default: 100. */
  maxRequests?: number | undefined;
  chainId?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Split an explicit numeric log range while retaining the pool's shared operation budget.
 * No partial log list is returned if any split fails. Tags/hashes are sent unchanged.
 */
export async function requestLogs(
  pool: Pick<RpcPool, "request" | "requestBatch">,
  filter: Readonly<Record<string, unknown>>,
  options: LogRangeOptions,
): Promise<unknown[]> {
  const { maxBlockRange, maxRequests = 100, chainId, signal } = options;
  if (!Number.isSafeInteger(maxBlockRange) || maxBlockRange < 1 || !Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new Error("requestLogs limits must be positive safe integers.");
  }
  const from = numericBlock(filter.fromBlock);
  const to = numericBlock(filter.toBlock);
  if (filter.blockHash !== undefined || from === undefined || to === undefined || from > to) {
    const result = await pool.request({ chainId, method: "eth_getLogs", params: [filter], signal });
    if (!Array.isArray(result)) throw new Error("eth_getLogs returned a non-array result.");
    return result;
  }
  const width = BigInt(maxBlockRange);
  const count = (to - from) / width + 1n;
  if (count > BigInt(maxRequests)) throw new Error(`Log range needs ${count} requests, exceeding maxRequests ${maxRequests}.`);
  const requests = [];
  for (let start = from; start <= to; start += width) {
    const end = start + width - 1n;
    requests.push({
      chainId,
      method: "eth_getLogs",
      params: [{ ...filter, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${(end > to ? to : end).toString(16)}` }],
      signal,
    });
  }
  const results = await pool.requestBatch(requests);
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (errors.length > 0) throw new AggregateError(errors.map((result) => result.reason), "One or more log ranges failed; no partial result was returned.");
  const logs: unknown[] = [];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    if (!Array.isArray(result.value)) throw new Error("eth_getLogs returned a non-array result.");
    for (const log of result.value) logs.push(log);
  }
  return logs;
}
