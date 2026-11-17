import { describe, expect, test } from "vitest";

import { flare } from "../src/index.js";

const HEAD = 1_000;
const urls = ["https://a.example/rpc", "https://b.example/rpc", "https://c.example/rpc"];

/** Each host reports its own head; the chain identity is always correct. */
function nodes(heads: Record<string, number>) {
  const methods: string[] = [];
  return {
    methods,
    async fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      methods.push(body.method);
      const head = heads[new URL(url).hostname] ?? HEAD;
      const result = body.method === "eth_chainId" ? "0xe" : `0x${head.toString(16)}`;
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  };
}

describe("Flare head-lag defaults", () => {
  test("an omitted headLag applies the one-block Flare lag grace", async () => {
    const mock = nodes({ "b.example": HEAD - 1, "c.example": HEAD - 4 });
    // All fixture heads were observed at the same logical instant.
    const pool = flare({ endpoints: urls, fetchFn: mock.fetchFn, cache: false, race: false, now: () => 0 });
    try {
      await pool.probe();
      const [leader, graced, behind] = pool.snapshot();
      expect(leader).toMatchObject({ head: HEAD, lag: 0 });
      expect(graced).toMatchObject({ head: HEAD - 1, lag: 1 });
      expect(graced?.score).toBe(leader?.score);
      expect(behind).toMatchObject({ head: HEAD - 4, lag: 4 });
      expect(behind?.score).toBeGreaterThan(leader?.score ?? Infinity);
    } finally { pool.close(); }
  });

  test("headLag: false stops head tracking altogether", async () => {
    const mock = nodes({ "b.example": HEAD - 500 });
    const pool = flare({ endpoints: urls, fetchFn: mock.fetchFn, headLag: false, cache: false, race: false });
    try {
      await pool.probe();
      await expect(pool.request({ method: "eth_blockNumber" })).resolves.toMatch(/^0x/);
      const rows = pool.snapshot();
      expect(rows.map(({ head, lag }) => [head, lag])).toEqual([[null, null], [null, null], [null, null]]);
    } finally { pool.close(); }
  });
});
