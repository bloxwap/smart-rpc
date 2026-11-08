---
title: Arbitrum One
---

# Arbitrum One

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { arbitrum } from "@bloxwap/smart-rpc/arbitrum";

const rpc = createSmartRpc({ transports: [arbitrum()] });
await rpc.request({ chainId: "eip155:42161", method: "eth_blockNumber" });
```

The factory fixes Arbitrum One's identity to `42161` and uses ETH with 18 decimals. Every admitted endpoint must answer `eth_chainId` correctly before receiving a user call. Other Arbitrum chains, including Nova and Sepolia, are distinct identities and are not registered by this factory.

The default is `https://arb1.arbitrum.io/rpc`. Its registry records the official source and review date. The public service has no published capacity guarantee, so the registry does not invent a numeric rate or batch limit. Set `budget`, `operationBudget`, and per-endpoint budgets for your application's needs. See the [official chain information](https://docs.arbitrum.io/chain-info).

The public endpoint has no WebSocket or IPv6 support. `https://arb1-sequencer.arbitrum.io/rpc` only accepts raw and conditional transaction submissions. `wss://arb1-feed.arbitrum.io/feed` is a Nitro feed, not a JSON-RPC service. These latter two URLs are rejected in `arbitrum({ endpoints })`, because the shared pool requires an execution endpoint that can verify identity and answer health probes. Direct sequencer submission and feed consumption require separate clients. The general execution RPC remains available for normal transaction submission.

`eth_sendRawTransactionConditional` passes all supplied conditions through unchanged. It is never raced, cached, coalesced, or retried automatically; a caller must reconsider its state and time constraints before explicitly submitting again. Successful submission does not establish Ethereum finality. The transport makes no confirmation guarantee based on a transaction hash; see [Arbitrum's submission behavior notice](https://docs.arbitrum.io/notices/transaction-submission-changes-notice).

The default capability table disables unverified HTTP batching, historical state, debug/trace, subscriptions and numeric pinning. Only `latest` and `pending` are enabled as block tags by default. These conservative settings express what this client enables, not a claim that the public service lacks every disabled feature. Use a tested provider configuration to opt into other capabilities:

```ts
arbitrum({
  endpoints: [{
    url: process.env.ARBITRUM_RPC_URL!,
    headers: { Authorization: `Bearer ${process.env.ARBITRUM_RPC_TOKEN!}` },
    capabilities: {
      archive: true,
      pinning: true,
      blockTags: ["latest", "pending", "safe", "finalized", "earliest"],
      debug: false,
      trace: false,
      subscriptions: false,
      batch: false,
    },
  }],
});
```

`safe` and `finalized` retain their requested meaning; neither is silently changed to `latest`. Sequenced heads are not a count of Ethereum confirmations. See [Arbitrum finality guidance](https://docs.arbitrum.io/build-decentralized-apps/troubleshooting-building).

RPC results and transaction parameters remain unmodified wire values. `ArbitrumReceiptFields` describes `l1BlockNumber` and `gasUsedForL1`; the latter is the parent-chain cost expressed in child-chain gas units. `ArbitrumBlockFields` describes Nitro's additional block fields. `ARBITRUM_PRECOMPILES` exports ArbSys, ArbGasInfo, ArbWasm and NodeInterface addresses. Fixtures cover ArbSys block numbers, six-word ArbGasInfo prices and separate NodeInterface L1/L2 gas estimate components. No Ethereum fee calculation replaces those values. See the [RPC field reference](https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/rpc-methods), [precompile reference](https://docs.arbitrum.io/arbitrum-essentials/precompiles/reference), and [gas estimation guide](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas). Archive and Stylus traces require provider capability configuration.

Run deterministic fixtures with `pnpm --filter @smart-rpc/arbitrum test`. Set `SMART_RPC_LIVE=1` to opt into the read-only public identity/head/precompile smoke test. Public availability is not a default CI dependency. Shared breaker, budget, cancellation, stale-head, batch-result and probe accounting policies remain in `@smart-rpc/core` and the canonical Ethereum adapter.
