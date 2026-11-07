import type { RpcPool } from "@smart-rpc/core";
import { ethereum, type EthereumEndpoint, type EthereumOptions } from "@smart-rpc/ethereum";

import { ROBINHOOD_CHAIN_ID, ROBINHOOD_MAINNET_CAIP, ROBINHOOD_MAINNET_REGISTRY, ROBINHOOD_RPC_URL } from "./registry.js";

export interface RobinhoodOptions extends Omit<EthereumOptions, "chainId" | "chainIds"> {}

/** Robinhood mainnet, with shared EVM routing, identity quarantine, retries and budgets. */
export function robinhood(options: RobinhoodOptions = {}): RpcPool {
  return ethereum({
    ...options,
    chainId: ROBINHOOD_CHAIN_ID,
    chainIds: [ROBINHOOD_MAINNET_CAIP],
    endpoints: (options.endpoints ?? ROBINHOOD_MAINNET_REGISTRY).map(configureEndpoint),
  });
}

function configureEndpoint(endpoint: EthereumEndpoint): EthereumEndpoint {
  const config = typeof endpoint === "string" ? { url: endpoint } : endpoint;
  const parsed = new URL(config.url);
  if (/^(?:sequencer|feed|delayed-feed)\.(?:mainnet|testnet)\.chain\.robinhood\.com$/.test(parsed.hostname)) {
    throw new Error("Robinhood sequencer and feed URLs are not general JSON-RPC endpoints. Use a full RPC provider.");
  }
  if (parsed.origin === ROBINHOOD_RPC_URL && (parsed.pathname === "/" || parsed.pathname === "")) {
    const defaults = ROBINHOOD_MAINNET_REGISTRY[0];
    return { ...defaults, ...config, capabilities: { ...defaults.capabilities, ...config.capabilities } };
  }
  return config;
}
