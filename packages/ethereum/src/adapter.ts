import { createPoolScope, type RpcPool } from "@smart-rpc/core";
import { createTransport, type EIP1193RequestFn, type Transport } from "viem";

import { ethereum, type EthereumOptions } from "./transport.js";

/**
 * Adapt Ethereum-compatible pools to viem. One adapter shares equivalent client pools;
 * different timeouts or retry counts use separate pools with the same chain's budgets.
 */
export function asViemTransport(options: EthereumOptions = {}): Transport<"smartRpc", RpcPool> {
  const scope = createPoolScope();
  return (parameters) => {
    if (options.chainId !== undefined && parameters.chain !== undefined && options.chainId !== parameters.chain.id) {
      throw new Error(`asViemTransport() chain ${parameters.chain.id} does not match configured chain ${options.chainId}.`);
    }
    const chainId = options.chainId ?? parameters.chain?.id ?? 1;
    const timeout = options.timeout ?? parameters.timeout ?? 10_000;
    const retryCount = options.retryCount ?? parameters.retryCount ?? 2;
    const key = JSON.stringify([chainId, timeout, retryCount]);
    const budgetKey = JSON.stringify([chainId]);
    const pool = ethereum({
      ...options,
      chainId,
      timeout,
      retryCount,
      sharing: { scope, key, budgetKey },
    });
    return createTransport({
      key: "smartRpc",
      name: "Smart RPC",
      retryCount: 0,
      retryDelay: options.retryDelay ?? 0,
      timeout,
      type: "smartRpc",
      request: (async ({ method, params }, requestOptions) => pool.request({
        method,
        params,
        signal: requestOptions?.signal,
      })) as EIP1193RequestFn,
    }, pool);
  };
}
