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
 * the request body viem prints into `message` is never matched. Each part is capped: a provider controls this
 * text, and classification only needs the reason.
 */
const ERROR_TEXT_LIMIT = 8_000;

function errorText(error: Error): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    const record = current as { message?: unknown; shortMessage?: unknown; details?: unknown; data?: unknown; cause?: unknown };
    const head = typeof record.shortMessage === "string" ? record.shortMessage : record.message;
    if (typeof head === "string") parts.push(clip(head));
    if (typeof record.details === "string") parts.push(clip(record.details));
    if (typeof record.data === "string") parts.push(clip(record.data));
    else if (typeof record.data === "object" && record.data !== null) parts.push(jsonText(record.data));
    current = record.cause;
  }
  return parts.join("\n");
}

function clip(value: string): string {
  return value.length > ERROR_TEXT_LIMIT ? value.slice(0, ERROR_TEXT_LIMIT) : value;
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
  if (hasRateLimitWording(text)) return "rate-limit";
  if (BLOCK_NOT_HELD_MESSAGE.test(text)) return "not-held";
  if (PROVIDER_RESTRICTION_MESSAGE.test(text) || hasSpanLimitWording(text)) return "restriction";
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

/**
 * Rate-limit phrases. Matched by scanning, not a regular expression: the text comes from the endpoint, and the
 * old pattern (`\d+` before a unit that is not there) retried every split of a long digit run.
 *
 * Same phrases as before, case-insensitive: `rate limit` / `rate-limit` / `ratelimit`, `too many requests`,
 * `request(s) per second|sec|minute|min`, a number then `rps` or `req/s`, `request limit reached`,
 * `exceeds defined limit`, `throttl…`, and quota / capacity / compute-unit / credit wording.
 */
function hasRateLimitWording(text: string): boolean {
  const lower = text.toLowerCase();
  if (
    lower.includes("ratelimit") || lower.includes("rate-limit") || lower.includes("rate limit") ||
    lower.includes("too many requests") || lower.includes("request limit reached") ||
    lower.includes("exceeds defined limit") || lower.includes("throttl")
  ) return true;
  return hasRequestsPer(lower) || hasRateFigure(lower) || hasQuotaClause(lower) || hasExceededQuota(lower);
}

/** `requests? per (second|sec|minute|min)` with a word boundary after the unit. */
function hasRequestsPer(lower: string): boolean {
  let from = 0;
  while (from < lower.length) {
    const at = lower.indexOf("request", from);
    if (at < 0) return false;
    let index = at + "request".length;
    if (lower.charCodeAt(index) === 115) index += 1; // "requests"
    if (lower.startsWith(" per ", index)) {
      index += " per ".length;
      for (const unit of ["second", "minute", "sec", "min"]) {
        if (lower.startsWith(unit, index) && wordBoundary(lower, index + unit.length)) return true;
      }
    }
    from = at + 1;
  }
  return false;
}

/** `\d+\s*(?:rps|req/s)\b`. */
function hasRateFigure(lower: string): boolean {
  return unitAfterDigits(lower, "rps") || unitAfterDigits(lower, "req/s");
}

function unitAfterDigits(text: string, unit: string): boolean {
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(unit, from);
    if (at < 0) return false;
    if (wordBoundary(text, at + unit.length)) {
      let index = at - 1;
      while (index >= 0 && isSpace(text.charCodeAt(index))) index -= 1;
      if (index >= 0 && isDigit(text.charCodeAt(index))) return true;
    }
    from = at + 1;
  }
  return false;
}

const QUOTA_SUBJECTS = ["compute units", "compute unit", "credits", "credit", "capacity", "quota"] as const;
const QUOTA_STATES = ["exceeded", "exhausted", "reached"] as const;

/** `quota|capacity|compute units?|credits?` followed by one space and `exceeded|exhausted|reached`. */
function hasQuotaClause(lower: string): boolean {
  for (const subject of QUOTA_SUBJECTS) {
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(subject, from);
      if (at < 0) break;
      const tail = at + subject.length;
      if (lower.charCodeAt(tail) === 32) {
        for (const state of QUOTA_STATES) {
          if (lower.startsWith(state, tail + 1)) return true;
        }
      }
      from = at + 1;
    }
  }
  return false;
}

/** `exceeded` then an optional `the` or `your`, then `quota|capacity|request limit|compute`. */
function hasExceededQuota(lower: string): boolean {
  let from = 0;
  while (from < lower.length) {
    const at = lower.indexOf("exceeded", from);
    if (at < 0) return false;
    let index = at + "exceeded".length;
    if (lower.startsWith(" the ", index)) index += " the ".length;
    else if (lower.startsWith(" your ", index)) index += " your ".length;
    else if (lower.charCodeAt(index) === 32) index += 1;
    else {
      from = at + 1;
      continue;
    }
    if (
      lower.startsWith("quota", index) || lower.startsWith("capacity", index) ||
      lower.startsWith("request limit", index) || lower.startsWith("compute", index)
    ) return true;
    from = at + 1;
  }
  return false;
}

/**
 * Span and size limits. Same phrases as the previous regular expression, scanned in linear time: that pattern
 * put an open-ended run (`[^.\n]*`, `\d+`, `\w*`) in front of a literal, so a long string of zeros after `max`
 * made the matcher try every split.
 */
function hasSpanLimitWording(text: string): boolean {
  const lower = text.toLowerCase();
  if (
    lower.includes("retry with the range") || lower.includes("response size") || lower.includes("size limit") ||
    lower.includes("size exceeded") || lower.includes("deliverable ceiling") || lower.includes("narrow the query") ||
    lower.includes("reduce the block range") || lower.includes("requested blocks") || lower.includes("too many results") ||
    lower.includes("too many logs") || lower.includes("too many blocks")
  ) return true;
  return hasBlockRangeLimit(lower) || hasRangeOver(lower) || hasMoreThanCount(lower) ||
    hasExceedMaxResults(lower) || hasLimitedToBlocks(lower);
}

/** A limit word and `block range` in the same sentence (no `.` or newline between them), in either order. */
function hasBlockRangeLimit(lower: string): boolean {
  let from = 0;
  while (from < lower.length) {
    const at = lower.indexOf("block range", from);
    if (at < 0) return false;
    const start = boundaryBefore(lower, at);
    const end = boundaryAfter(lower, at + "block range".length);
    const before = lower.slice(start, at);
    const after = lower.slice(at + "block range".length, end);
    if (
      before.includes("max") || before.includes("exceed") || before.includes("limit") || hasTooSize(before) ||
      after.includes("too") || after.includes("exceed") || after.includes("limit") || after.includes("max")
    ) return true;
    from = at + 1;
  }
  return false;
}

function hasTooSize(text: string): boolean {
  return text.includes("too large") || text.includes("too wide") || text.includes("too big") || text.includes("too many");
}

/** `range over <digit>` or `ranges over <digit>`. */
function hasRangeOver(lower: string): boolean {
  let from = 0;
  while (from < lower.length) {
    const at = lower.indexOf("range", from);
    if (at < 0) return false;
    let index = at + "range".length;
    if (lower.charCodeAt(index) === 115) index += 1;
    if (lower.startsWith(" over ", index) && isDigit(lower.charCodeAt(index + " over ".length))) return true;
    from = at + 1;
  }
  return false;
}

/** `more than <digits-or-commas> results|logs|blocks`. */
function hasMoreThanCount(lower: string): boolean {
  return countThenNoun(lower, "more than ");
}

/** `limited to <digits-or-commas> blocks`. */
function hasLimitedToBlocks(lower: string): boolean {
  let from = 0;
  while (from < lower.length) {
    const at = lower.indexOf("limited to ", from);
    if (at < 0) return false;
    const noun = skipNumber(lower, at + "limited to ".length);
    if (noun !== undefined && lower.startsWith(" blocks", noun)) return true;
    from = at + 1;
  }
  return false;
}

function countThenNoun(lower: string, prefix: string): boolean {
  let from = 0;
  while (from < lower.length) {
    const at = lower.indexOf(prefix, from);
    if (at < 0) return false;
    const noun = skipNumber(lower, at + prefix.length);
    if (
      noun !== undefined && lower.charCodeAt(noun) === 32 && (
        lower.startsWith("results", noun + 1) || lower.startsWith("logs", noun + 1) || lower.startsWith("blocks", noun + 1)
      )
    ) return true;
    from = at + 1;
  }
  return false;
}

/** Index just after a number (`\d[\d,]*`), or undefined when the index is not a digit. */
function skipNumber(text: string, index: number): number | undefined {
  if (!isDigit(text.charCodeAt(index))) return undefined;
  let cursor = index + 1;
  while (cursor < text.length && (isDigit(text.charCodeAt(cursor)) || text.charCodeAt(cursor) === 44)) cursor += 1;
  return cursor;
}

/** `exceed(s) max(imum) results`. */
function hasExceedMaxResults(lower: string): boolean {
  let from = 0;
  while (from < lower.length) {
    const at = lower.indexOf("exceed", from);
    if (at < 0) return false;
    let index = at + "exceed".length;
    if (lower.charCodeAt(index) === 115) index += 1;
    if (lower.startsWith(" max", index)) {
      index += " max".length;
      if (lower.startsWith("imum", index)) index += "imum".length;
      if (lower.startsWith(" results", index)) return true;
    }
    from = at + 1;
  }
  return false;
}

function boundaryBefore(text: string, index: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const code = text.charCodeAt(cursor);
    if (code === 46 || code === 10) return cursor + 1;
  }
  return 0;
}

function boundaryAfter(text: string, index: number): number {
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const code = text.charCodeAt(cursor);
    if (code === 46 || code === 10) return cursor;
  }
  return text.length;
}

function wordBoundary(text: string, index: number): boolean {
  return index >= text.length || !isWord(text.charCodeAt(index));
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isWord(code: number): boolean {
  return isDigit(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

/** JavaScript `\s` without the unicode flag. */
function isSpace(code: number): boolean {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32 ||
    code === 0x00a0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
    code === 0x3000 || code === 0xfeff;
}

