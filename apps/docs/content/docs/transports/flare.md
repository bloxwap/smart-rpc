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

`FLARE_MAINNET_REGISTRY` records source URLs, provider names, review date and explicit capabilities. Numeric request quotas and batch ceilings are not specified. Public defaults disable HTTP batching, archive state, debug/trace, numeric state pinning and safe/finalized selectors until the caller enables verified capabilities. For nonstandard methods, extend the default record's `supportedMethods` allowlist as well. Dedicated endpoints preserve unknown capabilities as pass-through, without promising support. A requested historical or finality selector is never changed to `latest`.

[Snowman++ consensus](https://dev.flare.network/network/consensus) accepts blocks with fast finality; the network overview describes approximately 1.8-second blocks. Local head comparisons expire after 18 seconds and tolerate three blocks of lag. These are configurable scoring heuristics, not finality thresholds or provider guarantees. `headLag: false` disables head scoring; `headLag: { staleMs, maxLag }` overrides the heuristics.

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
