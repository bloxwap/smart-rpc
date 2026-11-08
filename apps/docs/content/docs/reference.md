---
title: Library reference
---

# smart-rpc

One JSON-RPC client that routes by [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) chain id.

Shared routing lives in `@smart-rpc/core`: EWMA scoring, power-of-two-choices, a top-2 race for safe reads, a circuit breaker, retries, per-endpoint budgets, coalescing, a hot freshness-bounded cache with rolling log indexes, warm-start score persistence, cancellation, and health probes. Chain packages are thin transports. They supply the probe, the chain-identity check, and which methods are safe to retry. Nothing in the core imports a chain.

Install one package. The root entry re-exports the core and nothing else. Transports are subpaths of that same package, so a bundler only includes a chain you import, and importing the root does not register every transport.

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { ethereum } from "@bloxwap/smart-rpc/ethereum";
import { hyperevm } from "@bloxwap/smart-rpc/hyperevm";
import { solana } from "@bloxwap/smart-rpc/solana";

const rpc = createSmartRpc({
  transports: [ethereum(), hyperevm(), solana()],
});

const block = await rpc.request({
  chainId: "eip155:999",
  method: "eth_blockNumber",
  params: [],
});
```

`eip155:999` is HyperEVM. `eip155:1` is Ethereum mainnet. `solana:mainnet` is Solana. A chain id only reaches the transport that registered it.

## Install

```sh
npm install @bloxwap/smart-rpc
```

```sh
pnpm add @bloxwap/smart-rpc
```

```sh
yarn add @bloxwap/smart-rpc
```

That install is the whole library. Core, Ethereum, HyperEVM, and Solana are compiled into `@bloxwap/smart-rpc`. There is no second package to add for a chain. `viem` is a dependency of this package, used by the Ethereum and HyperEVM subpaths as `http()` / `webSocket()` child transports. Solana speaks JSON-RPC over `fetch`. A bundler that only imports `@bloxwap/smart-rpc/solana` does not include the EVM transports.

## Layout

| Path | Role |
| --- | --- |
| `@bloxwap/smart-rpc` | Published package. Root export is the core. |
| `@bloxwap/smart-rpc/ethereum` | EVM JSON-RPC. Probe `eth_blockNumber`. Quarantine on `eth_chainId`. Pins `"latest"`. |
| `@bloxwap/smart-rpc/hyperevm` | Ethereum transport with separate public RPC pools for `eip155:999` / `eip155:998`. |
| `@bloxwap/smart-rpc/solana` | Probe `getSlot`. Quarantine on `getGenesisHash`. |
| `packages/core`, `packages/ethereum`, `packages/hyperevm`, `packages/solana` | Private workspace packages. Not published. The release build compiles them into `@bloxwap/smart-rpc`. |
| `examples/quick-start` | The snippet above |

HyperEVM mainnet is chain id 999 (`eip155:999`); testnet is chain id 998 (`eip155:998`). `hyperevm()` with no arguments serves both through separate endpoint pools. Both include the official RPC and documented public alternatives. The official mainnet URL keeps the reference budget of 1.5 requests per second, burst 3.

Solana registers `solana:mainnet` and the genesis-hash CAIP-2 id `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. Devnet and testnet have the same pair of aliases.

## Public RPC defaults

The package also includes these EVM transports. Each factory uses the shared Ethereum adapter and core routing policies, verifies its own chain identity, and accepts dedicated endpoints and HTTP headers. Import the factory from its subpath, for example `import { base } from "@bloxwap/smart-rpc/base"`.

| Transport and provider notes | Subpath / factory | CAIP-2 id |
| --- | --- | --- |
| [BNB Smart Chain](./transports/bsc.md) | `bsc` | `eip155:56` |
| [Polygon PoS](./transports/polygon.md) | `polygon` | `eip155:137` |
| [Base](./transports/base.md) | `base` | `eip155:8453` |
| [Arbitrum One](./transports/arbitrum.md) | `arbitrum` | `eip155:42161` |
| [Monad](./transports/monad.md) | `monad` | `eip155:143` |
| [X Layer](./transports/xlayer.md) | `xlayer` | `eip155:196` |
| [Robinhood Chain](./transports/robinhood.md) | `robinhood` | `eip155:4663` |
| [Plasma](./transports/plasma.md) | `plasma` | `eip155:9745` |
| [Ink](./transports/ink.md) | `ink` | `eip155:57073` |
| [OP Mainnet](./transports/optimism.md) | `optimism` | `eip155:10` |
| [opBNB](./transports/opbnb.md) | `opbnb` | `eip155:204` |
| [Arc](./transports/arc.md) | `arc` | `eip155:5042` |
| [Etherlink](./transports/etherlink.md) | `etherlink` | `eip155:42793` |
| [Avalanche C-Chain](./transports/avalanche.md) | `avalanche` | `eip155:43114` |
| [Celo](./transports/celo.md) | `celo` | `eip155:42220` |
| [Gnosis](./transports/gnosis.md) | `gnosis` | `eip155:100` |
| [Mantle](./transports/mantle.md) | `mantle` | `eip155:5000` |
| [Flare](./transports/flare.md) | `flare` | `eip155:14` |

The existing `ethereum`, `hyperevm`, and `solana` subpaths remain available. Public endpoint records expose verified restrictions; undocumented numeric quotas and optional capabilities are not assumed. See each transport's notes before enabling archive, debug/trace, finality tags, HTTP batches, or subscriptions.

Ethereum mainnet, HyperEVM mainnet/testnet, and Solana mainnet/devnet/testnet have source-backed registries of free HTTP endpoints that do not require an API key. The transports pass those endpoints into the shared pool, so defaults use the same scoring, identity checks, failover, racing, circuit breakers, caching, and request budgets as custom endpoints. Endpoint discovery does not run in the client.

Each registry entry records its provider, source URLs, review date, and local request budget. These budgets are conservative client settings, not purchased capacity or provider guarantees. They cover calls, retries, identity checks, and probes in that pool; other clients and processes sharing your IP can also consume the provider's quota. Services that require a free account or API key are documented separately and can be configured explicitly.

See [Public RPCs](./public-rpcs) for coverage, provider sources, restrictions, and live verification instructions. Registries are exported from their transport subpaths:

```ts
import { ETHEREUM_MAINNET_REGISTRY } from "@bloxwap/smart-rpc/ethereum";
import { HYPEREVM_MAINNET_REGISTRY, HYPEREVM_TESTNET_REGISTRY } from "@bloxwap/smart-rpc/hyperevm";
import { MAINNET_REGISTRY, DEVNET_REGISTRY, TESTNET_REGISTRY } from "@bloxwap/smart-rpc/solana";
```

Passing `endpoints` replaces the selected network's defaults. With no `endpoints`, `ethereum()` passes each registry entry's budget, unsupported methods and capabilities (archive, batch size, log span) into the pool. To add your own provider while keeping the public pool, its budgets and its capabilities, map its exported registry:

```ts
import { ethereum, ETHEREUM_MAINNET_REGISTRY } from "@bloxwap/smart-rpc/ethereum";

const transport = ethereum({
  endpoints: [
    { url: process.env.ETHEREUM_RPC_URL!, label: "my-provider", rps: 5, burst: 5 },
    ...ETHEREUM_MAINNET_REGISTRY.map(({ url, rps, burst, unsupportedMethods, capabilities }) => ({
      url, rps, burst, unsupportedMethods, capabilities,
    })),
  ],
});
```

`ETHEREUM_MAINNET_ENDPOINTS` and the HyperEVM endpoint lists expose URLs for compatibility; their registry counterparts also carry budgets. Solana's `MAINNET_ENDPOINTS`, `DEVNET_ENDPOINTS`, and `TESTNET_ENDPOINTS` expose endpoint configurations with budgets. For a dual-network `hyperevm()` transport, `endpoints` replaces mainnet and `testnetEndpoints` replaces testnet. With `chainId: 998`, use `endpoints` for testnet.

## Scoped sharing and viem

Every built-in factory accepts `sharing`. Create one scope per fixed endpoint/credential configuration, then key each consumer variant by its chain, timeout, and retry policy. Equivalent acquisitions share scores, cache, coalescing, identity checks, and probe timers. A lease closes only itself; the last lease closes the underlying pool, and a later acquisition builds a fresh one. `scope.close()` closes the whole factory scope.

```ts
import { createPoolScope } from "@bloxwap/smart-rpc";
import { hyperevm } from "@bloxwap/smart-rpc/hyperevm";

const scope = createPoolScope();
const config = { chainId: 999 as const, endpoints: ["https://rpc.hyperliquid.xyz/evm"] };
const first = hyperevm({
  ...config,
  sharing: { scope, key: "999:10000:2", budgetKey: "999" },
});
const equivalent = hyperevm({
  ...config,
  sharing: { scope, key: "999:10000:2", budgetKey: "999" },
});
```

`budgetKey` defaults to `key`. Keep it unchanged across timeout/retry variants only when they use the same endpoints, credentials, chain, and budget configuration; those variants then share endpoint and provider-group token buckets while keeping separate pools. Different keys or scopes never share learned state. No global pool registry is used.

For viem clients, `asViemTransport(options)` from `@bloxwap/smart-rpc/ethereum` derives these keys from the client chain, timeout, and retry count. It delegates requests to the same pool implementation and exposes `close`, `snapshot`, `probe`, `cacheStats`, and events through the viem transport value. Closing one client does not close an equivalent peer.

## Cache and warm start

The cache canonicalizes block tags, refreshes hot reads in the background, and keeps rolling `eth_getLogs` indexes. Configure `cache` with `maxStaleBlocks`, `maxAgeMs`, `refreshInterval`, `hotKeys`, `hotIdleMs`, `maxEntries`, `maxBytes`, `logsWindow`, `copyResults`, or `immutableParams`. Generated log reads preserve endpoint capabilities and request budgets; latest-only providers retain their unchanged latest-query fallback.

Every pool exposes `scores()` and `restoreScores(snapshot)`. For automatic persistence, pass `persist: { load, save }`; saves are throttled and serialized newest-last. `localStoragePersistence(key)` provides a browser adapter. Snapshots contain global and per-method score books but never heads, breakers, identity state, or raw URLs for unlabeled endpoints.

## Defaults

The shared scoring, breaker and retry constants follow `@bloxwap/smart-hyperevm` at `092b8f9`. Every chain uses them. Several routing rules below go beyond that reference: full credit for fast first samples, released race losers, spare-token rules, rate-limit cooldowns, provider restrictions, and lag-aware leads. Head freshness and endpoint capabilities can vary by chain.

- Score: latency mix 0.6, upward EWMA 0.4, downward 0.2, tail 0.5 / 0.05, error step 0.3, liveness step 0.15, error weight 8, prior 250ms, 5 samples to full confidence, 3 samples to blend a method. A successful sample faster than the 250ms prior counts in full straight away. Slow or failure-only results are still pulled toward the prior until 5 samples.
- In-flight penalty: `1 + n + 0.25 n²`.
- Routing: power of two choices. Safe reads race the top 2 endpoints. The second slot goes first to an endpoint that has no latency sample yet. Racers and hedges must be within `maxLag` and keep a spare token. Race losers are not aborted: they finish in the background, their latency is scored, their answers are discarded, and they stop counting as in-flight. A caller abort still cancels every racer. Hedging is off by default; when it is enabled, hedge losers are aborted.
- Breaker: eject after 3 failures. Cooldown starts at 5s and doubles up to 60s. A health probe cannot clear a streak that includes a failed call. A `Retry-After` on an endpoint failure such as HTTP 503 ejects immediately, capped at 60s. Rate limits never reach the breaker (see [Rate limits](#rate-limits)).
- Retries: 2 extra attempts, 10s per attempt. Another live endpoint is tried at once. Re-trying an endpoint that already failed this call waits a jittered backoff from 100ms, doubling, capped at 2s.
- A total operation budget bounds identity checks, retries, races and batch items: 64 upstream calls and four attempt timeouts by default. Configure `operationBudget: { maxRequests, timeout }` on a transport. `requestBatch()` returns ordered settled results, preserving successful items when siblings fail.
- EVM read safety uses an explicit allowlist. Unknown extensions are single sends unless configured with `safeMethods`; known writes and stateful filters remain unshared. Filter handles stay with the endpoint that created them. Use the Ethereum subpath's dedicated `connectViem(...).subscribe(...)` callback API for subscriptions.
- Probes: every 4s (`eth_blockNumber` on EVM, `getSlot` on Solana). The timer stops after 60s without a request. On budgeted endpoints, automatic probes, race rivals, hedges, cache refreshes and cache head checks all keep the last available token for caller traffic; explicit `probe()` calls may use it. Background cache refreshes never wait for a refill. Probe success and failure update liveness, not the latency EWMA.
- Chain identity: an endpoint whose chain-id check has not run yet is checked in the background while a verified, funded endpoint serves the call. The check may spend an ungrouped endpoint's last token, so a burst-1 endpoint is still verified. An endpoint in a provider group needs a spare token.
- Heads older than 30s stop affecting the score. A head more than 1000 units ahead of the others' median is ignored. Two heads that far apart are not a reference. Lag is time-aligned: an endpoint is compared with the heads its peers had reported by the time its own head arrived. Peer heads that arrive up to 500ms later also count, carried back at `maxUnitsPerSecond` and rounded up.
- EVM transports pin `"latest"` to a block the chosen endpoints hold, and quarantine an endpoint whose `eth_chainId` is wrong. Pinning tolerates at least 2 blocks of lag, even where `maxLag` is lower. Solana quarantines a `getGenesisHash` mismatch. HyperEVM also skips HyperCore precompile `eth_call`s (`0x…0800`–`0x…08ff`) when pinning, because those calls ignore the block.

### Head lag

When a chain declares `blockTimeMs`, `maxLag` defaults to `round(1000 / blockTimeMs)`, at least 1: about one second of blocks. `maxUnitsPerSecond` defaults to 1.25 times the block rate. Without `blockTimeMs`, both defaults stay at 2. An explicit `headLag.maxLag` always wins. Every chain factory passes a measured block time except Ethereum, Polygon and Gnosis; Gnosis sets `maxLag` 2 and 0.2 blocks/s itself. Solana uses `slotTimeMs`, default 220 (`maxLag` 5). [Public RPCs](./public-rpcs#head-freshness) lists each chain's value.

An endpoint lagging past `maxLag` does not lead, race or hedge a head-sensitive read while a verified, closed, funded and fresh endpoint exists. On EVM chains, head-sensitive reads are those with a `latest` or `pending` tag (given or implied), log filters that end at the head, and head methods such as `eth_blockNumber` and `eth_gasPrice`. On Solana, every read is head-sensitive except fixed-slot, signature and cluster-constant reads and reads with `finalized` commitment. A lagging endpoint still leads block-number, block-hash, `safe`/`finalized` and transaction reads, and remains a failover once the first attempt fails. Pinned reads already exclude endpoints that lack the pinned block, so this rule does not apply to them. A policy can override the rule with `isHeadSensitive`.

### Failure handling

Every endpoint error falls into one class. The classifier reads the message, viem's `details` and JSON-RPC `data` along the error's cause chain. It reads viem's `shortMessage` instead of `message` when present, so the request body viem prints into `message` is never matched.

| Class | Matches | Effect |
| --- | --- | --- |
| Terminal | Reverts, transaction verdicts, bare invalid params (`-32602` without restriction wording) and the other terminal codes | Returned to the caller. The endpoint counts as healthy. |
| Rate limit | HTTP 429, `-32005`, or wording such as "rate limit", "too many requests", "requests per second", "exceeds defined limit" | The call fails over and the endpoint cools down. See [Rate limits](#rate-limits). |
| Provider restriction | Provider policy wording under any code, including `-32602`, `-32701` and HTTP 429: personal or API token required, "request blocked", "not served by … endpoint", "this endpoint will not serve", "please specify an address", "missing required field 'address' for log filter", "requires a … filter", paid-plan only, block-range, result, response-size and deliverable-ceiling limits, "retry with the range", "limited to N blocks" | The call fails over with no breaker strike and no score change. |
| Block not held | The endpoint has not reached the named block | The call fails over without counting against the endpoint. |
| Failure | Everything else | The call fails over and the failure counts against the endpoint. |
| Abort | The caller cancelled | Nothing is retried. |

After a restriction, the endpoint does not lead the same request shape again for 60 seconds while another endpoint can serve it, and it is not retried within the same call. A shape is the method plus, for each parameter, its object key names, its block tag, or whether it is a quantity or another string. A numeric log range also adds its order of magnitude (ceil log2 of the span). A refused 5,000-block query therefore bars only ranges of similar size, not a 50-block query with the same filter. A restriction answer to the head-probe method (`eth_blockNumber`, or `getSlot` on Solana) counts as an endpoint failure: that probe takes no parameters, so refusing it means the whole endpoint is refused. On Solana, `-32005` means "node unhealthy" and counts as a failure unless it comes with HTTP 429 or rate-limit wording. A policy can override the classes with `isRateLimited` and `isRestriction`.

The EVM transport rewrites a non-2xx JSON error body that has no JSON-RPC envelope (Sentio's, for example) into a JSON-RPC error that carries the provider's message, and keeps the status and headers, so the classifier sees the real reason. The Solana client keeps a gateway's error body (a JSON message or text) in `details`.

### Rate limits

A rate limit never ejects an endpoint and never changes its latency or error score. Instead:

- The endpoint gets no requests for exactly its `Retry-After`, up to 300s. Without one, the cooldown is 1s. It doubles, up to 30s, each time the endpoint answers 429 again straight after a cooldown, and resets on its first successful answer. A 429 that lands during a cooldown was sent before it began, so it does not count as a repeat.
- A budgeted endpoint's rate is halved, never below 10% of the configured rate, and its burst shrinks with it. The rate recovers by 5% of the configured rate per second of successful use. It does not recover while the pool is idle.
- An endpoint without a budget gets a learned one at half the rate it was being sent (at least 0.5 rps). The learned budget is dropped after 60s without a rate limit. A shared `providerBudget` is cut as well.
- While cooling down, the endpoint reports `tokens: 0` and `throttledMs` above zero in its snapshot. It is skipped like a spent budget and gets no probes or chain checks. A learned budget makes `tokens` a number instead of `null` while it lasts.
- Each rate limit emits `{ type: "throttle", endpoint, cooldownMs, rps, error }`. `rps` is the effective rate after the cut.

When every endpoint is in a cooldown or `Retry-After` window, a call waits up to 2s and then throws `BudgetExhaustedError` for the rest of the window, which can last up to 300s. This includes any single-endpoint pool after a 429. Earlier versions ejected the endpoint and could still send to it as a last resort.

### Related options

`ethereum({ blockTimeMs })` and the EVM chain factories built on it accept `blockTimeMs`; `solana({ slotTimeMs })` accepts the slot time. A custom `ChainPolicy` can set `blockTimeMs`, `isRateLimited`, `isRestriction` and `isHeadSensitive`. The published root exports the `ChainPolicy`, `EndpointSnapshot` and `RpcEvent` types that carry these fields. Inside the workspace, `@smart-rpc/core` also exports `classifyRpcError`, `isRateLimitError`, `isProviderRestriction`, `RpcErrorClass`, `blockCadence`, `BLOCK_RATE_HEADROOM`, `DEFAULT_LAG_TOLERANCE_MS`, `isHeadSensitiveRead`, the `RATE_LIMIT_*` constants and `RateLimitOutcome`.

Pass `retryCount`, `timeout`, `operationBudget`, `race`, `breaker`, `budget`, `cache`, `persist`, `sharing`, `endpoints`, `now`, and `random` on a transport to override a default. Registration stays explicit:

```ts
createSmartRpc({ transports: [hyperevm({ endpoints: ["https://rpc.hyperliquid.xyz/evm"] })] });
```

## Add a transport

An app can register a custom transport without a new package. `createPool` is exported from the root. Do not import a built-in chain from the root; import its subpath.

```ts
import { createPool, createSmartRpc, type ChainPolicy } from "@bloxwap/smart-rpc";

const policy: ChainPolicy = {
  chainIds: ["eip155:8453"],
  probeMethod: "eth_blockNumber",
  probeParams: [],
  parseHead: (result) => (typeof result === "string" ? Number.parseInt(result, 16) : null),
  identityMethod: "eth_chainId",
  identityParams: [],
  expectedIdentity: 8453,
  parseIdentity: (result) => (typeof result === "string" ? Number.parseInt(result, 16) : null),
  isSafeMethod: (method) => !method.startsWith("eth_send"),
  pin: true,
};

const base = createPool({
  policy,
  endpoints: [
    {
      id: "base",
      url: "https://mainnet.base.org",
      call: async (request, options) => {
        const response = await fetch("https://mainnet.base.org", {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: request.method, params: request.params ?? [] }),
          signal: options?.signal,
        });
        const body = await response.json();
        if (body.error) throw new Error(body.error.message);
        return body.result;
      },
    },
  ],
});

const rpc = createSmartRpc({ transports: [base] });
await rpc.request({ chainId: "eip155:8453", method: "eth_blockNumber", params: [] });
```

For an EVM chain that viem already speaks, prefer `ethereum({ chainId, endpoints })` from `@bloxwap/smart-rpc/ethereum`. It wires `http()` / `webSocket()`, pinning, and `eth_chainId`.

To ship a new chain inside this repo, add a private workspace package and a subpath file under `packages/smart-rpc/src` that re-exports its factory. The release build compiles that subpath into `@bloxwap/smart-rpc`. Leave `src/index.ts` as a re-export of the core only, so the new chain is not imported by the package root.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Node 22 and pnpm 10. The workspace is `packages/*` and `examples/*`.

`pnpm check:rpcs --protocol base` checks a built transport's public endpoints for chain identity and current head. Omit `--protocol` to check all registries. The manual **Public RPC smoke** GitHub Actions workflow runs the same check and saves its report; normal CI remains independent of public endpoint availability. Each chain package documents additional opt-in capability checks.
