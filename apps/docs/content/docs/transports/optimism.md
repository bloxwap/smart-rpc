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

The [official connection guide](https://docs.optimism.io/op-mainnet/network-information/connecting-to-op) documents `https://mainnet.optimism.io` as a rate-limited public RPC without general WebSocket support. No numeric request quota is assumed for it. `OPTIMISM_MAINNET_REGISTRY` exports the provider, source, review date, and capabilities. Set a local `rps`/`burst` policy or supply dedicated endpoints for sustained traffic.

| Endpoint or capability | Behavior |
| --- | --- |
| Public HTTPS RPC | Default read/write pool; verifies `eth_chainId` before user traffic. |
| `mainnet-sequencer.optimism.io` | Write-only; rejected as a pool endpoint because identity and read probes do not apply. |
| `op-mainnet-fb-ws-pub.optimism.io/ws` | Dedicated Subblocks stream; rejected as a general RPC endpoint. |
| Public WebSocket | Scheme-swapped public RPC URLs are rejected; use a documented provider URL. |
| Default pool | `mainnet.optimism.io`, PublicNode, dRPC, Pocket Network and Tenderly. Capabilities re-verified live on 2026-11-08. |
| Historical state | Routed to `mainnet.optimism.io` and dRPC (state back to genesis) and Tenderly (post-Bedrock). PublicNode returns 403 and Pocket's backends answered inconsistently, so both are excluded. |
| HTTP batching | Allowed when you enable `batch`: at most 10 items on `mainnet.optimism.io` (larger batches return 413 `-32014`), 3 on dRPC (documented) and 10 elsewhere (largest verified). |
| Logs | dRPC receives `eth_getLogs` spans of at most 100 blocks; PublicNode rejects logs without an `address`, and those calls fail over. |
| Budgets | Only Pocket publishes a keyless allowance (2,000 requests per IP per minute, set as `rps: 33`). |
| Debug/trace, numeric pinning | Disabled on the public defaults; enable on a tested provider. |
| Pre-Bedrock state | `archive: true` is not a promise of pre-Bedrock coverage (Tenderly lacks it). Errors remain errors, never a fallback to `latest`. |

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

Blocks arrive every 2s (measured 2026-11-08), so the factory passes `blockTimeMs: 2000` and the default `headLag.maxLag` is 1 block, about one second of staleness. An endpoint further behind does not lead, race or hedge `latest`, `pending` or other head reads while a fresh endpoint can serve them; it still serves block-number, block-hash, `safe`/`finalized` and transaction reads, and remains a failover. Pass `blockTimeMs` or `headLag: { maxLag }` to change it.

Run deterministic tests with `pnpm --filter @smart-rpc/optimism test`. They cover identity quarantine, disallowed endpoint roles, tag separation, preserved fee fields, signed-write isolation, cancellation, retry/batch budgets, stale heads, probe accounting, headers and archive rejection.

The optional live smoke performs only chain identity, head and finality-tag reads:

```sh
SMART_RPC_LIVE_OPTIMISM=1 pnpm --filter @smart-rpc/optimism test
# Optionally set OPTIMISM_RPC_URL to test a dedicated provider.
```

Public availability is not a CI dependency. A successful smoke is a point-in-time observation, not an archive, WebSocket, batch-capacity or service-level guarantee.
