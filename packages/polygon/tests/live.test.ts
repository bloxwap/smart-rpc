import { describe, expect, test } from "vitest";
import { POLYGON_MAINNET_REGISTRY, POLYGON_RPC_URL, POLYGON_WS_URL, polygon } from "../src/index.js";

const enabled = process.env.SMART_RPC_LIVE_POLYGON === "1";

describe.skipIf(!enabled)("Polygon opt-in public RPC smoke", () => {
  test.each(POLYGON_MAINNET_REGISTRY)("$provider reports Polygon identity and a full block head", async (endpoint) => {
    const pool = polygon({ endpoints: [endpoint], race: false, retryCount: 0, timeout: 8_000, headLag: { probeInterval: false } });
    try {
      await expect(pool.request({ method: "eth_chainId" })).resolves.toBe("0x89");
      const head = await pool.request({ method: "eth_blockNumber" });
      expect(head).toMatch(/^0x[0-9a-f]+$/i);
      expect(BigInt(head as string)).toBeGreaterThan(0n);
    } finally { pool.close(); }
  });

  test.skipIf(!process.env.POLYGON_FINALITY_RPC_URL)("explicit provider preserves finalized-tag support", async () => {
    const pool = polygon({
      endpoints: [{ url: process.env.POLYGON_FINALITY_RPC_URL!, capabilities: { blockTags: ["finalized"] } }],
      race: false, retryCount: 0, timeout: 8_000, headLag: { probeInterval: false },
    });
    try {
      const block = await pool.request({ method: "eth_getBlockByNumber", params: ["finalized", false] });
      expect(block).toEqual(expect.objectContaining({ number: expect.stringMatching(/^0x[0-9a-f]+$/i) }));
    } finally { pool.close(); }
  });

  test.skipIf(!process.env.POLYGON_ARCHIVE_RPC_URL)("explicit archive provider serves historical state", async () => {
    const pool = polygon({
      endpoints: [{ url: process.env.POLYGON_ARCHIVE_RPC_URL!, capabilities: { archive: true } }],
      race: false, retryCount: 0, timeout: 8_000, headLag: { probeInterval: false },
    });
    try {
      const balance = await pool.request({ method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000000", "0x1"] });
      expect(balance).toMatch(/^0x[0-9a-f]+$/i);
    } finally { pool.close(); }
  });

  test.skipIf(process.env.POLYGON_LIVE_BOR !== "1")("Bor provider exposes the opt-in author fixture", async () => {
    const pool = polygon({
      endpoints: [{ url: process.env.POLYGON_BOR_RPC_URL ?? POLYGON_RPC_URL, supportedMethods: ["eth_chainId", "eth_blockNumber", "bor_getAuthor"] }],
      race: false, retryCount: 0, timeout: 8_000, headLag: { probeInterval: false },
    });
    try {
      await expect(pool.request({ method: "bor_getAuthor", params: ["latest"] })).resolves.toMatch(/^0x[0-9a-f]{40}$/i);
    } finally { pool.close(); }
  });

  test.skipIf(process.env.POLYGON_LIVE_WS !== "1")("documented WSS address answers JSON-RPC identity", async () => {
    const socket = new WebSocket(process.env.POLYGON_WS_RPC_URL ?? POLYGON_WS_URL);
    try {
      const response = await new Promise<{ result?: string; error?: unknown }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Polygon WSS identity timed out")), 8_000);
        socket.addEventListener("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })), { once: true });
        socket.addEventListener("message", (event) => {
          clearTimeout(timer);
          try { resolve(JSON.parse(String(event.data)) as { result?: string; error?: unknown }); }
          catch (error) { reject(error); }
        }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Polygon WSS connection failed")); }, { once: true });
      });
      expect(response.error).toBeUndefined();
      expect(response.result).toBe("0x89");
    } finally { socket.close(); }
  });
});
