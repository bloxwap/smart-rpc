import { expect, test } from "vitest";

import { FLARE_MAINNET_REGISTRY } from "../src/index.js";

const httpEnabled = process.env.FLARE_RPC_INTEGRATION === "1";
const capabilityEnabled = process.env.FLARE_CAPABILITY_INTEGRATION === "1";
let sequence = 0;

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const id = ++sequence;
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(10_000),
  });
  expect(response.ok).toBe(true);
  const body = await response.json() as { id: number; error?: unknown; result?: unknown };
  expect(body.id).toBe(id);
  expect(body.error).toBeUndefined();
  return body.result;
}

for (const endpoint of FLARE_MAINNET_REGISTRY) {
  test.skipIf(!httpEnabled)(`public identity/head: ${endpoint.provider}`, async () => {
    expect(await rpc(endpoint.url, "eth_chainId")).toBe("0xe");
    expect(await rpc(endpoint.url, "eth_blockNumber")).toMatch(/^0x[\da-f]+$/i);
  }, 25_000);

  test.skipIf(!capabilityEnabled)(`safe/finalized selectors: ${endpoint.provider}`, async () => {
    for (const tag of ["safe", "finalized"]) {
      const block = await rpc(endpoint.url, "eth_getBlockByNumber", [tag, false]);
      expect(block).toMatchObject({ number: expect.stringMatching(/^0x[\da-f]+$/i), hash: expect.stringMatching(/^0x[\da-f]{64}$/i) });
    }
  }, 25_000);

  test.skipIf(!capabilityEnabled)(`small batch with partial error: ${endpoint.provider}`, async () => {
    const response = await fetch(endpoint.url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
        { jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: ["invalid-address", "latest"] },
      ]), signal: AbortSignal.timeout(10_000),
    });
    expect(response.ok).toBe(true);
    const body = await response.json() as { id: number; result?: unknown; error?: { code: number } }[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.find(({ id }) => id === 1)?.result).toBe("0xe");
    expect(body.find(({ id }) => id === 2)?.error?.code).toBeTypeOf("number");
  }, 15_000);

  test.skipIf(process.env.FLARE_WS_INTEGRATION !== "1")(`documented WS identity and newHeads subscription: ${endpoint.provider}`, async () => {
    const socket = new WebSocket(endpoint.websocketUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WebSocket test timeout")), 20_000);
        const finish = (error?: Error): void => { clearTimeout(timer); error ? reject(error) : resolve(); };
        socket.addEventListener("error", () => finish(new Error("WebSocket connection failed")), { once: true });
        socket.addEventListener("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })));
        socket.addEventListener("message", (event) => {
          try {
            const body = JSON.parse(String(event.data));
            if (body.error) throw new Error(JSON.stringify(body.error));
            if (body.id === 1) {
              expect(body.result).toBe("0xe");
              socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["newHeads"] }));
            } else if (body.id === 2) {
              expect(body.result).toBeTypeOf("string");
            } else if (body.method === "eth_subscription") {
              expect(body.params.result.number).toMatch(/^0x[\da-f]+$/i);
              socket.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_unsubscribe", params: [body.params.subscription] }));
            } else if (body.id === 3) {
              expect(body.result).toBe(true); finish();
            }
          } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        });
      });
    } finally { socket.close(); }
  }, 25_000);
}

test.skipIf(!process.env.FLARE_ARCHIVE_RPC_URL)("explicit archive provider historical state", async () => {
  const url = process.env.FLARE_ARCHIVE_RPC_URL!;
  expect(await rpc(url, "eth_chainId")).toBe("0xe");
  expect(await rpc(url, "eth_getBalance", ["0x0000000000000000000000000000000000000000", "0x1"]))
    .toMatch(/^0x[\da-f]+$/i);
}, 25_000);
