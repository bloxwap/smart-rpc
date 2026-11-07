import type { EthereumSubscription, EthereumSubscriptionOptions, ViemConnection } from "@smart-rpc/ethereum";

export interface AcceptedTransactionsOptions {
  /** False receives transaction hashes; true receives the transaction objects. */
  fullTransactions?: boolean | undefined;
  onData: EthereumSubscriptionOptions["onData"];
  onError?: EthereumSubscriptionOptions["onError"];
}

/**
 * Acceptance notifications precede execution and are not receipts.
 * Pass an identity-verified dedicated connection created with expectedChainId: 43114.
 * viem keeps the subscription attached to that connection and owns reconnection.
 */
export function subscribeAcceptedTransactions(
  connection: Pick<ViemConnection, "subscribe">,
  options: AcceptedTransactionsOptions,
): Promise<EthereumSubscription> {
  const args = {
    onData: options.onData,
    onError: options.onError,
    // viem's subscription types list canonical Ethereum events only. This
    // documented Avalanche extension uses the same eth_subscribe wire format.
    params: ["newAcceptedTransactions", options.fullTransactions ?? false],
  };
  return connection.subscribe(args as unknown as EthereumSubscriptionOptions);
}
