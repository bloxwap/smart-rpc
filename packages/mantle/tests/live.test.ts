import { describe, expect, test } from "vitest";
import { mantle, MANTLE_MAINNET_WS_URL, MANTLE_RPC_URL } from "../src/index.js";

let nextId = 1;
async function rpc(url: string, method: string, params: unknown[] = [], allowForbidden = false) {
  const id = nextId++;
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(10_000),
  });
  expect(response.ok || (allowForbidden && response.status === 403)).toBe(true);
  const body = await response.json() as { id: number; result?: unknown; error?: { code: number; message: string } };
  expect(body.id).toBe(id);
  return body;
}

describe.skipIf(process.env.MANTLE_RPC_INTEGRATION !== "1")("public Mantle RPC", () => {
  test("checks identity and a current head", async () => {
    const pool = mantle({ race: false, retryCount: 0, headLag: { probeInterval: false } });
    try {
      expect(await pool.request({ method: "eth_chainId" })).toBe("0x1388");
      expect(await pool.request({ method: "eth_blockNumber" })).toMatch(/^0x[0-9a-f]+$/i);
    } finally { pool.close(); }
  }, 25_000);

  test("confirms the documented deprecated block-range rejection", async () => {
    const body = await rpc(MANTLE_RPC_URL, "eth_getBlockRange", ["0x1", "0x1", false], true);
    expect(body.error).toBeDefined();
    expect(body.error?.message).toMatch(/whitelist|not found|not supported|unsupported/i);
  }, 15_000);
});

test.skipIf(process.env.MANTLE_WS_INTEGRATION !== "1")("documented WebSocket endpoint reports Mantle identity", async () => {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(MANTLE_MAINNET_WS_URL);
    const timer = setTimeout(() => { socket.close(); reject(new Error("WS identity timeout")); }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
    socket.onerror = () => { clearTimeout(timer); socket.close(); reject(new Error("WS connection failed")); };
    socket.onmessage = ({ data }) => {
      clearTimeout(timer);
      socket.close();
      try { expect(JSON.parse(String(data)).result).toBe("0x1388"); resolve(); }
      catch (error) { reject(error); }
    };
  });
}, 15_000);

const capabilityUrl = process.env.MANTLE_CAPABILITY_RPC_URL;
describe.skipIf(!capabilityUrl)("explicit Mantle provider capabilities", () => {
  test.each(["safe", "finalized"])("serves the %s tag", async (tag) => {
    expect((await rpc(capabilityUrl!, "eth_chainId")).result).toBe("0x1388");
    const body = await rpc(capabilityUrl!, "eth_getBlockByNumber", [tag, false]);
    expect(body.error).toBeUndefined();
    expect(body.result).toHaveProperty("number");
  }, 25_000);

  test("serves explicit historical state without substitution", async () => {
    expect((await rpc(capabilityUrl!, "eth_chainId")).result).toBe("0x1388");
    const body = await rpc(capabilityUrl!, "eth_getBalance", ["0x0000000000000000000000000000000000000000", "0x1"]);
    expect(body.error).toBeUndefined();
    expect(body.result).toMatch(/^0x[0-9a-f]+$/i);
  }, 25_000);

  test("keeps errors attached to individual wire batch items", async () => {
    expect((await rpc(capabilityUrl!, "eth_chainId")).result).toBe("0x1388");
    const response = await fetch(capabilityUrl!, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 500, method: "eth_blockNumber", params: [] },
        { jsonrpc: "2.0", id: 501, method: "eth_getBalance", params: ["invalid-address", "latest"] },
      ]), signal: AbortSignal.timeout(10_000),
    });
    const results = await response.json() as { id: number; result?: unknown; error?: unknown }[];
    expect(Array.isArray(results)).toBe(true);
    expect(results.find(({ id }) => id === 500)?.result).toMatch(/^0x[0-9a-f]+$/i);
    expect(results.find(({ id }) => id === 501)?.error).toBeDefined();
  }, 25_000);
});
