# smart-rpc

One JSON-RPC client that routes by [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) chain id.

Shared routing lives in `@smart-rpc/core`: EWMA scoring, power-of-two-choices, a top-2 race for safe reads, a circuit breaker, retries, per-endpoint budgets, coalescing, a freshness-bounded cache, cancellation, and health probes. Chain packages are thin transports. They supply the probe, the chain-identity check, and which methods are safe to retry. Nothing in the core imports a chain.

The root package `smart-rpc` re-exports the core and nothing else. Transports are subpaths, so a bundler only includes a chain you import, and constructing the client does not register a transport you did not pass.

```ts
import { createSmartRpc } from "smart-rpc";
import { ethereum } from "smart-rpc/ethereum";
import { hyperevm } from "smart-rpc/hyperevm";
import { solana } from "smart-rpc/solana";

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

## Install the transports you use

```sh
pnpm add smart-rpc @smart-rpc/hyperevm
```

`@smart-rpc/ethereum`, `@smart-rpc/hyperevm`, and `@smart-rpc/solana` are optional peer dependencies of `smart-rpc`. Install the ones you import. `@smart-rpc/ethereum` and `@smart-rpc/hyperevm` depend on `viem` and call `http()` / `webSocket()` for each endpoint. `@smart-rpc/solana` speaks JSON-RPC over `fetch`.

You can also depend on a chain package directly and skip the umbrella:

```sh
pnpm add @smart-rpc/solana
```

## Packages

| Package | Role |
| --- | --- |
| `@smart-rpc/core` | Scoring, routing, breaker, retries, budgets, cache, pin, probes |
| `@smart-rpc/ethereum` | EVM JSON-RPC. Probe `eth_blockNumber`. Quarantine on `eth_chainId`. Pins `"latest"`. |
| `@smart-rpc/hyperevm` | `ethereum()` with chain `eip155:999` / `eip155:998` and `https://rpc.hyperliquid.xyz/evm` |
| `@smart-rpc/solana` | Probe `getSlot`. Quarantine on `getGenesisHash`. |
| `smart-rpc` | Re-exports core at `.` and each transport at a subpath |
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

Implement the chain hooks and hand the pool to `createSmartRpc`. Do not import it from `smart-rpc`'s root.

```ts
import { createPool, createSmartRpc, type ChainPolicy } from "smart-rpc";

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

For an EVM chain, prefer `@smart-rpc/ethereum` with `chainId` and `endpoints`. It already wires viem, pinning, and `eth_chainId`. A new package should depend on `@smart-rpc/core` (and `@smart-rpc/ethereum` when it is an EVM chain), set `"sideEffects": false`, and export a factory that returns a transport. Add a subpath under `packages/smart-rpc/src` that re-exports that factory, and add the package as an optional peer of `smart-rpc`. The root `src/index.ts` stays a re-export of `@smart-rpc/core` only.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Node 22 and pnpm 10. The workspace is `packages/*` and `examples/*`.
