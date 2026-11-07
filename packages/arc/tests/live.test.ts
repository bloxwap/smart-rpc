import { expect, test } from "vitest";

import { ARC_MAINNET_REGISTRY, ARC_CHAIN_ID, ARC_USDC_ERC20_ADDRESS } from "../src/index.js";

const live = process.env.SMART_RPC_LIVE_ARC === "1";
const capabilities = process.env.SMART_RPC_ARC_CAPABILITIES === "1" && Boolean(process.env.ARC_RPC_URL);

async function rpc(url: string, method: string, params: unknown[] = []) {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000),
  });
  expect(response.ok).toBe(true);
  const body = await response.json() as { result?: unknown; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result;
}

test.skipIf(!live).each(ARC_MAINNET_REGISTRY)("public Arc identity/head: $provider", async ({ url }) => {
  expect(await rpc(url, "eth_chainId")).toBe(`0x${ARC_CHAIN_ID.toString(16)}`);
  expect(await rpc(url, "eth_blockNumber")).toMatch(/^0x[\da-f]+$/i);
}, 25_000);

test.skipIf(!capabilities)("configured provider supports safe/finalized and historical state", async () => {
  const url = process.env.ARC_RPC_URL!;
  for (const tag of ["safe", "finalized"]) {
    const block = await rpc(url, "eth_getBlockByNumber", [tag, false]) as { number: string };
    expect(block.number).toMatch(/^0x[\da-f]+$/i);
  }
  expect(await rpc(url, "eth_getBalance", [ARC_USDC_ERC20_ADDRESS, "0x1"])).toMatch(/^0x[\da-f]+$/i);
}, 35_000);

test.skipIf(!capabilities)("configured provider keeps partial HTTP batch errors", async () => {
  const response = await fetch(process.env.ARC_RPC_URL!, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: ["invalid-address", "latest"] },
    ]),
  });
  expect(response.ok).toBe(true);
  const values = await response.json() as { id: number; result?: unknown; error?: { code: number } }[];
  expect(Array.isArray(values)).toBe(true);
  expect(values.find(({ id }) => id === 1)?.result).toBe("0x13b2");
  expect(values.find(({ id }) => id === 2)?.error?.code).toBeTypeOf("number");
}, 15_000);

test.skipIf(!live || !process.env.ARC_WS_URL)("configured exact WebSocket URL reports Arc identity", async () => {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(process.env.ARC_WS_URL!);
    const timer = setTimeout(() => { socket.close(); reject(new Error("WebSocket identity timed out")); }, 10_000);
    const finish = (error?: unknown) => { clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(); };
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
    socket.onerror = () => finish(new Error("WebSocket connection failed"));
    socket.onmessage = (event) => {
      try {
        const body = JSON.parse(String(event.data)) as { result?: string; id: number };
        if (body.id !== 1) return;
        expect(body.result).toBe("0x13b2"); finish();
      } catch (error) { finish(error); }
    };
  });
}, 15_000);
