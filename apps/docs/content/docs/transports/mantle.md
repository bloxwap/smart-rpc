---
title: Mantle
---

# Mantle

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { mantle } from "@bloxwap/smart-rpc/mantle";

const rpc = createSmartRpc({ transports: [mantle()] });
await rpc.request({ chainId: "eip155:5000", method: "eth_blockNumber" });
rpc.close();
```

`@smart-rpc/mantle` is a private workspace package compiled into the public subpath. It composes the canonical Ethereum adapter and shared core; scoring, cancellation, retry, breaker, cache, and budget policies are not copied.

Mantle mainnet uses chain ID 5000 and MNT as native gas currency. The default HTTP endpoint is `https://rpc.mantle.xyz`; the separately documented WebSocket address is `wss://wss.mantle.xyz`. The public service is rate limited, but no numeric allowance is published on the cited network page. Registry entries omit unverified rate and batch ceilings. [Network details](https://docs.mantle.xyz/network/for-developers/quick-access).

The public provider rejects `eth_getBlockRange` and `eth_sendTransaction`. The factory retains those restrictions even if its public URL is supplied explicitly. A capable dedicated provider may be configured separately. Use `requestBatch` with individual `eth_getBlockByNumber` calls instead of deprecated block-range requests. Sign locally before `eth_sendRawTransaction`; successful writes are never raced, cached, or coalesced. `rebroadcastRawTransactions: false` disables failover of signed submissions.

`eth_gasPrice` and `GasPriceOracle.gasPrice()` describe L2 execution gas. The oracle's `l1BaseFee()` is a separate L1 value; its address is exported as `MANTLE_GAS_PRICE_ORACLE`. RPC quantities, call data, and extra receipt fields pass through unchanged. The adapter does not calculate a combined transaction fee. [Mantle API](https://docs.mantle.xyz/network/for-developers/resources-and-tooling/mantle-api).

Advanced public capabilities remain disabled until explicitly configured: archive state, debug/trace, safe/finalized tags, HTTP batching, and numeric state pinning. This is a conservative client policy, not a claim that a provider can never support them. Unsupported state requests fail without changing their selector to `latest`.

```ts
const transport = mantle({
  endpoints: [{
    url: process.env.MANTLE_RPC_URL!,
    headers: { "x-api-key": process.env.MANTLE_RPC_KEY! },
    capabilities: {
      archive: true,
      blockTags: ["latest", "pending", "safe", "finalized"],
      batch: true,
      // Set maxBatchSize only to a limit verified for this provider.
    },
  }],
  batch: true,
  operationBudget: { maxRequests: 32, timeout: 20_000 },
});
```

`requestBatch` preserves each item's outcome and shares one operation budget across its identity checks, attempts, and races. Head freshness remains configurable with `headLag`; finality is not inferred from an Ethereum epoch duration. Subscription callbacks use a dedicated `connectViem` session from the Ethereum subpath with `expectedChainId: 5000`, not ordinary pool requests. See the [Ethereum adapter](ethereum.md) for its lifecycle.

Run deterministic fixtures with `pnpm --filter @smart-rpc/mantle test`. Read-only live checks are opt-in:

```sh
MANTLE_RPC_INTEGRATION=1 pnpm --filter @smart-rpc/mantle test
MANTLE_WS_INTEGRATION=1 pnpm --filter @smart-rpc/mantle test
MANTLE_CAPABILITY_RPC_URL=https://your-provider.example pnpm --filter @smart-rpc/mantle test
```

The first command checks public identity/head and documented method rejection. The second checks identity over the exact documented WS URL. The third tests finality tags, archive state, and HTTP batch partial errors against an explicitly selected provider. These are point-in-time checks, not load tests or an SLA; no live test submits a transaction.
