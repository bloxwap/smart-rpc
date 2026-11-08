/**
 * JSON-RPC method safety and error classification for EVM transports.
 *
 * Ported from `@bloxwap/smart-hyperevm` `transport/_methods.ts` at 092b8f9.
 * Solana supplies its own method set; the error classes here are JSON-RPC and
 * are reused when a transport does not override `shouldFailover`.
 * @module
 */

import { isAbortError, toError } from "./error-util.js";

export { isAbortError, toError };

/** Methods the transport sends to at most one endpoint. */
export const NON_IDEMPOTENT_METHODS: readonly string[] = [
  "eth_sendRawTransaction",
  "eth_sendRawTransactionSync",
  "eth_sendTransaction",
  "eth_sign",
  "eth_signTransaction",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "personal_sign",
  "personal_sendTransaction",
  "eth_submitWork",
  "eth_submitHashrate",
  "wallet_sendTransaction",
  "wallet_sendCalls",
  "eth_subscribe",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
  "eth_unsubscribe",
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
];

/** Explicit read allowlist. Unknown/custom methods must never be guessed to be safe. */
export const SAFE_EVM_METHODS: readonly string[] = [
  "web3_clientVersion", "web3_sha3", "net_version", "net_listening", "net_peerCount",
  "eth_chainId", "eth_syncing", "eth_coinbase", "eth_accounts", "eth_blockNumber",
  "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_blobBaseFee", "eth_feeHistory",
  "eth_call", "eth_estimateGas", "eth_createAccessList", "eth_getBalance", "eth_getStorageAt",
  "eth_getTransactionCount", "eth_getCode", "eth_getProof", "eth_getLogs",
  "eth_getBlockByHash", "eth_getBlockByNumber", "eth_getBlockReceipts",
  "eth_getBlockTransactionCountByHash", "eth_getBlockTransactionCountByNumber",
  "eth_getTransactionByHash", "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex", "eth_getTransactionReceipt",
  "eth_getUncleCountByBlockHash", "eth_getUncleCountByBlockNumber",
  "eth_getUncleByBlockHashAndIndex", "eth_getUncleByBlockNumberAndIndex",
];
const SAFE: ReadonlySet<string> = new Set(SAFE_EVM_METHODS);

const DEFAULT_NON_IDEMPOTENT: ReadonlySet<string> = new Set(NON_IDEMPOTENT_METHODS);

/** Signed raw transaction sends. Rebroadcasting the same bytes is safe, so they fail over. */
export const REBROADCAST_METHODS: readonly string[] = ["eth_sendRawTransaction", "eth_sendRawTransactionSync"];

const DEFAULT_REBROADCAST: ReadonlySet<string> = new Set(REBROADCAST_METHODS);

/** Codes and messages that describe the call, not a sick endpoint. */
const TERMINAL_CODES: ReadonlySet<number> = new Set([
  3, // execution reverted
  -32700, // parse error
  -32600, // invalid request
  -32601, // method not found is a capability failure, not a retryable outage
  -32602, // invalid params
  -32003, // transaction rejected
  4001, // user rejected
  5000, // CAIP-25 user rejected
]);

const TERMINAL_MESSAGE = /execution reverted|gas required exceeds allowance/i;

/** Node-side verdicts on a signed transaction. Every endpoint would say the same. */
const REJECTED_TRANSACTION_MESSAGE =
  /nonce too (?:low|high)|insufficient funds|intrinsic gas too low|(?:replacement )?transaction underpriced|exceeds block gas limit|max fee per gas less than block base fee|invalid sender|duplicate transaction hash|already known|\bknown transaction|already imported|already in (?:the )?(?:mem)?pool/i;

/** A node already holds this transaction. On a rebroadcast, an earlier attempt landed. */
const ALREADY_KNOWN_MESSAGE = /duplicate transaction hash|already known|\bknown transaction|already imported|already in (?:the )?(?:mem)?pool/i;

/**
 * Provider limits on a request's span or size. Nodes report them as invalid params (`-32602`), as server errors,
 * as `-32005`, even with HTTP 429. Another endpoint may have a larger limit, so these fail over.
 */
const SPAN_LIMIT_MESSAGE =
  /(?:max(?:imum)?|exceed\w*|too (?:large|wide|big|many)|limit\w*)[^.\n]*block range|block range[^.\n]*(?:too|exceed\w*|limit\w*|max)|ranges? over \d|too many (?:results|logs|blocks)|more than \d[\d,]* (?:results|logs|blocks)|exceeds? max(?:imum)? results|retry with the range|response size|size (?:limit|exceeded)|deliverable ceiling|narrow the query|reduce the block range|limited to \d[\d,]* blocks|requested blocks/i;

/**
 * Generic limit wording. A restriction under any code except a rate-limit one: `-32005 limit exceeded` is the
 * EIP-1474 rate-limit error.
 */
const GENERIC_LIMIT_MESSAGE = /limit exceeded|limited to|query timeout|query timed out/i;

/**
 * Provider policies that refuse a request shape, a method or a depth on this endpoint only: token-gated archive or
 * indexed reads, filters a gateway insists on, requests a public tier declines. Each names the endpoint's own
 * policy, never a fault in the caller's request, so another endpoint may answer.
 */
const PROVIDER_RESTRICTION_MESSAGE =
  /personal token|requires? an? (?:api )?(?:key|token)\b|request blocked|(?:not served|will not serve)[^.\n]*endpoint|this endpoint will not|specify an address|missing required field '?address'? for log filter|requires? an? \w+ filter|paid (?:plan|tier)s? only|not (?:available|supported) on (?:the )?(?:free|public) (?:plan|tier)|upgrade your (?:plan|account)/i;

/**
 * Explicit rate-limit wording. It wins over the limit patterns: "limited to 10 requests per second" is a rate
 * limit, "limited to 1000 blocks" is a request-shape limit.
 */
const RATE_LIMIT_MESSAGE =
  /rate[- ]?limit|too many requests|requests? per (?:second|sec|minute|min)\b|\d+\s*(?:rps|req\/s)\b|request limit reached|exceeds defined limit|throttl|(?:quota|capacity|compute units?|credits?) (?:exceeded|exhausted|reached)|exceeded (?:the |your )?(?:quota|capacity|request limit|compute)/i;

/** Codes that report a request rate, not the call: HTTP 429 and EIP-1474 "limit exceeded". */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([429, -32005]);

/**
 * A node that has not reached the block a call names. Another endpoint may hold it.
 * The endpoint is not treated as sick.
 */
const BLOCK_NOT_HELD_MESSAGE =
  /header not found|unknown block|invalid block range|block range extends beyond|beyond (?:the )?(?:current )?head/i;

/**
 * How an endpoint error bears on routing.
 *
 * - `terminal`: the call itself is wrong (a revert, a rejected transaction, invalid params). Every endpoint would
 *   say the same, so the error goes back to the caller and the endpoint counts as healthy.
 * - `rate-limit`: the endpoint is over its request rate. Another endpoint may answer now; this one cools down.
 * - `restriction`: this endpoint's policy refuses this request (span, size, filter shape, token-gated method).
 *   Another endpoint may answer, and the endpoint is not sick.
 * - `not-held`: the endpoint has not reached the block the call names yet.
 * - `failure`: anything else. The endpoint may be sick; the call fails over and counts against it.
 * - `abort`: the caller cancelled.
 */
export type RpcErrorClass = "terminal" | "rate-limit" | "restriction" | "not-held" | "failure" | "abort";

/** True when the method is safe to send again to a different endpoint. */
export function isIdempotentMethod(method: string, extra: readonly string[] = []): boolean {
  if (DEFAULT_NON_IDEMPOTENT.has(method)) return false;
  return SAFE.has(method) && !extra.includes(method);
}

/**
 * Every human-readable part of an error and its causes: the message, viem's `details`, and JSON-RPC `data` (Pocket
 * puts the reason for a declined request there). viem's `shortMessage` stands in for `message` when present, so
 * the request body viem prints into `message` is never matched.
 */
function errorText(error: Error): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    const record = current as { message?: unknown; shortMessage?: unknown; details?: unknown; data?: unknown; cause?: unknown };
    const head = typeof record.shortMessage === "string" ? record.shortMessage : record.message;
    if (typeof head === "string") parts.push(head);
    if (typeof record.details === "string") parts.push(record.details);
    if (typeof record.data === "string") parts.push(record.data);
    else if (typeof record.data === "object" && record.data !== null) parts.push(jsonText(record.data));
    current = record.cause;
  }
  return parts.join("\n");
}

function jsonText(value: object): string {
  try {
    return JSON.stringify(value).slice(0, 2_000);
  } catch {
    return "";
  }
}

function errorCode(error: Error): number | undefined {
  if ("code" in error && typeof error.code === "number") return error.code;
  return undefined;
}

/** The HTTP status on the error or one of its causes. */
function errorStatus(error: Error): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    if ("status" in current && typeof current.status === "number") return current.status;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/**
 * Classify an endpoint error for routing. See {@link RpcErrorClass}.
 *
 * Order matters. A revert or a transaction verdict is terminal whatever else it says. Explicit rate-limit wording
 * wins over limit wording. A provider restriction fails over even when it arrives as invalid params (`-32602`),
 * `-32701`, or HTTP 429 (Sentio answers an oversized log range that way). Bare `-32602` and the other terminal
 * codes stay terminal, so a malformed request is never fanned out across every endpoint.
 */
export function classifyRpcError(error: Error): RpcErrorClass {
  if (isAbortError(error)) return "abort";
  const text = errorText(error);
  if (TERMINAL_MESSAGE.test(text) || REJECTED_TRANSACTION_MESSAGE.test(text)) return "terminal";
  if (RATE_LIMIT_MESSAGE.test(text)) return "rate-limit";
  if (BLOCK_NOT_HELD_MESSAGE.test(text)) return "not-held";
  if (PROVIDER_RESTRICTION_MESSAGE.test(text) || SPAN_LIMIT_MESSAGE.test(text)) return "restriction";
  const code = errorCode(error);
  if (errorStatus(error) === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) return "rate-limit";
  if (GENERIC_LIMIT_MESSAGE.test(text)) return "restriction";
  if (code !== undefined && TERMINAL_CODES.has(code)) return "terminal";
  return "failure";
}

/** True when the endpoint is over its request rate: HTTP 429, `-32005`, or rate-limit wording. */
export function isRateLimitError(error: Error): boolean {
  return classifyRpcError(error) === "rate-limit";
}

/**
 * True when this endpoint's own policy refused the request (span, size, filter shape, token-gated method).
 * Another endpoint may serve it, and the endpoint is not sick.
 */
export function isProviderRestriction(error: Error): boolean {
  return classifyRpcError(error) === "restriction";
}

/** True when the method is a signed raw transaction send that may be rebroadcast. */
export function isRebroadcastMethod(method: string): boolean {
  return DEFAULT_REBROADCAST.has(method);
}

/** True when a node reports that it already has the transaction. */
export function isAlreadyKnownError(error: Error): boolean {
  return ALREADY_KNOWN_MESSAGE.test(errorText(error));
}

/**
 * True when the endpoint answered that it does not hold the block the call names yet.
 * The call fails over, but the endpoint is not sick.
 */
export function isBlockNotHeldError(error: Error): boolean {
  return !isAbortError(error) && BLOCK_NOT_HELD_MESSAGE.test(errorText(error));
}

/**
 * True when another endpoint might answer this call.
 * Execution reverts, invalid params, transaction rejections, and user rejections stay on the caller.
 * Rate limits and provider restrictions fail over.
 */
export function shouldFailover(error: Error): boolean {
  const kind = classifyRpcError(error);
  return kind !== "abort" && kind !== "terminal";
}

