---
title: Ethereum and shared EVM transport
---

# Ethereum and shared EVM transport

`@bloxwap/smart-rpc/ethereum` exports `ethereum()`, the canonical adapter used by the other EVM transports. It verifies `eth_chainId` before caller traffic, supplies EVM method and selector policies, and delegates routing, retries, breakers, budgets, racing, coalescing, cancellation and caching to the shared core. Importing the package root does not register Ethereum.

## Provider configuration

```ts
import { ethereum } from "@bloxwap/smart-rpc/ethereum";

const pool = ethereum({
  endpoints: [{
    url: "https://your-provider.example/rpc",
    headers: { authorization: `Bearer ${process.env.RPC_TOKEN}` },
    providerGroup: "your-provider",
    providerBudget: { rps: 5, burst: 5 },
    capabilities: {
      archive: true,
      blockTags: ["latest", "pending", "safe", "finalized", "earliest"],
      debug: false,
      trace: false,
      batch: true,
      maxBatchSize: 10,
    },
  }],
  batch: true,
  operationBudget: { maxRequests: 32, timeout: 20_000 },
});
```

With no `endpoints`, chain 1 uses `ETHEREUM_MAINNET_REGISTRY`: PublicNode, dRPC, NOWNodes, Tenderly and Pocket Network, re-verified on 2026-11-08. Only operators that publish a keyless numeric allowance carry a budget: NOWNodes ("5 RPS", set as `rps: 5, burst: 5`) and Pocket (2,000 requests per IP per minute, set as `rps: 33`). The previous blanket 2 rps / burst 3 client budget was removed. It starved the router: in an A/B run of the benchmark workload, router p50 fell from 228 ms to 64–75 ms, p95 fell from 570–700 ms to 170–205 ms, and the `BudgetExhaustedError` failures stopped. Tenderly and NOWNodes skip `eth_getLogs`: Tenderly's large results look like invalid params, and NOWNodes timed out even on single-block queries.

Registry entries also record live-verified capabilities. Historical state was served by dRPC, Tenderly and Pocket; PublicNode returned 403 and NOWNodes reported missing state. dRPC is limited to 3-item batches (documented) and 100-block log spans (observed). The default pool routes on these capabilities.

`blockTimeMs` sets the chain's typical block interval. With it, the default `headLag.maxLag` becomes about one second of blocks (at least one) and `maxUnitsPerSecond` the block rate plus 25%. Every chain factory built on this adapter passes a measured value (see [Head freshness](../public-rpcs.md#head-freshness)). On chain 1 `ethereum()` defaults to 12000 (12s slots), so `maxLag` is 1 and `maxUnitsPerSecond` about 0.1. Other chain ids without a `blockTimeMs` keep `maxLag` 2 and `maxUnitsPerSecond` 2. An explicit `headLag.maxLag` always wins.

Some providers answer an error with a non-2xx JSON body that has no JSON-RPC envelope. Sentio, for example, answers an oversized `eth_getLogs` with HTTP 429 and `{"code":8,"message":"public eth_getLogs is limited to 1000 blocks"}`. The adapter rewrites such a body into a JSON-RPC error (code `-32000`) that carries the provider's message and keeps the original body as `data`. The HTTP status, `Retry-After` and other headers are kept, and stale `content-length`/`content-encoding` headers are dropped. The pool can then read the real reason instead of a bare 429, so this case fails over as a provider restriction rather than throttling the endpoint.

These are example settings for a provider whose features and quotas you have verified. Capability values omitted from a custom endpoint remain unknown; they do not guarantee support. `archive: false` rejects numeric, earliest and block-hash **state** reads, while historical blocks and logs remain separately accessible. `blockTags` limits named tags at recognized selector positions. `pinning: false` prevents converting latest state to numeric state. A historical or finalized request is never downgraded to latest.

`supportedMethods` is an exact allowlist; `unsupportedMethods` is an explicit denylist. Pooled EVM endpoints must permit `eth_chainId` unless the caller explicitly disables verification with `verifyIdentity: false`. Transaction-only sequencers and relays belong on a separate submission connection because they cannot pass pooled identity/probe checks. `debug: false` and `trace: false` exclude their respective namespaces before dispatch. `safeMethods` allows a chain adapter to opt specific read extensions into racing/retries; unknown methods default to one non-coalesced, uncached attempt.

Batching is opt-in. `capabilities.batch: false` disables it for an endpoint, and `maxBatchSize` caps the configured size. `requestBatch()` returns one settled outcome per input, so a rejected item does not erase successful results. The core shares the operation budget across all items, retries, identities and hedges. Concurrent safe reads share a viem HTTP batch while retaining separate caller cancellation: cancelling one read does not abort its live siblings, and cancelling the last participant aborts their shared HTTP work. Writes and stateful calls retain independent upstream signals. Provider group quotas apply across aliases in the same pool, not across processes or independent pools.

## State and log reads

Quantity hex, data hex and transaction extensions pass through untouched. Type-3 fields such as `blobVersionedHashes` and `maxFeePerBlobGas` remain separate from execution gas fields. Blob sidecars and beacon APIs are outside this execution transport. Pending reads are not cached; finality tags and full params, including `feeCurrency`, participate in read keys. Hash and numeric selectors are preserved. Private-relay writes, signing, filters and subscriptions are never raced, cached or coalesced. Server-local filter IDs are owned by the endpoint that created them.

Recently used log filters keep rolling indexes with `cache.logsWindow` blocks (default 1000). Covered numeric subsets and fresh latest-ended queries answer from memory; misses fetch exact numeric gaps through the same capability and budget checks as other reads. Unsupported generated ranges fall back to the unchanged original query without indexing an unpinned response. Block-hash filters use ordinary fresh entries on reorg-capable chains. `requestLogs` remains the way to split explicit numeric ranges that exceed a provider limit.

For a provider's documented numeric log range limit, use the shared helper:

```ts
import { requestLogs } from "@bloxwap/smart-rpc/ethereum";

const logs = await requestLogs(pool, {
  fromBlock: "0x100",
  toBlock: "0x1ff",
  address: "0x0000000000000000000000000000000000000000",
}, { maxBlockRange: 50, maxRequests: 10 });
```

Each split uses the pool and shared batch operation budget. The helper rejects if any split fails; it does not return an incomplete log list. Hash-based filters and tag ranges pass through unchanged. `maxRequests` prevents unbounded allocation (default 100); the pool's operation budget independently limits actual upstream calls. A normal `request({ method: "eth_getLogs" })` whose numeric range or topic count exceeds every configured provider's capabilities is rejected before dispatch rather than silently split.

## Dedicated subscriptions

The generic request API cannot carry notification callbacks, so it rejects `eth_subscribe` and `eth_unsubscribe`. Use an explicit provider-documented WebSocket URL and the dedicated session API:

```ts
import { connectViem } from "@bloxwap/smart-rpc/ethereum";

const session = connectViem(process.env.ETHEREUM_WS_URL!, {
  timeout: 10_000,
  expectedChainId: 1,
  reconnect: { attempts: 5, delay: 1_000 },
});
const subscription = await session.subscribe({
  params: ["newHeads"],
  onData: (notification) => console.log(notification),
  onError: (error) => console.error(error),
});
await subscription.unsubscribe();
session.close();
```

This dedicated connection verifies its own chain identity. viem owns the socket, reconnects to that same endpoint and resubscribes, updating `subscriptionId`. It does not fail over subscriptions to another provider. `close()` releases this session's subscriptions without closing viem's shared socket underneath other clients. Direct connection calls and subscriptions are outside pool quotas and scoring; configure provider usage accordingly. Browser-compatible WebSocket authentication uses the provider's documented URL, not arbitrary HTTP headers; passing WS headers throws instead of dropping them.

## Validation

Deterministic tests cover identity quarantine, capability routing, authenticated headers, original tags and blob fields, independent write calls, batch partial errors, log range limits and session lifecycle. Shared-core tests cover cancellation, retry budgets, stale heads, probe-vs-call scoring and reorg cache invalidation.

An optional read-only public smoke verifies identity, a head and latest/safe/finalized blocks:

```sh
SMART_RPC_ETHEREUM_LIVE=1 pnpm --filter @smart-rpc/ethereum test
# ETHEREUM_RPC_URL can select a dedicated provider.
# ETHEREUM_ARCHIVE_RPC_URL and ETHEREUM_WS_URL enable optional provider capability tests.
```

Source references: [Ethereum execution JSON-RPC](https://ethereum.org/en/developers/docs/apis/json-rpc/), [EIP-4844](https://eips.ethereum.org/EIPS/eip-4844), [viem HTTP transport](https://viem.sh/docs/clients/transports/http), and [viem WebSocket transport](https://viem.sh/docs/clients/transports/websocket). No Ethereum-wide batch, archive, trace or WebSocket limit is assumed.
