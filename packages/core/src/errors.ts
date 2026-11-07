/** Thrown when every attempted endpoint failed. The last error is `cause`. */
export class AllEndpointsFailedError extends Error {
  readonly errors: readonly Error[];

  constructor(errors: readonly Error[]) {
    const last = errors.at(-1);
    super("All RPC endpoints failed.", last ? { cause: last } : undefined);
    this.name = "AllEndpointsFailedError";
    this.errors = errors;
  }
}

/** Thrown when one endpoint exceeds its deadline. Failover may try another endpoint. */
export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`RPC request timed out after ${timeoutMs}ms.`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when an endpoint reports another chain identity.
 * EVM transports compare `eth_chainId`. Solana compares `getGenesisHash`.
 */
export class ChainMismatchError extends Error {
  readonly endpoint: string;
  readonly expected: unknown;
  readonly reported: unknown;

  constructor(endpoint: string, expected: unknown, reported: unknown) {
    super(`${endpoint} reported chain identity ${String(reported)}, expected ${String(expected)}.`);
    this.name = "ChainMismatchError";
    this.endpoint = endpoint;
    this.expected = expected;
    this.reported = reported;
  }
}

/**
 * Thrown when every endpoint that could serve a call is out of request budget, and the next token comes later
 * than the call may wait. Nothing was sent past the budget.
 */
export class BudgetExhaustedError extends Error {
  readonly endpoints: readonly string[];
  readonly refillMs: number;

  constructor(endpoints: readonly string[], refillMs: number) {
    super(`RPC request budget exhausted. Next token in ${refillMs}ms.`);
    this.name = "BudgetExhaustedError";
    this.endpoints = endpoints;
    this.refillMs = refillMs;
  }
}

/** Thrown by `request()` after `close()`. */
export class TransportClosedError extends Error {
  constructor() {
    super("RPC transport is closed.");
    this.name = "TransportClosedError";
  }
}

/** Thrown when `createSmartRpc` has no transport registered for a CAIP-2 chain id. */
export class UnknownChainError extends Error {
  readonly chainId: string;

  constructor(chainId: string) {
    super(`No smart-rpc transport is registered for chain ${chainId}.`);
    this.name = "UnknownChainError";
    this.chainId = chainId;
  }
}

/** The total operation ceiling was reached before another upstream call could start. */
export class OperationBudgetExceededError extends Error {
  constructor(readonly maxRequests: number) {
    super(`RPC operation exhausted its ${maxRequests} upstream request budget.`);
    this.name = "OperationBudgetExceededError";
  }
}

/** No endpoint can serve the requested method and state. */
export class EndpointCapabilityError extends Error {
  constructor(readonly method: string) {
    super(`No RPC endpoint supports the requested ${method} operation.`);
    this.name = "EndpointCapabilityError";
  }
}
