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
 * Provider limits that some nodes report as invalid params (`-32602`).
 * Another endpoint may have a larger limit, so these fail over.
 */
const PROVIDER_LIMIT_MESSAGE =
  /(?:max(?:imum)?|exceed\w*|too (?:large|wide|big|many)|limit\w*)[^.\n]*block range|block range[^.\n]*(?:too|exceed\w*|limit\w*|max)|ranges? over \d|too many (?:results|logs|blocks)|more than \d[\d,]* (?:results|logs|blocks)|response size|size (?:limit|exceeded)|limit exceeded|limited to|query timeout|query timed out/i;

/**
 * A node that has not reached the block a call names. Another endpoint may hold it.
 * The endpoint is not treated as sick.
 */
const BLOCK_NOT_HELD_MESSAGE =
  /header not found|unknown block|invalid block range|block range extends beyond|beyond (?:the )?(?:current )?head/i;

/** JSON-RPC invalid params. */
const INVALID_PARAMS_CODE = -32602;

/** True when the method is safe to send again to a different endpoint. */
export function isIdempotentMethod(method: string, extra: readonly string[] = []): boolean {
  if (DEFAULT_NON_IDEMPOTENT.has(method)) return false;
  return SAFE.has(method) && !extra.includes(method);
}

function errorText(error: Error): string {
  const details = "details" in error && typeof error.details === "string" ? error.details : "";
  return `${error.message}\n${details}`;
}

function errorCode(error: Error): number | undefined {
  if ("code" in error && typeof error.code === "number") return error.code;
  return undefined;
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
 */
export function shouldFailover(error: Error): boolean {
  if (isAbortError(error)) return false;
  const text = errorText(error);
  if (TERMINAL_MESSAGE.test(text)) return false;
  if (REJECTED_TRANSACTION_MESSAGE.test(text)) return false;
  if (BLOCK_NOT_HELD_MESSAGE.test(text)) return true;
  const code = errorCode(error);
  if (code === INVALID_PARAMS_CODE && PROVIDER_LIMIT_MESSAGE.test(text)) return true;
  if (code !== undefined && TERMINAL_CODES.has(code)) return false;
  return true;
}

