import { expect, test } from "vitest";
import { OPBNB_MAINNET_REGISTRY } from "../src/index.js";

let id = 0;
async function request(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const requestId = ++id;
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }), signal: AbortSignal.timeout(10_000),
  });
  expect(response.ok).toBe(true);
  const body = await response.json() as { id: number; result?: unknown; error?: unknown };
  expect(body.id).toBe(requestId);
  expect(body.error).toBeUndefined();
  return body.result;
}

test.skipIf(process.env.OPBNB_LIVE !== "1").each(OPBNB_MAINNET_REGISTRY)(
  "public identity/head: $provider", async ({ url }) => {
    expect(await request(url, "eth_chainId")).toBe("0xcc");
    expect(await request(url, "eth_blockNumber")).toMatch(/^0x[\da-f]+$/i);
  }, 25_000,
);

const capabilityUrl = process.env.OPBNB_CAPABILITY_URL;
test.skipIf(!capabilityUrl).each(["safe", "finalized"])("explicit provider %s tag", async (tag) => {
  expect(await request(capabilityUrl!, "eth_chainId")).toBe("0xcc");
  expect(await request(capabilityUrl!, "eth_getBlockByNumber", [tag, false])).toMatchObject({ number: expect.any(String), hash: expect.any(String) });
}, 25_000);

test.skipIf(!capabilityUrl)("explicit provider historical state and batch partial errors", async () => {
  expect(await request(capabilityUrl!, "eth_chainId")).toBe("0xcc");
  expect(await request(capabilityUrl!, "eth_getBalance", ["0x1111111111111111111111111111111111111111", "0x1"]))
    .toMatch(/^0x[\da-f]+$/i);
  const response = await fetch(capabilityUrl!, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 101, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 102, method: "eth_getBalance", params: ["invalid-address", "latest"] },
    ]),
  });
  expect(response.ok).toBe(true);
  const results = await response.json() as { id: number; result?: unknown; error?: unknown }[];
  expect(results.find(({ id }) => id === 101)?.result).toBe("0xcc");
  expect(results.find(({ id }) => id === 102)?.error).toBeDefined();
}, 35_000);

test.skipIf(!process.env.OPBNB_WS_URL)("explicit provider socket identity", async () => {
  const socket = new WebSocket(process.env.OPBNB_WS_URL!);
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket identity timeout")), 10_000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })), { once: true });
      socket.addEventListener("message", (event) => {
        clearTimeout(timer);
        try { resolve(JSON.parse(String(event.data))); } catch (error) { reject(error); }
      }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); }, { once: true });
    });
    expect(result).toMatchObject({ id: 1, result: "0xcc" });
  } finally { socket.close(); }
}, 15_000);
