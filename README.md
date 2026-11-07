# smart-rpc

One JSON-RPC client that routes by [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) chain id.

Shared routing lives in `@smart-rpc/core`: EWMA scoring, power-of-two-choices, a top-2 race for safe reads, a circuit breaker, retries, per-endpoint budgets, coalescing, a freshness-bounded cache, cancellation, and health probes. Chain packages are thin transports. They supply the probe, the chain-identity check, and which methods are safe to retry. Nothing in the core imports a chain.

Install one package. The root entry re-exports the core and nothing else. Transports are subpaths of that same package, so a bundler only includes a chain you import, and importing the root does not register every transport.

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

`eip155:999` is HyperEVM. `eip155:1` is Ethereum mainnet. `solana:mainnet` is Solana. A chain id only reaches the transport that registered it.

## Install

```sh
npm install @bloxwap/smart-rpc
```

```sh
pnpm add @bloxwap/smart-rpc
```

```sh
yarn add @bloxwap/smart-rpc
```

That install is the whole library. Core, Ethereum, HyperEVM, and Solana are compiled into `@bloxwap/smart-rpc`. There is no second package to add for a chain. `viem` is a dependency of this package, used by the Ethereum and HyperEVM subpaths as `http()` / `webSocket()` child transports. Solana speaks JSON-RPC over `fetch`. A bundler that only imports `@bloxwap/smart-rpc/solana` does not include the EVM transports.

## Layout

| Path | Role |
| --- | --- |
| `@bloxwap/smart-rpc` | Published package. Root export is the core. |
| `@bloxwap/smart-rpc/ethereum` | EVM JSON-RPC. Probe `eth_blockNumber`. Quarantine on `eth_chainId`. Pins `"latest"`. |
| `@bloxwap/smart-rpc/hyperevm` | Ethereum transport with separate public RPC pools for `eip155:999` / `eip155:998`. |
| `@bloxwap/smart-rpc/solana` | Probe `getSlot`. Quarantine on `getGenesisHash`. |
| `packages/core`, `packages/ethereum`, `packages/hyperevm`, `packages/solana` | Private workspace packages. Not published. The release build compiles them into `@bloxwap/smart-rpc`. |
| `examples/quick-start` | The snippet above |

HyperEVM mainnet is chain id 999 (`eip155:999`); testnet is chain id 998 (`eip155:998`). `hyperevm()` with no arguments serves both through separate endpoint pools. Both include the official RPC and documented public alternatives. The official mainnet URL keeps the reference budget of 1.5 requests per second, burst 3.

Solana registers `solana:mainnet` and the genesis-hash CAIP-2 id `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. Devnet and testnet have the same pair of aliases.

## Public RPC defaults

The package also includes these EVM transports. Each factory uses the shared Ethereum adapter and core routing policies, verifies its own chain identity, and accepts dedicated endpoints and HTTP headers. Import the factory from its subpath, for example `import { base } from "@bloxwap/smart-rpc/base"`.

| Transport and provider notes | Subpath / factory | CAIP-2 id |
| --- | --- | --- |
| [BNB Smart Chain](docs/transports/bsc.md) | `bsc` | `eip155:56` |
| [Polygon PoS](docs/transports/polygon.md) | `polygon` | `eip155:137` |
| [Base](docs/transports/base.md) | `base` | `eip155:8453` |
| [Arbitrum One](docs/transports/arbitrum.md) | `arbitrum` | `eip155:42161` |
| [Monad](docs/transports/monad.md) | `monad` | `eip155:143` |
| [X Layer](docs/transports/xlayer.md) | `xlayer` | `eip155:196` |
| [Robinhood Chain](docs/transports/robinhood.md) | `robinhood` | `eip155:4663` |
| [Plasma](docs/transports/plasma.md) | `plasma` | `eip155:9745` |
| [Ink](docs/transports/ink.md) | `ink` | `eip155:57073` |
| [OP Mainnet](docs/transports/optimism.md) | `optimism` | `eip155:10` |
| [opBNB](docs/transports/opbnb.md) | `opbnb` | `eip155:204` |
| [Arc](docs/transports/arc.md) | `arc` | `eip155:5042` |
| [Etherlink](docs/transports/etherlink.md) | `etherlink` | `eip155:42793` |
| [Avalanche C-Chain](docs/transports/avalanche.md) | `avalanche` | `eip155:43114` |
| [Celo](docs/transports/celo.md) | `celo` | `eip155:42220` |
| [Gnosis](docs/transports/gnosis.md) | `gnosis` | `eip155:100` |
| [Mantle](docs/transports/mantle.md) | `mantle` | `eip155:5000` |
| [Flare](docs/transports/flare.md) | `flare` | `eip155:14` |

The existing `ethereum`, `hyperevm`, and `solana` subpaths remain available. Public endpoint records expose verified restrictions; undocumented numeric quotas and optional capabilities are not assumed. See each transport's notes before enabling archive, debug/trace, finality tags, HTTP batches, or subscriptions.

Ethereum mainnet, HyperEVM mainnet/testnet, and Solana mainnet/devnet/testnet have source-backed registries of free HTTP endpoints that do not require an API key. The transports pass those endpoints into the shared pool, so defaults use the same scoring, identity checks, failover, racing, circuit breakers, caching, and request budgets as custom endpoints. Endpoint discovery does not run in the client.

Each registry entry records its provider, source URLs, review date, and local request budget. These budgets are conservative client settings, not purchased capacity or provider guarantees. They cover calls, retries, identity checks, and probes in that pool; other clients and processes sharing your IP can also consume the provider's quota. Services that require a free account or API key are documented separately and can be configured explicitly.

See [Public RPCs](docs/PUBLIC_RPCS.md) for coverage, provider sources, restrictions, and live verification instructions. Registries are exported from their transport subpaths:

```ts
import { ETHEREUM_MAINNET_REGISTRY } from "@bloxwap/smart-rpc/ethereum";
import { HYPEREVM_MAINNET_REGISTRY, HYPEREVM_TESTNET_REGISTRY } from "@bloxwap/smart-rpc/hyperevm";
import { MAINNET_REGISTRY, DEVNET_REGISTRY, TESTNET_REGISTRY } from "@bloxwap/smart-rpc/solana";
```

Passing `endpoints` replaces the selected network's defaults. To add your own provider while retaining the public pool and its budgets, use its exported registry:

```ts
import { ethereum, ETHEREUM_MAINNET_REGISTRY } from "@bloxwap/smart-rpc/ethereum";

const transport = ethereum({
  endpoints: [
    { url: process.env.ETHEREUM_RPC_URL!, label: "my-provider", rps: 5, burst: 5 },
    ...ETHEREUM_MAINNET_REGISTRY.map(({ url, rps, burst, unsupportedMethods }) => ({
      url, rps, burst, unsupportedMethods,
    })),
  ],
});
```

`ETHEREUM_MAINNET_ENDPOINTS` and the HyperEVM endpoint lists expose URLs for compatibility; their registry counterparts also carry budgets. Solana's `MAINNET_ENDPOINTS`, `DEVNET_ENDPOINTS`, and `TESTNET_ENDPOINTS` expose endpoint configurations with budgets. For a dual-network `hyperevm()` transport, `endpoints` replaces mainnet and `testnetEndpoints` replaces testnet. With `chainId: 998`, use `endpoints` for testnet.

## Defaults

The shared scoring, breaker and retry defaults follow `@bloxwap/smart-hyperevm` at `092b8f9`. Every chain uses them. Head freshness and endpoint capabilities can vary by chain.

- Score: latency mix 0.6, upward EWMA 0.4, downward 0.2, tail 0.5 / 0.05, error step 0.3, liveness step 0.15, error weight 8, prior 250ms, 5 samples to full confidence, 3 samples to blend a method.
- In-flight penalty: `1 + n + 0.25 n²`.
- Routing: power of two choices. Safe reads race the top 2 endpoints.
- Breaker: eject after 3 failures. Cooldown starts at 5s and doubles up to 60s. A health probe cannot clear a streak that includes a failed call. `Retry-After` ejects immediately, capped at 60s.
- Retries: 2 extra attempts, 10s per attempt. Another live endpoint is tried at once. Re-trying an endpoint that already failed this call waits a jittered backoff from 100ms, doubling, capped at 2s.
- A total operation budget bounds identity checks, retries, races and batch items: 64 upstream calls and four attempt timeouts by default. Configure `operationBudget: { maxRequests, timeout }` on a transport. `requestBatch()` returns ordered settled results, preserving successful items when siblings fail.
- EVM read safety uses an explicit allowlist. Unknown extensions are single sends unless configured with `safeMethods`; known writes and stateful filters remain unshared. Filter handles stay with the endpoint that created them. Use the Ethereum subpath's dedicated `connectViem(...).subscribe(...)` callback API for subscriptions.
- Probes: every 4s (`eth_blockNumber` on EVM, `getSlot` on Solana). The timer stops after 60s without a request. Automatic probes preserve the last available token on budgeted endpoints for caller traffic; explicit `probe()` calls may use it. Probe success and failure update liveness, not the latency EWMA.
- Heads older than 30s stop affecting the score. A head more than 1000 units ahead of the others' median is ignored. Two heads that far apart are not a reference.
- EVM transports pin `"latest"` to a block the chosen endpoints hold, and quarantine an endpoint whose `eth_chainId` is wrong. Solana quarantines a `getGenesisHash` mismatch. HyperEVM also skips HyperCore precompile `eth_call`s (`0x…0800`–`0x…08ff`) when pinning, because those calls ignore the block.

Pass `retryCount`, `timeout`, `operationBudget`, `race`, `breaker`, `budget`, `cache`, `endpoints`, `now`, and `random` on a transport to override a default. Registration stays explicit:

```ts
createSmartRpc({ transports: [hyperevm({ endpoints: ["https://rpc.hyperliquid.xyz/evm"] })] });
```

## Add a transport

An app can register a custom transport without a new package. `createPool` is exported from the root. Do not import a built-in chain from the root; import its subpath.

```ts
import { createPool, createSmartRpc, type ChainPolicy } from "@bloxwap/smart-rpc";

const policy: ChainPolicy = {
  chainIds: ["eip155:8453"],
  probeMethod: "eth_blockNumber",
  probeParams: [],
  parseHead: (result) => (typeof result === "string" ? Number.parseInt(result, 16) : null),
  identityMethod: "eth_chainId",
  identityParams: [],
  expectedIdentity: 8453,
  parseIdentity: (result) => (typeof result === "string" ? Number.parseInt(result, 16) : null),
  isSafeMethod: (method) => !method.startsWith("eth_send"),
  pin: true,
};

const base = createPool({
  policy,
  endpoints: [
    {
      id: "base",
      url: "https://mainnet.base.org",
      call: async (request, options) => {
        const response = await fetch("https://mainnet.base.org", {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: request.method, params: request.params ?? [] }),
          signal: options?.signal,
        });
        const body = await response.json();
        if (body.error) throw new Error(body.error.message);
        return body.result;
      },
    },
  ],
});

const rpc = createSmartRpc({ transports: [base] });
await rpc.request({ chainId: "eip155:8453", method: "eth_blockNumber", params: [] });
```

For an EVM chain that viem already speaks, prefer `ethereum({ chainId, endpoints })` from `@bloxwap/smart-rpc/ethereum`. It wires `http()` / `webSocket()`, pinning, and `eth_chainId`.

To ship a new chain inside this repo, add a private workspace package and a subpath file under `packages/smart-rpc/src` that re-exports its factory. The release build compiles that subpath into `@bloxwap/smart-rpc`. Leave `src/index.ts` as a re-export of the core only, so the new chain is not imported by the package root.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Node 22 and pnpm 10. The workspace is `packages/*` and `examples/*`.

`pnpm check:rpcs --protocol base` checks a built transport's public endpoints for chain identity and current head. Omit `--protocol` to check all registries. The manual **Public RPC smoke** GitHub Actions workflow runs the same check and saves its report; normal CI remains independent of public endpoint availability. Each chain package documents additional opt-in capability checks.
