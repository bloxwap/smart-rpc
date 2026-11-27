---
"@bloxwap/smart-rpc": minor
---

Add a `weighting` pool option. `"fixed"` (the default) keeps dividing an endpoint's score by its weight for the life of the pool. `"prior"` treats the weight as a belief held before measurement and fades it to neutral over the endpoint's first five latency samples.

Behaviour change: `hyperevm()` now defaults to `weighting: "prior"`. Its registry weights come from weekly probe history, and as permanent divisors they ranked a 450ms established endpoint ahead of 120ms endpoints with capped weights. Pass `weighting: "fixed"` to keep explicit weights permanent.

Refresh the HyperEVM and Solana defaults from a live audit on 2026-11-27. HyperEVM: add Purroof Group, and raise the budgets of Hypurrscan, dRPC and PublicNode from 1 to 4 requests/second after each sustained 5 requests/second for 60 seconds (Stakely and the official RPC are unchanged). Solana mainnet: remove Solana Vibe Station, which timed out on every connection, raise PublicNode to 4 requests/second and the official endpoint's burst to 6. On the router benchmark HyperEVM's p50 fell from 561ms to 122ms.

Document `pool.probe()` for warming a new pool and a longer keep-alive `fetchFn` for Node servers, where the default 4-second idle timeout adds a handshake to requests after a pause.
