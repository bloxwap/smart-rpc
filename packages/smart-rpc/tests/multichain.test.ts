import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { describe, expect, test } from "vitest";

import { createSmartRpc, type RpcPool } from "../src/index.js";

const chains = [
  ["ethereum", 1], ["bsc", 56], ["polygon", 137], ["base", 8453],
  ["arbitrum", 42161], ["monad", 143], ["xlayer", 196], ["robinhood", 4663],
  ["hyperevm", 999], ["plasma", 9745], ["ink", 57073], ["optimism", 10],
  ["opbnb", 204], ["arc", 5042], ["etherlink", 42793], ["avalanche", 43114],
  ["celo", 42220], ["gnosis", 100], ["mantle", 5000], ["flare", 14],
] as const;

const directory = fileURLToPath(new URL("../", import.meta.url));
const factory = async (name: string): Promise<(options: Record<string, unknown>) => RpcPool> => {
  const module = await import(new URL(`../dist/${name}.js`, import.meta.url).href);
  expect(typeof module[name]).toBe("function");
  return module[name];
};

describe("all published EVM transports", () => {
  test("routes twenty registered chains without leaking a call to another chain", async () => {
    const calls: string[] = [];
    const transports = await Promise.all(chains.map(async ([name, chainId]) => {
      const create = await factory(name);
      return create({
        chainId,
        endpoints: [`https://${name}.example/rpc`],
        headLag: false, race: false, cache: false,
        fetchFn: async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
          expect(url.hostname).toBe(`${name}.example`);
          const body = JSON.parse(String(init?.body)) as { id: number; method: string };
          calls.push(`${name}:${body.method}`);
          return new Response(JSON.stringify({
            jsonrpc: "2.0", id: body.id,
            result: body.method === "eth_chainId" ? `0x${chainId.toString(16)}` : `0x${chainId.toString(16)}`,
          }), { headers: { "content-type": "application/json" } });
        },
      });
    }));
    const rpc = createSmartRpc({ transports });
    try {
      for (const [name, chainId] of chains) {
        expect(await rpc.request({ chainId: `eip155:${chainId}`, method: "eth_blockNumber" }))
          .toBe(`0x${chainId.toString(16)}`);
        expect(calls.filter((call) => call === `${name}:eth_blockNumber`)).toHaveLength(1);
        expect(calls.filter((call) => call === `${name}:eth_chainId`)).toHaveLength(1);
      }
      expect(rpc.chainIds).toHaveLength(chains.length);
      await expect(rpc.request({ chainId: "eip155:123456789", method: "eth_blockNumber" })).rejects.toThrow();
      expect(calls).toHaveLength(chains.length * 2);
    } finally {
      rpc.close();
    }
  });

  test("every subpath is exported with bundled declarations and no private package dependency", () => {
    const manifest = JSON.parse(readFileSync(`${directory}/package.json`, "utf8"));
    for (const [name] of chains) {
      expect(manifest.exports[`./${name}`]).toEqual({ types: `./dist/${name}.d.ts`, import: `./dist/${name}.js` });
      expect(readFileSync(`${directory}/dist/${name}.d.ts`, "utf8")).not.toMatch(/from ["']@smart-rpc\//);
    }
    expect(Object.keys(manifest.dependencies)).toEqual(["viem"]);
  });

  test.each(chains)("bundling %s excludes unrelated transport factories", async (name) => {
    const result = await build({
      stdin: { contents: `export { ${name} } from "./dist/${name}.js";`, resolveDir: directory },
      bundle: true, write: false, format: "esm", platform: "node", external: ["viem"], treeShaking: true,
    });
    const output = result.outputFiles[0]!.text;
    expect(output).not.toMatch(/@smart-rpc\//);
    for (const [other] of chains) {
      if (other !== name && other !== "ethereum") expect(output).not.toMatch(new RegExp(`function ${other}\\(`));
    }
    expect(output).not.toMatch(/function solana\(/);
  });

  test("bundling the core root loads no transport or viem", async () => {
    const result = await build({
      stdin: { contents: 'export * from "./dist/index.js";', resolveDir: directory },
      bundle: true, write: false, format: "esm", platform: "node", external: ["viem"], treeShaking: true,
    });
    const output = result.outputFiles[0]!.text;
    expect(output).not.toMatch(/from ["']viem/);
    for (const [name] of chains) expect(output).not.toMatch(new RegExp(`function ${name}\\(`));
  });
});
