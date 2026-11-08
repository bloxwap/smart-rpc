---
title: Flare
---

# Flare

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { flare } from "@bloxwap/smart-rpc/flare";

const rpc = createSmartRpc({ transports: [flare()] });
const head = await rpc.request({ chainId: "eip155:14", method: "eth_blockNumber" });
```

`flare()` serves Flare mainnet (`14`) with native FLR, 18 decimals. It composes the Ethereum adapter and shared core. `endpoints` replaces the documented HTTP defaults; endpoint objects accept dedicated authentication `headers`, capability overrides and local `rps`/`burst` budgets.

The [official network configuration](https://dev.flare.network/network/overview) documents these exact URLs. Their paths must not be synthesized by replacing a URL scheme.

| Provider | HTTP JSON-RPC | Dedicated WebSocket |
| --- | --- | --- |
| Flare | `https://flare-api.flare.network/ext/C/rpc` | `wss://flare-api.flare.network/ext/C/ws` |
| QuickNode | `https://stylish-light-theorem.flare-mainnet.quiknode.pro/ext/bc/C/rpc` | `wss://stylish-light-theorem.flare-mainnet.quiknode.pro/ext/bc/C/ws` |

`FLARE_MAINNET_REGISTRY` also includes keyless dRPC (`https://flare.drpc.org`) and Tenderly (`https://flare.gateway.tenderly.co`) from chainlist and provider documentation. Each record stores its source URLs, provider name, review date and explicit capabilities. Numeric request quotas and batch ceilings are not specified.

Default capabilities come from live probes run on 2026-11-08:

- **Finality tags:** every default answers `safe`, `finalized`, `pending` and `earliest`.
- **Historical state:** only QuickNode and Tenderly serve state at block 1, so they are marked `archive`. The official node and dRPC hold no state behind the head.
- **Log range:** the official node reports a 30-block `eth_getLogs` maximum, and dRPC's free tier rejects ranges above roughly 100 blocks. Both values are applied as `maxLogBlockRange`.

HTTP batching, debug and trace, and numeric state pinning stay disabled until the caller enables verified capabilities. For nonstandard methods, extend the default record's `supportedMethods` allowlist as well. Dedicated endpoints preserve unknown capabilities as pass-through, without promising support. A requested historical or finality selector is never changed to `latest`.

[Snowman++ consensus](https://dev.flare.network/network/consensus) accepts blocks with fast finality; the network overview describes approximately 1.8-second blocks, but blocks measured on 2026-11-08 arrived about every second (1,000 blocks in 1,066s). The factory passes `blockTimeMs: 1000`, so the default lag tolerance is 1 block (it was three). An endpoint further behind does not lead, race or hedge head reads while a fresh endpoint can. `FLARE_HEAD_LAG` keeps the 18-second expiry for head comparisons and no longer sets `maxLag`. These are configurable scoring heuristics, not finality thresholds or provider guarantees. `headLag: false` disables head scoring; `headLag: { staleMs, maxLag }` overrides the heuristics.

Type-0 and type-2 execution fields, receipts, extension fields and Cancun call data pass through unchanged. The transport does not derive gas fees from Ethereum epoch/slot assumptions. Native FTSO contracts remain callable through `eth_call`; FTSO data services, [FDC verifiers](https://dev.flare.network/fdc/overview) and the DA Layer are separate APIs. Known public verifier/DA URLs are rejected as execution endpoints, and default method allowlists exclude their namespaces.

Subscriptions use an explicit dedicated `connectViem` session from `@bloxwap/smart-rpc/ethereum`, with a documented WS URL and `expectedChainId: 14`. Its callbacks and viem reconnect/resubscribe lifecycle remain on that endpoint; ordinary pooled `request({ method: "eth_subscribe" })` is unsupported. Public HTTP defaults do not open sockets.

Offline fixtures cover identity quarantine, opaque URLs/headers, capability routing, tags, transaction/receipt preservation, cancellation, shared operation budgets, batch partial errors, stale heads and non-healing probes. Network checks are opt-in and never submit transactions:

```sh
FLARE_RPC_INTEGRATION=1 pnpm --filter @smart-rpc/flare test
FLARE_CAPABILITY_INTEGRATION=1 pnpm --filter @smart-rpc/flare test
FLARE_WS_INTEGRATION=1 pnpm --filter @smart-rpc/flare test
FLARE_ARCHIVE_RPC_URL=https://your-provider.example/rpc pnpm --filter @smart-rpc/flare test
```

Capability checks exercise small batches and tag behavior; they do not load-test quotas or establish a public-service SLA. Add provider-specific ceilings only after obtaining documentation or contractual limits.
