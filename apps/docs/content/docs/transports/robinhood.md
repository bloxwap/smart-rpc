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

The default pool is the official RPC, PublicNode, Pocket Network, GlobalStake and dRPC. GlobalStake (a provider named in the official connection guide, with its URL listed on [Chainlist](https://chainlist.org/chain/4663)) replaced thirdweb on 2026-11-08. thirdweb trailed the head by about 7 blocks, returned occasional HTTP 429s at 4–5 requests per second, and ran about 150 ms at the median. GlobalStake answered in about 77 ms, usually within one or two blocks of the head, with no errors at 5 requests per second.

Capabilities were re-verified live on 2026-11-08:

- **Historical state:** routed only to Pocket, the one provider that served it consistently. The official RPC and GlobalStake are full nodes, PublicNode returns 403 for anything older than roughly 60–100 blocks, and dRPC alternated between answers and "Unknown state".
- **HTTP batching:** allowed when you enable `batch`: at most 3 items on dRPC (its documented limit) and 10 elsewhere. 20-item batches succeeded, but 10 matches the other registries.
- **Logs:** dRPC receives `eth_getLogs` spans of at most 100 blocks. PublicNode rejects logs without an `address`, and older ranges, and those calls fail over.
- **Budgets:** only Pocket's gateway publishes a keyless allowance (2,000 requests per IP per minute, set as `rps: 33`).
- **Not enabled:** automatic numeric pinning, debug/trace and subscriptions.
- **Block tags:** only `latest` and `pending` are enabled. During review, Pocket's `safe` head trailed its `finalized` head.

These restrictions express what this package enables, rather than claiming a server cannot support anything else. A request for historical, `safe`, or `finalized` state fails when no endpoint advertises support; its block selector is never changed to `latest`.

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

Blocks arrive every about 100ms (measured 2026-11-08: 0.106-0.110s over 100 and 1,000 blocks), so the factory passes `blockTimeMs: 100` and the default `headLag.maxLag` is 10 blocks, about one second of staleness. An endpoint further behind does not lead, race or hedge `latest`, `pending` or other head reads while a fresh endpoint can serve them; it still serves block-number, block-hash, `safe`/`finalized` and transaction reads, and remains a failover. The official RPC, which usually trails by about 5-7 blocks (0.5-0.7s), stays inside that tolerance. Pass `blockTimeMs` or `headLag: { maxLag }` to change it.

## Verification

```sh
pnpm --filter @smart-rpc/robinhood test
SMART_RPC_LIVE_ROBINHOOD=1 pnpm --filter @smart-rpc/robinhood test
```

The opt-in smoke test checks identity and head on the public RPC; `ROBINHOOD_RPC_URL` can select a dedicated endpoint. It does not assert archive, finality-tag, batch, or WebSocket support. Deterministic fixtures cover quarantine, endpoint roles, archive routing, tag preservation, custom headers, precompile and receipt fields, write isolation, and cancellation. Shared policy regressions remain in `packages/core` and `packages/ethereum`.
