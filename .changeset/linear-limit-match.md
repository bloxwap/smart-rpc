---
"@bloxwap/smart-rpc": patch
---

Classify provider block-range limit errors in linear time. A long, crafted error message from an endpoint could previously stall the event loop for seconds while the failover check ran.
