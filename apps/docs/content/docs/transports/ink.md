---
title: Ink
---

# Ink

`ink()` serves Ink mainnet (`eip155:57073`) with native ETH (18 decimals). It composes the Ethereum adapter and core pool, so routing, retries, cancellation, budgets, caches, and identity quarantine use the same implementation as other EVM transports.

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { ink } from "@bloxwap/smart-rpc/ink";

const rpc = createSmartRpc({ transports: [ink()] });
await rpc.request({ chainId: "eip155:57073", method: "eth_blockNumber" });
```

The first defaults are `https://rpc-gel.inkonchain.com` and `https://rpc-qnd.inkonchain.com`, from the [Ink network information](https://docs.inkonchain.com/general/network-information). `INK_MAINNET_REGISTRY` records provider sources and documented WebSocket alternatives. The [RPC guide](https://docs.inkonchain.com/tools/rpc) gives Gelato's WS URL as `wss://ws-gel.inkonchain.com`, while the network table gives `wss://rpc-gel.inkonchain.com`; both are recorded, and neither is silently substituted for HTTP.

The default pool is Gelato, QuickNode and Tenderly (the three `*.inkonchain.com` hosts), PublicNode and Pocket Network. dRPC was replaced by Pocket on 2026-11-08: its keyless Ink reads ran about 350 ms at the median and returned HTTP 500 "Temporary internal error" on about 17% of plain reads and about 40% of `eth_getLogs` calls.

Capabilities were re-verified live on 2026-11-08. Every default served historical state back to genesis, so numeric-block state reads may use any of them. HTTP batching is allowed when you enable `batch`, at most 10 items per request. That is the largest size verified (Tenderly answered 20 items with 429), not a published maximum. Only Pocket publishes a keyless allowance: 2,000 requests per IP per minute, set as `rps: 33`. No other rate limit is asserted. PublicNode rejects `eth_getLogs` without an `address`, and those calls fail over. Debug, trace, subscriptions, numeric pinning and safe/finalized tags stay disabled: providers reported different finalized heads during review. An unsupported request fails instead of changing its state tag. Configure a tested provider explicitly to enable those features and provide its limits:

```ts
const transport = ink({
  endpoints: [{
    url: process.env.INK_RPC_URL!,
    headers: { authorization: `Bearer ${process.env.INK_RPC_TOKEN!}` },
    capabilities: {
      archive: true,
      blockTags: ["latest", "pending", "safe", "finalized", "earliest"],
      pinning: true,
    },
  }],
});
```

`latest` identifies unsafe L2 state, `safe` reflects data included on Ethereum, and `finalized` reflects Ethereum finality. Their requests remain distinct in cache and coalescing keys. Pending responses can contain preconfirmations: they are not immutable cache entries and do not advance the full-block head. No OP Mainnet timing is imposed on Ink. See [OP Stack finality](https://docs.optimism.io/op-stack/transactions/transaction-finality).

`wss://subblocks.inkonchain.com/ws` is a separate stream and is rejected as an RPC pool endpoint. Subblocks use payload/index/diff messages and provide sequencer preconfirmations; their zero state roots and hashes are not authoritative blocks. Stateful WebSocket subscriptions require a tested endpoint and a persistent connection with explicit reconnect/resubscribe handling, separate from stateless retry routing.

For a dedicated subscription, `connectViem` from `@bloxwap/smart-rpc/ethereum` accepts the documented WS URL, `expectedChainId: 57073`, and `reconnect: true`. Its callback-based `subscribe({ params: ["newHeads"], onData })` verifies that connection's identity and keeps reconnect/resubscribe on the same provider. Call the returned subscription's `unsubscribe()` when finished. Generic pooled `request({ method: "eth_subscribe" })` is intentionally unsupported.

Receipt fields pass through unchanged, including L1 data/blob fee quantities and L2 execution gas quantities. The adapter performs no conversion or summation of those components; [Ink fee documentation](https://docs.inkonchain.com/build/transaction-fees) explains their separate roles.

Run deterministic fixtures with `pnpm --filter @smart-rpc/ink test`. To opt into public identity/head checks, run `SMART_RPC_LIVE=1 pnpm --filter @smart-rpc/ink test`. Set `SMART_RPC_INK_CAPABILITIES=1` separately to test safe/finalized tags, a small JSON batch, and subscriptions on the documented WS URLs. Set both `SMART_RPC_INK_ARCHIVE_URL` and `SMART_RPC_INK_ARCHIVE_BLOCK` to check historical state against a chosen archive provider. These optional checks have no SLA assumption, do not measure rate limits, and do not automatically enable capabilities in the default registry.

On 2026-11-06, both default providers passed identity/head, safe/finalized-tag, small-batch, and WS subscription smoke checks. Gelato's tested WS URL was `wss://ws-gel.inkonchain.com`; QuickNode's was `wss://rpc-qnd.inkonchain.com`. On 2026-11-08 all five defaults also served historical state at block 1,048,576 and at genesis, and a 10-item batch. Pocket documents no WebSocket URL, so the WS subscription check skips it. These are point-in-time observations, not service guarantees.
