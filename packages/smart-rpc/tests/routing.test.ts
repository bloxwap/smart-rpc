import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { ethereum } from "@smart-rpc/ethereum";
import { hyperevm } from "@smart-rpc/hyperevm";
import { MAINNET_GENESIS_HASH, solana } from "@smart-rpc/solana";

import { createSmartRpc } from "../src/index.js";

describe("CAIP-2 routing", () => {
  test("solana:mainnet stays on solana and eip155:999 stays on hyperevm", async () => {
    const hits: string[] = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const host = new URL(url).host;
      let method = "unknown";
      const raw = typeof init?.body === "string" ? init.body : "";
      if (raw) method = (JSON.parse(raw) as { method?: string }).method ?? method;
      hits.push(`${host} ${method}`);
      let result: unknown = "0x1";
      if (method === "eth_chainId") result = host.startsWith("hyper") ? "0x3e7" : "0x1";
      if (method === "eth_blockNumber") result = "0x10";
      if (method === "getGenesisHash") result = MAINNET_GENESIS_HASH;
      if (method === "getSlot" || method === "getHealth") result = method === "getSlot" ? 1 : "ok";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const rpc = createSmartRpc({
      transports: [
        ethereum({
          endpoints: ["https://eth.example/rpc"],
          fetchFn,
          headLag: { probeInterval: false },
          race: false,
          cache: false,
        }),
        hyperevm({
          chainId: 999,
          endpoints: ["https://hyper.example/evm"],
          fetchFn,
          headLag: { probeInterval: false },
          race: false,
          cache: false,
        }),
        solana({
          endpoints: ["https://sol.example/rpc"],
          fetchFn,
          headLag: { probeInterval: false },
          race: false,
          cache: false,
        }),
      ],
    });

    await rpc.request({ chainId: "solana:mainnet", method: "getHealth", params: [] });
    await rpc.request({ chainId: "eip155:999", method: "eth_blockNumber", params: [] });
    await rpc.request({ chainId: "eip155:1", method: "eth_chainId", params: [] });

    expect(hits.some((hit) => hit.startsWith("sol.example"))).toBe(true);
    expect(hits.some((hit) => hit.startsWith("hyper.example"))).toBe(true);
    expect(hits.some((hit) => hit.startsWith("eth.example"))).toBe(true);
    expect(hits.filter((hit) => hit.includes("getHealth") || hit.includes("getGenesisHash")).every((hit) => hit.startsWith("sol.example"))).toBe(true);
    expect(hits.filter((hit) => hit.startsWith("eth.example")).every((hit) => !hit.includes("get"))).toBe(true);
    const hyperCalls = hits.filter((hit) => hit.startsWith("hyper.example"));
    expect(hyperCalls.some((hit) => hit.endsWith("eth_blockNumber") || hit.endsWith("eth_chainId"))).toBe(true);
    expect(hits.filter((hit) => hit.endsWith("eth_blockNumber")).every((hit) => hit.startsWith("hyper.example"))).toBe(true);
    rpc.close();
  });
});

describe("umbrella entry", () => {
  test("the package root imports only @smart-rpc/core", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/@smart-rpc\/(solana|ethereum|hyperevm)/);
    expect(source).toMatch(/@smart-rpc\/core/);
    for (const name of ["solana", "ethereum", "hyperevm"]) {
      const subpath = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
      expect(subpath).toMatch(new RegExp(`@smart-rpc/${name}`));
    }
  });
});
