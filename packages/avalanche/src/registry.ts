import { NON_IDEMPOTENT_METHODS, SAFE_EVM_METHODS } from "@smart-rpc/core";
import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const AVALANCHE_RPC_URL = "https://api.avax.network/ext/bc/C/rpc";
export const AVALANCHE_WS_URL = "wss://api.avax.network/ext/bc/C/ws";

/** Read-only C-Chain extensions; provider availability is independent of method safety. */
export const AVALANCHE_READ_METHODS = ["eth_baseFee", "eth_suggestPriceOptions", "eth_getChainConfig"] as const;

/** Standard execution methods plus the explicitly documented Avalanche extensions. */
export const AVALANCHE_RPC_METHODS: readonly string[] = [...new Set([
  ...SAFE_EVM_METHODS, ...NON_IDEMPOTENT_METHODS.filter((method) => method.startsWith("eth_")), ...AVALANCHE_READ_METHODS,
  "eth_pendingTransactions", "eth_getHeaderByHash", "eth_getHeaderByNumber",
])];

export interface AvalanchePublicRpcEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
  /** Exact documented WebSocket URL, never inferred by swapping a scheme. */
  readonly websocketUrl: string;
}

/** Unknown numeric quotas are omitted; advanced capabilities require explicit verification. */
export const AVALANCHE_MAINNET_REGISTRY: readonly AvalanchePublicRpcEndpoint[] = [{
  id: "avalanche-public-c-chain",
  url: AVALANCHE_RPC_URL,
  websocketUrl: AVALANCHE_WS_URL,
  provider: "Avalanche",
  sourceUrls: ["https://build.avax.network/docs/rpcs/c-chain"],
  reviewedAt: "2026-11-06",
  supportedMethods: AVALANCHE_RPC_METHODS,
  unsupportedMethods: ["eth_getChainConfig", "eth_resend", "eth_sendTransaction", "eth_sign", "eth_signTransaction", "eth_accounts", "eth_coinbase", "eth_etherbase"],
  capabilities: {
    archive: false, blockTags: ["latest", "pending"], pinning: false,
    batch: false, debug: false, trace: false, subscriptions: false,
  },
}];

export const AVALANCHE_MAINNET_ENDPOINTS = AVALANCHE_MAINNET_REGISTRY.map(({ url }) => url);
