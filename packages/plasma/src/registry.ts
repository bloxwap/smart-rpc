import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

export const PLASMA_RPC_URL = "https://rpc.plasma.to";

/** Public metadata, with no inference of stablecoin fee payment or sponsored transactions. */
export const PLASMA_MAINNET = {
  id: 9745,
  caip2: "eip155:9745",
  name: "Plasma Mainnet Beta",
  nativeCurrency: { name: "Plasma", symbol: "XPL", decimals: 18 },
  blockTime: 1_000,
  blockExplorer: "https://plasmascan.to",
} as const;

export interface PlasmaRpcEndpoint extends EthereumEndpointConfig {
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
}

/**
 * Public HTTPS endpoint documented by Plasma. Advanced features stay disabled until
 * the caller supplies verified provider capabilities. No numeric public rate or batch
 * ceiling is documented, so this registry does not invent one.
 */
export const PLASMA_MAINNET_REGISTRY = [
  {
    url: PLASMA_RPC_URL,
    provider: "Plasma",
    sourceUrls: [
      "https://docs.plasma.org/docs/guides/network-configuration/mainnet-details",
      "https://www.plasma.org/docs/plasma-chain/tools/rpc-providers",
    ],
    reviewedAt: "2026-11-06",
    capabilities: {
      archive: false,
      pinning: false,
      batch: false,
      subscriptions: false,
      debug: false,
      trace: false,
      blockTags: ["latest", "pending"],
    },
  },
] as const satisfies readonly PlasmaRpcEndpoint[];

export const PLASMA_MAINNET_ENDPOINTS: readonly string[] = PLASMA_MAINNET_REGISTRY.map(({ url }) => url);
