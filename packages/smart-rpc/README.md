# @bloxwap/smart-rpc

One JSON-RPC client that routes by CAIP-2 chain id.

```sh
npm install @bloxwap/smart-rpc
```

```ts
import { createSmartRpc } from "@bloxwap/smart-rpc";
import { ethereum } from "@bloxwap/smart-rpc/ethereum";
import { hyperevm } from "@bloxwap/smart-rpc/hyperevm";
import { solana } from "@bloxwap/smart-rpc/solana";

const rpc = createSmartRpc({
  transports: [ethereum(), hyperevm(), solana()],
});

const block = await rpc.request({
  chainId: "eip155:999",
  method: "eth_blockNumber",
  params: [],
});
```

The package root exports the core and does not import a transport. Each chain is a subpath of this package, so a bundler includes only the chains the app imports. Importing the root does not register every transport. Pass the transports you want to `createSmartRpc`.

`viem` is installed with this package. The Ethereum and HyperEVM subpaths use it for `http()` and `webSocket()` child connections. You do not install a second smart-rpc package for a chain.

Additional EVM factories use the same shared adapter and policies:

| Transport and provider notes | Subpath / factory | CAIP-2 id |
| --- | --- | --- |
| [BNB Smart Chain](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/bsc.md) | `bsc` | `eip155:56` |
| [Polygon PoS](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/polygon.md) | `polygon` | `eip155:137` |
| [Base](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/base.md) | `base` | `eip155:8453` |
| [Arbitrum One](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/arbitrum.md) | `arbitrum` | `eip155:42161` |
| [Monad](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/monad.md) | `monad` | `eip155:143` |
| [X Layer](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/xlayer.md) | `xlayer` | `eip155:196` |
| [Robinhood Chain](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/robinhood.md) | `robinhood` | `eip155:4663` |
| [Plasma](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/plasma.md) | `plasma` | `eip155:9745` |
| [Ink](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/ink.md) | `ink` | `eip155:57073` |
| [OP Mainnet](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/optimism.md) | `optimism` | `eip155:10` |
| [opBNB](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/opbnb.md) | `opbnb` | `eip155:204` |
| [Arc](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/arc.md) | `arc` | `eip155:5042` |
| [Etherlink](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/etherlink.md) | `etherlink` | `eip155:42793` |
| [Avalanche C-Chain](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/avalanche.md) | `avalanche` | `eip155:43114` |
| [Celo](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/celo.md) | `celo` | `eip155:42220` |
| [Gnosis](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/gnosis.md) | `gnosis` | `eip155:100` |
| [Mantle](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/mantle.md) | `mantle` | `eip155:5000` |
| [Flare](https://github.com/bloxwap/smart-rpc/blob/main/docs/transports/flare.md) | `flare` | `eip155:14` |

For example, import `{ base }` from `"@bloxwap/smart-rpc/base"` and register `base()`. Each factory verifies its own network identity. Endpoint options support dedicated URLs, HTTP headers, provider quotas, and explicit capabilities. Unknown or disabled archive, finality, batching, trace/debug and subscription support should be checked with the provider before enabling it. Chain-specific restrictions are documented in the linked notes.

Each transport includes documented free HTTP RPC defaults that do not require an API key. Ethereum covers mainnet; HyperEVM covers mainnet and testnet in separate pools; Solana selects mainnet, devnet, or testnet with its `cluster` option. These endpoints use the shared HyperEVM strategy: adaptive scoring, safe-read racing, chain identity checks, failover, circuit breakers, request budgets, coalescing, caching, and health probes.

Registry metadata includes provider names, source URLs, review dates, capabilities, and budgets where available. The budgets cover requests, retries, identity checks, and probes within the pool; provider groups share a quota across their URLs. They do not guarantee provider capacity or coordinate usage across pools or processes. Free services requiring an account or API key stay opt-in through `endpoints`.

```ts
import { ETHEREUM_MAINNET_REGISTRY } from "@bloxwap/smart-rpc/ethereum";
import { HYPEREVM_MAINNET_REGISTRY, HYPEREVM_TESTNET_REGISTRY } from "@bloxwap/smart-rpc/hyperevm";
import { MAINNET_REGISTRY, DEVNET_REGISTRY, TESTNET_REGISTRY } from "@bloxwap/smart-rpc/solana";
```

An explicit `endpoints` array replaces defaults for the selected network. For `hyperevm()` serving both networks, `endpoints` replaces mainnet and `testnetEndpoints` replaces testnet. For `hyperevm({ chainId: 998 })`, `endpoints` selects testnet endpoints. The official HyperEVM mainnet RPC retains its 1.5 requests/second, burst 3 budget.

Provider inventory, restrictions, API-key options, and the repository's `pnpm check:rpcs` verification command are documented in [Public RPCs](https://github.com/bloxwap/smart-rpc/blob/main/docs/PUBLIC_RPCS.md).
