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

These are example settings for a provider whose features and quotas you have verified. Capability values omitted from a custom endpoint remain unknown; they do not guarantee support. `archive: false` rejects numeric, earliest and block-hash **state** reads, while historical blocks and logs remain separately accessible. `blockTags` limits named tags at recognized selector positions. `pinning: false` prevents converting latest state to numeric state. A historical or finalized request is never downgraded to latest.

`supportedMethods` is an exact allowlist; `unsupportedMethods` is an explicit denylist. Every pooled EVM endpoint must permit `eth_chainId`. Transaction-only sequencers and relays belong on a separate submission connection because they cannot pass pooled identity/probe checks. `debug: false` and `trace: false` exclude their respective namespaces before dispatch. `safeMethods` allows a chain adapter to opt specific read extensions into racing/retries; unknown methods default to one non-coalesced, uncached attempt.

Batching is opt-in. `capabilities.batch: false` disables it for an endpoint, and `maxBatchSize` caps the configured size. `requestBatch()` returns one settled outcome per input, so a rejected item does not erase successful results. The core shares the operation budget across all items, retries, identities and hedges. A wire batch can contain one item: independent cancellation signals are kept separate by viem. Provider group quotas apply across aliases in the same pool, not across processes or independent pools.

## State and log reads

Quantity hex, data hex and transaction extensions pass through untouched. Type-3 fields such as `blobVersionedHashes` and `maxFeePerBlobGas` remain separate from execution gas fields. Blob sidecars and beacon APIs are outside this execution transport. Pending reads are not cached; finality tags and full params, including `feeCurrency`, participate in read keys. Hash and numeric selectors are preserved. Private-relay writes, signing, filters and subscriptions are never raced, cached or coalesced. Server-local filter IDs are owned by the endpoint that created them.

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
