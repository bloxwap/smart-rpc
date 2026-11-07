export {
  HYPEREVM_CHAIN_ID,
  HYPEREVM_MAINNET_CAIP,
  HYPEREVM_NATIVE_CURRENCY,
  HYPEREVM_SAFE_METHODS,
  HYPEREVM_RPC_URL,
  HYPEREVM_TESTNET_CAIP,
  HYPEREVM_TESTNET_CHAIN_ID,
  HYPEREVM_TESTNET_RPC_URL,
  hyperevm,
  type HyperEvmOptions,
  type HyperEvmTransport,
} from "./transport.js";
export {
  HYPEREVM_MAINNET_ENDPOINTS,
  HYPEREVM_MAINNET_REGISTRY,
  HYPEREVM_OFFICIAL_CAPABILITIES,
  type HyperEvmPublicEndpoint,
  HYPEREVM_TESTNET_ENDPOINTS,
  HYPEREVM_TESTNET_REGISTRY,
} from "./registry.js";

export { requestLogs, type LogRangeOptions } from "@smart-rpc/ethereum";
