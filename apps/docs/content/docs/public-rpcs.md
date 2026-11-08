---
title: Public RPC registry
---

# Public RPC registry

Reviewed on 2026-11-07. The built-in transports cover 25 networks with 111 keyless public HTTPS endpoints. Each network has at most five defaults; smaller lists are intentional where fewer services could be substantiated. The registry is a researched snapshot, not a claim that every public RPC has been found or will remain available.

## How the defaults work

Each chain package supplies endpoint data to the shared pool. EVM pools check `eth_chainId`, and Solana pools check `getGenesisHash`, before admitting an endpoint. The pool scores responses, races safe reads, fails over on eligible errors, observes request budgets, and ejects failing providers with the circuit breaker. Every network has its own pool; a testnet RPC cannot serve a mainnet request.

Candidates were collected from [Chainlist](https://chainlist.org), official network documentation, and provider documentation. `sourceUrls` records the exact sources and `reviewedAt` records the documentation review date. Documentation review establishes intended public access. Live identity/head checks establish only what a service returned from one location at one time; they do not establish archive depth, every RPC method, every precompile, or future uptime.

The defaults are general-purpose HTTP endpoints that do not need an account or API key. WebSocket URLs may be retained as documented metadata, but are not added to HTTP pools. Transaction-only relays, free account plans, placeholder URLs, and services that could not be substantiated are not silently added. Low-allowance services such as 1RPC remain opt-in rather than defaults.

`rps` and `burst` are local token-bucket settings, not provider promises. Calls, identity checks, retries, and probes spend the same tokens within a pool. Multiple pools, applications, or machines sharing an IP do not share this budget. Where numeric public limits are undocumented, chain registries leave them unspecified rather than inventing them.

## Registry exports

The exact URLs, providers, sources, budgets, capabilities, and method restrictions live in each package's `src/registry.ts`.

| Subpath | Registry export | Network | Defaults |
| --- | --- | --- | ---: |
| `@bloxwap/smart-rpc/arbitrum` | `ARBITRUM_MAINNET_REGISTRY` | Arbitrum One, `eip155:42161` | 5 |
| `@bloxwap/smart-rpc/arc` | `ARC_MAINNET_REGISTRY` | Arc, `eip155:5042` | 5 |
| `@bloxwap/smart-rpc/avalanche` | `AVALANCHE_MAINNET_REGISTRY` | Avalanche C-Chain, `eip155:43114` | 4 |
| `@bloxwap/smart-rpc/base` | `BASE_MAINNET_REGISTRY` | Base, `eip155:8453` | 5 |
| `@bloxwap/smart-rpc/bsc` | `BSC_MAINNET_REGISTRY` | BNB Smart Chain, `eip155:56` | 5 |
| `@bloxwap/smart-rpc/celo` | `CELO_MAINNET_REGISTRY` | Celo, `eip155:42220` | 5 |
| `@bloxwap/smart-rpc/celo` | `CELO_SEPOLIA_REGISTRY` | Celo Sepolia, `eip155:11142220` | 4 |
| `@bloxwap/smart-rpc/ethereum` | `ETHEREUM_MAINNET_REGISTRY` | Ethereum, `eip155:1` | 5 |
| `@bloxwap/smart-rpc/etherlink` | `ETHERLINK_MAINNET_REGISTRY` | Etherlink, `eip155:42793` | 4 |
| `@bloxwap/smart-rpc/flare` | `FLARE_MAINNET_REGISTRY` | Flare, `eip155:14` | 4 |
| `@bloxwap/smart-rpc/gnosis` | `GNOSIS_MAINNET_REGISTRY` | Gnosis, `eip155:100` | 5 |
| `@bloxwap/smart-rpc/hyperevm` | `HYPEREVM_MAINNET_REGISTRY` | HyperEVM, `eip155:999` | 5 |
| `@bloxwap/smart-rpc/hyperevm` | `HYPEREVM_TESTNET_REGISTRY` | HyperEVM testnet, `eip155:998` | 2 |
| `@bloxwap/smart-rpc/ink` | `INK_MAINNET_REGISTRY` | Ink, `eip155:57073` | 5 |
| `@bloxwap/smart-rpc/mantle` | `MANTLE_MAINNET_REGISTRY` | Mantle, `eip155:5000` | 5 |
| `@bloxwap/smart-rpc/monad` | `MONAD_MAINNET_REGISTRY` | Monad, `eip155:143` | 5 |
| `@bloxwap/smart-rpc/opbnb` | `OPBNB_MAINNET_REGISTRY` | opBNB, `eip155:204` | 5 |
| `@bloxwap/smart-rpc/optimism` | `OPTIMISM_MAINNET_REGISTRY` | OP Mainnet, `eip155:10` | 5 |
| `@bloxwap/smart-rpc/plasma` | `PLASMA_MAINNET_REGISTRY` | Plasma, `eip155:9745` | 3 |
| `@bloxwap/smart-rpc/polygon` | `POLYGON_MAINNET_REGISTRY` | Polygon, `eip155:137` | 5 |
| `@bloxwap/smart-rpc/robinhood` | `ROBINHOOD_MAINNET_REGISTRY` | Robinhood Chain, `eip155:4663` | 5 |
| `@bloxwap/smart-rpc/solana` | `MAINNET_REGISTRY` | Solana mainnet | 5 |
| `@bloxwap/smart-rpc/solana` | `DEVNET_REGISTRY` | Solana devnet | 2 |
| `@bloxwap/smart-rpc/solana` | `TESTNET_REGISTRY` | Solana testnet | 3 |
| `@bloxwap/smart-rpc/xlayer` | `XLAYER_MAINNET_REGISTRY` | X Layer, `eip155:196` | 5 |

The corresponding `*_ENDPOINTS` exports retain the existing public APIs. Ethereum and most EVM chains export URL arrays; Solana exports endpoint configuration arrays including labels and budgets. Use a registry when its metadata must be retained.

## Provider-specific restrictions

- dRPC public endpoints exclude the six stateful filter methods documented in its [public-node rules](https://drpc.org/docs/howitworks/ratelimiting). If enabling EVM batches for a pool containing dRPC, use `batch: { batchSize: 3 }` rather than unrestricted batching.
- Ethereum's Tenderly endpoint excludes `eth_getLogs`: its [public log-result limit](https://docs.tenderly.co/node-rpc/overview#public-endpoint-limits) can make a valid large query look like invalid parameters.
- BNB dataseeds retain their shared provider budget, `eth_getLogs` exclusion, and BSC extension-method exclusions. Other chain-specific unsupported methods and conservative capabilities remain in their registries.
- Solana's official public clusters retain conservative budgets based on the [published cluster limits](https://solana.com/docs/references/clusters). Pocket excludes `getTokenAccountsByOwner`, which its public gateway documents as unreliable.

## HyperEVM ranking

HyperEVM mainnet keeps its persisted historical ranking. `packages/hyperevm/registry/mainnet.json` contains eligibility, rank, weight, and summary statistics for the five retained sources; `history.json` contains only their retained rolling observations. Only eligible endpoints with positive weights enter the default pool. Source URLs, capabilities, unsupported methods, and request budgets remain in `src/registry.ts`, so a ranking refresh cannot rewrite operator-reviewed settings. Testnet retains neutral weight 1.

Rankings are refreshed separately by the weekly/manual **Rank HyperEVM registry** workflow, which opens a pull request rather than pushing to `main`. To explicitly rerun the live maintenance probe without writing, use `pnpm rank:hyperevm --dry-run`. `pnpm rank:hyperevm --fixtures <observation.json> --dry-run` replays historical fixtures without network access. Neither command is part of normal CI.

## Custom providers and free API keys

Passing `endpoints` replaces the defaults for the selected network. No credentials are embedded in the library. Obtain a free-tier key from your chosen provider and configure its URL explicitly with a budget appropriate to your plan. Do not use shared demo keys as defaults.

```ts
import { ethereum, ETHEREUM_MAINNET_REGISTRY } from "@bloxwap/smart-rpc/ethereum";
import { solana, MAINNET_ENDPOINTS } from "@bloxwap/smart-rpc/solana";

const ethereumRpc = ethereum({
  endpoints: [
    { url: process.env.ETHEREUM_RPC_URL!, label: "my-ethereum-provider", rps: 5, burst: 5 },
    ...ETHEREUM_MAINNET_REGISTRY.map(({ url, rps, burst, unsupportedMethods }) => ({
      url, rps, burst, unsupportedMethods,
    })),
  ],
});

const solanaRpc = solana({
  endpoints: [
    { url: process.env.SOLANA_RPC_URL!, label: "my-solana-provider", rps: 5, burst: 5 },
    ...MAINNET_ENDPOINTS,
  ],
});
```

The 5 rps example is a caller setting; use the provider's actual allowance. Passing an Ethereum URL array alone does not carry registry budget metadata. `budget: false` explicitly disables pool budgets, including endpoint defaults. For `hyperevm()` serving both chains, `endpoints` replaces mainnet and `testnetEndpoints` replaces testnet.

## Verify and refresh

The release-build check on 2026-11-07 passed identity and head/slot checks for **111 of 111 endpoints** across all 25 networks. It completed at 18:08:37 UTC with a 10-second request deadline and concurrency 4. This is a point-in-time result, not an uptime guarantee.

Build first, then run the opt-in network checker from the repository root:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm check:rpcs
pnpm check:rpcs --protocol solana
pnpm check:rpcs --help
```

The checker sends read-only identity and head requests against the built registries. It uses bounded timeouts, paces requests across networks by provider, and emits JSON results. Exit status is 0 when all checks pass, 1 when an endpoint fails, and 2 for invalid arguments or a missing/invalid build. Network, DNS, authentication, rate-limit, malformed-response, and chain-identity failures should be interpreted separately; a blocked local network is not evidence of a permanent provider outage.

Refresh an endpoint by reviewing its operator's current documentation, checking its network identity and head, recording source URLs and review date, and updating budgets or unsupported methods as needed. Keep the five-endpoint cap, and keep keys and transaction-only services out of default pools.
