import { expect, test } from "vitest";
import { connectViem, ethereum, ETHEREUM_MAINNET_REGISTRY } from "../src/index.js";

// Optional checks exercise provider behavior without making free services a CI dependency.
test.skipIf(process.env.SMART_RPC_ETHEREUM_LIVE !== "1")("public Ethereum HTTP identity, head and tag smoke", async () => {
  const endpoint = process.env.ETHEREUM_RPC_URL ?? ETHEREUM_MAINNET_REGISTRY[0]!.url;
  const pool = ethereum({ endpoints: [endpoint], headLag: false, race: false, retryCount: 0, timeout: 10_000, cache: false });
  try {
    await expect(pool.request({ method: "eth_chainId" })).resolves.toBe("0x1");
    await expect(pool.request({ method: "eth_blockNumber" })).resolves.toMatch(/^0x[\da-f]+$/i);
    for (const tag of ["latest", "safe", "finalized"]) {
      const block = await pool.request({ method: "eth_getBlockByNumber", params: [tag, false] });
      expect(block).toMatchObject({ number: expect.stringMatching(/^0x[\da-f]+$/i) });
    }
  } finally { pool.close(); }
}, 60_000);

test.skipIf(process.env.SMART_RPC_ETHEREUM_LIVE !== "1" || !process.env.ETHEREUM_ARCHIVE_RPC_URL)("dedicated archive provider serves historical state", async () => {
  const pool = ethereum({ endpoints: [{ url: process.env.ETHEREUM_ARCHIVE_RPC_URL!, capabilities: { archive: true } }], headLag: false, race: false, retryCount: 0, cache: false });
  try {
    await expect(pool.request({ method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000000", "0x1"] })).resolves.toMatch(/^0x[\da-f]+$/i);
  } finally { pool.close(); }
}, 30_000);

test.skipIf(process.env.SMART_RPC_ETHEREUM_LIVE !== "1" || !process.env.ETHEREUM_WS_URL)("dedicated WS provider supports verified subscription lifecycle", async () => {
  const session = connectViem(process.env.ETHEREUM_WS_URL!, { timeout: 10_000, expectedChainId: 1 });
  try {
    const subscription = await session.subscribe({ params: ["newHeads"], onData: () => undefined });
    expect(subscription.subscriptionId).toMatch(/^0x[\da-f]+$/i);
    await subscription.unsubscribe();
  } finally { session.close(); }
}, 30_000);
