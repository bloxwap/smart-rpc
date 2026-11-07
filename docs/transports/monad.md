# Monad

`monad()` registers `eip155:143`, with native currency MON (18 decimals). It composes the shared Ethereum adapter and core pool; routing, identity quarantine, retries, coalescing, cancellation and breaker accounting stay in core.

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { monad } from "@bloxwap/smart-rpc/monad";

const rpc = createSmartRpc({ transports: [monad()] });
await rpc.request({ chainId: "eip155:143", method: "eth_blockNumber" });
```

The [network registry](https://docs.monad.xyz/developer-essentials/network-information), reviewed November 6, 2026, supplies five keyless HTTP defaults:

| Endpoint | Documented requests | Items per batch | Historical state |
| --- | --- | --- | --- |
| `rpc.monad.xyz` | 20/s; 5 batches/s | 100 | Yes |
| `rpc1.monad.xyz` | 20/s; 5 batches/s | 100 | Yes |
| `rpc2.monad.xyz` (Goldsky) | 300/10s | 10 | Yes |
| `rpc3.monad.xyz` (Ankr) | 300/10s | 10 | No |
| `rpc-mainnet.monadinfra.com` | 20/s; 5 batches/s | 100 | Yes |

These are documented limits, not uptime guarantees. Foundation aliases share a conservative local bucket (2 requests/s, burst 3); Goldsky/Ankr use 20/s, burst 20. Identity checks and probes consume those budgets. Sharing applies inside one pool, not across processes or other applications using the same IP. `batch` remains opt-in and each endpoint caps batch size. This low Foundation budget also bounds singleton batches below its documented batch rate. Custom endpoints replace defaults and accept headers and capability overrides.

Ankr excludes historical-state and debug requests and numeric latest-state pinning. Historical requests are never changed to latest. Advertised WebSocket URLs are exported as metadata; default pools use HTTP. The network page labels the first two endpoints MF while the [RPC overview](https://docs.monad.xyz/reference/json-rpc/overview) names their operators QuickNode/Alchemy; the registry conservatively groups them together.

Monad has sub-second blocks. Local head checks use a ten-block grace, ten-second stale threshold and 200-block outlier threshold, all overridable through `headLag`. These are routing settings, not finality timing. `latest`, `safe`, `finalized` and `pending` pass through distinctly, and extra result fields are preserved. Trace calls retain their explicit options object. [Historical state availability](https://docs.monad.xyz/developer-essentials/historical-data) is a provider property.

Run deterministic fixtures with `pnpm --filter @smart-rpc/monad test`. Optional capability checks use `MONAD_RPC_INTEGRATION=1 pnpm --filter @smart-rpc/monad test` and `MONAD_WS_INTEGRATION=1 pnpm --filter @smart-rpc/monad test`. They check identity, tags, archive reads, batch partial errors and documented WebSocket addresses. They do not stress provider ceilings or run in ordinary CI.
