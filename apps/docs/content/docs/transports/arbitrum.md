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

The first default is `https://arb1.arbitrum.io/rpc`. Each registry entry records its sources and review date. The official service has no published capacity guarantee, so the registry does not invent a numeric rate limit for it. Set `budget`, `operationBudget`, and per-endpoint budgets for your application's needs. See the [official chain information](https://docs.arbitrum.io/chain-info).

The public endpoint has no WebSocket or IPv6 support. `https://arb1-sequencer.arbitrum.io/rpc` only accepts raw and conditional transaction submissions. `wss://arb1-feed.arbitrum.io/feed` is a Nitro feed, not a JSON-RPC service. These latter two URLs are rejected in `arbitrum({ endpoints })`, because the shared pool requires an execution endpoint that can verify identity and answer health probes. Direct sequencer submission and feed consumption require separate clients. The general execution RPC remains available for normal transaction submission.

`eth_sendRawTransactionConditional` passes all supplied conditions through unchanged. It is never raced, cached, coalesced, or retried automatically; a caller must reconsider its state and time constraints before explicitly submitting again. Successful submission does not establish Ethereum finality. The transport makes no confirmation guarantee based on a transaction hash; see [Arbitrum's submission behavior notice](https://docs.arbitrum.io/notices/transaction-submission-changes-notice).

The default pool is the official RPC, PublicNode, dRPC, Pocket Network and Tenderly. Their capabilities were re-verified live on 2026-11-08:

- **Historical state:** routed only to Pocket and Tenderly, which served post-Nitro state. The official RPC is a full node, PublicNode returns 403 for anything older than roughly 60–100 blocks, and dRPC alternated between answers and "Unknown state". No public endpoint serves pre-Nitro (classic) state.
- **HTTP batching:** allowed when you enable `batch`: at most 3 items on dRPC (its documented limit) and 10 elsewhere. 10 is the largest size verified, not a published maximum.
- **Logs:** dRPC receives `eth_getLogs` spans of at most 100 blocks. PublicNode rejects logs without an `address`, and older ranges, and those calls fail over.
- **Budgets:** only Pocket publishes a keyless allowance (2,000 requests per IP per minute, set as `rps: 33`).
- Debug/trace, subscriptions and numeric pinning stay disabled. Only `latest` and `pending` are enabled as block tags: during review, providers reported different `safe` heads.

These settings express what this client enables, not a claim that a service lacks every disabled feature. Use a tested provider configuration to opt into other capabilities:

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

Blocks arrive every about 250ms (measured 2026-11-08: 0.26-0.30s), so the factory passes `blockTimeMs: 250` and the default `headLag.maxLag` is 4 blocks, about one second of staleness. An endpoint further behind does not lead, race or hedge `latest`, `pending` or other head reads while a fresh endpoint can serve them; it still serves block-number, block-hash, `safe`/`finalized` and transaction reads, and remains a failover. Pass `blockTimeMs` or `headLag: { maxLag }` to change it.

Run deterministic fixtures with `pnpm --filter @smart-rpc/arbitrum test`. Set `SMART_RPC_LIVE=1` to opt into the read-only public identity/head/precompile smoke test. Public availability is not a default CI dependency. Shared breaker, budget, cancellation, stale-head, batch-result and probe accounting policies remain in `@smart-rpc/core` and the canonical Ethereum adapter.
