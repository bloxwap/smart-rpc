import { describe, expect, test } from "vitest";
import { keccak256 } from "viem";

import { createPoolScope } from "@smart-rpc/core";

import { ethereum } from "../src/transport.js";

type Wire = { id: number; method: string; params: unknown[] };
type Reply = { result: unknown } | { error: { code: number; message: string } } | { status: number };

function fixture(resolve: (request: Wire, url: string) => Reply) {
  const calls: { url: string; request: Wire }[] = [];
  const batches: number[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body)) as Wire | Wire[];
    const list = Array.isArray(body) ? body : [body];
    batches.push(list.length);
    let status = 200;
    const replies = list.map((request) => {
      calls.push({ url, request });
      const reply = request.method === "eth_chainId" ? { result: "0x1" } : resolve(request, url);
      if ("status" in reply) status = reply.status;
      return { jsonrpc: "2.0", id: request.id, ...reply };
    });
    if (status !== 200) return new Response("unavailable", { status });
    return Response.json(Array.isArray(body) ? replies : replies[0]);
  };
  return { calls, batches, fetchFn };
}

describe("ethereum() option validation", () => {
  test.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects chainId %s", (chainId) => {
    expect(() => ethereum({ chainId, endpoints: ["https://a.example"], headLag: false }))
      .toThrow(`ethereum() chainId must be a positive integer, got ${String(chainId)}.`);
  });

  test("rejects a blank endpoint url before opening a connection", () => {
    expect(() => ethereum({ endpoints: [{ url: "   " }], headLag: false })).toThrow("endpoint url must not be empty");
  });

  test("rejects empty, duplicated and malformed CAIP-2 chain ids", () => {
    const endpoints = ["https://a.example"];
    expect(() => ethereum({ chainIds: [], endpoints, headLag: false })).toThrow("must include at least one CAIP-2 id");
    expect(() => ethereum({ chainIds: ["eip155:1", "eip155:1"], endpoints, headLag: false })).toThrow("chainIds must be unique");
    expect(() => ethereum({ chainIds: ["eip155:1", "not a caip id"], endpoints, headLag: false }))
      .toThrow('chainIds entry "not a caip id" is not a CAIP-2 id');
  });
});

describe("endpoint batching without a provider ceiling", () => {
  test("keeps the caller's batch settings when the endpoint states no maxBatchSize", async () => {
    const { batches, fetchFn } = fixture(() => ({ result: "0x10" }));
    const pool = ethereum({
      endpoints: [{ url: "https://uncapped.example", capabilities: { batch: true } }],
      batch: { batchSize: 3, wait: 1 }, verifyIdentity: false, headLag: false, race: false, cache: false, fetchFn,
    });
    try {
      const results = await Promise.all(["eth_blockNumber", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_blobBaseFee"]
        .map((method) => pool.request({ method })));
      expect(results).toEqual(["0x10", "0x10", "0x10", "0x10"]);
      expect(batches).toEqual([3, 1]);
    } finally { pool.close(); }
  });
});

describe("credential identity for shared pools", () => {
  test("header order and name case do not change the credential fingerprint", () => {
    const scope = createPoolScope();
    const open = (headers: Record<string, string>) => ethereum({
      endpoints: [{ url: "https://a.example", headers }], sharing: { scope, key: "app" }, headLag: false,
    });
    const first = open({ "X-Api-Key": "k", authorization: "Bearer a", "x-tenant": "t", Accept: "application/json" });
    const second = open({ accept: "application/json", "X-Tenant": "t", Authorization: "Bearer a", "x-api-key": "k" });
    expect(() => open({ accept: "application/json", "x-tenant": "t", authorization: "Bearer a", "x-api-key": "other" }))
      .toThrow(/sharing key/);
    first.close();
    second.close();
    scope.close();
  });

  test("names that differ only by case keep both values in the fingerprint", () => {
    const scope = createPoolScope();
    const open = (headers: Record<string, string>) => ethereum({
      endpoints: [{ url: "https://a.example", headers }], sharing: { scope, key: "app" }, headLag: false,
    });
    const first = open({ "X-Key": "one", "x-key": "two", authorization: "a" });
    expect(() => open({ "X-Key": "one", "x-key": "changed", authorization: "a" })).toThrow(/sharing key/);
    first.close();
    scope.close();
  });

  test("an empty header object is the same identity as no headers", () => {
    const scope = createPoolScope();
    const first = ethereum({ endpoints: [{ url: "https://a.example", headers: {} }], sharing: { scope, key: "app" }, headLag: false });
    const second = ethereum({ endpoints: [{ url: "https://a.example" }], sharing: { scope, key: "app" }, headLag: false });
    expect(() => ethereum({
      endpoints: [{ url: "https://a.example", headers: { authorization: "a" } }], sharing: { scope, key: "app" }, headLag: false,
    })).toThrow(/sharing key/);
    first.close();
    second.close();
    scope.close();
  });
});

describe("pinLatest given as an object", () => {
  const PRECOMPILE = "0x0000000000000000000000000000000000000800";
  const CONTRACT = "0x00000000000000000000000000000000000000aa";

  async function pinned(pinLatest: { skipPrecompiles?: boolean }): Promise<Record<string, unknown>> {
    const { calls, fetchFn } = fixture((request) => ({ result: request.method === "eth_blockNumber" ? "0x64" : "0x" }));
    const pool = ethereum({ endpoints: ["https://pin.example"], fetchFn, pinLatest, race: false, cache: false });
    try {
      await pool.request({ method: "eth_blockNumber" });
      await pool.request({ method: "eth_call", params: [{ to: CONTRACT, data: "0x01" }, "latest"] });
      await pool.request({ method: "eth_call", params: [{ to: PRECOMPILE, data: "0x01" }, "latest"] });
      const tags: Record<string, unknown> = {};
      for (const { request } of calls) {
        if (request.method === "eth_call") tags[(request.params[0] as { to: string }).to] = request.params[1];
      }
      return tags;
    } finally { pool.close(); }
  }

  test("its own skipPrecompiles wins over the transport default", async () => {
    await expect(pinned({ skipPrecompiles: true })).resolves.toEqual({ [CONTRACT]: "0x64", [PRECOMPILE]: "latest" });
  });

  test("it inherits the transport's skipPrecompiles when it names none", async () => {
    await expect(pinned({})).resolves.toEqual({ [CONTRACT]: "0x64", [PRECOMPILE]: "0x64" });
  });
});

describe("raw transaction rebroadcast results", () => {
  const RAW = "0x02f86c0180843b9aca00";

  /** The first endpoint tried is down; every later one says the transaction is already known. */
  function rebroadcast() {
    const down = new Set<string>();
    return fixture((_request, url) => {
      if (down.size === 0 || down.has(url)) {
        down.add(url);
        return { status: 503 };
      }
      return { error: { code: -32000, message: "already known" } };
    });
  }
  const options = { endpoints: ["https://relay-a.example", "https://relay-b.example"], headLag: false, verifyIdentity: false, retryDelay: 0 } as const;

  test("an already-known answer on failover resolves to the hash of the signed bytes", async () => {
    const { calls, fetchFn } = rebroadcast();
    const pool = ethereum({ ...options, fetchFn });
    try {
      await expect(pool.request({ method: "eth_sendRawTransaction", params: [RAW] })).resolves.toBe(keccak256(RAW));
      expect(new Set(calls.map((call) => call.url)).size).toBe(2);
    } finally { pool.close(); }
  });

  test.each([
    { name: "the sync variant, whose result is a receipt", method: "eth_sendRawTransactionSync", params: [RAW] as unknown },
    { name: "params that are not a list", method: "eth_sendRawTransaction", params: { raw: RAW } as unknown },
    { name: "a payload that is not a string", method: "eth_sendRawTransaction", params: [1234] as unknown },
    { name: "a payload that is not strict hex", method: "eth_sendRawTransaction", params: ["0xnothex"] as unknown },
  ])("does not invent a hash for $name", async ({ method, params }) => {
    const { fetchFn } = rebroadcast();
    const pool = ethereum({ ...options, fetchFn });
    try {
      await expect(pool.request({ method, params })).rejects.toThrow();
    } finally { pool.close(); }
  });
});
