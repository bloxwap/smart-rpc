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

const DRPC_UNSUPPORTED_METHODS: readonly string[] = [
  "eth_newFilter", "eth_newBlockFilter", "eth_newPendingTransactionFilter",
  "eth_getFilterChanges", "eth_getFilterLogs", "eth_uninstallFilter",
];

export interface AvalanchePublicRpcEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
  /** Exact documented WebSocket URL, never inferred by swapping a scheme. */
  readonly websocketUrl: string;
}

/**
 * Unknown numeric quotas are omitted; advanced capabilities require explicit verification.
 * `archive` is enabled only where repeated live probes (2026-11-08: block 1 plus five
 * spread historical blocks, on separate runs) returned historical state. The official
 * endpoint keeps only 8,192 ancestors; dRPC (free-plan timeouts) and PublicNode
 * (timeouts) did not reliably serve historical state.
 */
export const AVALANCHE_MAINNET_REGISTRY: readonly AvalanchePublicRpcEndpoint[] = [
  {
    id: "avalanche-public-c-chain",
    url: AVALANCHE_RPC_URL,
    websocketUrl: AVALANCHE_WS_URL,
    provider: "Avalanche",
    sourceUrls: ["https://build.avax.network/docs/rpcs/c-chain", "https://chainlist.org/chain/43114"],
    reviewedAt: "2026-11-08",
    supportedMethods: AVALANCHE_RPC_METHODS,
    unsupportedMethods: ["eth_getChainConfig", "eth_resend", "eth_sendTransaction", "eth_sign", "eth_signTransaction", "eth_accounts", "eth_coinbase", "eth_etherbase"],
    capabilities: {
      archive: false, blockTags: ["latest", "pending"], pinning: false,
      batch: false, debug: false, trace: false, subscriptions: false,
    },
  },
  {
    id: "avalanche-publicnode",
    url: "https://avalanche-c-chain-rpc.publicnode.com",
    websocketUrl: "wss://avalanche-c-chain-rpc.publicnode.com",
    provider: "Allnodes / PublicNode",
    sourceUrls: ["https://avalanche.publicnode.com/", "https://chainlist.org/chain/43114"],
    reviewedAt: "2026-11-08",
    supportedMethods: AVALANCHE_RPC_METHODS,
    capabilities: {
      archive: false, blockTags: ["latest", "pending"], pinning: false,
      batch: false, debug: false, trace: false, subscriptions: false,
    },
  },
  {
    id: "avalanche-drpc",
    url: "https://avalanche.drpc.org",
    websocketUrl: "wss://avalanche.drpc.org",
    provider: "dRPC",
    sourceUrls: ["https://drpc.org/chainlist/avalanche-mainnet-rpc", "https://chainlist.org/chain/43114"],
    reviewedAt: "2026-11-08",
    supportedMethods: AVALANCHE_RPC_METHODS.filter((method) => !DRPC_UNSUPPORTED_METHODS.includes(method)),
    unsupportedMethods: DRPC_UNSUPPORTED_METHODS,
    capabilities: {
      archive: false, blockTags: ["latest", "pending"], pinning: false,
      batch: false, debug: false, trace: false, subscriptions: false,
    },
  },
  {
    id: "avalanche-tenderly",
    url: "https://avalanche.gateway.tenderly.co",
    websocketUrl: "wss://avalanche.gateway.tenderly.co",
    provider: "Tenderly",
    sourceUrls: ["https://docs.tenderly.co/node-rpc/rpc-reference", "https://chainlist.org/chain/43114"],
    reviewedAt: "2026-11-08",
    supportedMethods: AVALANCHE_RPC_METHODS,
    capabilities: {
      archive: true, blockTags: ["latest", "pending"], pinning: false,
      batch: false, debug: false, trace: false, subscriptions: false,
    },
  },
];

export const AVALANCHE_MAINNET_ENDPOINTS = AVALANCHE_MAINNET_REGISTRY.map(({ url }) => url);
