import { describe, expect, test } from "vitest";

import type { EthereumSubscriptionOptions } from "@smart-rpc/ethereum";

import { subscribeAcceptedTransactions } from "../src/index.js";

describe("Avalanche accepted-transaction subscriptions", () => {
  test("omitting fullTransactions subscribes to hashes only and forwards both handlers", async () => {
    const seen: EthereumSubscriptionOptions[] = [];
    const data: unknown[] = [];
    const errors: unknown[] = [];
    const subscription = await subscribeAcceptedTransactions({
      async subscribe(options) {
        seen.push(options);
        return { subscriptionId: "0x7", async unsubscribe() { return { jsonrpc: "2.0", id: 2, result: true }; } };
      },
    }, { onData: (message) => data.push(message), onError: (error) => errors.push(error) });

    expect(subscription.subscriptionId).toBe("0x7");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.params).toEqual(["newAcceptedTransactions", false]);
    const notification = { jsonrpc: "2.0" as const, id: 1, result: "0xhash" };
    seen[0]?.onData(notification);
    const failure = new Error("socket closed");
    seen[0]?.onError?.(failure);
    expect(data).toEqual([notification]);
    expect(errors).toEqual([failure]);
  });
});
