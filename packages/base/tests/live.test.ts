import { describe, expect, test } from "vitest";

import { base, BASE_RPC_URL } from "../src/index.js";

/** Opt-in only: public availability is not a deterministic CI dependency. */
describe.runIf(process.env.SMART_RPC_LIVE_BASE === "1")("Base public RPC smoke", () => {
  test("reports Base identity, a full block head and independent settlement tags", async () => {
    const client = base({
      endpoints: [process.env.BASE_RPC_URL ?? BASE_RPC_URL],
      headLag: { probeInterval: false }, retryCount: 0, race: false, cache: false, timeout: 5_000,
    });
    try {
      expect(await client.request({ method: "eth_chainId" })).toBe("0x2105");
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
