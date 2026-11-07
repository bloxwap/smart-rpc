# Ethereum free RPC survey

Reviewed 2026-11-06 for Ethereum mainnet (`eip155:1`). This is a maintained survey of discoverable providers, not a claim that every privately operated RPC on the internet can be enumerated. Provider documentation establishes access terms; the separate probe results below establish only what this environment observed at one point in time. No account was created and no third-party API key was copied.

## Public, keyless general-purpose candidates

The source links below are operated by the providers themselves. Only one hostname per operator should normally be included in the default pool: aliases do not create independent capacity or failure domains. OMNIA and SubQuery remain catalog candidates because their probes failed with 521 and DNS errors respectively. The shipped registry is authoritative about which candidates are enabled.

| Provider | HTTPS URL | Documented limits and caveats | Primary source |
| --- | --- | --- | --- |
| PublicNode / Allnodes | `https://ethereum-rpc.publicnode.com` | Public endpoint; the website offers archive access separately. No fixed per-client RPS found. Legacy `ethereum.publicnode.com` is the same service. | [Ethereum gateway](https://ethereum.publicnode.com/) |
| dRPC | `https://eth.drpc.org` | Free/public restrictions include variable CU limits, nominally 120,000 CU/minute/IP, maximum batch size 3, maximum 10,000 log results, a 2-second execution timeout, and disabled filter methods. A CU budget is not an RPS guarantee. Archive/debug/trace are not part of the free plan. | [Ethereum API](https://drpc.org/docs/ethereum-api), [rate limiting](https://drpc.org/docs/howitworks/ratelimiting), [plans](https://drpc.org/docs/pricing/plans) |
| LlamaNodes | `https://eth.llamarpc.com` | Published as a free public endpoint. No current fixed quota established. | [Ethereum endpoint](https://llamarpc.com/eth) |
| BlockPI | `https://ethereum.public.blockpi.network/v1/rpc/public` | Use the current public hostname, including `.public.`. Public batches are limited to 10 requests. Archive/advanced APIs are advertised separately. | [Public endpoints](https://public.blockpi.io/), [API reference](https://docs.blockpi.io/build/api-reference) |
| OnFinality | `https://eth.api.onfinality.io/public` | Public service advertises 5 requests/second. A personal endpoint is available after signup. | [Provider network list](https://www.onfinality.io/en/), [Ethereum setup](https://onfinality.io/es/rpc-assistant/ethereum-rpc) |
| OMNIA | `https://endpoints.omniatech.io/v1/eth/mainnet/public` | Provider lists the free mainnet endpoint. Live probe returned 521 here, so availability was not verified. | [Public RPC endpoints](https://docs.omniatech.io/public-rpc-endpoints) |
| 0xRPC | `https://0xrpc.io/eth` | Operator says fewer than roughly 10–20 calls/second, counting batched calls. Full blocks with 128-state history; not an archive-state guarantee. `https://0xrpc.io/eth/v1` is the beacon API and must not enter this JSON-RPC pool. | [Operator endpoint list](https://0xrpc.github.io/) |
| NOWNodes | `https://public-eth.nownodes.io` | Explicitly keyless, no registration; published limit 5 requests/second. | [Public endpoints](https://nownodes.io/public-endpoints) |
| Nodies | `https://ethereum-public.nodies.app` | Provider homepage public endpoint data contains this exact hostname; public endpoints are shared. No fixed quota found for this hostname. | [Provider homepage](https://nodies.app), [public service](https://docs.nodies.app/rpc-services/public-endpoints) |
| Nodies / POKT | `https://eth-pokt.nodies.app` | Alternate Nodies-operated public gateway over Pocket, with dynamic throughput around 15–25 RPS. Avoid treating it as an unrelated operator. | [POKT endpoints](https://docs.nodies.app/rpc-services/pokt-public-rpc-endpoints) |
| Tenderly | `https://mainnet.gateway.tenderly.co` | Key is explicitly optional. Keyless access allows 1 GB response data/IP/day; exhaustion returns HTTP 429 / RPC `-32005`. Log calls are capped at 3,000 results (`-32602` beyond the cap). Custom authenticated Node RPC is a separate paid service. | [RPC reference](https://docs.tenderly.co/node-rpc/rpc-reference), [public limits](https://docs.tenderly.co/node-rpc/overview#public-endpoint-limits) |
| SubQuery | `https://ethereum.rpc.subquery.network/public` | Provider project page still advertises public archive RPC. DNS did not resolve in the live check; retain as a candidate pending successful revalidation. | [Ethereum RPC project](https://subquery.network/projects/ethereum-rpc---archive-node) |
| Pocket Network Foundation | `https://eth.api.pocket.network` | Explicitly free, keyless public gateway. Published rate limit is 2,000 requests/IP/minute, with a separate 10,000 requests/second total endpoint ceiling. This is separate from the Nodies-hosted POKT URL, although upstream infrastructure may overlap. | [API portal](https://docs.pocket.network/foundation/api-portal/), [supported chains and limits](https://docs.pocket.network/developers/supported-chains/) |
| Web3CDN | `https://ethereum.web3cdn.rest` | Exact URL appears in the Ethereum page's API Playground. No-key limits are 2/second, 60/minute, 1,000/hour, and 10,000/day by IP. No archive entitlement on the public tier. A normal four-second probe cadence alone exceeds the daily cap; a much lower endpoint budget is required. | [Ethereum endpoint and limits](https://web3cdn.network/rpc/ethereum) |

Known limits should be represented in endpoint configuration when supported. Conservative client token buckets are application defaults, not promises that providers allow that rate. Per-IP/day, byte, method, CU, and aggregate-across-process quotas cannot be fully enforced by a single per-instance RPS bucket. Batch requests should remain off unless the selected providers' individual batch limits are respected.

The implementation includes eleven Ethereum defaults. Most use 2 RPS / burst 3. Web3CDN uses 0.025 RPS / burst 2 so four Web3CDN entries across the supported protocols consume at most about 8,640 requests/day in steady state, plus eight initial burst tokens. This is a per-instance mitigation; restarts, additional instances, and unrelated traffic from the same IP can still exhaust the provider's shared quota. The implementation excludes dRPC filter methods. It conservatively excludes `eth_getLogs` from the default Tenderly entry: its documented result-limit error uses `-32602`, which can otherwise be treated as a caller error rather than a provider capability limit. Other eligible defaults can serve log queries.

## Public endpoints that need deliberate opt-in

| Provider | URL | Why it is not a blanket general-purpose default | Primary source |
| --- | --- | --- | --- |
| 1RPC | `https://public.1rpc.io/eth` | Current public quota is **200 requests/day/user**, then blocked until 00:00 UTC. Continuous four-second probes alone would use that quota in about 13 minutes. The old `https://1rpc.io/eth` URL and old 10,000/day quota should not be copied from stale lists. A free keyed Starter tier is separate. | [Networks](https://docs.1rpc.io/using-the-web3-api/networks), [quota errors](https://docs.1rpc.io/using-the-web3-api/errors), [plans](https://www.1rpc.io/) |
| Nodely | `https://eth.nodely.dev` | Public, no key. Pruned state/blocks/logs cover about 14 days; transaction-hash/receipt lookup covers only about an hour and can return `null` for older transactions. That is a successful RPC result that ordinary failover cannot detect as missing history. Explicit per-method routing is needed before a generic default is safe. | [Ethereum RPC](https://nodely.io/docs/ethereum) |
| Merkle / Blink | `https://eth.merkle.io` | Provider's older announcement documents the public service; current product page advertises free 25 RPS and directs signup. Probe returned 429. Uses MEV-protected transaction routing; preserve that choice explicitly. | [Public RPC announcement](https://www.merkle.io/blog/improving-reth-with-our-free-ethereum-rpc-service), [current offering](https://www.merkle.io/ethereum-rpc) |
| Gateway.fm | `https://rpc.eth.gateway.fm` | Exact URL appears in provider docs, but the same page retains obsolete Goerli examples and current free entitlement/live availability were not established. | [Ethereum API](https://docs.gateway.fm/rpc/ethereum/) |
| Stakely | `https://ethereum-json-rpc.stakely.io` | Exact URL appears in the operator page, which displayed zero active nodes during review. Current availability needs a successful probe before enabling. | [Ethereum API](https://stakely.io/web3-api-load-balancer/ethereum) |
| Flashbots Protect | `https://rpc.flashbots.net`, `/fast` | Private transaction routing has different privacy/inclusion semantics. No JSON-RPC batching. Several common reads permit 200 calls/IP/5 minutes; other methods 600/IP/5 minutes. Do not silently rebroadcast private submissions through a public-mempool fallback. | [Rate limits](https://docs.flashbots.net/flashbots-protect/ratelimiting) |
| MEV Blocker | `https://rpc.mevblocker.io` | Other public variants: `/fast`, `/noreverts`, `/fullprivacy`, `/maxbackruns`, `/nochecks`. These deliberately differ in transaction sharing/revert/refund behavior; pending nonce results include private transactions. Preserve the selected policy rather than racing or failing over writes indiscriminately. | [Transaction endpoints](https://docs.mevblocker.io/reference/api/transaction-endpoints), [integration semantics](https://docs.mevblocker.io/how-to/integrate/Wallets) |
| BlockRazor | `https://eth.blockrazor.xyz` | Explicitly free/keyless; private transaction delivery and rebate policy. `/fullprivacy` and `/maxbackrun?percent=90` are distinct policies, not interchangeable capacity. | [Ethereum RPC](https://blockrazor.io/rpc/ethereum/) |
| thirdweb | `https://1.rpc.thirdweb.com` | The provider's Ethereum chain page publishes this naked URL and it passed live keyless identity/head checks. However, its infrastructure policy requires developer API keys, and current SDK documentation specifies `https://<chainId>.rpc.thirdweb.com/<clientId>`. Public app-use entitlement and keyless quotas remain unclear, so successful probes alone do not justify automatic inclusion. Supply your own client ID for a configured endpoint and check the current account plan. | [Ethereum chain page](https://thirdweb.com/ethereum), [API key policy](https://blog.thirdweb.com/changelog/api-keys-to-access-thirdweb-infra/), [current client documentation](https://portal.thirdweb.com/typescript/v5/client) |

## Free accounts and credentials

These can be supplied through `ethereum({ endpoints: [...] })` after the caller obtains their own credentials. They cannot ship as anonymous defaults. Free-tier figures are snapshots, not ongoing guarantees; monthly/daily credit caps differ from requests per second.

| Provider | Free access and caller setup | Primary source |
| --- | --- | --- |
| Ankr | Personal API key required. The existing keyless `/eth` default returned an explicit authentication error during verification. | [Current Ethereum access notice](https://eth.public-rpc.com/), [API reference](https://www.ankr.com/docs/api-reference/) |
| Alchemy | Free account: 30M CU/month, 25 RPS, 5 apps; use the account's Ethereum endpoint. | [Pricing](https://www.alchemy.com/pricing) |
| Infura | Free account: 3M credits/day and 500 credits/second. Requests consume method-dependent credits. | [Pricing documentation](https://docs.infura.io/get-started/pricing/) |
| Chainstack | Free Developer account: 3M request units/month, 25 RPS, one node. | [Plans](https://chainstack.com/pricing/) |
| GetBlock | Free account: 50K CU/day, 20 RPS, two access tokens. | [Limits](https://docs.getblock.io/getting-started/plans-and-limits/cu-and-rate-limits) |
| ZAN | Free quickstart requires a personal project/API key; current documented Ethereum URL is `https://api.zan.top/node/v1/eth/mainnet/{apiKey}`. | [Free quickstart](https://docs.zan.top/docs/quick-start-guide), [authentication](https://docs.zan.top/reference/api-instructions) |
| Nodies | Dedicated endpoint registration advertises 15M free monthly requests separately from public endpoints. | [Public versus dedicated endpoints](https://docs.nodies.app/rpc-services/pokt-public-rpc-endpoints) |
| dRPC | Account Free tier advertises 210M CU/30 days and public nodes; paid plans have distinct features. No credentials are needed for the public URL above. | [Plans](https://drpc.org/docs/pricing/plans) |
| 1RPC | Starter free account advertises 1,000 requests/day, separate from the 200/day public quota. | [Provider plans](https://www.1rpc.io/) |

## Retired and unverified listings

- `https://cloudflare-eth.com`: remove the legacy default; Cloudflare documents deprecation of public legacy gateway hostnames and migration to account-managed gateways. [Migration guide](https://developers.cloudflare.com/web3/reference/migration-guide/).
- `https://eth-mainnet.public.blastapi.io`: exclude; the operator states BlastAPI products are no longer available. This is the RPC provider, not the similarly named Blast blockchain. [Deprecation notice](https://blastapi.io/).
- MeowRPC (`https://eth.meowrpc.com`), Lava (`https://eth1.lava.build`), and other community hosts surfaced in directories, but an exact current primary-provider eligibility source was not established in this pass. MeowRPC also returned 403 here. They remain discovery candidates rather than automatically trusted defaults.
- Public lists contain shared demo credentials, arbitrary UUID/token paths, and virtual fork URLs. Their presence in a list does not establish permission, stable public access, or Ethereum-mainnet equivalence. They were not copied or tested.

## Live probe record

On 2026-11-06, sent one `eth_chainId` and one `eth_blockNumber` request per endpoint, without credentials or transactions. Initial sandboxed calls all failed DNS; an approved network-capable invocation produced the following. These are point-in-time observations from one environment, not global uptime measurements. HTTP 403 may reflect local egress/IP/provider filtering; HTTP 429 is throttling, not proof that a service is paid-only.

| Endpoint | `eth_chainId` | `eth_blockNumber` |
| --- | --- | --- |
| `https://0xrpc.io/eth` | `0x1` | `0x19237b3` |
| `https://ethereum-public.nodies.app` | `0x1` | `0x19237b3` |
| `https://mainnet.gateway.tenderly.co` | `0x1` | `0x19237b3` |
| `https://ethereum-rpc.publicnode.com` | HTTP 403 | HTTP 403 |
| `https://eth.drpc.org` | HTTP 403 | HTTP 403 |
| `https://eth.llamarpc.com` | HTTP 403 | HTTP 403 |
| `https://ethereum.public.blockpi.network/v1/rpc/public` | HTTP 403 | HTTP 403 |
| `https://public-eth.nownodes.io` | HTTP 403 | HTTP 403 |
| `https://eth.api.onfinality.io/public` | HTTP 429 | HTTP 429 |
| `https://eth.merkle.io` | HTTP 429 | HTTP 429 |
| `https://endpoints.omniatech.io/v1/eth/mainnet/public` | HTTP 521 | HTTP 521 |
| `https://ethereum.rpc.subquery.network/public` | DNS failure | DNS failure |
| `https://rpc.ankr.com/eth` | RPC `-32000`, API key required | Same authentication error |
| `https://cloudflare-eth.com` | HTTP 403 | HTTP 403 |
| `https://eth.meowrpc.com` | HTTP 403 | HTTP 403 |

The transport should still verify identity before use, score health at runtime, honor retry/rate-limit feedback, and fail over to a different eligible provider. These results cannot replace those checks or establish archive/method coverage.

A targeted second pass found that several initial 403 responses were specific to Python's default User-Agent. Repeating the same two read-only probes with `User-Agent: smart-rpc-discovery/1.0` produced the following results. This was ordinary HTTP client identification; no credentials, challenge bypass, or account was used.

| Endpoint | `eth_chainId` | `eth_blockNumber` |
| --- | --- | --- |
| `https://ethereum-rpc.publicnode.com` | `0x1` | `0x19237d0` |
| `https://eth.drpc.org` | `0x1` | `0x19237d0` |
| `https://public-eth.nownodes.io` | `0x1` | `0x19237d0` |
| `https://1.rpc.thirdweb.com` | `0x1` | `0x19237d0` |
| `https://eth.llamarpc.com` | HTTP 525 | HTTP 525 |
| `https://ethereum.public.blockpi.network/v1/rpc/public` | HTTP 521 | HTTP 521 |

New cross-provider discoveries also passed both read-only probes: `https://eth.api.pocket.network` and `https://ethereum.web3cdn.rest` each returned chain `0x1` and head `0x19237ce`. LlamaNodes and BlockPI remain source-documented services but were not live-verified in either pass; their 5xx responses merit exclusion or revalidation rather than labeling them healthy.
