/** Parse a hex quantity such as an `eth_blockNumber` result. */
export function parseQuantity(value: unknown): number | null {
  if (typeof value !== "string" || !value.startsWith("0x")) return null;
  const parsed = Number.parseInt(value, 16);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
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
  return `0x${block.toString(16)}`;
}
