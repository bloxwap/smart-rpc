---
title: Etherlink EVM
---

# Etherlink EVM

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { etherlink } from "@bloxwap/smart-rpc/etherlink";

const rpc = createSmartRpc({ transports: [etherlink()] });
const head = await rpc.request({ chainId: "eip155:42793", method: "eth_blockNumber" });
rpc.close();
```

`etherlink()` composes the canonical Ethereum adapter and shared pool. It verifies chain 42793 before user traffic. The native currency is XTZ with 18 decimals. This transport handles Ethereum JSON-RPC; the Michelson interface has separate endpoints and a separate client. Known Michelson URLs and `/tezlink` or `/michelson` endpoint paths are rejected. EVM calls to the NAC precompile remain EVM calls and are passed through unchanged. [Network information](https://docs.etherlink.com/evm/get-started/network-information/), [Michelson endpoints](https://docs.etherlink.com/michelson/network-information/).

The default full RPC is `https://node.mainnet.etherlink.com`. Its documented allowance is 1,000 requests/minute; the client conservatively uses 16 requests/second with burst 4, counting identity checks, probes, retries and reads. Provider-group buckets coordinate configured URLs within a pool, not separate processes sharing an IP. No numeric HTTP batch ceiling is invented. [Provider restrictions](https://docs.etherlink.com/evm/tools/node-providers/).

`https://relay.mainnet.etherlink.com` accepts only `eth_sendRawTransaction` and `eth_blockNumber`; it cannot perform identity verification and is rejected from this general pool. There is no default public WebSocket endpoint. Supply a documented dedicated provider URL without changing its path. The shared Ethereum `connectViem` API provides dedicated callback subscription sessions; generic pool requests do not own subscriptions. [Endpoint roles](https://docs.etherlink.com/evm/get-started/network-information/), [WebSockets](https://docs.etherlink.com/evm/developing/websockets/).

`ETHERLINK_MAINNET_REGISTRY` has three defaults: the Etherlink node, Ankr and thirdweb. dRPC was removed on 2026-11-08 because its reported head repeatedly froze, falling up to 21 blocks behind.

Default capabilities come from live probes run on 2026-11-08:

- **Finality tags:** the defaults answer `finalized`, `pending` and `earliest`. Etherlink nodes reject `safe` with a terminal error, so `safe` is never routed to a default.
- **Historical state:** the Etherlink node and Ankr serve state at block 1, so they are marked `archive`. thirdweb rate-limits historical state, so it is not.
- **Excluded methods:** filter methods (`Method disabled`) and `eth_getProof` are excluded everywhere.
- **Log range:** thirdweb gets log ranges of at most 100 blocks, based on its own error message.

Debug and trace, and batching, stay disabled. `latest` is never rewritten, because numeric pinning is off in the public profile. Override `capabilities` only after verifying your provider. A request for unsupported historical state or finality fails instead of becoming a latest-state request. Custom URLs and HTTP headers are supported:

```ts
const pool = etherlink({
  endpoints: [{
    url: process.env.ETHERLINK_RPC_URL!,
    headers: { "x-api-key": process.env.ETHERLINK_API_KEY! },
    capabilities: { archive: true, blockTags: ["latest", "safe", "finalized"] },
  }],
  operationBudget: { maxRequests: 32, timeout: 20_000 },
});
```

Public log queries are limited to 500 blocks and 5,000 returned logs. Ordinary oversized numeric ranges are rejected before dispatch. Use the shared helper for bounded range splitting; a split error rejects the whole operation, preserving the error rather than returning partial logs. Smaller ranges may still exceed a result ceiling, requiring narrower filters. A response at the result ceiling alone does not prove completeness. [Log restrictions](https://docs.etherlink.com/evm/tools/node-providers/).

```ts
import { requestLogs } from "@bloxwap/smart-rpc/etherlink";

const logs = await requestLogs(pool, {
  address: "0x1111111111111111111111111111111111111111",
  fromBlock: "0x1", toBlock: "0x3e8",
}, { maxBlockRange: 500, maxRequests: 20 });
pool.close();
```

`ETHERLINK_PRECOMPILES` exposes the XTZ bridge (`0xff…01`), FA bridge (`0xff…02`) and native atomic gateway (`0xff…07`) EVM addresses. The transport preserves calldata, native values, return bytes, receipt fields and revert errors. NAC stays within Etherlink; it is different from bridging to Tezos L1. These constants do not implement a bridge SDK or promise withdrawal timing. [NAC ABI](https://docs.etherlink.com/evm/nac-usage/), [XTZ bridge](https://docs.etherlink.com/evm/bridging/bridging-tezos/), [FA bridge](https://docs.etherlink.com/evm/bridging/bridging-fa/), [Architecture](https://docs.etherlink.com/overview/architecture/).

Blocks arrive every about 1.2-1.4s (measured 2026-11-08), so the factory passes `blockTimeMs: 1200` and the default `headLag.maxLag` is 1 block, about one second of staleness. An endpoint further behind does not lead, race or hedge `latest`, `pending` or other head reads while a fresh endpoint can serve them; it still serves block-number, block-hash, `safe`/`finalized` and transaction reads, and remains a failover. Pass `blockTimeMs` or `headLag: { maxLag }` to change it.

Run fixtures with `pnpm --filter @smart-rpc/etherlink test`. Set `SMART_RPC_LIVE_ETHERLINK=1` for public identity/head/bounded-log smoke checks. Optional `ETHERLINK_ARCHIVE_RPC_URL` plus `ETHERLINK_ARCHIVE_BLOCK`, `ETHERLINK_FINALITY_TEST=1` (optionally `ETHERLINK_RPC_URL`), and `ETHERLINK_WS_RPC_URL` enable provider-specific capability checks. Live tests do not submit transactions or establish an SLA; capabilities and limits remain provider-specific. Sources reviewed 2026-11-08.
