# Base

Import `base` from `@bloxwap/smart-rpc/base` and register it with `createSmartRpc`.
The private workspace package `@smart-rpc/base` composes the Ethereum adapter and
shared core. It registers only `eip155:8453`; gas is ETH with 18 decimals.

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { base } from "@bloxwap/smart-rpc/base";

const rpc = createSmartRpc({ transports: [base()] });
const head = await rpc.request({ chainId: "eip155:8453", method: "eth_blockNumber" });
```

The default is `https://mainnet.base.org`, verified against the
[Base network documentation](https://docs.base.org/get-started/connect-to-base).
The submission-only `https://mainnet-sequencer.base.org` is excluded, and passing
that host to `base({ endpoints })` throws before any identity check, probe, or
read. A transaction can be submitted through the regular RPC; specialized direct
sequencer clients belong outside this pool.

`latest` identifies the unsafe L2 head. `safe` reflects data inclusion on Ethereum,
and `finalized` reflects Ethereum finality. Requests retain their exact settlement
tag, which is part of the shared cache/coalescing key. No fixed finality timer is
inferred. Preconfirmation feeds are not full-block health sources. See the
[OP Stack finality documentation](https://docs.optimism.io/op-stack/transactions/transaction-finality).

Receipt fields pass through unchanged, including independent L2 execution gas,
L1 calldata/blob fee fields, and future extensions. This adapter does not estimate
total fees by treating `gasUsed * effectiveGasPrice` as the L1-inclusive cost.

| Public default capability | Policy |
| --- | --- |
| Batch, archive state, debug/trace, subscriptions | Disabled until configured on a verified provider |
| Numeric latest pinning | Disabled on this unverified public endpoint |
| Safe/finalized tags | Passed through without a timing or availability guarantee |
| Numeric rate or batch limits | Unspecified; no provider limit inferred |

Custom endpoints replace defaults, with capabilities and authentication passed to
the shared Ethereum adapter. Declare only capabilities verified for that provider:

```ts
base({
  endpoints: [{
    url: process.env.BASE_PROVIDER_URL!,
    headers: { authorization: `Bearer ${process.env.BASE_PROVIDER_KEY!}` },
    capabilities: { archive: true, blockTags: ["latest", "safe", "finalized"] },
  }],
});
```

The Base tests cover chain quarantine, sequencer exclusion, settlement-tag
isolation, fee-field preservation, submission semantics, cancellation, bounded
retries, partial batch outcomes, and full-block probe freshness/accounting. Shared core and Ethereum tests
cover the policy implementation, including partial batch errors and provider
budgets. Run the optional read-only public checks with
`SMART_RPC_LIVE_BASE=1 pnpm --filter @smart-rpc/base test`; `BASE_RPC_URL` can target
a configured provider. The smoke test checks identity, head, and settlement tags;
it does not establish archive, WebSocket, batch limits, capacity, or an SLA.
