import { expect, test } from "vitest";

import { HYPEREVM_RPC_URL, hyperevm } from "../src/index.js";

// Explicit opt-in: free RPC availability is not a CI dependency or an SLA.
const enabled = process.env.SMART_RPC_LIVE_HYPEREVM === "1";
test.skipIf(!enabled)("official HyperEVM RPC reports identity, head and separate gas fees", async () => {
  const client = hyperevm({
    chainId: 999,
    endpoints: [HYPEREVM_RPC_URL],
    race: false,
    retryCount: 0,
    timeout: 10_000,
    cache: false,
    headLag: { probeInterval: false },
  });
  try {
    await expect(client.request({ method: "eth_chainId" })).resolves.toBe("0x3e7");
    await expect(client.request({ method: "eth_blockNumber" })).resolves.toMatch(/^0x[0-9a-f]+$/);
    await expect(client.request({ method: "eth_gasPrice" })).resolves.toMatch(/^0x[0-9a-f]+$/);
    await expect(client.request({ method: "eth_bigBlockGasPrice" })).resolves.toMatch(/^0x[0-9a-f]+$/);
    await expect(client.request({ method: "eth_maxPriorityFeePerGas" })).resolves.toMatch(/^0x[0-9a-f]+$/);
    await expect(client.request({ method: "eth_getLogs", params: [{ fromBlock: "latest", toBlock: "latest" }] })).resolves.toBeInstanceOf(Array);
  } finally { client.close?.(); }
}, 40_000);
