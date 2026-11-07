import { describe, expect, test } from "vitest";

import {
  HYPEREVM_MAINNET_CAIP,
  HYPEREVM_RPC_URL,
  HYPEREVM_TESTNET_CAIP,
  HYPEREVM_TESTNET_RPC_URL,
  hyperevm,
} from "../src/index.js";

describe("hyperevm", () => {
  test("serves eip155:999 and eip155:998 with the public RPCs", () => {
    const seen: string[] = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      seen.push(url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const result = body.method === "eth_chainId" ? "0x3e7" : "0x10";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const mainnet = hyperevm({
      chainId: 999,
      fetchFn,
      headLag: { probeInterval: false },
      verifyIdentity: false,
      race: false,
    });
    expect(mainnet.chainIds).toEqual([HYPEREVM_MAINNET_CAIP]);
    const both = hyperevm({ fetchFn, headLag: { probeInterval: false } });
    expect(both.chainIds).toEqual([HYPEREVM_MAINNET_CAIP, HYPEREVM_TESTNET_CAIP]);
    expect(HYPEREVM_RPC_URL).toBe("https://rpc.hyperliquid.xyz/evm");
    expect(HYPEREVM_TESTNET_RPC_URL).toBe("https://rpc.hyperliquid-testnet.xyz/evm");
    return mainnet.request({ chainId: HYPEREVM_MAINNET_CAIP, method: "eth_chainId", params: [] }).then((result) => {
      expect(result).toBe("0x3e7");
      expect(seen.some((url) => url.startsWith(HYPEREVM_RPC_URL))).toBe(true);
      mainnet.close?.();
      both.close?.();
    });
  });
});
