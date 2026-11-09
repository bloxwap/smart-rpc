---
title: Arc
---

# Arc

Import `arc` from `@bloxwap/smart-rpc/arc`. The private workspace package is `@smart-rpc/arc`; routing, retries, caching, budgets and identity checks use the shared Ethereum adapter and core.

```ts
import { arc } from "@bloxwap/smart-rpc/arc";

const transport = arc();
const address = "0x1111111111111111111111111111111111111111";
const balance = await transport.request({
  chainId: "eip155:5042",
  method: "eth_getBalance",
  params: [address, "latest"],
});
transport.close();
```

Mainnet is chain **5042**. Native gas and balances use **USDC, 18 decimals**. The ERC-20 USDC interface at `ARC_USDC_ERC20_ADDRESS` uses 6 decimals but represents the same balance. The transport returns original RPC quantities without conversion. [Network configuration](https://docs.arc.io/arc/references/connect-to-arc)

`ARC_MAINNET_REGISTRY` contains five keyless HTTP endpoints. Four come from Arc's documentation (Arc, Blockdaemon, dRPC and QuickNode) and one from chainlist (PublicNode). Alchemy needs a caller-provided API key, so it is not a default. The registry stores the exact Blockdaemon and QuickNode WebSocket URLs as metadata and never derives a WS URL from an HTTP one. Passing `endpoints` replaces the defaults, and each endpoint may supply `headers` for dedicated provider authentication. [Provider URLs](https://docs.arc.io/arc/references/connect-to-arc)

Default capabilities come from live probes run on 2026-11-08:

- **Finality tags:** every default answers `safe`, `finalized`, `pending` and `earliest`, because Arc finality is deterministic.
- **Historical state:** only Arc, dRPC and QuickNode serve state at block 1, so they are marked `archive`. Blockdaemon prunes old state, and PublicNode requires a token for any numeric-block state.
- **Excluded methods:**
  - Arc and QuickNode never receive filter methods or `eth_getProof`, which they answer with `method not supported`.
  - dRPC never receives filter methods.
  - PublicNode never receives `eth_getLogs`, because it refuses old or address-less log queries with a terminal error.
- **Log range:** dRPC's free tier gets `eth_getLogs` ranges of at most 100 blocks.

Debug and trace, pinning, batching and subscriptions stay off. No numeric provider quota or batch ceiling is invented. The `capabilities.blockTags`, `archive`, `batch` and `maxBatchSize` endpoint options, and related ones, enable provider behavior you have tested. Subscriptions use the shared adapter's dedicated WebSocket session API. [Finality](https://docs.arc.io/arc/concepts/deterministic-finality)

Arc targets Osaka with execution differences, so the transport forwards gas estimates and error details rather than simulating Ethereum rules. Native-value transfers can revert for zero-address, burning, or blocklist restrictions; a revert remains terminal. It does not construct transactions, choose fee caps, or assume blob transactions are supported. [EVM differences](https://docs.arc.io/arc/references/evm-differences)

System native-USDC Transfer logs come from `ARC_NATIVE_TRANSFER_EMITTER` at 18-decimal precision; ERC-20 logs use the contract address and 6-decimal precision. Both logs can describe one transfer. RPC results preserve both emitters, amounts and ordering so applications can avoid double counting. [System events](https://docs.arc.io/arc/references/usdc-system-events)

Blocks arrive every about 500ms (measured 2026-11-08: 0.51s), so the factory passes `blockTimeMs: 500` and the default `headLag.maxLag` is 2 blocks, about one second of staleness. An endpoint further behind does not lead, race or hedge `latest`, `pending` or other head reads while a fresh endpoint can serve them; it still serves block-number, block-hash, `safe`/`finalized` and transaction reads, and remains a failover. Pass `blockTimeMs` or `headLag: { maxLag }` to change it.

Run `pnpm --filter @smart-rpc/arc test` for deterministic fixtures. `SMART_RPC_LIVE_ARC=1 pnpm --filter @smart-rpc/arc test` adds public identity/head checks. Optional capability probes require `SMART_RPC_ARC_CAPABILITIES=1` and `ARC_RPC_URL`; WS checks additionally require `ARC_WS_URL`. These read-only probes establish observed behavior at one time, not availability guarantees or provider limits. No transaction is submitted.
