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

Each transport includes documented free HTTP RPC defaults that do not require an API key. Ethereum covers mainnet; HyperEVM covers mainnet and testnet in separate pools; Solana selects mainnet, devnet, or testnet with its `cluster` option. These endpoints use the shared HyperEVM strategy: adaptive scoring, safe-read racing, chain identity checks, failover, circuit breakers, request budgets, coalescing, caching, and health probes.

Registry metadata includes provider names, source URLs, review dates, and conservative local budgets. The budgets cover requests, retries, identity checks, and probes within the pool. They do not guarantee provider capacity or coordinate usage across processes. Free services requiring an account or API key stay opt-in through `endpoints`.

```ts
import { ETHEREUM_MAINNET_REGISTRY } from "@bloxwap/smart-rpc/ethereum";
import { HYPEREVM_MAINNET_REGISTRY, HYPEREVM_TESTNET_REGISTRY } from "@bloxwap/smart-rpc/hyperevm";
import { MAINNET_REGISTRY, DEVNET_REGISTRY, TESTNET_REGISTRY } from "@bloxwap/smart-rpc/solana";
```

An explicit `endpoints` array replaces defaults for the selected network. For `hyperevm()` serving both networks, `endpoints` replaces mainnet and `testnetEndpoints` replaces testnet. For `hyperevm({ chainId: 998 })`, `endpoints` selects testnet endpoints. The official HyperEVM mainnet RPC retains its 1.5 requests/second, burst 3 budget.

Provider inventory, restrictions, API-key options, and the repository's `pnpm check:rpcs` verification command are documented in [Public RPCs](https://github.com/bloxwap/smart-rpc/blob/main/docs/PUBLIC_RPCS.md).
