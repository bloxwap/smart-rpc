---
"@bloxwap/smart-rpc": minor
---

Add source-backed public RPC registries for Ethereum, HyperEVM, and Solana, with provider budgets and method restrictions feeding the existing smart transport. Export registry metadata through the chain subpaths and add an opt-in identity/head checker.

Forward timeout cancellation to upstream requests, coalesce overlapping health probes, reserve foreground capacity during automatic probes, and reject malformed Solana responses so they trigger fallback.
