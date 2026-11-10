import { describe, expect, test } from "vitest";

import { createPoolScope } from "@smart-rpc/core";

import { ethereum } from "../src/transport.js";

describe("ethereum chain identity", () => {
  test("rejects a chain id that eth_chainId would not prove", () => {
    expect(() => ethereum({ chainIds: ["eip155:999"], headLag: false })).toThrow(/eip155:1/);
    expect(() => ethereum({
      chainId: 1,
      chainIds: ["eip155:999"],
      endpoints: ["https://a.example"],
      headLag: false,
    })).toThrow(/eip155:1/);
    const client = ethereum({
      chainId: 999,
      chainIds: ["eip155:999", "custom:999"],
      endpoints: ["https://a.example"],
      headLag: false,
    });
    expect(client.chainIds).toEqual(["eip155:999", "custom:999"]);
    client.close();
  });
});

describe("safeMethods", () => {
  test("adding a send-like name does not race or retry it", async () => {
    const calls: string[] = [];
    const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      calls.push(body.method);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1" }), {
        headers: { "content-type": "application/json" },
      });
    };
    const client = ethereum({
      endpoints: ["https://a.example", "https://b.example"],
      safeMethods: ["debug_sendRawTransaction", "linea_sendBundle"],
      verifyIdentity: false,
      race: true,
      retryCount: 2,
      headLag: false,
      routing: "best",
      fetchFn,
    });
    try {
      await expect(client.request({ method: "linea_sendBundle", params: [] })).resolves.toBe("0x1");
      expect(calls.filter((method) => method === "linea_sendBundle")).toEqual(["linea_sendBundle"]);
    } finally {
      client.close();
    }
  });
});

describe("shared ethereum credentials", () => {
  test("the same sharing key rejects a different url or authorization header", () => {
    const scope = createPoolScope();
    const first = ethereum({
      endpoints: [{ url: "https://a.example", headers: { authorization: "Bearer a" } }],
      sharing: { scope, key: "app" },
      headLag: false,
    });
    expect(() => ethereum({
      endpoints: [{ url: "https://b.example", headers: { authorization: "Bearer a" } }],
      sharing: { scope, key: "app" },
      headLag: false,
    })).toThrow(/sharing key/);
    expect(() => ethereum({
      endpoints: [{ url: "https://a.example", headers: { authorization: "Bearer b" } }],
      sharing: { scope, key: "app" },
      headLag: false,
    })).toThrow(/sharing key/);
    first.close();
    scope.close();
  });
});
