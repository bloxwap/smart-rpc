# Avalanche C-Chain

```ts
import { avalanche } from "@bloxwap/smart-rpc/avalanche";

const pool = avalanche();
const head = await pool.request({ method: "eth_blockNumber" });
pool.close();
```

`avalanche()` registers `eip155:43114`, with AVAX native currency metadata (18 decimals). It composes the canonical Ethereum adapter and shared core. The default is `https://api.avax.network/ext/bc/C/rpc`; the separately exported WebSocket address is `wss://api.avax.network/ext/bc/C/ws`. Atomic `/ext/bc/C/avax`, P-Chain, and X-Chain endpoints and namespaces are rejected. Chain identity is checked before a user call. [Avalanche RPC documentation](https://build.avax.network/docs/rpcs/c-chain)

The [Helicon upgrade](https://build.avax.network/docs/primary-network/helicon-upgrade) separates consensus acceptance from execution and settlement. The adapter preserves tags and response fields: `latest` and normally `pending` address executed blocks, while `safe`/`finalized` address settled blocks. A node can instead configure `pending` to refer to accepted state; that node may reject state reads until execution. Empty logs for an unexecuted block are not cached as a permanent result. Header roots, bloom, and gas fields are passed through unchanged; they must not be treated as an executed receipt. The `newAcceptedTransactions` notification similarly is not a receipt. [RPC semantics](https://build.avax.network/docs/rpcs/c-chain)

`eth_baseFee` and `eth_suggestPriceOptions` are explicit safe read extensions. The public endpoint cannot serve `eth_getChainConfig`; a dedicated node may. Read live fees instead of baking in a historical gas-price floor: header/baseFee values are upper bounds, while receipt values describe execution. [Fee documentation](https://build.avax.network/docs/rpcs/other/guides/txn-fees)

The registry records provider, sources, review date, method restrictions, and capabilities. No undocumented numeric rate or batch limit is invented. Archive, debug/trace, batching, numeric pinning, and finality-tag guarantees are disabled in the default profile until verified for the selected provider. A rejected historical/finality read is never rewritten to `latest`. Configure explicit dedicated endpoints and request budgets for production traffic:

```ts
const dedicated = avalanche({
  endpoints: [{
    url: process.env.AVALANCHE_RPC_URL!,
    headers: { "x-api-key": process.env.AVALANCHE_RPC_KEY! },
    capabilities: {
      archive: true,
      blockTags: ["latest", "pending", "safe", "finalized", "earliest"],
      pinning: true,
    },
  }],
  operationBudget: { maxRequests: 16, timeout: 20_000 },
});
```

`supportedMethods` replaces an endpoint's method allowlist. Use the exported `AVALANCHE_RPC_METHODS` plus only the provider's verified extension methods; `debug` and `trace` also need their capability flags. `requestBatch` returns ordered per-item settled results under one operation budget. HTTP batching is separately opt-in and uses viem's cancellation isolation. Subscriptions use `connectViem` from the Ethereum subpath with a verified WS URL and `expectedChainId: 43114`; keep that dedicated session, handle its notifications, and unsubscribe/close it when finished. `subscribeAcceptedTransactions(connection, { onData, fullTransactions: true })` supports the Avalanche acceptance event without interpreting it as execution. Pool requests do not deliver subscription notifications.

Observed verification on 2026-11-06: public HTTP identity/head, safe/finalized block reads, and a two-item partial-error batch passed. The documented public WS URL returned `-32601` for `eth_chainId`, so it could not establish the identity required by the dedicated subscription session. That endpoint remains unverified for subscriptions; use a provider supporting identity checks on the same connection. Historical state was not tested without an archive provider. The conservative default capability flags remain unchanged by this one observation.

Run `pnpm --filter @smart-rpc/avalanche test` for deterministic fixtures. `SMART_RPC_LIVE=1 pnpm --filter @smart-rpc/avalanche test` also checks the public identity and executed head. Add `SMART_RPC_AVALANCHE_CAPABILITIES=1` to check tags, a small partial-error batch, and WS lifecycle. Archive verification additionally requires `SMART_RPC_AVALANCHE_ARCHIVE_URL` and `SMART_RPC_AVALANCHE_ARCHIVE_BLOCK`. These explicit network checks establish behavior at that time, not a provider SLA or quota ceiling.
