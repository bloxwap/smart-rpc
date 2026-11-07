import { describe, expect, test } from "vitest";

import { optimism, OPTIMISM_RPC_URL } from "../src/index.js";

/** Opt-in only: public availability is not a deterministic CI dependency. */
describe.runIf(process.env.SMART_RPC_LIVE_OPTIMISM === "1")("OP Mainnet public RPC smoke", () => {
  test("reports OP Mainnet identity, a full block head and independent settlement tags", async () => {
    const client = optimism({
      endpoints: [process.env.OPTIMISM_RPC_URL ?? OPTIMISM_RPC_URL],
      headLag: { probeInterval: false }, retryCount: 0, race: false, cache: false, timeout: 5_000,
    });
    try {
      expect(await client.request({ method: "eth_chainId" })).toBe("0xa");
      expect(await client.request({ method: "eth_blockNumber" })).toMatch(/^0x[0-9a-f]+$/i);
      for (const tag of ["safe", "finalized"] as const) {
        const block = await client.request({ method: "eth_getBlockByNumber", params: [tag, false] }) as { number?: string } | null;
        expect(block?.number).toMatch(/^0x[0-9a-f]+$/i);
      }
    } finally {
      client.close();
    }
  }, 30_000);
});
