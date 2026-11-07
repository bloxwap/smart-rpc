# Folding smart-hyperevm and smart-solana into smart-rpc

This is the map for moving [bloxwap/smart-hyperevm](https://github.com/bloxwap/smart-hyperevm) (`092b8f9`) and [bloxwap/smart-solana](https://github.com/bloxwap/smart-solana) (`ff5891a`) onto this repo. v1 is the shared router plus thin transports. It is not a drop-in rename of either package.

## Where the code goes

| Today | Here |
| --- | --- |
| `smart-hyperevm` `transport/_score.ts`, `_breaker.ts`, `_race.ts`, `_budget.ts`, `_coalesce.ts`, `_pin.ts`, `_scoreboard.ts`, the send loop in `transport/mod.ts` | `@smart-rpc/core` |
| `transport/_methods.ts` (idempotency, reverts, block-not-held) | `@smart-rpc/core` `evm-methods.ts`, passed in by `@smart-rpc/ethereum` |
| viem `http()` / `webSocket()` child transports, `eth_chainId`, `eth_blockNumber` | `@smart-rpc/ethereum` |
| Chain 999 / 998, `https://rpc.hyperliquid.xyz/evm`, official 1.5 rps burst 3, HyperCore precompile pin-skip | `@smart-rpc/hyperevm`, which calls `ethereum()` |
| `smart-solana` method safety, genesis hashes, default public endpoints, `getSlot` / `getGenesisHash` | `@smart-rpc/solana` |
| Ranked public registry, warm-start persistence, the rolling `eth_getLogs` index | Not in v1. Leave them in smart-hyperevm until a follow-up moves the registry in as data the HyperEVM transport loads. |

Callers that do `createPublicClient({ transport: smartHyperevm() })` need an adapter. v1's public call is `rpc.request({ chainId, method, params })`. The ethereum transport still uses viem `http()` and `webSocket()` as the child of each endpoint. A later `asViemTransport(pool)` can wrap `createTransport` without moving policy back into the chain package.

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

The HyperEVM registry (`registry/nodes.json` and the ranker) is not loaded. `hyperevm()` defaults to the official URL, plus the testnet URL `https://rpc.hyperliquid-testnet.xyz/evm` for chain 998. The reference registry at `092b8f9` is mainnet-only. Testnet is called out here so folding the registry does not silently drop chain 998.

The v1 read cache does not include the reference log index or background hot-key refresh. State reads, hashes, and `eth_chainId` are cached. `eth_getLogs`, filters, subscriptions, gas estimates, and nonces at `"latest"` are not. Port `_cache.ts` into core behind the same `CachePolicy` hook when log queries need the index.

Score persistence (`_warmstart.ts`, `localStoragePersistence`) is not ported. A `persist` option can sit on the pool later without a chain import.

## Suggested order

1. Point new callers at `createSmartRpc` and the subpath for the chain they use. Keep smart-hyperevm and smart-solana published until those callers move.
2. Add a viem `Transport` adapter in `@smart-rpc/ethereum` that delegates to the pool, so `createPublicClient` sites can switch without rewriting call sites. Map `smartHyperevm({ endpoints, onEvent })` onto `hyperevm({ endpoints, onEvent })`.
3. Move `registry/nodes.json` into `@smart-rpc/hyperevm` and use eligible HTTP URLs as the default endpoint list, keeping the official budget.
4. Port the log index and warm-start into core behind the existing cache and scoreboard hooks.
5. Replace smart-solana's transport internals with `@smart-rpc/solana`. Keep its cluster endpoint list if it is ahead of the short default in this repo. Do not bring its breaker or backoff numbers back.

Until step 2, a process that needs both a viem client and this router should use this router for new calls and leave the old transport in place for the viem client. Do not run both against the same provider budget unless each has its own `budget`.
