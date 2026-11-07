import { expect, test } from "vitest";
import { robinhood, ROBINHOOD_RPC_URL } from "../src/index.js";

/** Explicit opt-in; free public endpoints are never a normal CI dependency. */
test.skipIf(process.env.SMART_RPC_LIVE_ROBINHOOD !== "1")("public Robinhood identity and head smoke test", async () => {
  const pool = robinhood({ endpoints: [process.env.ROBINHOOD_RPC_URL ?? ROBINHOOD_RPC_URL], headLag: { probeInterval: false }, retryCount: 0, race: false });
  try {
    await expect(pool.request({ method: "eth_chainId" })).resolves.toBe("0x1237");
    await expect(pool.request({ method: "eth_blockNumber" })).resolves.toMatch(/^0x[0-9a-f]+$/i);
    expect(pool.snapshot()[0]?.quarantined).toBe(false);
  } finally { pool.close(); }
}, 30_000);
