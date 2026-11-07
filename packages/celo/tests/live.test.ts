import { expect, test } from "vitest";
import {
  celo, CELO_RPC_URL, CELO_CHAIN_ID, CELO_SEPOLIA_CHAIN_ID, CELO_WEBSOCKET_URL,
} from "../src/index.js";

const smoke = process.env.CELO_LIVE === "1";
const capabilities = process.env.CELO_CAPABILITIES === "1";

test.skipIf(!smoke).each([CELO_CHAIN_ID, CELO_SEPOLIA_CHAIN_ID] as const)("public Celo identity and head on %i", async (chainId) => {
  const client = celo({ chainId, headLag: false, race: false, cache: false, retryCount: 0, timeout: 10_000 });
  try {
    expect(await client.request({ method: "eth_chainId" })).toBe(`0x${chainId.toString(16)}`);
    expect(await client.request({ method: "eth_blockNumber" })).toMatch(/^0x[0-9a-f]+$/i);
  } finally { client.close(); }
});

test.skipIf(!capabilities)("Forno safe/finalized block capability, explicitly requested", async () => {
  const client = celo({ endpoints: [{ url: CELO_RPC_URL, capabilities: { blockTags: ["safe", "finalized"] } }],
    headLag: false, race: false, cache: false, retryCount: 0 });
  try {
    for (const tag of ["safe", "finalized"]) {
      const block = await client.request({ method: "eth_getBlockByNumber", params: [tag, false] }) as { hash?: unknown };
      expect(block?.hash).toMatch(/^0x[0-9a-f]{64}$/i);
    }
  } finally { client.close(); }
});

test.skipIf(!capabilities)("Forno JSON batch capability preserves an individual RPC error", async () => {
  const response = await fetch(CELO_RPC_URL, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 2, method: "smart_rpc_unsupported_fixture", params: [] },
    ]),
  });
  expect(response.ok).toBe(true);
  const body = await response.json() as { id: number; result?: unknown; error?: { code: unknown } }[];
  expect(Array.isArray(body)).toBe(true);
  expect(body.find(({ id }) => id === 1)?.result).toBe("0xa4ec");
  expect(body.find(({ id }) => id === 2)?.error?.code).toBe(-32601);
});

test.skipIf(!capabilities)("documented Forno WebSocket verifies Celo identity", async () => {
  const result = await new Promise<unknown>((resolve, reject) => {
    const socket = new WebSocket(CELO_WEBSOCKET_URL);
    const timer = setTimeout(() => { socket.close(); reject(new Error("WebSocket identity timeout")); }, 8_000);
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
    socket.onerror = () => { clearTimeout(timer); socket.close(); reject(new Error("WebSocket connection failed")); };
    socket.onmessage = (event) => {
      try {
        const body = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
        if (body.id !== 1) return;
        clearTimeout(timer); socket.close();
        if (body.error) reject(new Error(JSON.stringify(body.error))); else resolve(body.result);
      } catch (error) { clearTimeout(timer); socket.close(); reject(error); }
    };
  });
  expect(result).toBe("0xa4ec");
});

test.skipIf(!process.env.CELO_ARCHIVE_URL || !process.env.CELO_ARCHIVE_BLOCK)("explicit archive provider preserves a historical state request", async () => {
  const client = celo({ endpoints: [{ url: process.env.CELO_ARCHIVE_URL!, capabilities: { archive: true } }],
    headLag: false, race: false, cache: false, retryCount: 0 });
  try {
    expect(await client.request({ method: "eth_getBalance", params: [
      "0x0000000000000000000000000000000000000000", process.env.CELO_ARCHIVE_BLOCK,
    ] })).toMatch(/^0x[0-9a-f]+$/i);
  } finally { client.close(); }
});
