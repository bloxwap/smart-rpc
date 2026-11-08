---
"@bloxwap/smart-rpc": minor
---

Re-audit every public registry against live benchmarks: remove dead, stale or persistently throttled endpoints (Celo dRPC, Polygon ZAN, Ink dRPC, Robinhood thirdweb, Etherlink dRPC, Plasma and Solana mainnet Tatum, Solana testnet Web3CDN), add documented replacements (Polygon QuickNode, Celo thirdweb, Ink Pocket, Robinhood GlobalStake, Plasma Tenderly), and correct archive flags, log-range caps, unsupported methods and documented budgets.

Improve routing quality: time-aligned head lag, block-time-aware lag tolerance per chain (`blockTimeMs` / Solana `slotTimeMs`), lagging endpoints no longer lead head-sensitive reads when a fresh endpoint is available, race losers are scored instead of aborted, unsampled endpoints get the second race slot, and races, hedges and cache refreshes spend only spare tokens.

Rate limits now throttle instead of ejecting: `Retry-After` is honoured exactly (up to 300s), otherwise a short doubling cooldown, with multiplicative budget decrease and additive recovery, and a learned budget for unbudgeted endpoints. A new `throttle` event and `throttledMs` snapshot field report it. Behaviour change: a pool whose only endpoints are all inside a rate-limit hold rejects with `BudgetExhaustedError` for that window rather than ejecting and retrying them.

Provider restrictions (token-gated methods, address-required log filters, response-size and range ceilings, including messages carried in JSON-RPC `data` or non-JSON-RPC error bodies) fail over to another endpoint without a breaker strike, while genuine invalid-params errors stay terminal.
