---
title: X Layer
---

# X Layer

`@bloxwap/smart-rpc/xlayer` exports `xlayer()`, a mainnet transport for `eip155:196`. The private workspace package is `@smart-rpc/xlayer`; routing, identity quarantine, breakers, retries and request budgets come from Ethereum/core.

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { xlayer } from "@bloxwap/smart-rpc/xlayer";

const rpc = createSmartRpc({ transports: [xlayer()] });
const block = await rpc.request({ chainId: "eip155:196", method: "eth_blockNumber" });
```

The native currency is OKB with 18 decimals. The two default URLs are `https://rpc.xlayer.tech` and `https://xlayerrpc.okx.com`. [Network information](https://web3.okx.com/onchainos/dev-docs/xlayer/developer/build-on-xlayer/network-information) and [viem's chain definition](https://github.com/wevm/viem/blob/main/src/chains/definitions/xLayer.ts) record the identity and currency metadata.

Both public URLs share the documented 100 requests/second/IP allowance through `providerGroup: "xlayer-public"`. Local defaults additionally use 2 requests/second with a burst of 3 per URL. These conservative client settings are not a provider guarantee; other pools, processes and clients sharing the IP are outside this pool's accounting. Identity checks, probes and retries consume the same budgets as caller traffic. [RPC documentation](https://web3.okx.com/onchainos/dev-docs/xlayer/developer/rpc-endpoints/rpc-endpoints)

| Public default | Behavior |
| --- | --- |
| Health | `eth_blockNumber`; `txpool_content` is empty and `eth_protocolVersion` is zero by design |
| Method support | Documented allowlist; debug tracing requires an explicit capability |
| State | `latest`/`pending`. Historical state routes to OKX, dRPC and Sentio, which served state at block 1 and head-100k on 2026-11-08. Numeric pinning and safe/finalized tags require provider configuration |
| Log ranges | `maxLogBlockRange` is 100 on OKX, dRPC and thirdweb and 1,000 on Sentio, each taken from that provider's own error. Wider ranges are rejected before sending |
| Wire batches | Disabled until the provider is verified; no invented numeric batch limit |
| WebSocket | Explicit URLs are exported separately; HTTP defaults do not enable subscriptions |

The published WebSocket URLs are `wss://xlayerws.okx.com` and `wss://ws.xlayer.tech`. They are never synthesized from HTTP URLs. [WebSocket documentation](https://web3.okx.com/onchainos/dev-docs/xlayer/developer/websockets-endpoints/websocket-endpoints)

Dedicated provider URLs replace public defaults. Headers and capability declarations pass to the shared Ethereum adapter:

```ts
const transport = xlayer({
  endpoints: [{
    url: process.env.XLAYER_RPC_URL!,
    headers: { "x-api-key": process.env.XLAYER_RPC_KEY! },
    capabilities: { archive: true, debug: true, blockTags: ["latest", "pending", "safe", "finalized"] },
  }],
});
```

Configure only features verified against that provider. Passing an official public URL retains its public defaults; explicit per-endpoint capability overrides win. Responses and transaction fields are passed through without interpreting the network's execution stack or gas economics. There is no implicit testnet registration.

Run deterministic tests with `pnpm --filter @smart-rpc/xlayer test`. Public checks are opt-in:

```sh
SMART_RPC_LIVE_XLAYER=1 pnpm --filter @smart-rpc/xlayer test
SMART_RPC_LIVE_XLAYER=1 XLAYER_LIVE_CAPABILITIES=batch,safe,finalized,archive,ws pnpm --filter @smart-rpc/xlayer test
```

`XLAYER_RPC_URL` and `XLAYER_WS_URL` select providers. `XLAYER_ARCHIVE_BLOCK` selects a historical state fixture. The `debug` capability check also needs `XLAYER_TRACE_TRANSACTION`, a known mined transaction hash. These checks use tiny requests rather than testing rate limits by generating load; a successful probe is not an SLA or an exhaustive capability certification.

On 2026-11-06, the live suite passed identity/head checks on both HTTP URLs, a two-item batch, safe/finalized block reads, a historical balance read and a WebSocket identity request. Debug tracing was not run without a transaction fixture. These observations leave the conservative defaults unchanged.
