import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { MAINNET_GENESIS_HASH } from "@smart-rpc/solana";

import { ethereum } from "../src/ethereum.js";
import { hyperevm } from "../src/hyperevm.js";
import { createSmartRpc } from "../src/index.js";
import { solana } from "../src/solana.js";

describe("CAIP-2 routing", () => {
  test("solana:mainnet stays on solana and eip155:999 stays on hyperevm", async () => {
    const hits: string[] = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const host = new URL(url).host;
      let method = "unknown";
      let id: unknown = 1;
      const raw = typeof init?.body === "string" ? init.body : "";
      if (raw) {
        const parsed = JSON.parse(raw) as { id?: unknown; method?: string };
        method = parsed.method ?? method;
        if (parsed.id !== undefined) id = parsed.id;
      }
      hits.push(`${host} ${method}`);
      let result: unknown = "0x1";
      if (method === "eth_chainId") result = host.startsWith("hyper") ? "0x3e7" : "0x1";
      if (method === "eth_blockNumber" || method === "eth_getBlockByNumber") result = "0x10";
      if (method === "getGenesisHash") result = MAINNET_GENESIS_HASH;
      if (method === "getSlot" || method === "getHealth") result = method === "getSlot" ? 1 : "ok";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
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

describe("published package", () => {
  test("the root source does not import a transport", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/@smart-rpc\/(solana|ethereum|hyperevm)/);
    expect(source).not.toMatch(/from "\.\/(solana|ethereum|hyperevm)/);
    expect(source).toMatch(/@smart-rpc\/core/);
    for (const name of ["solana", "ethereum", "hyperevm"]) {
      const subpath = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
      expect(subpath).toMatch(new RegExp(`@smart-rpc/${name}`));
    }
  });

  test("npm install @bloxwap/smart-rpc is the only public package", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      name: string;
      sideEffects: boolean;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      exports: Record<string, unknown>;
    };
    expect(manifest.name).toBe("@bloxwap/smart-rpc");
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.dependencies).toEqual({ viem: expect.any(String) });
    expect(Object.keys(manifest.dependencies ?? {})).not.toEqual(
      expect.arrayContaining(["@smart-rpc/core", "@smart-rpc/ethereum", "@smart-rpc/hyperevm", "@smart-rpc/solana"]),
    );
    expect(manifest.exports).toMatchObject({
      ".": { import: "./dist/index.js" },
      "./ethereum": { import: "./dist/ethereum.js" },
      "./hyperevm": { import: "./dist/hyperevm.js" },
      "./solana": { import: "./dist/solana.js" },
    });
  });

  test("the built root does not import a transport, and subpaths do not import private packages", () => {
    const dist = new URL("../dist/", import.meta.url);
    const read = (name: string): string => readFileSync(new URL(name, dist), "utf8");
    const closure = (entry: string): string => {
      const seen = new Set<string>();
      const pending = [entry];
      let text = "";
      while (pending.length > 0) {
        const name = pending.pop();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const source = read(name);
        text += `\n${source}`;
        for (const match of source.matchAll(/(?:from|import)\s*["'](\.\/[^"']+)["']/g)) {
          const relative = match[1];
          if (relative) pending.push(relative.slice(2));
        }
      }
      return text;
    };
    const index = closure("index.js");
    const ethereumJs = closure("ethereum.js");
    const solanaJs = closure("solana.js");
    expect(index).not.toMatch(/["']viem["']/);
    expect(index).not.toMatch(/ethereum\.js|hyperevm\.js|solana\.js/);
    expect(index).not.toMatch(/@smart-rpc\//);
    expect(ethereumJs).toMatch(/["']viem["']/);
    expect(ethereumJs).not.toMatch(/solana\.js/);
    expect(ethereumJs).not.toMatch(/from ["']@smart-rpc\//);
    expect(solanaJs).not.toMatch(/["']viem["']/);
    expect(solanaJs).not.toMatch(/from ["']@smart-rpc\//);
    for (const name of ["index.d.ts", "ethereum.d.ts", "hyperevm.d.ts", "solana.d.ts"]) {
      expect(read(name)).not.toMatch(/from ["']@smart-rpc\//);
      expect(read(name)).not.toMatch(/import ["']@smart-rpc\//);
    }
  });
});
