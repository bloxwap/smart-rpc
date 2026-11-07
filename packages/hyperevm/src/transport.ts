/**
 * HyperEVM transport.
 *
 * A factory around {@link ethereum} with HyperEVM defaults: chain `eip155:999` and
 * `eip155:998`, `https://rpc.hyperliquid.xyz/evm`, HyperCore precompile pin-skip, and
 * the official RPC's 1.5 rps / burst 3 budget from smart-hyperevm at 092b8f9.
 * @module
 */

import {
  UnknownChainError,
  type RpcEvent,
  type SmartRpcTransport,
} from "@smart-rpc/core";
import {
  ethereum,
  type EthereumEndpoint,
  type EthereumOptions,
} from "@smart-rpc/ethereum";

/** HyperEVM mainnet chain id. */
export const HYPEREVM_CHAIN_ID = 999;

/** HyperEVM testnet chain id. */
export const HYPEREVM_TESTNET_CHAIN_ID = 998;

/** CAIP-2 id for HyperEVM mainnet. */
export const HYPEREVM_MAINNET_CAIP = "eip155:999";

/** CAIP-2 id for HyperEVM testnet. */
export const HYPEREVM_TESTNET_CAIP = "eip155:998";

/** Official HyperEVM HTTP RPC. The reference keeps this under the per-IP limit at 1.5 rps, burst 3. */
export const HYPEREVM_RPC_URL = "https://rpc.hyperliquid.xyz/evm";

/** Official HyperEVM testnet HTTP RPC. */
export const HYPEREVM_TESTNET_RPC_URL = "https://rpc.hyperliquid-testnet.xyz/evm";

export interface HyperEvmOptions
  extends Omit<EthereumOptions, "chainId" | "chainIds" | "endpoints" | "skipPrecompiles"> {
  /**
   * One HyperEVM chain. Omit to serve both `eip155:999` and `eip155:998`.
   */
  chainId?: 999 | 998 | undefined;
  /** Endpoints for the selected chain, or for mainnet when both chains are served. */
  endpoints?: readonly EthereumEndpoint[] | undefined;
  /** Endpoints for `eip155:998` when both chains are served. */
  testnetEndpoints?: readonly EthereumEndpoint[] | undefined;
  /** Skip HyperCore read precompiles when pinning `eth_call`. Default: true. */
  skipPrecompiles?: boolean | undefined;
}

/** HyperEVM transport for `createSmartRpc({ transports })`. */
export function hyperevm(options: HyperEvmOptions = {}): SmartRpcTransport {
  const chains: readonly (999 | 998)[] = options.chainId === undefined ? [999, 998] : [options.chainId];
  const pools = chains.map((chainId) =>
    ethereum({
      ...shared(options),
      chainId,
      chainIds: [`eip155:${chainId}`],
      endpoints: endpointsFor(options, chainId),
      skipPrecompiles: options.skipPrecompiles ?? true,
    }),
  );
  const first = pools[0];
  if (!first) throw new Error("hyperevm() requires a chain.");
  if (pools.length === 1) return first;
  return combine(pools);
}

function shared(options: HyperEvmOptions): Omit<EthereumOptions, "chainId" | "chainIds" | "endpoints" | "skipPrecompiles"> {
  const { chainId: _chain, endpoints: _endpoints, testnetEndpoints: _testnet, skipPrecompiles: _skip, ...rest } = options;
  void _chain;
  void _endpoints;
  void _testnet;
  void _skip;
  return rest;
}

function endpointsFor(options: HyperEvmOptions, chainId: 999 | 998): readonly EthereumEndpoint[] {
  if (chainId === 998 && options.chainId === undefined) {
    return (options.testnetEndpoints ?? [HYPEREVM_TESTNET_RPC_URL]).map((endpoint) => tagOfficial(endpoint));
  }
  const configured = options.endpoints ?? (chainId === 999 ? [HYPEREVM_RPC_URL] : [HYPEREVM_TESTNET_RPC_URL]);
  return configured.map((endpoint) => tagOfficial(endpoint));
}

/** The official mainnet RPC keeps the reference per-IP budget unless the caller set one. */
function tagOfficial(endpoint: EthereumEndpoint): EthereumEndpoint {
  if (typeof endpoint === "string") {
    return endpoint === HYPEREVM_RPC_URL ? { url: endpoint, rps: 1.5, burst: 3 } : endpoint;
  }
  if (endpoint.url === HYPEREVM_RPC_URL && endpoint.rps === undefined && endpoint.burst === undefined) {
    return { ...endpoint, rps: 1.5, burst: 3 };
  }
  return endpoint;
}

function combine(transports: readonly SmartRpcTransport[]): SmartRpcTransport {
  const byChain = new Map<string, SmartRpcTransport>();
  for (const transport of transports) {
    for (const chainId of transport.chainIds) byChain.set(chainId, transport);
  }
  return {
    chainIds: [...byChain.keys()],
    request(request) {
      const transport = request.chainId ? byChain.get(request.chainId) : undefined;
      if (!transport) throw new UnknownChainError(request.chainId ?? "");
      return transport.request(request);
    },
    probe(): Promise<void> {
      return Promise.all(transports.map((transport) => transport.probe?.() ?? Promise.resolve())).then(() => undefined);
    },
    close(): void {
      for (const transport of transports) transport.close?.();
    },
    snapshot(method) {
      return transports.flatMap((transport) => transport.snapshot?.(method) ?? []);
    },
    onEvent(listener: (event: RpcEvent) => void): () => void {
      const stops = transports.flatMap((transport) => {
        const stop = transport.onEvent?.(listener);
        return stop ? [stop] : [];
      });
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}
