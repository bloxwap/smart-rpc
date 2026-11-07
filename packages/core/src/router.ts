import { UnknownChainError } from "./errors.js";
import type { RpcRequest, SmartRpcTransport } from "./types.js";

export interface SmartRpc {
  /** CAIP-2 chain ids the registered transports serve. */
  readonly chainIds: readonly string[];
  /**
   * Send one JSON-RPC call. The chain id picks the transport.
   * A Solana id never reaches an EVM transport, and `eip155:999` reaches whichever transport registered it
   * (HyperEVM, when that package is passed).
   */
  request(request: RpcRequest & { chainId: string }): Promise<unknown>;
  /** Close every registered transport once. */
  close(): void;
}

/**
 * Route by explicit CAIP-2 chain id. Transports are not imported or registered for you:
 * pass the ones this process should call.
 */
export function createSmartRpc(options: { transports: readonly SmartRpcTransport[] }): SmartRpc {
  const byChain = new Map<string, SmartRpcTransport>();
  for (const transport of options.transports) {
    for (const chainId of transport.chainIds) {
      if (byChain.has(chainId)) {
        throw new Error(`createSmartRpc() chain id ${chainId} is registered more than once.`);
      }
      byChain.set(chainId, transport);
    }
  }
  return {
    chainIds: [...byChain.keys()],
    async request(request: RpcRequest & { chainId: string }): Promise<unknown> {
      const transport = byChain.get(request.chainId);
      if (!transport) throw new UnknownChainError(request.chainId);
      return transport.request(request);
    },
    close(): void {
      const seen = new Set<SmartRpcTransport>();
      for (const transport of byChain.values()) {
        if (seen.has(transport)) continue;
        seen.add(transport);
        transport.close?.();
      }
    },
  };
}
