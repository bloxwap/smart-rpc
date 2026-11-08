---
title: Plasma
---

# Plasma

`@smart-rpc/plasma` is the private workspace implementation of the published
`@bloxwap/smart-rpc/plasma` subpath. `plasma()` registers `eip155:9745` and delegates
its routing, identity quarantine, retries, cancellation, and health accounting to
the Ethereum adapter and shared core.

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { plasma } from "@bloxwap/smart-rpc/plasma";

const rpc = createSmartRpc({ transports: [plasma()] });
await rpc.request({ chainId: "eip155:9745", method: "eth_blockNumber" });
```

The [network configuration](https://docs.plasma.org/docs/guides/network-configuration/mainnet-details)
documents the public HTTPS endpoint `https://rpc.plasma.to`, chain 9745, XPL gas,
PlasmaBFT, and approximately one-second blocks. The metadata uses 18 native token
decimals, matching [viem's Plasma definition](https://github.com/wevm/viem/blob/main/src/chains/definitions/plasma.ts).
Ordinary transactions pay XPL. The factory does not add fee currencies, sponsorship,
or gasless-transfer semantics to requests.

| Public default | Policy |
| --- | --- |
| HTTPS execution RPC | Enabled; identity checked before user calls |
| Default providers | `rpc.plasma.to`, Tenderly's public gateway (`plasma.gateway.tenderly.co`) and thirdweb (`9745.rpc.thirdweb.com`) |
| Historical state | Enabled on `rpc.plasma.to` and Tenderly, which served state at block 1 and head-100k in probes on 2026-11-08 |
| Batch, debug/trace, subscriptions | Disabled pending provider verification |
| State tags | `latest` and `pending`; advanced tags require an explicit capability |
| Numeric state pinning | Disabled; `latest` is sent unchanged |
| Numeric rate or batch ceiling | Unspecified; configure your provider's actual limit |

Tatum's keyless gateway was removed on 2026-11-08. It answered "exceeded your limit of
5 requests per minute" after four calls, which is too little for pool traffic.

These disabled capabilities are conservative client policy, not evidence that
the provider rejects every such method. No synthetic WebSocket URL is derived.
Plasma's [provider directory](https://www.plasma.org/docs/plasma-chain/tools/rpc-providers)
warns that its public RPC is rate-limited and unsuitable for sustained production
loads, and lists dedicated providers. Their URLs, quotas and capabilities must
be configured explicitly:

```ts
const transport = plasma({
  endpoints: [{
    url: process.env.PLASMA_RPC_URL!,
    headers: { "x-api-key": process.env.PLASMA_RPC_KEY! },
    capabilities: { archive: true, blockTags: ["latest", "pending", "safe", "finalized"] },
  }],
});
```

`endpoints` replaces the public registry. Capability assertions should come from
your provider's documentation and checks. Finality tags and historical state are
never rewritten to `latest`. `PLASMA_MAINNET_REGISTRY` exposes sources and review
date; `PLASMA_MAINNET` exposes native currency and network metadata.

The local head policy allows four blocks of lag, discards observations after
12 seconds (three normal probe intervals), and rejects a lead exceeding 120 blocks
when peer evidence is available. These are configurable routing thresholds,
not consensus finality promises. The shared four-second probe cadence and
60-second idle cutoff remain in effect. Override `headLag` or disable it with `false`.

Tests use deterministic fixtures by default. To opt into public checks:

```sh
PLASMA_RPC_SMOKE=1 pnpm --filter @smart-rpc/plasma test
```

Set `PLASMA_RPC_URL` for a provider, `PLASMA_FINALITY_TAG=safe` (or `finalized`),
`PLASMA_ARCHIVE_BLOCK=0x...` for an old state block, and/or `PLASMA_WS_URL` for an
exact provider WebSocket URL to enable the corresponding optional checks.
Set `PLASMA_RPC_BATCH=1` to verify a two-item HTTP batch on the selected provider.
A successful check establishes only the tested endpoint behavior; it does not
establish an SLA, a chain-wide batch limit, or subscription reconnection support.
