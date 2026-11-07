import { describe, expect, test } from "vitest";
import { MONAD_MAINNET_REGISTRY } from "../src/index.js";

let requestId = 0;
async function call(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const body = await response.json() as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`${url}: ${JSON.stringify(body.error)}`);
  return body.result;
}

describe.skipIf(process.env.MONAD_RPC_INTEGRATION !== "1")("Monad public HTTP capabilities (opt-in)", () => {
  for (const endpoint of MONAD_MAINNET_REGISTRY) {
    test(endpoint.id, async () => {
      expect(await call(endpoint.url, "eth_chainId")).toBe("0x8f");
      const head = await call(endpoint.url, "eth_blockNumber");
      expect(head).toMatch(/^0x[0-9a-f]+$/i);
      for (const tag of ["safe", "finalized"]) {
        const block = await call(endpoint.url, "eth_getBlockByNumber", [tag, false]);
        expect(block).toHaveProperty("number");
      }
      if (endpoint.capabilities?.archive) {
        const old = `0x${(BigInt(head as string) > 100_000n ? BigInt(head as string) - 100_000n : 1n).toString(16)}`;
        expect(await call(endpoint.url, "eth_getBalance", ["0x0000000000000000000000000000000000000000", old])).toMatch(/^0x[0-9a-f]+$/i);
      }
      // Small capability check, not a rate-limit stress test.
      const response = await fetch(endpoint.url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 101, method: "eth_chainId", params: [] },
          { jsonrpc: "2.0", id: 102, method: "eth_getBalance", params: ["invalid"] },
        ]), signal: AbortSignal.timeout(15_000),
      });
      expect(response.ok).toBe(true);
      const items = await response.json() as { id: number; result?: unknown; error?: unknown }[];
      expect(items.find(({ id }) => id === 101)?.result).toBe("0x8f");
      expect(items.find(({ id }) => id === 102)?.error).toBeDefined();
    }, 90_000);
  }
});

describe.skipIf(process.env.MONAD_WS_INTEGRATION !== "1")("Monad documented WebSocket endpoints (opt-in)", () => {
  for (const endpoint of MONAD_MAINNET_REGISTRY.filter(({ websocketUrl }) => websocketUrl)) {
    test(endpoint.id, async () => {
      const socket = new WebSocket(endpoint.websocketUrl!);
      try {
        const identity = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("WebSocket identity timeout")), 15_000);
          socket.addEventListener("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })), { once: true });
          socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); }, { once: true });
          socket.addEventListener("message", (event) => {
            clearTimeout(timer);
            const body = JSON.parse(String(event.data)) as { result?: unknown; error?: unknown };
            if (body.error) reject(new Error(JSON.stringify(body.error))); else resolve(body.result);
          }, { once: true });
        });
        expect(identity).toBe("0x8f");
      } finally { socket.close(); }
    }, 20_000);
  }
});
