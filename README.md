# Smart RPC

Performance-optimized, multi-chain JSON-RPC routing for TypeScript. One package includes the shared router and every built-in transport.

## Install

```sh
npm install @bloxwap/smart-rpc
```

Node.js 22.12 or later is required.

## Use

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

Every chain uses a subpath of `@bloxwap/smart-rpc`, so application bundles include only imported transports. The release package contains no private workspace dependencies.

Caller-visible enforcement is listed in the [migration guide](apps/docs/content/docs/migration.md). Solana unknown methods are single-shot, `earliest` is not an alias of block 0, Solana `getTransaction` is immutable only at `finalized`, and HyperEVM probes block hashes so a forward reorg drops cached state.

## Documentation

The Next.js and Fumadocs application lives in [`apps/docs`](apps/docs). It includes the complete performance-feature table, installation, configuration, transport notes, public RPC registries, migration guidance, benchmarks, and research.

```sh
pnpm install
pnpm docs:dev
```

The documentation development server runs on port 3901. Build the static site with `pnpm docs:build`.

## Repository layout

| Path | Role |
| --- | --- |
| `apps/docs` | Documentation application and content. |
| `packages/smart-rpc` | Single published, split ESM bundle. |
| `packages/*` | Private core and chain workspaces compiled into the published package. |
| `examples/quick-start` | Minimal consumer example. |
| `scripts` | Maintenance and public RPC verification. |

## Develop

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm docs:check
pnpm docs:build
```

See [development](apps/docs/content/docs/development.mdx) for workflows and bundle details, and the [library reference](apps/docs/content/docs/reference.md) for complete API behavior and defaults.
