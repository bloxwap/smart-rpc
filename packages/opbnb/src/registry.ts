import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

const chainList = "https://chainlist.org/chain/204";
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
    sourceUrls: [networkDocs, chainList],
    reviewedAt: "2026-11-07",
    capabilities: { ...conservativeCapabilities },
  },
  {
    id: "opbnb-publicnode",
    url: "https://opbnb-rpc.publicnode.com",
    provider: "PublicNode",
    sourceUrls: [networkDocs, chainList, "https://opbnb.publicnode.com/"],
    reviewedAt: "2026-11-07",
    websocketUrl: "wss://opbnb-rpc.publicnode.com",
    capabilities: { ...conservativeCapabilities },
  },
  {
    id: "opbnb-drpc",
    url: "https://opbnb.drpc.org",
    provider: "dRPC",
    sourceUrls: [networkDocs, chainList, "https://drpc.org/chainlist/opbnb"],
    reviewedAt: "2026-11-07",
    unsupportedMethods: [
      "eth_newFilter",
      "eth_newBlockFilter",
      "eth_newPendingTransactionFilter",
      "eth_getFilterChanges",
      "eth_getFilterLogs",
      "eth_uninstallFilter",
    ],
    capabilities: { ...conservativeCapabilities },
  },
  {
    id: "opbnb-thirdweb",
    url: "https://204.rpc.thirdweb.com",
    provider: "thirdweb",
    sourceUrls: [networkDocs, chainList, "https://thirdweb.com/opbnb"],
    reviewedAt: "2026-11-07",
    capabilities: { ...conservativeCapabilities },
  },
  {
    id: "opbnb-pocket",
    url: "https://opbnb.api.pocket.network",
    provider: "Pocket Network",
    sourceUrls: [networkDocs, chainList, "https://api.pocket.network/"],
    reviewedAt: "2026-11-07",
    capabilities: { ...conservativeCapabilities },
  },
];

export const OPBNB_MAINNET_ENDPOINTS: readonly string[] = OPBNB_MAINNET_REGISTRY.map(({ url }) => url);
export const OPBNB_MAINNET_WEBSOCKET_ENDPOINTS: readonly string[] = OPBNB_MAINNET_REGISTRY.flatMap(
  ({ websocketUrl }) => websocketUrl ? [websocketUrl] : [],
);
