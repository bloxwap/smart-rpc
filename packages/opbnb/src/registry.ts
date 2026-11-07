import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

const networkDocs = "https://docs.bnbchain.org/bnb-opbnb/get-started/network-info/";

export interface OpBnbPublicRpcEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
  /** Provider-published URL, never derived from an arbitrary HTTP URL. */
  readonly websocketUrl?: string | undefined;
}

/** Unverified optional services require dedicated endpoint configuration. */
const conservativeCapabilities = {
  archive: false,
  batch: false,
  debug: false,
  trace: false,
  subscriptions: false,
  pinning: false,
  blockTags: ["latest", "pending"] as const,
};

/** Public HTTP defaults. No undocumented rate or batch limits are asserted. */
export const OPBNB_MAINNET_REGISTRY: readonly OpBnbPublicRpcEndpoint[] = [
  {
    id: "opbnb-bnbchain",
    url: "https://opbnb-mainnet-rpc.bnbchain.org",
    provider: "BNB Chain",
    sourceUrls: [networkDocs],
    reviewedAt: "2026-11-06",
    capabilities: { ...conservativeCapabilities },
  },
  {
    id: "opbnb-publicnode",
    url: "https://opbnb-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: [networkDocs, "https://opbnb.publicnode.com/"],
    reviewedAt: "2026-11-06",
    websocketUrl: "wss://opbnb-rpc.publicnode.com",
    capabilities: { ...conservativeCapabilities },
  },
];

export const OPBNB_MAINNET_ENDPOINTS: readonly string[] = OPBNB_MAINNET_REGISTRY.map(({ url }) => url);
export const OPBNB_MAINNET_WEBSOCKET_ENDPOINTS: readonly string[] = OPBNB_MAINNET_REGISTRY.flatMap(
  ({ websocketUrl }) => websocketUrl ? [websocketUrl] : [],
);
