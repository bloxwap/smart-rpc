import { describe, expect, test } from "vitest";

import { xlayer, XLAYER_MAINNET_ENDPOINTS, XLAYER_MAINNET_WEBSOCKET_ENDPOINTS } from "../src/index.js";

const live = process.env.SMART_RPC_LIVE_XLAYER === "1";
const url = process.env.XLAYER_RPC_URL ?? XLAYER_MAINNET_ENDPOINTS[0]!;
const capabilities = new Set((process.env.XLAYER_LIVE_CAPABILITIES ?? "").split(","));

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.ok).toBe(true);
  const body = await response.json() as { error?: unknown; result?: unknown };
  expect(body.error).toBeUndefined();
  return body.result;
}

describe.skipIf(!live)("X Layer opt-in public RPC smoke checks", () => {
  test.each(process.env.XLAYER_RPC_URL ? [url] : XLAYER_MAINNET_ENDPOINTS)("checks identity and a block height at %s", async (endpoint) => {
    const client = xlayer({ endpoints: [endpoint], headLag: { probeInterval: false }, race: false });
    try {
      await expect(client.request({ method: "eth_chainId" })).resolves.toBe("0xc4");
      expect(await client.request({ method: "eth_blockNumber" })).toMatch(/^0x[0-9a-f]+$/i);
    } finally { client.close(); }
  }, 30_000);

  test.runIf(capabilities.has("batch"))("checks an explicitly requested small wire batch", async () => {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
        { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
      ]),
      signal: AbortSignal.timeout(10_000),
    });
    const results = await response.json() as { id: number; result?: unknown; error?: unknown }[];
    expect(response.ok).toBe(true);
    expect(results).toHaveLength(2);
    expect(results.find(({ id }) => id === 1)?.result).toBe("0xc4");
    expect(results.find(({ id }) => id === 2)?.result).toMatch(/^0x[0-9a-f]+$/i);
    expect(results.every(({ error }) => error === undefined)).toBe(true);
  }, 15_000);

  for (const tag of ["safe", "finalized"]) {
    test.runIf(capabilities.has(tag))(`checks explicitly opted-in ${tag} tag`, async () => {
      expect(await rpc("eth_getBlockByNumber", [tag, false])).toMatchObject({ number: expect.stringMatching(/^0x[0-9a-f]+$/i) });
    }, 15_000);
  }

  test.runIf(capabilities.has("archive"))("checks explicitly opted-in historical state", async () => {
    expect(await rpc("eth_getBalance", ["0x0000000000000000000000000000000000000001", process.env.XLAYER_ARCHIVE_BLOCK ?? "0x1"]))
      .toMatch(/^0x[0-9a-f]+$/i);
  }, 15_000);

  test.runIf(capabilities.has("debug"))("checks trace mode on an explicitly configured provider", async () => {
    const hash = process.env.XLAYER_TRACE_TRANSACTION;
    expect(hash, "Set XLAYER_TRACE_TRANSACTION to a known mined transaction hash").toMatch(/^0x[0-9a-f]{64}$/i);
    expect(await rpc("debug_traceTransaction", [hash, { tracer: "callTracer" }])).toBeDefined();
  }, 15_000);

  test.runIf(capabilities.has("ws"))("checks the documented WS address without rewriting an HTTP URL", async () => {
    const socket = new WebSocket(process.env.XLAYER_WS_URL ?? XLAYER_MAINNET_WEBSOCKET_ENDPOINTS[0]);
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("X Layer WebSocket identity check timed out")), 10_000);
        socket.addEventListener("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })), { once: true });
        socket.addEventListener("message", (event) => {
          clearTimeout(timer);
          const body = JSON.parse(String(event.data)) as { error?: unknown; result?: unknown };
          if (body.error) reject(new Error(JSON.stringify(body.error))); else resolve(body.result);
        }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("X Layer WebSocket connection failed")); }, { once: true });
      });
      expect(result).toBe("0xc4");
    } finally { socket.close(); }
  }, 15_000);
});
