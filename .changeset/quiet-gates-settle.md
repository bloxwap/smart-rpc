---
"@bloxwap/smart-rpc": patch
---

Handle both outcomes of a shared identity check, so a policy hook that throws while the check is failing rejects the call without also raising an unhandled promise rejection.
