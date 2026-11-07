import { expect, test } from "vitest";

import { arbitrum, ARBITRUM_PRECOMPILES } from "../src/index.js";

/** Opt in explicitly: free public RPC availability is not a CI requirement. */
test.skipIf(process.env.SMART_RPC_LIVE !== "1")("Arbitrum execution RPC identity, head and ArbSys code", async () => {
  const rpc = arbitrum({ race: false, retryCount: 0, headLag: { probeInterval: false }, timeout: 10_000 });
  try {
    await expect(rpc.request({ method: "eth_chainId" })).resolves.toBe("0xa4b1");
    expect(await rpc.request({ method: "eth_blockNumber" })).toMatch(/^0x[0-9a-f]+$/);
    expect(await rpc.request({ method: "eth_getCode", params: [ARBITRUM_PRECOMPILES.arbSys, "latest"] })).toMatch(/^0x[0-9a-f]*$/);
  } finally { rpc.close(); }
}, 35_000);
