# @bloxwap/smart-rpc

## 0.3.0

### Minor Changes

- 7ef8901: Re-audit every public registry against live benchmarks: remove dead, stale or persistently throttled endpoints (Celo dRPC, Polygon ZAN, Ink dRPC, Robinhood thirdweb, Etherlink dRPC, Plasma and Solana mainnet Tatum, Solana testnet Web3CDN), add documented replacements (Polygon QuickNode, Celo thirdweb, Ink Pocket, Robinhood GlobalStake, Plasma Tenderly), and correct archive flags, log-range caps, unsupported methods and documented budgets.

  Improve routing quality: time-aligned head lag, block-time-aware lag tolerance per chain (`blockTimeMs` / Solana `slotTimeMs`, now declared by every chain: Ethereum 12s, Polygon 1.5s and Gnosis 5s join the rest, tightening their default `maxLag` from 2 to 1), lagging endpoints no longer lead head-sensitive reads when a fresh endpoint is available, race losers are scored instead of aborted, unsampled endpoints get the second race slot, and races, hedges and cache refreshes spend only spare tokens.

  Rate limits now throttle instead of ejecting: `Retry-After` is honoured exactly (up to 300s), otherwise a short doubling cooldown, with multiplicative budget decrease and additive recovery, and a learned budget for unbudgeted endpoints. A new `throttle` event and `throttledMs` snapshot field report it. Behaviour change: a pool whose only endpoints are all inside a rate-limit hold rejects with `BudgetExhaustedError` for that window rather than ejecting and retrying them.

  Provider restrictions (token-gated methods, address-required log filters, response-size and range ceilings, including messages carried in JSON-RPC `data` or non-JSON-RPC error bodies) fail over to another endpoint without a breaker strike, while genuine invalid-params errors stay terminal.

### Patch Changes

- 7ef8901: Reduce cache-key allocation, avoid redundant LRU updates, and copy cached log results only once while preserving caller isolation. Refresh built-in endpoint ordering from live identity and state-read measurements, remove failing or paid-only public defaults, and refresh HyperEVM's rolling eligibility history. Extend the RPC audit with repeated latency samples and state-method checks.
- 9535054: Classify provider block-range limit errors in linear time. A long, crafted error message from an endpoint could previously stall the event loop for seconds while the failover check ran.
- 7ef8901: Start fresh HyperEVM default pools in their curated eligible endpoint order until a request-latency sample or restored score exists. Then resume normal weighted routing. Custom endpoint weights retain the previous startup behavior; `coldStart: "weighted"` explicitly opts out. Identity verification, capability checks, rate budgets, and circuit breakers still apply.
- 7ef8901: Handle both outcomes of a shared identity check, so a policy hook that throws while the check is failing rejects the call without also raising an unhandled promise rejection.

## 0.2.2

### Patch Changes

- 056e7be: Raise the `viem` dependency range to `^2.57.20` so the published package picks up ox 0.14.67's ABI decode size cap.

## 0.2.1

### Patch Changes

- e4cd714: Publish with npm trusted publishing (OIDC) and provenance instead of an automation token.

## 0.2.0

### Minor Changes

- a5c4630: Add eighteen EVM chain transport subpaths with documented public endpoints and chain-specific capabilities. Harden shared operation budgets, provider quotas, method safety, pinning, caching, batching, and dedicated WebSocket sessions across the transports.
- 9df94f3: Enforce pool invariants that were previously assumptions. Solana unknown methods are single-shot, `earliest` is not rewritten to `0x0`, `getTransaction` is cached without an age limit only at `finalized`, and HyperEVM probes `eth_getBlockByNumber("latest", false)` so a forward reorg drops cached state. Sharing keys, chain ids, breaker and score settings, clocks, and JSON-RPC replies are validated.
- 4f2f051: Add canonical read-cache plans, bounded hot-key background refresh, immutable-params memoization, and fresh monotonic local block numbers. Preserve chain-specific finality policies, HyperCore precompile cache keys, capability and budget checks, exact-block proof requirements, and zero-capacity refresh suppression across every transport.
- 4f2f051: Rank HyperEVM mainnet defaults from rolling identity, head/lag, per-method latency, HyperCore precompile, and realistic log-range observations. Apply established and new-node weight caps, preserve explicit endpoint overrides and registry metadata, and add a bounded pull-request workflow with bad-run rewrite safeguards.
- ad87045: Initial release of `@bloxwap/smart-rpc`. One package: import the core from the root and each chain from a subpath. Transports are compiled in and are not separate installs.
- e50e9ea: Add source-backed public RPC registries for Ethereum, HyperEVM, and Solana, with provider budgets and method restrictions feeding the existing smart transport. Export registry metadata through the chain subpaths and add an opt-in identity/head checker.

  Forward timeout cancellation to upstream requests, coalesce overlapping health probes, reserve foreground capacity during automatic probes, and reject malformed Solana responses so they trigger fallback.

- 4f2f051: Add bounded rolling `eth_getLogs` indexes with exact tail fetching, hot-key refresh, reorg invalidation, shared cache accounting, and capability-safe fallback to original latest queries. Preserve HyperEVM-only immutable block-hash results and latest-only public provider restrictions.
- 4f2f051: Add factory-scoped pool leases with shared learned state, cache, coalescing, probe scheduling, and coordinated endpoint/provider budgets across all built-in transports. Add a viem adapter with equivalent-client reuse and safe independent close behavior.
- 4f2f051: Add opt-in warm-start score persistence to every pool transport. Export validated versioned score snapshots, weak restore priors, sync/async storage adapters with throttled saves and telemetry, and a safe `localStorage` adapter.

### Patch Changes

- 37fa6c8: Expire idle hot keys before head-driven refreshes, including when periodic refresh is disabled. Return successful full log responses without a duplicate RPC when the rolling window or storage limit cannot retain the entire query.
- 4f2f051: Include the package license in the published tarball and update documentation links for the new Fumadocs application.
