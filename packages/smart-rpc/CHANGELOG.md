# @bloxwap/smart-rpc

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
