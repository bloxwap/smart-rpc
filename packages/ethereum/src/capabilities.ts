/** Endpoint facts. Omitted values are unknown, never a promise of provider support. */
export type EvmBlockTag = "latest" | "pending" | "safe" | "finalized" | "earliest";

export interface EthereumEndpointCapabilities {
  /** Historical state access, distinct from historical blocks, receipts and logs. */
  archive?: boolean | undefined;
  blockTags?: readonly EvmBlockTag[] | undefined;
  debug?: boolean | undefined;
  trace?: boolean | undefined;
  subscriptions?: boolean | undefined;
  /** Whether latest state may be rewritten to a numeric block. */
  pinning?: boolean | undefined;
  /** HTTP batching remains opt-in through the transport's batch option. */
  batch?: boolean | undefined;
  maxBatchSize?: number | undefined;
  maxLogBlockRange?: number | undefined;
  maxLogTopics?: number | undefined;
}

const STATE_SLOTS: Readonly<Record<string, number>> = {
  eth_call: 1,
  eth_estimateGas: 1,
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getTransactionCount: 1,
  eth_getStorageAt: 2,
  eth_getProof: 2,
  debug_traceCall: 1,
  trace_call: 2,
};

const BLOCK_SLOTS: Readonly<Record<string, number>> = {
  eth_getBlockByNumber: 0,
  eth_getBlockTransactionCountByNumber: 0,
  eth_getUncleCountByBlockNumber: 0,
  eth_getTransactionByBlockNumberAndIndex: 0,
  eth_getUncleByBlockNumberAndIndex: 0,
  eth_feeHistory: 1,
  debug_traceBlockByNumber: 0,
  trace_block: 0,
};

const TAGS: ReadonlySet<string> = new Set(["latest", "pending", "safe", "finalized", "earliest"]);

/** Test request selectors without rewriting finality, historical state, or extension fields. */
export function supportsEvmRequest(
  capabilities: EthereumEndpointCapabilities | undefined,
  request: { method: string; params?: unknown },
): boolean {
  if (!capabilities) return true;
  const { method } = request;
  if (capabilities.debug === false && method.startsWith("debug_")) return false;
  if (capabilities.trace === false && method.startsWith("trace_")) return false;
  if (capabilities.subscriptions === false && (method === "eth_subscribe" || method === "eth_unsubscribe")) return false;
  const params = Array.isArray(request.params) ? request.params : [];
  const stateSlot = STATE_SLOTS[method];
  const blockSlot = stateSlot ?? BLOCK_SLOTS[method];
  if (blockSlot !== undefined) {
    const selector: unknown = params[blockSlot] ?? (stateSlot !== undefined ? "latest" : undefined);
    if (!supportsSelector(capabilities, selector, stateSlot !== undefined)) return false;
  }
  if (method !== "eth_getLogs") return true;
  const filter: unknown = params[0];
  if (!isRecord(filter)) return true; // Let the server report malformed parameters.
  if (capabilities.maxLogTopics !== undefined && Array.isArray(filter.topics) && filter.topics.length > capabilities.maxLogTopics) return false;
  if (filter.blockHash !== undefined) return true;
  if (!supportsSelector(capabilities, filter.fromBlock ?? "latest", false) || !supportsSelector(capabilities, filter.toBlock ?? "latest", false)) return false;
  const from = numericBlock(filter.fromBlock);
  const to = numericBlock(filter.toBlock);
  return capabilities.maxLogBlockRange === undefined || from === undefined || to === undefined ||
    to < from || to - from + 1n <= BigInt(capabilities.maxLogBlockRange);
}

function supportsSelector(capabilities: EthereumEndpointCapabilities, selector: unknown, state: boolean): boolean {
  if (isRecord(selector)) {
    if (selector.blockHash !== undefined && state && capabilities.archive === false) return false;
    return selector.blockNumber === undefined || supportsSelector(capabilities, selector.blockNumber, state);
  }
  if (typeof selector === "string" && TAGS.has(selector)) {
    if (state && selector === "earliest" && capabilities.archive === false) return false;
    return capabilities.blockTags === undefined || capabilities.blockTags.includes(selector as EvmBlockTag);
  }
  return !(state && capabilities.archive === false && numericBlock(selector) !== undefined);
}

export function numericBlock(value: unknown): bigint | undefined {
  return typeof value === "string" && /^0x[\da-f]+$/i.test(value) ? BigInt(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateCapabilities(value: EthereumEndpointCapabilities | undefined): void {
  for (const key of ["maxBatchSize", "maxLogBlockRange", "maxLogTopics"] as const) {
    const limit = value?.[key];
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error(`ethereum() capabilities.${key} must be a positive safe integer.`);
    }
  }
}
