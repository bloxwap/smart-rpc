import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const CELO_RPC_URL = "https://forno.celo.org";
export const CELO_WEBSOCKET_URL = "wss://forno.celo.org/ws";
export const CELO_SEPOLIA_RPC_URL = "https://forno.celo-sepolia.celo-testnet.org";
export const CELO_SEPOLIA_WEBSOCKET_URL = "wss://forno.celo-sepolia.celo-testnet.org/ws";

/** Forno's documented behavior; absent numeric limits are not provider guarantees. */
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

function forno(id: string, url: string, websocketUrl: string): CeloPublicRpcEndpoint {
  return {
    id, url, websocketUrl,
    provider: "cLabs Forno",
    sourceUrls: sources,
    reviewedAt: "2026-11-06",
    // Forno does not hold signing keys. Submit locally signed transaction bytes.
    unsupportedMethods: ["eth_sendTransaction", "eth_sign", "eth_signTransaction"],
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

/** Mainnet HTTP defaults. Forno is rate limited, without a documented numeric quota here. */
export const CELO_MAINNET_REGISTRY: readonly CeloPublicRpcEndpoint[] = [
  forno("celo-forno-mainnet", CELO_RPC_URL, CELO_WEBSOCKET_URL),
];
export const CELO_SEPOLIA_REGISTRY: readonly CeloPublicRpcEndpoint[] = [
  forno("celo-forno-sepolia", CELO_SEPOLIA_RPC_URL, CELO_SEPOLIA_WEBSOCKET_URL),
];
export const CELO_MAINNET_ENDPOINTS: readonly string[] = CELO_MAINNET_REGISTRY.map(({ url }) => url);
export const CELO_SEPOLIA_ENDPOINTS: readonly string[] = CELO_SEPOLIA_REGISTRY.map(({ url }) => url);
