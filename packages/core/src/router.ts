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
  /** Ordered per-item outcomes. Each pool shares its operation budget across its batch items. */
  requestBatch(requests: readonly (RpcRequest & { chainId: string })[]): Promise<PromiseSettledResult<unknown>[]>;
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
    async requestBatch(requests): Promise<PromiseSettledResult<unknown>[]> {
      const results: PromiseSettledResult<unknown>[] = new Array(requests.length);
      const groups = new Map<SmartRpcTransport, { request: RpcRequest; index: number }[]>();
      requests.forEach((request, index) => {
        const transport = byChain.get(request.chainId);
        if (!transport) { results[index] = { status: "rejected", reason: new UnknownChainError(request.chainId) }; return; }
        const group = groups.get(transport) ?? [];
        group.push({ request, index });
        groups.set(transport, group);
      });
      await Promise.all([...groups].map(async ([transport, entries]) => {
        try {
          const batch = entries.map(({ request }) => request);
          const outcomes = transport.requestBatch
            ? await transport.requestBatch(batch)
            : await Promise.allSettled(batch.map((request) => Promise.resolve().then(() => transport.request(request))));
          entries.forEach(({ index }, offset) => {
            results[index] = outcomes[offset] ?? { status: "rejected", reason: new Error("Transport omitted a batch result.") };
          });
        } catch (reason: unknown) {
          for (const { index } of entries) results[index] = { status: "rejected", reason };
        }
      }));
      return results;
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
