---
"@bloxwap/smart-rpc": patch
---

Reduce cache-key allocation, avoid redundant LRU updates, and copy cached log results only once while preserving caller isolation. Refresh built-in endpoint ordering from live identity and state-read measurements, remove failing or paid-only public defaults, and refresh HyperEVM's rolling eligibility history. Extend the RPC audit with repeated latency samples and state-method checks.
