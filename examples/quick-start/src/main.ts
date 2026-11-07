/**
 * One client, one request. The CAIP-2 chain id picks the transport.
 *
 * Run with `pnpm --filter quick-start start` after `pnpm build`.
 */
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

console.log(block);
rpc.close();
