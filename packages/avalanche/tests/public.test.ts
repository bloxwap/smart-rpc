import { connectViem } from "@smart-rpc/ethereum";
import { describe, expect, test } from "vitest";
import { avalanche, AVALANCHE_CHAIN_ID, AVALANCHE_RPC_URL, AVALANCHE_WS_URL } from "../src/index.js";

const live = process.env.SMART_RPC_LIVE === "1";
const optional = process.env.SMART_RPC_AVALANCHE_CAPABILITIES === "1";
const idle = { probeInterval: false } as const;

describe("optional public Avalanche checks", () => {
  test.skipIf(!live)("checks public chain identity and executed head", async () => {
    const pool = avalanche({ headLag: idle, race: false, retryCount: 0, timeout: 10_000 });
    try {
      expect(await pool.request({ method: "eth_chainId" })).toBe("0xa86a");
      expect(await pool.request({ method: "eth_blockNumber" })).toMatch(/^0x[0-9a-f]+$/i);
    } finally { pool.close(); }
  });

  test.skipIf(!live || !optional)("checks settled safe/finalized tags without equating them to latest", async () => {
    const pool = avalanche({ endpoints: [{ url: AVALANCHE_RPC_URL, capabilities: { blockTags: ["latest", "pending", "safe", "finalized"] } }], headLag: idle, pinLatest: false, race: false, retryCount: 0 });
    try {
      for (const tag of ["latest", "pending", "safe", "finalized"]) {
        const block = await pool.request({ method: "eth_getBlockByNumber", params: [tag, false] }) as { number?: unknown };
        expect(block.number).toMatch(/^0x[0-9a-f]+$/i);
      }
    } finally { pool.close(); }
  });

  test.skipIf(!live || !optional)("checks a small HTTP batch with independent error outcomes", async () => {
    const pool = avalanche({ endpoints: [{ url: AVALANCHE_RPC_URL, capabilities: { batch: true } }], batch: { batchSize: 2 }, headLag: idle, race: false, retryCount: 0 });
    try {
      const results = await pool.requestBatch([
        { method: "eth_blockNumber" },
        { method: "eth_getBalance", params: ["invalid", "latest"] },
      ]);
      expect(results[0]?.status).toBe("fulfilled");
      expect(results[1]?.status).toBe("rejected");
    } finally { pool.close(); }
  });

  test.skipIf(!live || !optional)("checks documented WS identity and newHeads subscription lifecycle", async () => {
    const connection = connectViem(AVALANCHE_WS_URL, { timeout: 10_000, expectedChainId: AVALANCHE_CHAIN_ID, reconnect: false });
    try {
      const subscription = await connection.subscribe({ params: ["newHeads"], onData() {}, onError() {} });
      expect(subscription.subscriptionId).toMatch(/^0x/);
      await subscription.unsubscribe();
    } finally { connection.close(); }
  });

  test.skipIf(!live || !process.env.SMART_RPC_AVALANCHE_ARCHIVE_URL || !process.env.SMART_RPC_AVALANCHE_ARCHIVE_BLOCK)("checks an explicitly supplied historical-state provider", async () => {
    const pool = avalanche({ endpoints: [{ url: process.env.SMART_RPC_AVALANCHE_ARCHIVE_URL!, capabilities: { archive: true } }], headLag: idle, race: false, retryCount: 0 });
    try {
      expect(await pool.request({ method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000000", process.env.SMART_RPC_AVALANCHE_ARCHIVE_BLOCK!] }))
        .toMatch(/^0x[0-9a-f]+$/i);
    } finally { pool.close(); }
  });
});
