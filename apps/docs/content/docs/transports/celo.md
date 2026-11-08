---
title: Celo
---

# Celo

```ts
import { celo } from "@bloxwap/smart-rpc/celo";

const mainnet = celo();
const testnet = celo({ chainId: 11142220 });
```

The factory composes the canonical Ethereum adapter and shared core. Mainnet is `eip155:42220`; Celo Sepolia is `eip155:11142220`. Both use CELO with 18 native decimals. Alfajores is retired and rejected by the factory. Requests verify `eth_chainId` before admission.

| Network | HTTP default | Documented WebSocket |
| --- | --- | --- |
| Mainnet | `https://forno.celo.org` | `wss://forno.celo.org/ws` |
| Celo Sepolia | `https://forno.celo-sepolia.celo-testnet.org` | `wss://forno.celo-sepolia.celo-testnet.org/ws` |

Forno is a best-effort, rate-limited service without a stated numeric quota in the reviewed documentation. No numeric provider limit is invented. Supply `rps`, `burst`, or a shared `providerGroup`/`providerBudget` for your own traffic policy. Public defaults exclude signing operations: submit locally signed bytes with `eth_sendRawTransaction`.

The mainnet registry adds PublicNode, Ankr, thirdweb (`https://42220.rpc.thirdweb.com`) and Tenderly; Celo Sepolia adds Ankr, dRPC and Tenderly. dRPC mainnet is not a default: in repeated checks on 2026-11-07/08 it answered 25–90% of `eth_blockNumber`, `eth_getBalance` and `eth_getTransactionCount` calls with `-32601 method does not exist`.

Forno documents non-archive nodes, so its entries disable numeric historical state reads and numeric pinning, preserving `latest` requests without converting them into unsupported historical reads. Historical state is routed only to entries whose `archive` flag was verified live on 2026-11-08 (block 1 plus five spread historical blocks on separate runs): thirdweb on mainnet; Ankr, dRPC and Tenderly on Celo Sepolia. Ankr and Tenderly mainnet lack pre-L2-migration state and stay disabled. HTTP batching, debug/trace, subscriptions and finality tags require explicit capability configuration. Supply a dedicated endpoint's explicit `capabilities` after checking its support; archive/finality requests are never silently changed to `latest`. The exported `CELO_MAINNET_REGISTRY` and `CELO_SEPOLIA_REGISTRY` record sources and review dates.

WebSocket URLs are documentation metadata, not automatically opened defaults. Forno disconnects WebSocket sessions after about 20 minutes. Use the shared Ethereum dedicated subscription connection API and its reconnect/resubscribe lifecycle when enabling subscriptions; ordinary pool requests cannot receive notification callbacks.

## Fee currencies

The transport preserves full transaction objects and results, including `feeCurrency`, hex quantities, CIP-64 transaction bytes, and L1 fee fields. It does not select a currency, convert amounts or sign transactions. A non-18-decimal fee token such as USDC or USD₮ uses its fee-currency **adapter** address, which may differ from its ERC-20 token address. Read the current allowlist before choosing an adapter; the package does not embed a stale address catalogue.

```ts
await mainnet.request({
  method: "eth_estimateGas",
  params: [{ from, to, data, feeCurrency: adapterAddress }],
});
```

The shared cache and coalescer serialize complete parameters. Requests that differ by `feeCurrency`, transaction fields or block tag remain distinct. Signed submissions are never raced, cached or coalesced. Tests exercise two different adapters and ensure the transport never replaces an adapter with the underlying token address.

Blocks arrive every about 1s (measured 2026-11-08), so the factory passes `blockTimeMs: 1000` and the default `headLag.maxLag` is 1 block, about one second of staleness. An endpoint further behind does not lead, race or hedge `latest`, `pending` or other head reads while a fresh endpoint can serve them; it still serves block-number, block-hash, `safe`/`finalized` and transaction reads, and remains a failover. Pass `blockTimeMs` or `headLag: { maxLag }` to change it.

## Verification

`pnpm --filter @smart-rpc/celo test` runs deterministic transport fixtures. `CELO_LIVE=1 pnpm --filter @smart-rpc/celo test` adds read-only mainnet/Sepolia identity and head checks. `CELO_CAPABILITIES=1` adds opt-in Forno batch partial-error, safe/finalized block and documented WebSocket checks. An explicitly supplied `CELO_ARCHIVE_URL` and `CELO_ARCHIVE_BLOCK` enable a read-only historical-state check. Results are point-in-time observations, not an SLA or numeric capacity test. No test submits a live transaction.

On 2026-11-06, mainnet identity/head, safe/finalized block, two-item partial-error batch, and WebSocket identity checks passed. The documented Sepolia HTTP endpoint returned HTTP 503 during its identity check; its live availability remains unverified. Archive access was not tested without a dedicated endpoint.

Sources reviewed 2026-11-06: [network information](https://docs.celo.org/learn/network/overview), [Forno](https://docs.celo.org/build/tools/nodes/forno), [fee abstraction](https://docs.celo.org/build/fee-abstraction/overview), [fee currency contracts](https://docs.celo.org/build/tools/contracts/fee-currencies), [fee abstraction specification](https://docs.celo.org/operate/specification/fee-abstraction).
