import type { EthereumEndpointConfig } from "@smart-rpc/ethereum";

/** Official public Base mainnet JSON-RPC endpoint. */
export const BASE_RPC_URL = "https://mainnet.base.org";

/** Submission only. This URL must not be used as a general-purpose pool endpoint. */
export const BASE_SEQUENCER_URL = "https://mainnet-sequencer.base.org";

/** Documentation-backed endpoint configuration; absent limits are unverified. */
export interface BasePublicRpcEndpoint extends EthereumEndpointConfig {
  readonly id: string;
  readonly provider: string;
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
}

/**
 * The public endpoint has no documented numeric quota here. Supply `rps`/`burst`
 * for your own traffic policy; neither a provider quota nor an SLA is inferred.
 * Unverified optional capabilities stay disabled until explicitly configured.
 */
export const BASE_MAINNET_REGISTRY: readonly BasePublicRpcEndpoint[] = [
  {
    id: "base-mainnet",
    url: BASE_RPC_URL,
    provider: "Base",
    sourceUrls: ["https://docs.base.org/get-started/connect-to-base"],
    reviewedAt: "2026-11-06",
    capabilities: {
      batch: false,
      archive: false,
      debug: false,
      trace: false,
      subscriptions: false,
      pinning: false,
    },
  },
];

export const BASE_MAINNET_ENDPOINTS: readonly string[] = BASE_MAINNET_REGISTRY.map(({ url }) => url);
