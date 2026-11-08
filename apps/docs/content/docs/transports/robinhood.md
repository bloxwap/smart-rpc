---
title: Robinhood Chain
---

# Robinhood Chain

`@bloxwap/smart-rpc/robinhood` exports `robinhood()`. The private workspace implementation is `@smart-rpc/robinhood`; it delegates routing, scoring, budgets, retries, caching, and identity verification to the Ethereum adapter and shared core.

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { robinhood } from "@bloxwap/smart-rpc/robinhood";

const rpc = createSmartRpc({ transports: [robinhood()] });
const head = await rpc.request({ chainId: "eip155:4663", method: "eth_blockNumber" });
```

Robinhood mainnet uses chain ID **4663**, native **ETH** with 18 decimals, and the public HTTP RPC `https://rpc.mainnet.chain.robinhood.com`. This factory serves mainnet only. The official public service is rate limited without a published numeric allowance; the registry invents no provider quota. Applications can supply `budget` or per-endpoint `rps` and `burst` settings. Dedicated provider URLs and HTTP headers are supported. These network details were reviewed on 2026-11-06. [Official connection documentation](https://docs.robinhood.com/chain/connecting/).

| Service | Default use |
| --- | --- |
| Full HTTP RPC | Identity checks, full-block probes, ordinary calls |
| Sequencer submission URL | Excluded from general RPC pools |
| Primary sequencer feed | Excluded; a separate stream for node operators |
| Delayed backup feed | Excluded; a separate backup stream, approximately 500 ms behind |

`ROBINHOOD_INFRASTRUCTURE` records those URLs with explicit roles. Supplying a known sequencer or feed URL in `endpoints` throws before making a network request. Feed updates never enter full-block head scoring. [Infrastructure roles](https://docs.robinhood.com/chain/connecting/).

The public endpoint starts with conservative client capabilities: no automatic numeric pinning, archive state, debug/trace, JSON batching, or subscriptions. Only `latest` and `pending` state tags are enabled. These restrictions express what this package enables, rather than claiming the server cannot support anything else. A request for historical, `safe`, or `finalized` state fails when no endpoint advertises support; its block selector is never changed to `latest`.

Configure an independently verified provider explicitly:

```ts
const transport = robinhood({
  endpoints: [{
    url: process.env.ROBINHOOD_RPC_URL!,
    headers: { authorization: `Bearer ${process.env.ROBINHOOD_RPC_TOKEN}` },
    capabilities: {
      archive: true,
      pinning: true,
      blockTags: ["latest", "pending", "safe", "finalized"],
    },
  }],
});
```

Enable capabilities only after checking the specific endpoint. A shared Nitro implementation does not establish Robinhood provider support. Fee and receipt extension fields pass through unchanged. L2 execution fees and Ethereum data-publication costs are distinct components; the adapter does not reinterpret quantities or discard `gasUsedForL1`. [Gas and fees](https://docs.robinhood.com/chain/gas-and-fees/). Sequencer confirmations are separate from publication and finality on Ethereum; no fixed confirmation timer is used to manufacture finality. [Finality model](https://docs.robinhood.com/chain/transaction-finality/).

The ArbSys precompile is an ordinary `eth_call` target. Its L2 block number is distinct from Solidity's L1-oriented `block.number`; probes use execution RPC `eth_blockNumber`. [EVM differences](https://docs.robinhood.com/chain/differences-from-ethereum/).

## Optional endpoint candidate

BlockVectra's [provider catalog](https://api.blockvectra.com/v1/chains), reviewed on 2026-11-06, lists `https://api.blockvectra.com/v1/robinhood_mainnet/public`. Its public profile advertises 3 requests/s per IP, burst 20, 900-block history, and stricter log limits: one address, 100 blocks, 1,000 results, 1 MiB, no `blockHash`, and a single-call log batch. Raw transaction submission has a separate 1 request/s, burst-3 allowance. The general public batch ceiling is 10. This endpoint is **not a default**: those additional method-specific quotas and log restrictions need explicit enforcement before enabling it as a general fallback. Chain-level catalog limits are not interchangeable with public-profile limits.

## Verification

```sh
pnpm --filter @smart-rpc/robinhood test
SMART_RPC_LIVE_ROBINHOOD=1 pnpm --filter @smart-rpc/robinhood test
```

The opt-in smoke test checks identity and head on the public RPC; `ROBINHOOD_RPC_URL` can select a dedicated endpoint. It does not assert archive, finality-tag, batch, or WebSocket support. Deterministic fixtures cover quarantine, endpoint roles, archive routing, tag preservation, custom headers, precompile and receipt fields, write isolation, and cancellation. Shared policy regressions remain in `packages/core` and `packages/ethereum`.
