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
| `@bloxwap/smart-rpc/hyperevm` | Ethereum transport with chain `eip155:999` / `eip155:998` and `https://rpc.hyperliquid.xyz/evm` |
| `@bloxwap/smart-rpc/solana` | Probe `getSlot`. Quarantine on `getGenesisHash`. |
| `packages/core`, `packages/ethereum`, `packages/hyperevm`, `packages/solana` | Private workspace packages. Not published. The release build compiles them into `@bloxwap/smart-rpc`. |
| `examples/quick-start` | The snippet above |

HyperEVM mainnet is chain id 999 (`eip155:999`), default URL `https://rpc.hyperliquid.xyz/evm`. Testnet is chain id 998 (`eip155:998`), default URL `https://rpc.hyperliquid-testnet.xyz/evm`. `hyperevm()` with no arguments serves both. The official mainnet URL keeps the reference budget of 1.5 requests per second, burst 3.

Solana registers `solana:mainnet` and the genesis-hash CAIP-2 id `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. Devnet and testnet have the same pair of aliases.

## Defaults

These match `@bloxwap/smart-hyperevm` at `092b8f9`. Every chain uses them. Solana does not keep that repo's 150ms / 30s backoff.

- Score: latency mix 0.6, upward EWMA 0.4, downward 0.2, tail 0.5 / 0.05, error step 0.3, liveness step 0.15, error weight 8, prior 250ms, 5 samples to full confidence, 3 samples to blend a method.
- In-flight penalty: `1 + n + 0.25 n²`.
- Routing: power of two choices. Safe reads race the top 2 endpoints.
- Breaker: eject after 3 failures. Cooldown starts at 5s and doubles up to 60s. A health probe cannot clear a streak that includes a failed call. `Retry-After` ejects immediately, capped at 60s.
- Retries: 2 extra attempts, 10s per attempt. Another live endpoint is tried at once. Re-trying an endpoint that already failed this call waits a jittered backoff from 100ms, doubling, capped at 2s.
- Probes: every 4s (`eth_blockNumber` on EVM, `getSlot` on Solana). The timer stops after 60s without a request. Probe success and failure update liveness, not the latency EWMA.
- Heads older than 30s stop affecting the score. A head more than 1000 units ahead of the others' median is ignored. Two heads that far apart are not a reference.
- EVM transports pin `"latest"` to a block the chosen endpoints hold, and quarantine an endpoint whose `eth_chainId` is wrong. Solana quarantines a `getGenesisHash` mismatch. HyperEVM also skips HyperCore precompile `eth_call`s (`0x…0800`–`0x…08ff`) when pinning, because those calls ignore the block.

Pass `retryCount`, `timeout`, `race`, `breaker`, `budget`, `cache`, `endpoints`, `now`, and `random` on a transport to override a default. Registration stays explicit:

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
