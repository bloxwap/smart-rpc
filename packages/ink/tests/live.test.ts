import { describe, expect, test } from "vitest";
import { connectViem } from "@smart-rpc/ethereum";
import { INK_CHAIN_ID, INK_MAINNET_REGISTRY, ink } from "../src/index.js";

/** Explicitly opt in; free public RPC uptime is never a normal CI dependency. */
describe.skipIf(process.env.SMART_RPC_LIVE !== "1")("Ink public RPC smoke", () => {
  test.each(INK_MAINNET_REGISTRY)("$provider reports Ink identity and a full-block head", async ({ url }) => {
    const client = ink({ endpoints: [url], headLag: false, retryCount: 0, race: false, timeout: 8_000, cache: false });
    try {
      expect(await client.request({ method: "eth_chainId" })).toBe(`0x${INK_CHAIN_ID.toString(16)}`);
      expect(await client.request({ method: "eth_blockNumber" })).toMatch(/^0x[0-9a-f]+$/i);
    } finally { client.close(); }
  });
});

/** More expensive capability checks are opt-in independently of the identity smoke. */
describe.skipIf(process.env.SMART_RPC_INK_CAPABILITIES !== "1")("Ink provider capabilities", () => {
  test.each(INK_MAINNET_REGISTRY)("$provider supports distinct safe/finalized tags when enabled", async ({ url }) => {
    const client = ink({
      endpoints: [{ url, capabilities: { blockTags: ["latest", "safe", "finalized"], pinning: false } }],
      headLag: false, race: false, retryCount: 0, timeout: 8_000, cache: false,
    });
    try {
      const blocks = await Promise.all(["latest", "safe", "finalized"].map((tag) => client.request({
        method: "eth_getBlockByNumber", params: [tag, false],
      })));
      for (const block of blocks) expect(block).toMatchObject({ number: expect.stringMatching(/^0x[0-9a-f]+$/i) });
    } finally { client.close(); }
  });

  test.each(INK_MAINNET_REGISTRY)("$provider accepts an explicitly enabled small JSON batch", async ({ url }) => {
    const client = ink({
      endpoints: [{ url, capabilities: { batch: true } }], batch: { wait: 10 },
      headLag: false, race: false, retryCount: 0, timeout: 8_000, cache: false,
    });
    try {
      const results = await client.requestBatch([{ method: "eth_chainId" }, { method: "eth_blockNumber" }]);
      expect(results.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    } finally { client.close(); }
  });

  test.each(INK_MAINNET_REGISTRY)("$provider subscribes on its documented WS URL", async ({ websocketUrls }) => {
    const session = connectViem(websocketUrls[0], { timeout: 8_000, expectedChainId: INK_CHAIN_ID, reconnect: true });
    try {
      const subscription = await session.subscribe({ params: ["newHeads"], onData: () => undefined });
      expect(subscription.subscriptionId).toBeTruthy();
      await subscription.unsubscribe();
    } finally { session.close(); }
  });
});

test.skipIf(!process.env.SMART_RPC_INK_ARCHIVE_URL || !process.env.SMART_RPC_INK_ARCHIVE_BLOCK)(
  "configured archive provider serves explicitly selected historical state", async () => {
    const client = ink({
      endpoints: [{ url: process.env.SMART_RPC_INK_ARCHIVE_URL!, capabilities: { archive: true } }],
      headLag: false, race: false, retryCount: 0, timeout: 8_000, cache: false,
    });
    try {
      const balance = await client.request({
        method: "eth_getBalance",
        params: ["0x0000000000000000000000000000000000000001", process.env.SMART_RPC_INK_ARCHIVE_BLOCK],
      });
      expect(balance).toMatch(/^0x[0-9a-f]+$/i);
    } finally { client.close(); }
  },
);
