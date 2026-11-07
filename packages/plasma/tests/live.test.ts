import { describe, expect, test } from "vitest";

import { plasma, PLASMA_CHAIN_ID, PLASMA_RPC_URL } from "../src/index.js";

const enabled = process.env.PLASMA_RPC_SMOKE === "1";
const url = process.env.PLASMA_RPC_URL ?? PLASMA_RPC_URL;

describe.skipIf(!enabled)("Plasma public/provider smoke (opt in)", () => {
  test("verifies identity and an execution block without assuming an SLA", async () => {
    const client = plasma({ endpoints: [url], race: false, cache: false, retryCount: 0, headLag: false });
    try {
      expect(await client.request({ method: "eth_chainId" })).toBe(`0x${PLASMA_CHAIN_ID.toString(16)}`);
      expect(await client.request({ method: "eth_blockNumber" })).toMatch(/^0x[0-9a-f]+$/i);
    } finally { client.close(); }
  });

  test.skipIf(!process.env.PLASMA_FINALITY_TAG)("checks a provider's explicitly selected finality tag", async () => {
    const tag = process.env.PLASMA_FINALITY_TAG;
    expect(["safe", "finalized"]).toContain(tag);
    const client = plasma({ endpoints: [url], race: false, cache: false, retryCount: 0, headLag: false });
    try {
      expect(await client.request({ method: "eth_getBlockByNumber", params: [tag, false] })).toMatchObject({ number: expect.stringMatching(/^0x[0-9a-f]+$/i) });
    } finally { client.close(); }
  });

  test.skipIf(!process.env.PLASMA_ARCHIVE_BLOCK)("checks an explicitly selected historical state block", async () => {
    const client = plasma({ endpoints: [{ url, capabilities: { archive: true } }], race: false, cache: false, retryCount: 0, headLag: false });
    try {
      expect(await client.request({ method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000000", process.env.PLASMA_ARCHIVE_BLOCK] })).toMatch(/^0x[0-9a-f]+$/i);
    } finally { client.close(); }
  });

  test.skipIf(!process.env.PLASMA_WS_URL)("checks a provider's exact documented WS URL", async () => {
    const client = plasma({ endpoints: [process.env.PLASMA_WS_URL!], race: false, cache: false, retryCount: 0, headLag: false });
    try {
      expect(await client.request({ method: "eth_blockNumber" })).toMatch(/^0x[0-9a-f]+$/i);
    } finally { client.close(); }
  });

  test.skipIf(process.env.PLASMA_RPC_BATCH !== "1")("checks a provider's explicit two-item HTTP batch", async () => {
    const client = plasma({
      endpoints: [{ url, capabilities: { batch: true, maxBatchSize: 2 } }],
      batch: { batchSize: 2 },
      race: false,
      cache: false,
      retryCount: 0,
      headLag: false,
    });
    try {
      const results = await client.requestBatch([{ method: "eth_chainId" }, { method: "eth_blockNumber" }]);
      expect(results[0]).toEqual({ status: "fulfilled", value: `0x${PLASMA_CHAIN_ID.toString(16)}` });
      expect(results[1]).toMatchObject({ status: "fulfilled", value: expect.stringMatching(/^0x[0-9a-f]+$/i) });
    } finally { client.close(); }
  });
});
