# opBNB

```ts
import { opbnb } from "@bloxwap/smart-rpc/opbnb";

const transport = opbnb();
const block = await transport.request({ chainId: "eip155:204", method: "eth_blockNumber" });
transport.close();
```

The private `@smart-rpc/opbnb` workspace package composes the shared Ethereum adapter and core. Mainnet is chain 204 with native BNB (18 decimals). Its settlement parent is **BNB Smart Chain, chain 56**. It does not register BSC itself or reuse Ethereum finality thresholds. The adapter preserves raw quantities, receipts, transaction fields and explicit block tags.

| Provider | Default HTTP RPC | Published WebSocket RPC |
| --- | --- | --- |
| BNB Chain | `https://opbnb-mainnet-rpc.bnbchain.org` | An exact URL was not established from the network page |
| PublicNode | `https://opbnb-rpc.publicnode.com` | `wss://opbnb-rpc.publicnode.com` |

The [official network page](https://docs.bnbchain.org/bnb-opbnb/get-started/network-info/) advertises WSS generally. [PublicNode's own page and embedded endpoint configuration](https://opbnb.publicnode.com/) provide the explicit WSS URL and current HTTP hostname. The older `https://opbnb.publicnode.com` URL in network docs is the provider's landing page; it is not synthesized into a socket URL. NodeReal requires user-owned credentials and remains opt-in.

Default capabilities permit latest/pending reads and ordinary execution RPC. Historical state, safe/finalized tags, debug/trace, HTTP batching, numeric state pinning and subscriptions require explicit provider configuration after verification. HTTP defaults never open a WebSocket. `OPBNB_MAINNET_WEBSOCKET_ENDPOINTS` records provider URLs; use the Ethereum adapter's dedicated WebSocket session API for notification subscriptions and reconnect/resubscribe behavior. op-node administrative/rollup APIs and sequencer feeds are not substitutes for execution RPC endpoints.

```ts
const dedicated = opbnb({
  endpoints: [{
    url: "https://your-provider.example/opbnb",
    headers: { authorization: "Bearer YOUR_KEY" },
    capabilities: {
      archive: true,
      pinning: true,
      blockTags: ["latest", "pending", "safe", "finalized", "earliest"],
    },
  }],
  operationBudget: { maxRequests: 12, timeout: 20_000 },
});
```

Only enable capabilities your endpoint actually supports. Per-endpoint `rps`, `burst`, `providerGroup`, `providerBudget`, batch ceilings and log limits can be supplied explicitly. No numeric public rate/batch quota was established in the cited sources, so the registry invents none. `requestBatch` retains ordered success/error results and shares the operation budget across items, identities, retries and races.

[opBNB's fee documentation](https://docs.bnbchain.org/bnb-opbnb/core-concepts/gas-and-fees/) separates execution gas from the cost of publishing batches to **BSC**. Fields such as `l1Fee`, `l1GasPrice` and `l1GasUsed` stay independent from `gasUsed`/`effectiveGasPrice`; no Ethereum blob fields, prices, or fee formula are added. The client does not calculate bridge withdrawal finality from head progression. Configure head freshness using `headLag` to suit the provider and application.

Run deterministic fixtures with `pnpm --filter @smart-rpc/opbnb test`. Set `OPBNB_LIVE=1` for public identity/head smoke tests. Optional `OPBNB_CAPABILITY_URL` enables provider-specific safe/finalized, historical-state, and batch probes; `OPBNB_WS_URL` enables a socket identity check. These tests send only reads, do not establish SLAs or throughput limits, and never submit transactions.
