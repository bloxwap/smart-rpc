/**
 * HyperEVM transport.
 *
 * A factory around {@link ethereum} with HyperEVM defaults: chain `eip155:999` and
 * `eip155:998`, source-backed public endpoint registries, HyperCore precompile pin-skip, and
 * the official RPC's 1.5 rps / burst 3 budget from smart-hyperevm at 092b8f9.
 * @module
 */

import {
  UnknownChainError,
  type RpcEvent,
  type RpcPool,
  type RpcRequest,
  type SmartRpcTransport,
} from "@smart-rpc/core";
import {
  ethereum,
  type EthereumEndpoint,
  type EthereumOptions,
} from "@smart-rpc/ethereum";

import {
  HYPEREVM_MAINNET_REGISTRY,
  HYPEREVM_OFFICIAL_CAPABILITIES,
  HYPEREVM_RPC_URL,
  HYPEREVM_TESTNET_REGISTRY,
  HYPEREVM_TESTNET_RPC_URL,
} from "./registry.js";

export { HYPEREVM_RPC_URL, HYPEREVM_TESTNET_RPC_URL } from "./registry.js";

/** Native gas balances use HYPE with 18 decimals on both networks. */
export const HYPEREVM_NATIVE_CURRENCY = { name: "HYPE", symbol: "HYPE", decimals: 18 } as const;

/** Read-only HyperEVM extensions; their parameters and result fields pass through unchanged. */
export const HYPEREVM_SAFE_METHODS: readonly string[] = [
  "eth_bigBlockGasPrice",
  "eth_usingBigBlocks",
  "eth_getSystemTxsByBlockHash",
  "eth_getSystemTxsByBlockNumber",
];

/** HyperEVM mainnet chain id. */
export const HYPEREVM_CHAIN_ID = 999;

/** HyperEVM testnet chain id. */
export const HYPEREVM_TESTNET_CHAIN_ID = 998;

/** CAIP-2 id for HyperEVM mainnet. */
export const HYPEREVM_MAINNET_CAIP = "eip155:999";

/** CAIP-2 id for HyperEVM testnet. */
export const HYPEREVM_TESTNET_CAIP = "eip155:998";

export interface HyperEvmOptions
  extends Omit<EthereumOptions, "chainId" | "chainIds" | "endpoints" | "skipPrecompiles"> {
  /**
   * One HyperEVM chain. Omit to serve both `eip155:999` and `eip155:998`.
   */
  chainId?: 999 | 998 | undefined;
  /** Replace public defaults for the selected chain, or mainnet when both chains are served. */
  endpoints?: readonly EthereumEndpoint[] | undefined;
  /** Replace public testnet defaults for `eip155:998` when both chains are served. */
  testnetEndpoints?: readonly EthereumEndpoint[] | undefined;
  /** Skip HyperCore read precompiles when pinning `eth_call`. Default: true. */
  skipPrecompiles?: boolean | undefined;
}

/** Dual-network transport. A batch must explicitly name one network for its shared operation budget. */
export interface HyperEvmTransport extends SmartRpcTransport {
  requestBatch(requests: readonly RpcRequest[]): Promise<PromiseSettledResult<unknown>[]>;
}

/** A selected HyperEVM network also exposes batch requests and pool statistics. */
export function hyperevm(options: HyperEvmOptions & { chainId: 999 | 998 }): RpcPool;
/** HyperEVM transport for `createSmartRpc({ transports })`. */
export function hyperevm(options?: HyperEvmOptions): HyperEvmTransport;
export function hyperevm(options: HyperEvmOptions = {}): HyperEvmTransport {
  const chains: readonly (999 | 998)[] = options.chainId === undefined ? [999, 998] : [options.chainId];
  const pools = chains.map((chainId) =>
    ethereum({
      ...shared(options),
      chainId,
      chainIds: [`eip155:${chainId}`],
      endpoints: endpointsFor(options, chainId),
      skipPrecompiles: options.skipPrecompiles ?? true,
      safeMethods: [...HYPEREVM_SAFE_METHODS, ...(options.safeMethods ?? [])],
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
  const configured = chainId === 998 && options.chainId === undefined
    ? options.testnetEndpoints
    : options.endpoints;
  if (configured !== undefined) return configured.map((endpoint) => tagOfficial(endpoint));
  const registry = chainId === 999 ? HYPEREVM_MAINNET_REGISTRY : HYPEREVM_TESTNET_REGISTRY;
  return registry.map(({ url, rps, burst, unsupportedMethods, capabilities }) => ({
    url, rps, burst, unsupportedMethods, capabilities,
  }));
}

/** Keep documented official restrictions and the reference budget for both networks. */
function tagOfficial(endpoint: EthereumEndpoint): EthereumEndpoint {
  const config = typeof endpoint === "string" ? { url: endpoint } : endpoint;
  if (config.url !== HYPEREVM_RPC_URL && config.url !== HYPEREVM_TESTNET_RPC_URL) return endpoint;
  return {
    ...config,
    ...(config.rps === undefined && config.burst === undefined ? { rps: 1.5, burst: 3 } : {}),
    capabilities: { ...HYPEREVM_OFFICIAL_CAPABILITIES, ...config.capabilities },
  };
}

function combine(transports: readonly RpcPool[]): HyperEvmTransport {
  const byChain = new Map<string, RpcPool>();
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
    async requestBatch(requests): Promise<PromiseSettledResult<unknown>[]> {
      if (requests.length === 0) return [];
      const chainId = requests[0]?.chainId;
      if (!chainId) throw new UnknownChainError("");
      if (requests.some((request) => request.chainId !== chainId)) {
        throw new Error("HyperEVM batch requests must explicitly name one chain; use separate batches for mainnet and testnet.");
      }
      const transport = byChain.get(chainId);
      if (!transport) throw new UnknownChainError(chainId);
      return transport.requestBatch(requests);
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
