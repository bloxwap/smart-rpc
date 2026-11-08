---
title: Gnosis
---

# Gnosis

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { gnosis } from "@bloxwap/smart-rpc/gnosis";

const rpc = createSmartRpc({ transports: [gnosis()] });
const height = await rpc.request({ chainId: "eip155:100", method: "eth_blockNumber" });
```

`gnosis()` composes the canonical Ethereum adapter and shared pool. It registers only chain 100 and verifies `eth_chainId` before admitting an endpoint. The native fee currency is **xDAI (18 decimals)**; GNO is the staking token. The transport forwards JSON-RPC quantities, transaction fields, and receipts without converting native balances into GNO units.

The [official mainnet documentation](https://docs.gnosischain.com/about/networks/mainnet) lists two execution RPC defaults:

| Provider | HTTPS execution RPC | Documented WS |
| --- | --- | --- |
| Gnosis starter | `https://rpc.gnosischain.com` | `wss://rpc.gnosischain.com/wss` |
| Gateway.fm | `https://rpc.gnosis.gateway.fm` | Unverified |

The [provider documentation](https://docs.gnosischain.com/tools/RPC%20Providers/) describes the starter service without availability guarantees. Its WebSocket path includes `/wss`; swapping the HTTPS scheme alone produces the wrong endpoint. Dedicated providers from that directory can be supplied with `endpoints` and HTTP `headers`. Credentials are never included in fixtures.

Consensus REST at `rpc-gbc.gnosischain.com` is a separate API. The factory rejects that known host and beacon REST paths. It also rejects a guessed starter socket URL without `/wss`; neither consensus responses nor beacon heights enter execution-head scoring.

The network documentation gives 5-second slots, 16-slot epochs, and approximate 2.7-minute finalization. These are exported as `GNOSIS_CONSENSUS` metadata, not used to infer a block's finality. Peer head extrapolation uses 0.2 blocks/second, and the default freshness window is 30 seconds with two blocks of tolerated lag. Override `maxUnitsPerSecond` or `headLag` for your environment; probes retain the shared 4-second cadence and 60-second idle cutoff.

Public defaults leave advanced capabilities disabled pending your provider verification: archive state, debug/trace, subscriptions, HTTP batching, numeric pinning, and safe/finalized tags. They carry no invented numeric rate or batch limits. Configure measured capabilities explicitly:

```ts
const transport = gnosis({
  endpoints: [{
    url: process.env.GNOSIS_RPC_URL!,
    headers: { "x-api-key": process.env.GNOSIS_RPC_KEY! },
    capabilities: {
      archive: true,
      pinning: true,
      blockTags: ["latest", "pending", "safe", "finalized", "earliest"],
    },
  }],
});
```

Safe/finalized and historical selectors remain unchanged and have independent cache keys. An unsupported request fails or goes to a capable endpoint; it is never rewritten to `latest`. Use `connectViem` from the Ethereum subpath with `expectedChainId: 100` for a dedicated subscription session; callbacks stay on that connection and viem handles reconnect/resubscribe. Generic pool requests do not return a usable subscription notification stream.

`requestBatch()` returns ordered settled results and applies one operation budget across all items, retries, and identity checks. HTTP batching additionally requires the `batch` option and a provider capability profile. Partial errors remain attached to their items. Shared core fixtures cover racing, loser cancellation, breakers, coalesced cancellation, and retry limits; Gnosis fixtures exercise the chain-specific boundaries and the composed behavior.

Optional live checks, without transactions or provider load tests:

```sh
GNOSIS_RPC_INTEGRATION=1 pnpm --filter @smart-rpc/gnosis test
GNOSIS_CAPABILITY_INTEGRATION=1 pnpm --filter @smart-rpc/gnosis test
GNOSIS_WS_INTEGRATION=1 pnpm --filter @smart-rpc/gnosis test
```

Set `GNOSIS_RPC_URL` for a dedicated capability test provider, `GNOSIS_ARCHIVE_BLOCK` for a numeric historical state test, and `GNOSIS_TRACE_TX_HASH` for a known transaction to trace. `GNOSIS_WS_URL` overrides the documented socket for its identity and subscribe/unsubscribe test. A passing check records only the tested methods at that time and does not enable a runtime guarantee.
