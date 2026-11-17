import { describe, expect, test } from "vitest";

import { jsonRpcCaller, solana } from "../src/index.js";

const GENESIS = "CustomGenesisHash1111111111111111111111111111";
const offline = { headLag: { probeInterval: false as const }, race: false, cache: false } as const;

interface Body { id: number; method: string }

function reply(answer: (body: Body, host: string) => unknown) {
  const calls: { host: string; method: string }[] = [];
  return {
    calls,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body)) as Body;
      const host = new URL(url).hostname;
      calls.push({ host, method: body.method });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: answer(body, host) });
    },
  };
}

describe("Solana chain ids for a private cluster", () => {
  test("accepts custom ids once endpoints and genesisHash are explicit and the genesis id is listed", async () => {
    const mock = reply((body) => body.method === "getGenesisHash" ? GENESIS : "ok");
    const chainIds = [`solana:${GENESIS}`, "solana:localnet"];
    const client = solana({ ...offline, endpoints: ["https://private.example"], genesisHash: GENESIS, chainIds, fetchFn: mock.fetchFn });
    try {
      expect(client.chainIds).toEqual(chainIds);
      await expect(client.request({ chainId: "solana:localnet", method: "getHealth" })).resolves.toBe("ok");
      expect(mock.calls.map(({ method }) => method)).toEqual(["getGenesisHash", "getHealth"]);
    } finally { client.close(); }
  });

  test.each([
    ["the genesis id is missing", { endpoints: ["https://private.example"], genesisHash: GENESIS, chainIds: ["solana:localnet"] }],
    ["genesisHash is not explicit", { endpoints: ["https://private.example"], chainIds: ["solana:localnet"] }],
    ["endpoints are not explicit", { genesisHash: GENESIS, chainIds: [`solana:${GENESIS}`, "solana:localnet"] }],
    ["an id belongs to another namespace", { endpoints: ["https://private.example"], genesisHash: GENESIS, chainIds: [`solana:${GENESIS}`, "eip155:1"] }],
    ["an id has an empty reference", { endpoints: ["https://private.example"], genesisHash: GENESIS, chainIds: [`solana:${GENESIS}`, "solana:"] }],
  ])("rejects custom ids when %s", (_reason, options) => {
    expect(() => solana({ ...offline, ...options })).toThrow(/chainIds must be solana:mainnet and solana:.+ unless endpoints and genesisHash are both set/);
  });
});

describe("Solana identity parsing", () => {
  test.each([
    ["an empty string", ""],
    ["a non-string", { hash: GENESIS }],
  ])("never sends a user call to an endpoint whose getGenesisHash result is %s", async (_label, identity) => {
    const mock = reply((body, host) => {
      if (body.method === "getGenesisHash") return host === "broken.example" ? identity : GENESIS;
      return "ok";
    });
    const client = solana({
      ...offline,
      routing: "best",
      endpoints: [{ label: "broken", url: "https://broken.example" }, { label: "good", url: "https://good.example" }],
      genesisHash: GENESIS,
      chainIds: [`solana:${GENESIS}`],
      fetchFn: mock.fetchFn,
    });
    try {
      await expect(client.request({ method: "getHealth" })).resolves.toBe("ok");
      expect(mock.calls.filter(({ host }) => host === "broken.example").map(({ method }) => method)).toEqual(["getGenesisHash"]);
      expect(mock.calls.filter(({ host }) => host === "good.example").map(({ method }) => method)).toEqual(["getGenesisHash", "getHealth"]);
      // No identity is an endpoint failure, not proof of another chain, so nothing is quarantined.
      expect(client.snapshot().map(({ quarantined }) => quarantined)).toEqual([false, false]);
    } finally { client.close(); }
  });

  test("a lone endpoint that reports no identity fails the request", async () => {
    const mock = reply((body) => body.method === "getGenesisHash" ? "" : "ok");
    const client = solana({
      ...offline,
      retryCount: 0,
      endpoints: ["https://broken.example"],
      genesisHash: GENESIS,
      chainIds: [`solana:${GENESIS}`],
      fetchFn: mock.fetchFn,
    });
    try {
      await expect(client.request({ method: "getHealth" })).rejects.toThrow("All RPC endpoints failed.");
      expect(mock.calls.some(({ method }) => method === "getHealth")).toBe(false);
    } finally { client.close(); }
  });
});

describe("Solana JSON-RPC envelopes", () => {
  test("a body carrying only an id is still held to the JSON-RPC version and id", async () => {
    let sent = 0;
    const call = jsonRpcCaller("https://rpc.example", async (_input, init) => {
      sent = (JSON.parse(String(init?.body)) as Body).id;
      return Response.json({ id: sent });
    });
    await expect(call({ method: "getSlot" })).rejects.toMatchObject({
      message: "Solana RPC returned an invalid JSON-RPC response: mismatched id.",
      status: 200,
    });
    expect(sent).toBeGreaterThan(0);
  });

  test.each([
    ["null", null],
    ["a string", "boom"],
    ["an object without a message", { code: -32000, data: { retry: true } }],
  ])("an HTTP 200 error member that is %s is reported as an invalid error", async (_label, error) => {
    const call = jsonRpcCaller("https://rpc.example", async (_input, init) => {
      const { id } = JSON.parse(String(init?.body)) as Body;
      return Response.json({ jsonrpc: "2.0", id, error });
    });
    const failure: unknown = await call({ method: "getSlot" }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message: "Solana RPC returned an invalid JSON-RPC error.", status: 200 });
    if (error !== null && typeof error === "object") {
      expect(failure).toMatchObject({ code: -32000, data: { retry: true } });
    } else {
      expect(failure).not.toHaveProperty("code");
      expect(failure).not.toHaveProperty("data");
    }
  });
});
