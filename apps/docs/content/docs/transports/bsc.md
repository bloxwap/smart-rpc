---
title: BNB Smart Chain
---

# BNB Smart Chain

`bsc()` registers mainnet `eip155:56`, with BNB as its 18-decimal native currency. It composes the Ethereum adapter and shared core; retry, breaker, scoring, caching, cancellation, and probe policy remain shared.

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { bsc, BSC_MAINNET_REGISTRY } from "@bloxwap/smart-rpc/bsc";

const rpc = createSmartRpc({
  transports: [bsc({
    endpoints: [
      ...BSC_MAINNET_REGISTRY,
      {
        url: process.env.BSC_RPC_URL!,
        headers: { Authorization: `Bearer ${process.env.BSC_RPC_TOKEN!}` },
        capabilities: { archive: true, blockTags: ["latest", "safe", "finalized"] },
      },
    ],
  })],
});
```

Only declare a capability after checking the chosen provider. Passing `endpoints` replaces the defaults; spreading the registry retains them. The factory fixes chain identity to BSC mainnet and quarantines wrong-chain responses before routing a user call.

The [official endpoint documentation](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/) lists public dataseeds, disables their `eth_getLogs`, and documents 10,000 requests per five minutes. Defaults use two BNB-hosted dataseeds under one provider group: 5 requests/s and burst 10 per URL, plus a shared 10 requests/s and burst 20 ceiling. Those are conservative local settings, not purchased capacity. The group covers identity, probes, retries and races within the pool; other processes sharing an IP still consume the provider allowance. Supplying either default URL explicitly retains its restrictions and budgets.

The registry also includes PublicNode, thirdweb and Pocket Network. Logs skip the dataseeds and Pocket (whose BSC suppliers reject log filters without an `address`) and go to thirdweb, PublicNode (which also requires an `address`) or a configured capable provider; a pool made only of dataseeds rejects logs locally without harming endpoint health. Numeric historical state routes only to thirdweb, whose `archive` flag was verified live on 2026-11-08 (block 1 plus five spread historical blocks on separate runs). No batch size, WebSocket URL, debug/trace support, or finality-tag capability is invented. Public defaults disable those capabilities and numeric state pinning; `latest` remains `latest`, while unsupported historical/finalized state is rejected. Explicit provider configurations can enable tested capabilities.

The [BSC API documentation](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/bsc-api-list/) describes Parlia finality APIs and execution-layer blob sidecars. `BSC_EXTENSION_METHODS` identifies these extensions, which require an explicit endpoint `supportedMethods` allowlist (include `eth_chainId` and `eth_blockNumber` as well as the selected methods). JSON results retain provider fields, sidecars and quantities unchanged. `eth_getFinalizedHeader` validator thresholds remain caller-supplied; this adapter applies no Ethereum epoch timing. `eth_newFinalizedHeaderFilter` is stateful and never raced or coalesced.

Run deterministic tests with `pnpm --filter @smart-rpc/bsc test`. An optional live identity/head smoke test runs with `SMART_RPC_BSC_LIVE=1 pnpm --filter @smart-rpc/bsc test`. Set `BSC_RPC_URL` for a dedicated provider; adding `BSC_ARCHIVE_BLOCK=0x...` enables archive/finalized checks. Public smoke tests are deliberately excluded from normal CI and do not establish an SLA or a provider's production limits.
