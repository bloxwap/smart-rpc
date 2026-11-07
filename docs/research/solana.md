# Solana free RPC research

Reviewed 2026-11-06. This inventory covers the repository's existing mainnet, devnet, and testnet clusters. Provider pages establish whether an endpoint is intentionally public; small read-only probes check present identity and basic functionality. This is a researched inventory, not a promise that every free service has been discovered or that public capacity will remain available.

## Keyless endpoints

| Cluster | Provider | HTTP endpoint | Evidence and limits |
| --- | --- | --- | --- |
| Mainnet | PublicNode / Allnodes | `https://solana-rpc.publicnode.com` | [Provider page](https://solana.publicnode.com/) publishes the endpoint. No numerical public HTTP quota found. Basic identity and head probes passed. Archive access is separately offered; general history depth is not guaranteed. |
| Mainnet | Pocket Network | `https://solana.api.pocket.network` | [Supported chains](https://docs.pocket.network/developers/supported-chains/) publishes keyless access and 2,000 requests per IP per minute. Identity and head passed. [Provider integration notes](https://docs.pocket.network/developers/integration-examples/) warn that `getTokenAccountsByOwner` may be unreliable. |
| Mainnet | Solana | `https://api.mainnet.solana.com` | [Official cluster documentation](https://solana.com/docs/references/clusters) publishes this current canonical URL. Identity and head passed. |
| Mainnet | OnFinality | `https://solana.api.onfinality.io/public` | [Provider network page](https://www.onfinality.io/en/networks/solana) publishes the public endpoint and 5 requests/second. Both probes returned HTTP 429 from this location; this documents rate limiting, not a chain identity verification. |
| Mainnet | Solana Vibe Station | `https://public.rpc.solanavibestation.com` | [Provider homepage](https://solanavibestation.com/) demonstrates the public URL. [RPC service documentation](https://docs.solanavibestation.com/services/solana-node-services/rpc-services) lists free-tier 5 requests/second and 1 `sendTransaction`/second. Identity and head passed. Public and authenticated free offerings need not have identical limits; 1 request/second is a conservative local ceiling. |
| Mainnet | Web3CDN | `https://solana.web3cdn.rest` | [Provider Solana page](https://web3cdn.network/rpc/solana) publishes this URL in its HTML input value and lists a no-key tier. Identity and head passed. See quota discussion below. |
| Devnet | Solana | `https://api.devnet.solana.com` | [Official cluster documentation](https://solana.com/docs/references/clusters). Identity and head passed. |
| Devnet | OnFinality | `https://solana-devnet.api.onfinality.io/public` | [Provider devnet page](https://www.onfinality.io/en/networks/solana-devnet) publishes the endpoint and 5 requests/second. Identity and head passed. |
| Testnet | Solana | `https://api.testnet.solana.com` | [Official cluster documentation](https://solana.com/docs/references/clusters). Identity and head passed. |
| Testnet | PublicNode / Allnodes | `https://solana-testnet-rpc.publicnode.com` | [Provider Solana page](https://solana.publicnode.com/) contains this exact URL in its embedded network configuration under Testnet. Identity and head passed. |
| Testnet | Web3CDN | `https://solana-testnet.web3cdn.rest` | [Provider Solana page](https://web3cdn.network/rpc/solana) publishes this URL in its HTML input value. Identity and head passed. |

The official Solana quotas include 100 requests per 10 seconds per IP, **40 requests per 10 seconds for one method**, 40 concurrent connections, and a bandwidth ceiling. The transport's endpoint-wide token bucket cannot enforce every dimension. A local 3 requests/second with burst 3 stays below the repeated-method request ceiling for a single pool; quotas remain shared with other callers on the same public IP. Do not register the legacy `https://api.mainnet-beta.solana.com` as a second independent default: it answered with the same mainnet identity and slot as the canonical URL and belongs to the same operator. [Source](https://solana.com/docs/references/clusters)

Web3CDN's no-key tier publishes 2 requests/second, 60/minute, 1,000/hour, and 10,000/day. All four included Web3CDN entries—Ethereum mainnet, HyperEVM mainnet, and Solana mainnet/testnet—use 0.025 requests/second with burst 2. One long-lived pool for each network can therefore consume roughly 8,640 requests/day plus eight initial tokens across the four buckets, conservatively allocating the possible shared IP quota. Background probes preserve a request token so these slow-refill endpoints remain usable as fallbacks. The buckets do not coordinate new instances, restarts, independent processes, or unrelated traffic sharing the public IP. [Source](https://web3cdn.network/rpc/solana)

## Partial, credentialed, or excluded candidates

| Candidate | Finding | Default decision |
| --- | --- | --- |
| Tatum mainnet `https://solana-mainnet.gateway.tatum.io` and devnet `https://solana-devnet.gateway.tatum.io` | Anonymous identity/head calls passed. [Access-restriction documentation](https://docs.tatum.io/docs/api-key-access-restrictions) confirms an anonymous tier; [chain page](https://tatum.io/chain/solana) gives both URLs. However, [gateway limits](https://docs.tatum.io/docs/gateway-limits) exclude anonymous `getBalance`, `getConfirmedSignaturesForAddress2`, `getProgramAccounts`, `getSignaturesForAddress`, and `getTokenAccountsByOwner`. Live `getBalance` returned a paid-plan error. | Omit from general defaults. A caller intentionally using its partial anonymous service must exclude these methods and apply a very small budget. The sibling library's historical 5 requests/minute is not treated as a current provider guarantee. |
| LeoRPC `https://solana.leorpc.com/?api_key=FREE` | Correct identity and head returned without a private credential. [Provider homepage](https://leorpc.com/) advertises no-signup free access; [pricing](https://leorpc.com/pricing) lists 3 requests/second. The exact `FREE` query template could not be confirmed in the crawlable provider page. | Document as an opt-in candidate pending exact provider-publication confirmation. Do not treat an arbitrary exposed key as a public credential. |
| Solana Tracker `https://rpc.solanatracker.io/public` | HTTP 401, RPC error `-32401`, explicitly says the formerly public endpoint now requires a free API key. [Current RPC documentation](https://docs.solanatracker.io/solana-rpc) uses `https://rpc-mainnet.solanatracker.io/?api_key=YOUR_API_KEY`. | Remove the obsolete keyless default. Use a caller's free key explicitly. |
| dRPC `https://solana.drpc.org` | HTTP 400, RPC code 35, reports Solana is unavailable on the free plan. [Current pricing](https://drpc.org/docs/pricing/plans) and [Solana API guide](https://drpc.org/docs/solana-api) establish paid/keyed access. | Exclude from free defaults. |
| Ankr `https://rpc.ankr.com/solana` | HTTP 403; response says the API key is not allowed to access the blockchain. Historical public listings are insufficient to establish current keyless access. | Exclude the bare public URL. |
| Uniblock `https://api.uniblock.dev/uni/v1/json-rpc?chainId=solana` and `?chainId=solana-devnet` | Both returned HTTP 429 referring to a shared documentation project. [Current provider docs](https://docs.uniblock.dev/guides/getting-started/starting-out) direct users to obtain an API key. | Exclude shared documentation access; configure the caller's own free account. |
| QuickNode `https://docs-demo.solana-mainnet.quiknode.pro` | Historical sibling entry is a documentation demonstration URL. A demo URL is not sufficient evidence of an intentionally supported general-purpose free service. | Exclude; do not redistribute documentation credentials or demos as default capacity. |
| `https://1rpc.io/sol` | [Provider public quota documentation](https://docs.1rpc.io/using-the-web3-api/errors) lists 200 requests/day/user. Four-second continuous health probes alone would exceed that allowance. | Keep opt-in; unsuitable for the automatic default probe cadence. |
| Raw IPs from Solana gossip scans | Discoverable nodes are not necessarily operator-supported public APIs, and bare HTTP does not provide the HTTPS transport expected for defaults. | Exclude without an operator's public service documentation. |
| Helius Sender, Jito block engines, and other transaction relays | Transaction delivery services are not interchangeable with ordinary `getGenesisHash`, `getSlot`, account-read, and history RPC endpoints. | Do not register send-only services as full RPC fallbacks. |

## Free accounts that require caller credentials

These are alternatives to public shared URLs, not bundled credentials. Method limits and billing units differ; obtain an endpoint from the provider and pass it through `solana({ endpoints: [...] })` with a suitable budget. No accounts were created, keys obtained, or paid services enabled during this research.

| Provider | Evidence |
| --- | --- |
| Helius | [RPC plans](https://www.helius.dev/solana-rpc-nodes/) list a free plan with 1 million credits, 10 RPC requests/second, and 1 `sendTransaction`/second. |
| Alchemy | [Pricing](https://www.alchemy.com/pricing) lists a free tier with 30 million compute units/month and 15 requests/second; [Solana archival guide](https://www.alchemy.com/blog/how-alchemy-built-the-fastest-archival-methods-on-solana) describes obtaining an API key through a free account. |
| Chainstack | [Pricing](https://chainstack.com/pricing/) offers account-based RPC plans; [Solana method guide](https://chainstack.com/solana-rpc-methods/) describes free Developer restrictions and plan-specific Solana rate limits. Do not assume a generic account RPS headline applies to every Solana method. |
| GetBlock | [Pricing](https://getblock.io/pricing/) includes free shared-node access and lists Solana among supported networks. Endpoint tokens come from the user's account. |
| Solana Tracker | [RPC documentation](https://docs.solanatracker.io/solana-rpc) and the old public endpoint's authentication response direct users to obtain a free key. |
| OnFinality | [Network page](https://www.onfinality.io/en/networks/solana) advertises a registered free plan up to 40 requests/second separately from its 5 requests/second public endpoint. |
| Tatum | [Plans](https://docs.tatum.io/docs/plans-limits) describe two free keys, 100,000 credits, and 3 requests/second. [Method restrictions](https://docs.tatum.io/docs/gateway-limits) still exclude some common Solana reads on the free keyed plan. |
| Solana Vibe Station | [RPC service documentation](https://docs.solanavibestation.com/services/solana-node-services/rpc-services) documents its free service tier separately from paid offerings. |
| Web3CDN | [Solana page](https://web3cdn.network/rpc/solana) distinguishes no-key access from a registered free tier with separate monthly and rate limits. |
| Uniblock | [Provider pricing](https://uniblock.dev/) lists a free startup plan; [setup documentation](https://docs.uniblock.dev/guides/getting-started/starting-out) requires the user's API key. |

## Probe method and limitations

Probes were ordinary JSON-RPC POST requests using only `getGenesisHash` and `getSlot`, plus four spaced Tatum capability reads. Tatum allowed `getAccountInfo` and `getLatestBlockhash`, rejected `getBalance` as paid-only, and rejected anonymous `getSignaturesForAddress`. No probes submitted transactions. The expected genesis hashes were:

- Mainnet: `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`.
- Devnet: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.
- Testnet: `4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY`.

Initial sandboxed shell access could not resolve external names. Network-enabled read-only checks subsequently succeeded. Python's default HTTP user agent received 403 from PublicNode, while curl succeeded against the same mainnet and testnet endpoints; that difference is not a chain or endpoint outage. PublicNode mainnet and testnet curl probes returned slots `466329815` and `461489129`, respectively. Successful heads are a point-in-time observation, not an uptime benchmark, CORS test, full method compliance test, or archive guarantee. OnFinality mainnet remained rate limited in the sampled requests. The runtime must continue checking identity, learning latency, respecting budgets, and failing over.
