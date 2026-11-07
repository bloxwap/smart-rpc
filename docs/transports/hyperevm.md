# HyperEVM

`hyperevm()` composes the shared Ethereum adapter for HyperEVM mainnet (`eip155:999`) and testnet (`eip155:998`). Both use HYPE with 18 decimals. Pass `chainId: 999` or `chainId: 998` to select one network. Registration does not open a connection; `eth_chainId` is checked before an endpoint receives a user call.

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { hyperevm } from "@bloxwap/smart-rpc/hyperevm";

const rpc = createSmartRpc({ transports: [hyperevm()] });
await rpc.request({ chainId: "eip155:999", method: "eth_blockNumber" });
```

The [official network documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) lists the mainnet URL `https://rpc.hyperliquid.xyz/evm` and testnet URL `https://rpc.hyperliquid-testnet.xyz/evm`. Both retain a conservative local budget of 1.5 requests/second, burst 3. This is the project's reference client setting, not a provider quota or service guarantee. Public alternatives and their sources remain exported in `HYPEREVM_MAINNET_REGISTRY` and `HYPEREVM_TESTNET_REGISTRY`.

## Requested state and capabilities

The official RPC supports latest state reads; historical block and transaction metadata do not imply archive state access. Its capability record disables numeric pinning of latest reads and historical state routing. A request for unsupported state fails or selects a configured capable endpoint; it is never rewritten to latest. The [JSON-RPC reference](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc) documents these restrictions.

Public defaults conservatively disable unverified archive, batch, debug/trace, subscription and additional finality-tag capabilities. These flags control what this client enables; they do not assert that every public provider lacks those features. Supply verified capabilities with a dedicated endpoint to opt in:

```ts
const transport = hyperevm({
  chainId: 999,
  endpoints: [
    "https://rpc.hyperliquid.xyz/evm",
    {
      url: process.env.HYPEREVM_ARCHIVE_RPC!,
      headers: { authorization: `Bearer ${process.env.HYPEREVM_RPC_TOKEN!}` },
      capabilities: { archive: true, pinning: true, blockTags: ["latest", "safe", "finalized"] },
    },
  ],
});
```

Only enable tags that the selected provider supports. Endpoint URLs are opaque; the official RPC has no WebSocket JSON-RPC endpoint. A provider's separately documented WS URL is not derived from its HTTP URL. Core filters/subscriptions remain governed by the shared adapter's connection rules.

The official log query limits are 50 blocks and four topic positions. Use the exported `requestLogs(pool, filter, { maxBlockRange: 50 })` helper with a selected-network pool to split explicit numeric ranges while preserving filters and ordering. Direct oversized requests and excessive topic positions are rejected before sending a log call. Historical-state gating does not prevent historical log queries. Range splitting consumes the same operation budget as retries and hedges. No HTTP batch maximum is assumed for HyperEVM.

## HyperCore and gas behavior

HyperEVM's small and large blocks share an increasing EVM block-number sequence. `eth_gasPrice` and `eth_bigBlockGasPrice` return separate base fees, and `eth_usingBigBlocks` reports an account's block mode. The transport forwards those values unchanged and does not calculate Ethereum slot or finality timing. The [dual-block specification](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture) explains this distinction.

`HYPEREVM_SAFE_METHODS` permits those read extensions and `eth_getSystemTxsByBlockHash` / `eth_getSystemTxsByBlockNumber` to use shared safe-read routing. Caller `nonIdempotentMethods` still overrides the allowlist. System-transaction fields remain intact. Transaction submissions do not race, cache or coalesce. A selected-network transport exposes `requestBatch()` with ordered success/error results and one shared operation budget. A dual-network transport partitions mixed-network batches by each item's explicit chain ID and preserves input order. Each network pool shares one operation budget across its own items. Unknown or missing chain IDs reject only those items without sending them upstream.

Calls to HyperCore read precompiles in `0x…0800`–`0x…08ff` retain their supplied tag when latest pinning is enabled on capable providers. Their results describe HyperCore state, and ordinary archive state availability does not guarantee historical hypothetical precompile results. See the [read-precompile reference](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore).

HyperEVM uses Cancun without blobs. The client preserves RPC results rather than inventing blob support or replacing a zero priority-fee quote. Error code `10055` alone is not a retry verdict: nonce, funds and underpriced replacement messages are deterministic, while a duplicate transaction hash is handled as already known. Shared core error classification supplies these rules.

## Verification

`pnpm --filter @smart-rpc/hyperevm test` runs offline identity, pool-isolation, budget, precompile, capability, log-range and extension/error fixtures. Shared Ethereum/core tests cover cancellation, batching partial results, stale heads and probe failure accounting. Public smoke checks are explicit:

```sh
SMART_RPC_LIVE_HYPEREVM=1 pnpm --filter @smart-rpc/hyperevm test
```

The smoke test checks the official mainnet identity, head, gas quotes and a one-block log query. It does not claim archive, WS or finality-tag support and never runs by default in CI. Documentation was reviewed on 2026-11-06; public endpoint availability can change.
