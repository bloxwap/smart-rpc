# Folding smart-hyperevm and smart-solana into smart-rpc

This is the map for moving [bloxwap/smart-hyperevm](https://github.com/bloxwap/smart-hyperevm) (`092b8f9`) and [bloxwap/smart-solana](https://github.com/bloxwap/smart-solana) (`ff5891a`) onto this repo. v1 is one published package, `@bloxwap/smart-rpc`, with the shared router and thin transports compiled in. It is not a drop-in rename of either package.

Callers install that package only:

```sh
npm install @bloxwap/smart-rpc
```

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { hyperevm } from "@bloxwap/smart-rpc/hyperevm";
import { solana } from "@bloxwap/smart-rpc/solana";
```

The workspace packages below are private. They are how the repo is organized. They are not on npm, and they are not peer dependencies. The release build of `@bloxwap/smart-rpc` compiles them into `dist/index.js` and the subpath entries.

## Where the code goes

| Today | In this repo | Published as |
| --- | --- | --- |
| `smart-hyperevm` `transport/_score.ts`, `_breaker.ts`, `_race.ts`, `_budget.ts`, `_coalesce.ts`, `_pin.ts`, `_scoreboard.ts`, the send loop in `transport/mod.ts` | private `@smart-rpc/core` | `@bloxwap/smart-rpc` |
| `transport/_methods.ts` (idempotency, reverts, block-not-held) | private `@smart-rpc/core` `evm-methods.ts`, passed in by the ethereum transport | `@bloxwap/smart-rpc` |
| viem `http()` / `webSocket()` child transports, `eth_chainId`, `eth_blockNumber` | private `@smart-rpc/ethereum` | `@bloxwap/smart-rpc/ethereum` |
| Chain 999 / 998, `https://rpc.hyperliquid.xyz/evm`, official 1.5 rps burst 3, HyperCore precompile pin-skip | private `@smart-rpc/hyperevm`, which calls `ethereum()` | `@bloxwap/smart-rpc/hyperevm` |
| `smart-solana` method safety, genesis hashes, default public endpoints, `getSlot` / `getGenesisHash` | private `@smart-rpc/solana` | `@bloxwap/smart-rpc/solana` |
| Public endpoint discovery and registry data | Source-backed registries in the Ethereum, HyperEVM, and Solana packages; the shared pool ranks endpoints at runtime. | Each transport subpath |
| Persisted registry rankings, warm-start persistence, the rolling `eth_getLogs` index | Not ported. The source registries carry provenance and local budgets, not historical scores. | — |

Callers that use `createPublicClient({ transport: smartHyperevm() })` can use `asViemTransport(options)` from the ethereum subpath. It delegates to pools and keeps routing policy out of the viem adapter. Equivalent clients share one pool, while chain, timeout, and retry variants remain isolated; matching variants spend factory-scoped endpoint and provider budgets. The ethereum transport still uses viem `http()` and `webSocket()` as the child of each endpoint.

## What stays the same

Core defaults are the HyperEVM transport at `092b8f9`, for every chain:

- EWMA constants in `_score.ts` (`latencyMix` 0.6, alphas 0.4 / 0.2 / 0.5 / 0.05, `errorAlpha` 0.3, `livenessAlpha` 0.15, `errorWeight` 8, `queueWeight` 0.25, prior 250ms, confidence 5, method blend 3).
- In-flight penalty `1 + n + 0.25 n²`.
- Power-of-two-choices, top-2 race for safe reads.
- Breaker: 3 failures, 5s cooldown, doubling to 60s. Probe success does not clear a streak that holds a failed call. `Retry-After` ejects immediately.
- 2 extra retries, 10s attempt timeout, immediate failover when another endpoint is up, jittered backoff from 100ms capped at 2s.
- Probe every 4s, stop after 60s idle. Liveness is separate from the latency EWMA.
- Stale heads (30s) and outlier heads (`maxAhead` 1000, and no reference when only two heads disagree) match `_scoreboard.ts`.
- Block-tag pinning matches `_pin.ts`, including the 1s freshness window. HyperEVM keeps the precompile exception (`0x…0800`–`0x…08ff`). Ethereum leaves that skip off: those addresses are not special on Ethereum. The reference always skips them because it only speaks HyperEVM.

## What changes, and why

The brief says to follow the HyperEVM reference when it disagrees with smart-solana. These smart-solana behaviors are not copied:

- Backoff base 150ms and cap 30s. Core uses 100ms to 2s.
- A successful probe resetting call failures. Core keeps the HyperEVM rule: probes do not clear call failures.
- Per-method cache TTLs (400ms to hours). Core uses the HyperEVM window: 2 seconds and one freshness unit of lag. Solana still chooses which methods may be cached; `getSlot` is the freshness unit.

`solana:mainnet`, `solana:devnet`, and `solana:testnet` are aliases. Each cluster also registers `solana:<genesis hash>`, which is the CAIP-2 chain reference from the Solana namespace. `createSmartRpc` matches the string the caller passes. It does not guess.

Public endpoint registries are now included as transport data. HyperEVM mainnet and testnet each use their own list, including the official URL and documented public alternatives. Ethereum mainnet and each Solana cluster use the same approach. Registry entries carry provider/source metadata and conservative request budgets; core owns runtime scoring and fallback. The old `registry/nodes.json` historical rankings and ranker are not loaded. See [Public RPCs](docs/PUBLIC_RPCS.md) for sources, limitations, and verification commands.

An explicit `endpoints` array still replaces the defaults. For `hyperevm()` serving both chains, `endpoints` selects mainnet endpoints and `testnetEndpoints` selects testnet endpoints. The official HyperEVM mainnet budget remains 1.5 rps, burst 3. Solana's public endpoint budgets now account for provider-specific limits instead of carrying over the old endpoint settings unchanged.

Automatic health probes preserve the last available token on budgeted endpoints so slow-refill public services can still serve requests. Explicit `probe()` calls may spend it. Concurrent probes share one pending sweep, and timed-out attempts cancel their underlying request.

The v1 read cache does not include the reference log index or background hot-key refresh. State reads, hashes, and `eth_chainId` are cached. `eth_getLogs`, filters, subscriptions, gas estimates, and nonces at `"latest"` are not. Port `_cache.ts` into core behind the same `CachePolicy` hook when log queries need the index.

Score persistence (`_warmstart.ts`, `localStoragePersistence`) is not ported. A `persist` option can sit on the pool later without a chain import.

## Suggested order

1. Point new callers at `npm install @bloxwap/smart-rpc` and the subpath for the chain they use (`@bloxwap/smart-rpc/hyperevm`, `@bloxwap/smart-rpc/solana`). Keep smart-hyperevm and smart-solana published until those callers move. Do not publish the private workspace packages.
2. Use `asViemTransport(options)` from the ethereum subpath for `createPublicClient`. For HyperEVM, set `chainId: 999`, `skipPrecompiles: true`, the HyperEVM endpoints, and `HYPEREVM_SAFE_METHODS`; the adapter supplies equivalent-client sharing and budget coordination.
3. Review and refresh the included source-backed endpoint registries with `pnpm check:rpcs` after building. Preserve provider budgets and separate chain identities; the public defaults ship through the transport subpaths.
4. Port the log index and warm-start into the private core package behind the existing cache and scoreboard hooks.
5. Replace smart-solana's transport internals with the Solana code in this repo. Reconcile new public endpoints into the source-backed cluster registries. Do not bring its breaker or backoff numbers back.

A process that keeps the old `smart-hyperevm` package alongside this adapter still has two independent budget stores. Migrate equivalent clients to one adapter scope, or give the old and new transports separate allowances.
