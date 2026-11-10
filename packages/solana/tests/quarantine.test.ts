import { describe, expect, test } from "vitest";

import { MAINNET_GENESIS_HASH, solana } from "../src/index.js";

describe("solana quarantine", () => {
  test("drops an endpoint whose getGenesisHash does not match", async () => {
    const seen: string[] = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const host = new URL(url).host;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (body.method === "getSlot" || body.method === "getHealth") seen.push(host);
      let result: unknown = "ok";
      if (body.method === "getGenesisHash") {
        result = host.startsWith("wrong") ? "not-the-genesis" : MAINNET_GENESIS_HASH;
      }
      if (body.method === "getSlot") result = 10;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = solana({
      endpoints: [
        { label: "wrong", url: "https://wrong.example" },
        { label: "right", url: "https://right.example" },
      ],
      fetchFn,
      routing: "best",
      race: false,
      headLag: { probeInterval: false },
      cache: false,
    });
    await expect(client.request({ chainId: "solana:mainnet", method: "getHealth", params: [] })).resolves.toBe("ok");
    expect(seen).toEqual(["right.example"]);
    expect(client.snapshot().find((row) => row.id === "wrong")?.quarantined).toBe(true);
    client.close();
  });
});
