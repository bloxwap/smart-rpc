/**
 * Umbrella entry. Re-exports `@smart-rpc/core` only.
 * Chain transports are subpaths (`smart-rpc/ethereum`, `smart-rpc/hyperevm`, `smart-rpc/solana`)
 * so a bundler does not pull a transport the caller did not import, and nothing auto-registers.
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
  type ChainPolicy,
  type EndpointSnapshot,
  type PoolOptions,
  type RpcEvent,
  type RpcPool,
  type RpcRequest,
  type SmartRpc,
  type SmartRpcTransport,
} from "@smart-rpc/core";
