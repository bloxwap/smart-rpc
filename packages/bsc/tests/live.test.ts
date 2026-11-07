import { expect, test } from "vitest";
import { bsc, BSC_RPC_URL } from "../src/index.js";

/** Opt in explicitly; public availability is not a deterministic CI requirement. */
test.skipIf(process.env.SMART_RPC_BSC_LIVE !== "1")("public BSC identity and head", async () => {
  const pool = bsc({
    endpoints: [{ url: process.env.BSC_RPC_URL ?? BSC_RPC_URL, label: "bsc-live" }],
    headLag: { probeInterval: false }, race: false, retryCount: 0, cache: false,
  });
  try {
    await expect(pool.request({ method: "eth_chainId" })).resolves.toBe("0x38");
    const head = await pool.request({ method: "eth_blockNumber" });
    expect(typeof head === "string" && /^0x[0-9a-f]+$/i.test(head)).toBe(true);
  } finally { pool.close(); }
});

test.skipIf(process.env.SMART_RPC_BSC_LIVE !== "1" || !process.env.BSC_ARCHIVE_BLOCK)("configured provider's archive and finalized state", async () => {
  if (!process.env.BSC_RPC_URL) throw new Error("BSC_RPC_URL is required for archive capability testing.");
  const pool = bsc({
    endpoints: [{
      url: process.env.BSC_RPC_URL,
      label: "bsc-archive-live",
      capabilities: { archive: true, blockTags: ["latest", "safe", "finalized"] },
    }],
    headLag: { probeInterval: false }, race: false, retryCount: 0, cache: false,
  });
  try {
    const balance = await pool.request({ method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", process.env.BSC_ARCHIVE_BLOCK] });
    expect(balance).toMatch(/^0x[0-9a-f]+$/i);
    const finalized = await pool.request({ method: "eth_getBlockByNumber", params: ["finalized", false] });
    expect(finalized).toMatchObject({ number: expect.stringMatching(/^0x[0-9a-f]+$/i) });
  } finally { pool.close(); }
});
