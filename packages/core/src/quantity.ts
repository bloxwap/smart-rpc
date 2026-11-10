/** Parse a hex quantity such as an `eth_blockNumber` result. */
export function parseQuantity(value: unknown): number | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return nonNegativeHead(parsed);
}

/** A block or slot the pool will store. Fractions, negatives, and values above 2^53-1 are not heads. */
export function nonNegativeHead(value: number | null): number | null {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/**
 * Pull the chain head out of a JSON-RPC result when the call asked for it.
 * Only `eth_blockNumber`, and `eth_getBlockByNumber` with the `"latest"` tag, count.
 */
export function blockNumberFromResult(method: string, result: unknown, params?: unknown): number | null {
  if (method === "eth_blockNumber") return parseQuantity(result);
  if (method !== "eth_getBlockByNumber") return null;
  if (!Array.isArray(params) || params[0] !== "latest") return null;
  if (typeof result !== "object" || result === null || !("number" in result)) return null;
  return parseQuantity(result.number);
}

export function toHexQuantity(block: number): string {
  if (!Number.isSafeInteger(block) || block < 0) {
    throw new Error(`Block number must be a non-negative safe integer, got ${String(block)}.`);
  }
  return `0x${block.toString(16)}`;
}
