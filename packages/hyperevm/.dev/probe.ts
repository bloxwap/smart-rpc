import {
  LOGS_RANGE_BLOCKS,
  LOGS_RANGE_PROBE,
  PRECOMPILE_PROBE,
  type ProbeObservation,
} from "../src/registry/policy.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EMPTY_LOG_ADDRESS = "0x0000000000000000000000000000000000000001";
const MAX_BODY_BYTES = 1_000_000;
export const L1_BLOCK_NUMBER_PRECOMPILE = "0x0000000000000000000000000000000000000809";

export interface ProbeOptions {
  expectedChainId?: number | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: Date | undefined;
  beforeRequest?: (() => Promise<void>) | undefined;
  /**
   * Width of the realistic log page. Default: {@link LOGS_RANGE_BLOCKS}. Pass the
   * endpoint's declared `maxLogBlockRange` when it is smaller: the router never sends a
   * wider range there, so failing a wider probe would rank a working node as down.
   */
  logsRangeBlocks?: number | undefined;
}

interface MethodSample {
  ms: number;
  ok: boolean;
  result?: unknown;
}

/** Probe identity, head, ordinary reads, HyperCore, and a realistic log page. */
export async function probeEndpoint(url: string, options: ProbeOptions = {}): Promise<ProbeObservation> {
  const expectedChainId = options.expectedChainId ?? 999;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const at = (options.now ?? new Date()).toISOString();
  const methods: ProbeObservation["methods"] = {};
  const callMethod = (method: string, params: unknown[]) =>
    call(url, method, params, timeoutMs, fetchImpl, options.beforeRequest);

  const chain = await callMethod("eth_chainId", []);
  const chainIdOk = chain.ok && parseChainId(chain.result) === expectedChainId;
  methods.eth_chainId = { ms: chain.ms, ok: chainIdOk };

  const block = await callMethod("eth_blockNumber", []);
  const head = chainIdOk && block.ok ? parseQuantity(block.result) : null;
  const headAt = head === null ? undefined : new Date().toISOString();
  methods.eth_blockNumber = { ms: block.ms, ok: chainIdOk && head !== null };

  const ordinary = await callMethod("eth_call", [{ to: ZERO_ADDRESS, data: "0x" }, "latest"]);
  methods.eth_call = { ms: ordinary.ms, ok: chainIdOk && ordinary.ok };

  const precompile = await callMethod(
    "eth_call",
    [{ to: L1_BLOCK_NUMBER_PRECOMPILE, data: "0x" }, "latest"],
  );
  methods[PRECOMPILE_PROBE] = { ms: precompile.ms, ok: chainIdOk && precompile.ok && isNonZeroWord(precompile.result) };

  if (head !== null) {
    const toBlock = `0x${head.toString(16)}`;
    const logs = await callMethod("eth_getLogs", [{ address: EMPTY_LOG_ADDRESS, fromBlock: toBlock, toBlock }]);
    methods.eth_getLogs = { ms: logs.ms, ok: chainIdOk && logs.ok && Array.isArray(logs.result) };
    const width = Math.max(1, Math.min(LOGS_RANGE_BLOCKS, options.logsRangeBlocks ?? LOGS_RANGE_BLOCKS));
    const fromBlock = `0x${Math.max(0, head - (width - 1)).toString(16)}`;
    const range = await callMethod("eth_getLogs", [{ address: EMPTY_LOG_ADDRESS, fromBlock, toBlock }]);
    methods[LOGS_RANGE_PROBE] = { ms: range.ms, ok: chainIdOk && range.ok && Array.isArray(range.result) };
  } else {
    methods.eth_getLogs = { ms: 0, ok: false };
    methods[LOGS_RANGE_PROBE] = { ms: 0, ok: false };
  }

  const ok = chainIdOk && methods.eth_blockNumber.ok;
  return {
    at,
    url,
    ok,
    chainIdOk,
    head: ok ? head : null,
    lag: null,
    ...(headAt ? { headAt } : {}),
    methods,
  };
}

/** HyperEVM's roughly one-second blocks adjust heads sampled at different times. */
const BLOCK_MS = 1_000;

export function assignLags(observations: readonly ProbeObservation[]): ProbeObservation[] {
  const usable = observations.filter((observation) => observation.head !== null && observation.chainIdOk);
  const times = usable.map((observation) => Date.parse(observation.headAt ?? observation.at)).filter(Number.isFinite);
  const referenceMs = times.length === 0 ? null : Math.max(...times);
  const projected = (observation: ProbeObservation): number | null => {
    if (observation.head === null) return null;
    if (referenceMs === null) return observation.head;
    const at = Date.parse(observation.headAt ?? observation.at);
    const elapsed = Number.isFinite(at) ? Math.max(0, referenceMs - at) : 0;
    return observation.head + elapsed / BLOCK_MS;
  };
  const heads = usable.map(projected).filter((head): head is number => head !== null);
  const best = heads.length === 0 ? null : Math.max(...heads);
  return observations.map((observation) => {
    const head = projected(observation);
    if (head === null || best === null || !observation.chainIdOk) return { ...observation, lag: null };
    const behind = best - head;
    return { ...observation, lag: behind <= 0 ? 0 : Math.round(behind) };
  });
}

export async function mapPool<T, U>(items: readonly T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("RPC response exceeded 1 MB.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function call(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
  fetchImpl: typeof fetch,
  beforeRequest?: () => Promise<void>,
): Promise<MethodSample> {
  let started = performance.now();
  try {
    await beforeRequest?.();
    started = performance.now();
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    const ms = roundMs(performance.now() - started);
    if (!response.ok) {
      await response.body?.cancel();
      return { ms, ok: false };
    }
    const body = JSON.parse(await readBody(response)) as {
      jsonrpc?: unknown;
      id?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (body.jsonrpc !== "2.0" || body.id !== 1 || body.error !== undefined || !("result" in body)) {
      return { ms, ok: false };
    }
    return { ms, ok: true, result: body.result };
  } catch {
    return { ms: roundMs(performance.now() - started), ok: false };
  }
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseChainId(result: unknown): number | null {
  if (typeof result === "number" && Number.isSafeInteger(result)) return result;
  if (typeof result !== "string" || !/^(?:0x[\da-f]+|\d+)$/i.test(result)) return null;
  const parsed = Number(result);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isNonZeroWord(result: unknown): boolean {
  return typeof result === "string" && /^0x[\da-f]{64}$/i.test(result) && /[1-9a-f]/i.test(result.slice(2));
}

function parseQuantity(result: unknown): number | null {
  if (typeof result !== "string" || !/^0x[\da-f]+$/i.test(result)) return null;
  const parsed = Number(result);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
