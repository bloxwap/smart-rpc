# Public RPC registry

Reviewed on 2026-11-06. The built-in transports cover Ethereum mainnet, HyperEVM mainnet/testnet, and Solana mainnet/devnet/testnet. The registry is a researched snapshot of documented public services, not a claim that every free RPC has been found or will remain available.

## How the defaults work

Each chain package supplies endpoint data to the existing shared pool. The pool checks `eth_chainId` or `getGenesisHash` before admitting an endpoint, scores its responses, races safe reads, fails over on eligible errors, observes request budgets, and ejects failing providers with the circuit breaker. Each network has its own pool; a testnet RPC cannot serve a mainnet request.

Source metadata records the provider, exact URL, documentation links, and `reviewedAt` date. Documentation review establishes the intended public service. Live checks establish only what that service returned from one location at one time. A successful identity/head check does not establish archive depth, every RPC method, every precompile, or future uptime.

`rps` and `burst` are local token-bucket settings. They are conservative routing limits, not provider promises. Calls, identity checks, retries, and probes spend the same tokens within a pool. Automatic probes preserve the last available token for caller traffic; an explicit `probe()` call may spend it. Multiple pools, applications, or machines sharing an IP do not share this budget. Where provider quotas depend on methods, time windows, compute units, or daily totals, one token bucket cannot represent every rule. Services whose small daily quota does not fit the default workload remain opt-in.

The default registries contain HTTP endpoints that do not need an account or API key. WebSocket services, transaction-only relays, free account plans, and endpoints that could not be substantiated are not silently added to general-purpose defaults. The research notes preserve those distinctions:

- [Ethereum research](research/ethereum.md)
- [HyperEVM research](research/hyperevm.md)
- [Solana research](research/solana.md)

## Registry exports

| Subpath | Registry export | Network |
| --- | --- | --- |
| `@bloxwap/smart-rpc/ethereum` | `ETHEREUM_MAINNET_REGISTRY` | Ethereum, `eip155:1` |
| `@bloxwap/smart-rpc/hyperevm` | `HYPEREVM_MAINNET_REGISTRY` | HyperEVM, `eip155:999` |
| `@bloxwap/smart-rpc/hyperevm` | `HYPEREVM_TESTNET_REGISTRY` | HyperEVM testnet, `eip155:998` |
| `@bloxwap/smart-rpc/solana` | `MAINNET_REGISTRY` | Solana mainnet |
| `@bloxwap/smart-rpc/solana` | `DEVNET_REGISTRY` | Solana devnet |
| `@bloxwap/smart-rpc/solana` | `TESTNET_REGISTRY` | Solana testnet |

`PublicRpcEndpoint` is exported as a type from the package root. Ethereum's existing `ETHEREUM_MAINNET_ENDPOINTS` and HyperEVM's `HYPEREVM_MAINNET_ENDPOINTS` / `HYPEREVM_TESTNET_ENDPOINTS` are URL arrays. Solana's existing `MAINNET_ENDPOINTS`, `DEVNET_ENDPOINTS`, and `TESTNET_ENDPOINTS` remain endpoint configuration arrays, including their labels and budgets.

## Ethereum mainnet

Eleven defaults use a local budget of 2 requests/second, burst 3, except Web3CDN at 0.025 requests/second, burst 2. The provider links establish the public service; [Ethereum research](research/ethereum.md) records observed responses and exclusions.

| Provider source | HTTP RPC |
| --- | --- |
| [PublicNode](https://ethereum.publicnode.com/) | `https://ethereum-rpc.publicnode.com` |
| [dRPC](https://drpc.org/docs/ethereum-api) | `https://eth.drpc.org` |
| [LlamaNodes](https://llamarpc.com/eth) | `https://eth.llamarpc.com` |
| [BlockPI](https://public.blockpi.io/) | `https://ethereum.public.blockpi.network/v1/rpc/public` |
| [OnFinality](https://www.onfinality.io/en/) | `https://eth.api.onfinality.io/public` |
| [0xRPC](https://0xrpc.github.io/) | `https://0xrpc.io/eth` |
| [NOWNodes](https://nownodes.io/public-endpoints) | `https://public-eth.nownodes.io` |
| [Nodies](https://docs.nodies.app/rpc-services/public-endpoints) | `https://ethereum-public.nodies.app` |
| [Tenderly](https://docs.tenderly.co/node-rpc/rpc-reference) | `https://mainnet.gateway.tenderly.co` |
| [Pocket Network](https://docs.pocket.network/developers/supported-chains/) | `https://eth.api.pocket.network` |
| [Web3CDN](https://web3cdn.network/rpc/ethereum) | `https://ethereum.web3cdn.rest` |

dRPC's [public-node rules](https://drpc.org/docs/howitworks/ratelimiting) disable filter methods, so those methods are excluded for that endpoint. Tenderly's [public log-result limit](https://docs.tenderly.co/node-rpc/overview#public-endpoint-limits) can return an invalid-parameters error for a valid large query; the default pool routes `eth_getLogs` to other providers.

The old Ankr keyless URL requires credentials, and [Cloudflare deprecated its legacy gateway](https://developers.cloudflare.com/web3/reference/migration-guide/). 1RPC's [200-request daily allowance](https://docs.1rpc.io/using-the-web3-api/errors) stays opt-in. Source-documented candidates with failing current probes, including OMNIA, are recorded in the research notes rather than presented as healthy defaults.

## HyperEVM mainnet and testnet

Ten mainnet endpoints and two testnet endpoints passed chain identity, head, and a HyperCore precompile read during research. These are point-in-time capability checks. HyperEVM keeps the existing precompile pinning exception and routes through the Ethereum transport and shared pool.

Mainnet also has a persisted historical ranking. `packages/hyperevm/registry/mainnet.json` contains eligibility, rank, weight, and summary statistics; `history.json` contains the rolling observations that produced them. Only eligible endpoints with positive weights enter the default pool. Source URLs, capabilities, unsupported methods, and request budgets remain in `src/registry.ts`, so a ranking refresh cannot rewrite those operator-reviewed settings. Testnet retains neutral weight 1 until it has a separate history. Explicit `endpoints` and `testnetEndpoints` continue to replace these defaults and retain caller-supplied weights.

| Network | Provider source | HTTP RPC | Local rps / burst |
| --- | --- | --- | --- |
| Mainnet | [Hyperliquid](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) | `https://rpc.hyperliquid.xyz/evm` | 1.5 / 3 |
| Mainnet | [Hypurrscan](https://hyperliquid.gitbook.io/hyperliquid-docs/builder-tools/hyperevm-tools) | `https://rpc.hypurrscan.io` | 1 / 2 |
| Mainnet | [dRPC](https://blog.drpc.org/drpc-adds-support-for-hyperliquid-rpc/) | `https://hyperliquid.drpc.org` | 1 / 2 |
| Mainnet | [Purroof](https://www.purroofgroup.com/) | `https://rpc.purroofgroup.com` | 1 / 2 |
| Mainnet | [Stakely](https://stakely.io/web3-api-load-balancer/hyperliquid) | `https://hyperliquid-json-rpc.stakely.io` | 1 / 2 |
| Mainnet | [OnFinality](https://onfinality.io/en/networks/hyperliquid) | `https://hyperliquid.api.onfinality.io/evm/public` | 1 / 2 |
| Mainnet | [bloXroute](https://docs.bloxroute.com/core-solutions/rpc-service/fast-rpc) | `https://hyperliquid.rpc.blxrbdn.com` | 1 / 2 |
| Mainnet | [PublicNode](https://publicnode.com/) | `https://hyperliquid-rpc.publicnode.com` | 1 / 2 |
| Mainnet | [Pocket Network](https://docs.pocket.network/developers/supported-chains/) | `https://hyperliquid.api.pocket.network` | 1 / 2 |
| Mainnet | [Web3CDN](https://web3cdn.network/rpc/hyperliquid) | `https://hyperliquid.web3cdn.rest` | 0.025 / 2 |
| Testnet | [Hyperliquid](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) | `https://rpc.hyperliquid-testnet.xyz/evm` | 1.5 / 3 |
| Testnet | [dRPC](https://drpc.org/chainlist/hyperliquid-testnet-rpc) | `https://hyperliquid-testnet.drpc.org` | 1 / 2 |

The official mainnet budget preserves the original transport's setting; testnet also receives a conservative local budget. dRPC filter methods are excluded on both networks under its [public-node rules](https://drpc.org/docs/howitworks/ratelimiting). Public aggregators may share upstream operators, so endpoint counts do not measure independent infrastructure. [HyperEVM research](research/hyperevm.md) records the checks, provider limits, and alternatives.

Restricted candidates stay opt-in: 1RPC and MoltNode have small daily quotas; Tatum's anonymous endpoint rejected `eth_call` as paid-only; NodeFlare limits anonymous methods and frequency; HyperLend and Sentio failed the HyperCore precompile check. Chainlink's testnet returned upstream failures and documents latest-only state access, which does not support the transport's general block-pinning behavior.

EVM batching is disabled by default. dRPC public endpoints accept at most three calls per batch. If enabling batches for a pool that includes dRPC, use `batch: { batchSize: 3 }` rather than unrestricted `batch: true`, and respect other providers' documented limits. Batching does not increase a provider's request allowance.

## Solana clusters

Each cluster registers its familiar alias and genesis-hash CAIP identifier. Local budgets below include identity checks and probes.

| Cluster | Provider source | HTTP RPC | Local rps / burst |
| --- | --- | --- | --- |
| Mainnet | [PublicNode](https://solana.publicnode.com/) | `https://solana-rpc.publicnode.com` | 3 / 3 |
| Mainnet | [Pocket Network](https://docs.pocket.network/developers/supported-chains/) | `https://solana.api.pocket.network` | 3 / 3 |
| Mainnet | [Solana](https://solana.com/docs/references/clusters) | `https://api.mainnet.solana.com` | 3 / 3 |
| Mainnet | [OnFinality](https://www.onfinality.io/en/networks/solana) | `https://solana.api.onfinality.io/public` | 3 / 2 |
| Mainnet | [Solana Vibe Station](https://solanavibestation.com/) | `https://public.rpc.solanavibestation.com` | 1 / 1 |
| Mainnet | [Web3CDN](https://web3cdn.network/rpc/solana) | `https://solana.web3cdn.rest` | 0.025 / 2 |
| Devnet | [Solana](https://solana.com/docs/references/clusters) | `https://api.devnet.solana.com` | 3 / 3 |
| Devnet | [OnFinality](https://www.onfinality.io/en/networks/solana-devnet) | `https://solana-devnet.api.onfinality.io/public` | 3 / 2 |
| Testnet | [Solana](https://solana.com/docs/references/clusters) | `https://api.testnet.solana.com` | 3 / 3 |
| Testnet | [PublicNode](https://solana.publicnode.com/) | `https://solana-testnet-rpc.publicnode.com` | 3 / 3 |
| Testnet | [Web3CDN](https://web3cdn.network/rpc/solana) | `https://solana-testnet.web3cdn.rest` | 0.025 / 2 |

Solana's [official cluster limits](https://solana.com/docs/references/clusters) include a per-method ceiling of 40 requests per 10 seconds; the local 3 rps budget accounts for that ceiling. Pocket's documented `getTokenAccountsByOwner` limitation excludes that method from its endpoint. Vibe Station's stricter transaction limit determines its local budget. See [Solana research](research/solana.md) for method restrictions and observed checks.

All four Web3CDN defaults—Ethereum mainnet, HyperEVM mainnet, and Solana mainnet/testnet—use 0.025 rps with burst 2. Together, one long-lived pool per network can consume about 8,640 requests per day plus eight initial tokens, below the provider's [10,000-request daily allowance](https://web3cdn.network/rpc/solana). This allocation also stays below the listed hourly and minute quotas. It is not a shared counter: new transport instances, restarts, other processes, and unrelated traffic using the same public IP can consume additional quota.

SolanaTracker's former public endpoint now requires authentication. Solana dRPC access and transaction-only services are not included as free general-purpose defaults. Free plans requiring registration are listed in the research notes and can be added explicitly.

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

The 5 rps example is a caller setting; use your provider's actual allowance. Passing an Ethereum URL array alone does not carry the registry's budget metadata. Use the registry mapping above to retain it. `budget: false` explicitly disables pool budgets, including endpoint defaults.

For `hyperevm()` serving both chains, `endpoints` replaces mainnet and `testnetEndpoints` replaces testnet. For `hyperevm({ chainId: 998 })`, `endpoints` configures testnet. The official HyperEVM mainnet RPC retains its 1.5 rps, burst 3 default unless explicitly overridden.

## Verify and refresh

The release-build check on 2026-11-06 (Pacific time; completed 2026-11-07 01:48 UTC) passed identity and head checks for **28 of 34 endpoints**. All six networks had a passing endpoint. The remaining observations were:

| Endpoint | Observed response |
| --- | --- |
| `https://eth.llamarpc.com` | HTTP 525 |
| `https://ethereum.public.blockpi.network/v1/rpc/public` | HTTP 521 |
| `https://eth.api.onfinality.io/public` | HTTP 429 |
| `https://hyperliquid.api.onfinality.io/evm/public` | HTTP 429 |
| `https://solana.api.onfinality.io/public` | HTTP 429 |
| `https://solana-devnet.api.onfinality.io/public` | HTTP 429 |

These documented public services remain listed as source-backed candidates, with runtime identity checks, scoring, circuit breakers, and fallback determining their use. HyperEVM mainnet's historical eligibility additionally determines whether a candidate enters its default pool. Registry membership does not promise current availability. This check used an 8-second request deadline and concurrency 4, with provider pacing enabled. The checker exited 1 to preserve those six failures in its result.

Build first, then run the opt-in network checker from the repository root:

```sh
pnpm build
pnpm check:rpcs
pnpm check:rpcs --protocol solana
pnpm check:rpcs --help
```

The checker sends read-only identity and head requests against the built registry. It uses bounded timeouts, paces requests across networks by provider, and emits JSON results. Exit status is 0 when all checks pass, 1 when an endpoint fails a check, and 2 for invalid arguments or a missing/invalid build. Use `--timeout 10000` or `--concurrency 2` to adjust those defaults. It does not run during unit tests or rewrite the registry. Network, DNS, authentication, rate-limit, malformed-response, and chain-identity failures should be interpreted separately; a blocked local network is not evidence that a provider is permanently unavailable.

Refresh an endpoint by reviewing its operator's current documentation, checking its network identity and head, recording its source URLs and review date, and updating its budget or unsupported methods as needed. Keep keys and transaction-only services out of the default pool. Run the normal typecheck, tests, and build after changes.

HyperEVM mainnet rankings are refreshed separately by the weekly/manual **Rank HyperEVM registry** workflow, which opens a pull request rather than pushing to `main`. The ranker checks identity and head, adjusts lag for probe time, records ordinary call and log latency, calls the HyperCore `l1BlockNumber` precompile, and requests a 999-block log page. Requests have bounded deadlines and concurrency and are paced below each endpoint's configured sustained budget. Three successful observations spread over 14 days earn full weight; until then the endpoint cap is 0.15 and newcomers together hold at most 25% once an established endpoint exists. Missing source observations, wrong-chain-only runs, and rewrites that empty the pool are refused before writing.

The committed history was bootstrapped from the reference `smart-hyperevm` registry at commit `092b8f9`, retaining only URLs in this repo's source registry; it was not produced by a new current-day run. To explicitly rerun the live maintenance probe and print its result without writing, use `pnpm rank:hyperevm --dry-run`. `pnpm rank:hyperevm --fixtures <observation.json> --dry-run` replays historical fixtures without network access. Neither command is part of normal CI. The shared pool continues measuring live health at runtime; persisted weights only set its HyperEVM starting preferences.
