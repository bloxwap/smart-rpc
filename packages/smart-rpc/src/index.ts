/**
 * Package root. Re-exports the core only.
 * Chain transports are subpaths (`@bloxwap/smart-rpc/ethereum`, `/hyperevm`, `/solana`).
 * This file must not import a transport, so a bundler includes a chain only when the app imports that subpath.
 */
export {
  AllEndpointsFailedError,
  BudgetExhaustedError,
  ChainMismatchError,
  TimeoutError,
  TransportClosedError,
  UnknownChainError,
  createPool,
  createSmartRpc,
  defaultScoreConfig,
  localStoragePersistence,
  type ChainPolicy,
  type EndpointSnapshot,
  type PoolOptions,
  type ScoreBook,
  type ScorePersistence,
  type ScoreSnapshot,
  type RpcEvent,
  type RpcPool,
  type RpcRequest,
  type SmartRpc,
  type SmartRpcTransport,
} from "@smart-rpc/core";
