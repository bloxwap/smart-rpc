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
