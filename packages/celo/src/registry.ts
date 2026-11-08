import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const CELO_RPC_URL = "https://forno.celo.org";
export const CELO_WEBSOCKET_URL = "wss://forno.celo.org/ws";
export const CELO_SEPOLIA_RPC_URL = "https://forno.celo-sepolia.celo-testnet.org";
export const CELO_SEPOLIA_WEBSOCKET_URL = "wss://forno.celo-sepolia.celo-testnet.org/ws";

/** Public endpoint metadata; absent numeric limits are not provider guarantees. */
export interface CeloPublicRpcEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
  readonly websocketUrl: string;
}

const sources = [
  "https://docs.celo.org/learn/network/overview",
  "https://docs.celo.org/build/tools/nodes/forno",
] as const;

function publicRpc(
  id: string,
  provider: string,
  url: string,
  websocketUrl: string,
  sourceUrls: readonly string[],
): CeloPublicRpcEndpoint {
  return {
    id, url, websocketUrl, provider, sourceUrls,
    reviewedAt: "2026-11-07",
    capabilities: {
      archive: false,
      pinning: false,
      blockTags: ["latest", "pending"],
      batch: false,
      debug: false,
      trace: false,
      subscriptions: false,
    },
  };
}

function forno(
  id: string,
  url: string,
  websocketUrl: string,
  sourceUrls: readonly string[],
): CeloPublicRpcEndpoint {
  return {
    ...publicRpc(id, "cLabs Forno", url, websocketUrl, sourceUrls),
    // Forno does not hold signing keys. Submit locally signed transaction bytes.
    unsupportedMethods: ["eth_sendTransaction", "eth_sign", "eth_signTransaction"],
  };
}

function drpc(
  id: string,
  url: string,
  websocketUrl: string,
  sourceUrls: readonly string[],
): CeloPublicRpcEndpoint {
  return {
    ...publicRpc(id, "dRPC", url, websocketUrl, sourceUrls),
    unsupportedMethods: ["eth_newFilter", "eth_newBlockFilter", "eth_newPendingTransactionFilter", "eth_getFilterChanges", "eth_getFilterLogs", "eth_uninstallFilter"],
  };
}

/** Mainnet HTTP defaults. Undocumented numeric quotas are intentionally omitted. */
export const CELO_MAINNET_REGISTRY: readonly CeloPublicRpcEndpoint[] = [
  forno("celo-forno-mainnet", CELO_RPC_URL, CELO_WEBSOCKET_URL, [...sources, "https://chainlist.org/chain/42220"]),
  publicRpc("celo-publicnode-mainnet", "PublicNode", "https://celo-rpc.publicnode.com", "wss://celo-rpc.publicnode.com", ["https://celo.publicnode.com/", "https://chainlist.org/chain/42220"]),
  publicRpc("celo-ankr-mainnet", "Ankr", "https://rpc.ankr.com/celo", "wss://rpc.ankr.com/celo", ["https://www.ankr.com/docs/rpc-service/chains/chains-list/c-i/", "https://chainlist.org/chain/42220"]),
  drpc("celo-drpc-mainnet", "https://celo.drpc.org", "wss://celo.drpc.org", ["https://drpc.org/chainlist/celo-mainnet-rpc", "https://drpc.org/docs/howitworks/ratelimiting", "https://chainlist.org/chain/42220"]),
  publicRpc("celo-tenderly-mainnet", "Tenderly", "https://celo.gateway.tenderly.co", "wss://celo.gateway.tenderly.co", ["https://docs.tenderly.co/node-rpc/rpc-reference", "https://chainlist.org/chain/42220"]),
];
export const CELO_SEPOLIA_REGISTRY: readonly CeloPublicRpcEndpoint[] = [
  forno("celo-forno-sepolia", CELO_SEPOLIA_RPC_URL, CELO_SEPOLIA_WEBSOCKET_URL, [...sources, "https://chainlist.org/chain/11142220"]),
  publicRpc("celo-ankr-sepolia", "Ankr", "https://rpc.ankr.com/celo_sepolia", "wss://rpc.ankr.com/celo_sepolia", ["https://www.ankr.com/docs/rpc-service/chains/chains-list/c-i/", "https://chainlist.org/chain/11142220"]),
  drpc("celo-drpc-sepolia", "https://celo-sepolia.drpc.org", "wss://celo-sepolia.drpc.org", ["https://drpc.org/chainlist/celo-sepolia-rpc", "https://drpc.org/docs/howitworks/ratelimiting", "https://chainlist.org/chain/11142220"]),
  publicRpc("celo-tenderly-sepolia", "Tenderly", "https://celo-sepolia.gateway.tenderly.co", "wss://celo-sepolia.gateway.tenderly.co", ["https://docs.tenderly.co/node-rpc/rpc-reference", "https://chainlist.org/chain/11142220"]),
];
export const CELO_MAINNET_ENDPOINTS: readonly string[] = CELO_MAINNET_REGISTRY.map(({ url }) => url);
export const CELO_SEPOLIA_ENDPOINTS: readonly string[] = CELO_SEPOLIA_REGISTRY.map(({ url }) => url);
