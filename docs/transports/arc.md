# Arc

Import `arc` from `@bloxwap/smart-rpc/arc`. The private workspace package is `@smart-rpc/arc`; routing, retries, caching, budgets and identity checks use the shared Ethereum adapter and core.

```ts
import { arc } from "@bloxwap/smart-rpc/arc";

const transport = arc();
const address = "0x1111111111111111111111111111111111111111";
const balance = await transport.request({
  chainId: "eip155:5042",
  method: "eth_getBalance",
  params: [address, "latest"],
});
transport.close();
```

Mainnet is chain **5042**. Native gas and balances use **USDC, 18 decimals**. The ERC-20 USDC interface at `ARC_USDC_ERC20_ADDRESS` uses 6 decimals but represents the same balance. The transport returns original RPC quantities without conversion. [Network configuration](https://docs.arc.io/arc/references/connect-to-arc)

`ARC_MAINNET_REGISTRY` contains four documented keyless HTTP endpoints: Arc, Blockdaemon, dRPC and QuickNode. Alchemy requires a caller-provided API key and is not a default. The registry records exact Blockdaemon and QuickNode WebSocket URLs as metadata; it never derives a WS URL from HTTP. Supplying `endpoints` replaces defaults, and each endpoint may supply `headers` for dedicated provider authentication. [Provider URLs](https://docs.arc.io/arc/references/connect-to-arc)

Default optional capabilities are conservative: archive state, debug/trace, pinning, batching, subscriptions and safe/finalized selectors require explicit configuration. No numeric provider quota or batch ceiling is invented. `capabilities.blockTags`, `archive`, `batch`, `maxBatchSize`, and related endpoint options enable tested provider behavior. Public network finality does not establish a provider's JSON-RPC tag support. Subscriptions use the shared adapter's dedicated WebSocket session API. [Finality](https://docs.arc.io/arc/concepts/deterministic-finality)

Arc targets Osaka with execution differences, so the transport forwards gas estimates and error details rather than simulating Ethereum rules. Native-value transfers can revert for zero-address, burning, or blocklist restrictions; a revert remains terminal. It does not construct transactions, choose fee caps, or assume blob transactions are supported. [EVM differences](https://docs.arc.io/arc/references/evm-differences)

System native-USDC Transfer logs come from `ARC_NATIVE_TRANSFER_EMITTER` at 18-decimal precision; ERC-20 logs use the contract address and 6-decimal precision. Both logs can describe one transfer. RPC results preserve both emitters, amounts and ordering so applications can avoid double counting. [System events](https://docs.arc.io/arc/references/usdc-system-events)

Run `pnpm --filter @smart-rpc/arc test` for deterministic fixtures. `SMART_RPC_LIVE_ARC=1 pnpm --filter @smart-rpc/arc test` adds public identity/head checks. Optional capability probes require `SMART_RPC_ARC_CAPABILITIES=1` and `ARC_RPC_URL`; WS checks additionally require `ARC_WS_URL`. These read-only probes establish observed behavior at one time, not availability guarantees or provider limits. No transaction is submitted.
