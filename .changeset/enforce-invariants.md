---
"@bloxwap/smart-rpc": minor
---

Enforce pool invariants that were previously assumptions. Solana unknown methods are single-shot, `earliest` is not rewritten to `0x0`, `getTransaction` is cached without an age limit only at `finalized`, and HyperEVM probes `eth_getBlockByNumber("latest", false)` so a forward reorg drops cached state. Sharing keys, chain ids, breaker and score settings, clocks, and JSON-RPC replies are validated.
