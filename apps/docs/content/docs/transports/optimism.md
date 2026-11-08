---
title: OP Mainnet
---

# OP Mainnet

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { optimism } from "@bloxwap/smart-rpc/optimism";

const rpc = createSmartRpc({ transports: [optimism()] });
const block = await rpc.request({
  chainId: "eip155:10",
  method: "eth_getBlockByNumber",
  params: ["safe", false],
});
rpc.close();
```

`optimism()` registers mainnet only: chain ID 10 and native ETH with 18 decimals. It composes the canonical Ethereum transport and shared core; it does not implement another retry, race, cache, or scoring policy.

The [official connection guide](https://docs.optimism.io/op-mainnet/network-information/connecting-to-op) documents `https://mainnet.optimism.io` as a rate-limited public RPC without general WebSocket support. No numeric quota or batch ceiling is assumed. `OPTIMISM_MAINNET_REGISTRY` exports the provider, source, review date, and capabilities. Set a local `rps`/`burst` policy or supply dedicated endpoints for sustained traffic.

| Endpoint or capability | Behavior |
| --- | --- |
| Public HTTPS RPC | Default read/write pool; verifies `eth_chainId` before user traffic. |
| `mainnet-sequencer.optimism.io` | Write-only; rejected as a pool endpoint because identity and read probes do not apply. |
| `op-mainnet-fb-ws-pub.optimism.io/ws` | Dedicated Subblocks stream; rejected as a general RPC endpoint. |
| Public WebSocket | Scheme-swapped public RPC URLs are rejected; use a documented provider URL. |
| Archive, debug/trace, HTTP batching, numeric pinning | Disabled on the public default because support/limits are unverified here; enable on a tested provider. |
| Historical and pre-Bedrock state | Require a provider with the appropriate history; `archive: true` alone is not a promise of pre-Bedrock coverage. Errors remain errors, never a fallback to `latest`. |

The [OP finality reference](https://docs.optimism.io/op-stack/transactions/transaction-finality) distinguishes `latest` (unsafe sequencer head), `safe` (data included on Ethereum), and `finalized` (Ethereum-finalized data). The transport preserves the requested tag and separates cache/coalescing keys by parameters. A Subblocks preconfirmation never becomes a full-block probe head. Provider acceptance of finality tags can be checked with the opt-in test; timing is not used to manufacture a finalized result.

[OP fees](https://docs.optimism.io/op-stack/transactions/fees) include execution gas, L1 data fees and, after Isthmus, operator fees. RPC results pass through unchanged, including L1 blob/base-fee fields, operator fee fields, and deposit receipt extensions. The transport does not fold these into `gasPrice` or recompute transaction fees.

```ts
const pool = optimism({
  endpoints: [{
    url: process.env.OP_RPC_URL!,
    headers: { authorization: `Bearer ${process.env.OP_RPC_TOKEN!}` },
    capabilities: {
      archive: true,
      blockTags: ["latest", "safe", "finalized", "pending", "earliest"],
      // Enable only capabilities verified for this provider.
    },
  }],
  operationBudget: { maxRequests: 8, timeout: 15_000 },
});
```

For subscriptions use the shared Ethereum `connectViem` session API with an actual provider WebSocket URL. Ordinary request routing cannot deliver notifications. No URL is guessed for a provider.

Run deterministic tests with `pnpm --filter @smart-rpc/optimism test`. They cover identity quarantine, disallowed endpoint roles, tag separation, preserved fee fields, signed-write isolation, cancellation, retry/batch budgets, stale heads, probe accounting, headers and archive rejection.

The optional live smoke performs only chain identity, head and finality-tag reads:

```sh
SMART_RPC_LIVE_OPTIMISM=1 pnpm --filter @smart-rpc/optimism test
# Optionally set OPTIMISM_RPC_URL to test a dedicated provider.
```

Public availability is not a CI dependency. A successful smoke is a point-in-time observation, not an archive, WebSocket, batch-capacity or service-level guarantee.
