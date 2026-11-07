import { describe, expect, test } from "vitest";
import { GNOSIS_MAINNET_REGISTRY, GNOSIS_RPC_URL, GNOSIS_WEBSOCKET_URL } from "../src/index.js";

let sequence = 0;
async function rpc(url: string, method: string, params: unknown[] = []) {
  const id = ++sequence;
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(10_000) });
  expect(response.ok).toBe(true);
  const body = await response.json() as { id: number; result?: unknown; error?: unknown };
  expect(body.id).toBe(id);
  expect(body.error).toBeUndefined();
  return body.result;
}

describe.skipIf(process.env.GNOSIS_RPC_INTEGRATION !== "1")("public Gnosis execution RPC smoke", () => {
  test.each(GNOSIS_MAINNET_REGISTRY)("$provider identity and head", async ({ url }) => {
    expect(await rpc(url, "eth_chainId")).toBe("0x64");
    expect(await rpc(url, "eth_blockNumber")).toMatch(/^0x[\da-f]+$/i);
  }, 25_000);
});

describe.skipIf(process.env.GNOSIS_CAPABILITY_INTEGRATION !== "1")("explicit Gnosis capability verification", () => {
  const url = process.env.GNOSIS_RPC_URL ?? GNOSIS_RPC_URL;
  test.each(["safe", "finalized"])("preserves %s block tag", async (tag) => {
    const block = await rpc(url, "eth_getBlockByNumber", [tag, false]) as { number: string; hash: string };
    expect(block.number).toMatch(/^0x[\da-f]+$/i);
    expect(block.hash).toMatch(/^0x[\da-f]{64}$/i);
  });
  test("HTTP batch retains one method error and one successful result", async () => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000), body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 2, method: "smartRpc_capabilityCheckUnknown", params: [] },
    ]) });
    const body = await response.json() as { id: number; result?: unknown; error?: unknown }[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.find(({ id }) => id === 1)?.result).toBe("0x64");
    expect(body.find(({ id }) => id === 2)?.error).toBeDefined();
  });
  test.skipIf(!process.env.GNOSIS_ARCHIVE_BLOCK)("explicit historical state", async () => {
    expect(await rpc(url, "eth_getBalance", ["0x0000000000000000000000000000000000000000", process.env.GNOSIS_ARCHIVE_BLOCK])).toMatch(/^0x[\da-f]+$/i);
  });
  test.skipIf(!process.env.GNOSIS_TRACE_TX_HASH)("explicit provider debug capability", async () => {
    expect(await rpc(url, "debug_traceTransaction", [process.env.GNOSIS_TRACE_TX_HASH, { tracer: "callTracer" }])).toBeTruthy();
  });
});

test.skipIf(process.env.GNOSIS_WS_INTEGRATION !== "1")("documented WebSocket verifies identity and opens/closes a newHeads subscription", async () => {
  const socket = new WebSocket(process.env.GNOSIS_WS_URL ?? GNOSIS_WEBSOCKET_URL);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket identity check timed out")), 10_000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })));
      socket.addEventListener("message", (event) => {
        try {
          const body = JSON.parse(String(event.data));
          if (body.id === 1) {
            expect(body.result).toBe("0x64");
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["newHeads"] }));
          } else if (body.id === 2) {
            expect(body.result).toMatch(/^0x[\da-f]+$/i);
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_unsubscribe", params: [body.result] }));
          } else if (body.id === 3) {
            expect(body.result).toBe(true);
            clearTimeout(timer); resolve();
          }
        } catch (error) { clearTimeout(timer); reject(error); }
      });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); });
    });
  } finally { socket.close(); }
}, 15_000);
