---
title: Polygon PoS
---

# Polygon PoS

`polygon()` registers `eip155:137` and verifies `eth_chainId` before user traffic. It composes the Ethereum adapter and shared core; scoring, circuit breaking, retries, cancellation and probes have no Polygon-specific fork. The native currency metadata is **POL**, with 18 decimals.

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { polygon } from "@bloxwap/smart-rpc/polygon";

const rpc = createSmartRpc({ transports: [polygon()] });
const head = await rpc.request({ chainId: "eip155:137", method: "eth_blockNumber" });
```

The source-backed defaults are dRPC, Tenderly, Allnodes/PublicNode and QuickNode (`https://rpc-mainnet.matic.quiknode.pro`) from the [Polygon RPC directory](https://docs.polygon.technology/pos/reference/rpc-endpoints/), plus Pocket Network. `POLYGON_MAINNET_REGISTRY` includes each URL, provider, review date and capability configuration. No numeric public request quota or batch ceiling is asserted. Supply your provider's documented `rps`, `burst`, `providerGroup` and `providerBudget` when known. ZAN was removed on 2026-11-08: keyless callers receive HTTP 429 for every `eth_getLogs` and for about a quarter of calls at 2 requests/s.

Defaults allow ordinary EVM reads and raw signed transaction submission. Numeric historical state routes only to dRPC, Tenderly and QuickNode, whose `archive` flag was verified live on 2026-11-08 (block 1 plus five spread historical blocks on separate runs). Finality tags, Bor extensions, debug/trace, HTTP batches and subscriptions require explicit provider configuration after verification. A missing capability produces an error rather than substituting `latest`. This conservative configuration describes what the client enables, not proof that a provider lacks an advanced feature. Documented WSS `wss://polygon.drpc.org` is exported as `POLYGON_WS_URL` without creating a socket at import or factory construction time.

```ts
import { polygon, POLYGON_PUBLIC_METHODS } from "@bloxwap/smart-rpc/polygon";

const transport = polygon({
  endpoints: [{
    url: process.env.POLYGON_RPC_URL!,
    headers: { "x-api-key": process.env.POLYGON_RPC_KEY! },
    supportedMethods: [...POLYGON_PUBLIC_METHODS, "bor_getAuthor"],
    capabilities: {
      archive: true,
      blockTags: ["latest", "pending", "safe", "finalized", "earliest"],
      pinning: true,
      // Add only limits confirmed for this provider:
      maxLogBlockRange: 100,
    },
  }],
});
```

The example's 100-block log limit is a caller choice, not a Polygon network limit. Endpoint capabilities enforce the limit; use the shared Ethereum `requestLogs` helper with a matching `maxBlockRange` to split a wide numeric range under one operation budget. Raw `eth_getLogs` never silently truncates a range or returns partial results. Bor methods are exact provider opt-ins; their request and response fields remain intact. [dRPC's `bor_getAuthor` documentation](https://drpc.org/docs/polygon-api/borspecific/bor_getAuthor) supplies the author-address fixture used by the unit tests.

The adapter forwards `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_feeHistory` and transaction fee fields without Ethereum fee defaults. For Polygon-specific fee recommendations, query the separate [Polygon Gas Station](https://docs.polygon.technology/tools/gas/polygon-gas-station/) at exported `POLYGON_GAS_STATION_URL`. Gas Station reports fees in **gwei**; RPC quantity fields use **wei**. The RPC client does not silently request this REST service or rewrite signed transaction fees.

Run deterministic tests with `pnpm --filter @smart-rpc/polygon test`. Public checks are opt-in and make no uptime guarantee:

```sh
SMART_RPC_LIVE_POLYGON=1 pnpm --filter @smart-rpc/polygon test
```

Additional checks require `POLYGON_FINALITY_RPC_URL`, `POLYGON_ARCHIVE_RPC_URL`, `POLYGON_LIVE_BOR=1` (optional `POLYGON_BOR_RPC_URL`), or `POLYGON_LIVE_WS=1` (optional `POLYGON_WS_RPC_URL`). WSS smoke verifies identity only; it does not certify subscription reconnection. CI's deterministic fixtures verify Polygon identity quarantine, provider headers, Bor routing, gas and receipt fields, finality preservation, cancellation and retry bounds. Shared core and Ethereum suites cover batching partial errors, budgets, stale heads, probe accounting, log splitting and other common invariants.
