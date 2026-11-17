import { describe, expect, test } from "vitest";

import { monad } from "../src/index.js";

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
      const result = body.method === "eth_chainId" ? "0x8f" : `0x${head.toString(16)}`;
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  };
}

describe("Monad head-lag defaults", () => {
  test("an omitted headLag applies the Monad lag grace and lead limit", async () => {
    const mock = nodes({ "b.example": HEAD - 10, "c.example": HEAD + 201 });
    const pool = monad({ endpoints: urls, fetchFn: mock.fetchFn, cache: false, race: false });
    try {
      await pool.probe();
      const [leader, behind, ahead] = pool.snapshot();
      // Ten blocks behind is inside MONAD_HEAD_LAG.maxLag, so the score is not penalized.
      expect(behind).toMatchObject({ head: HEAD - 10, lag: 10 });
      expect(behind?.score).toBe(leader?.score);
      // 201 blocks ahead exceeds maxAhead 200 (the core default of 1000 would accept it as the tip).
      expect(leader).toMatchObject({ head: HEAD, lag: 0 });
      expect(ahead).toMatchObject({ head: HEAD + 201, lag: null });
      expect(ahead?.score).toBeGreaterThan(leader?.score ?? Infinity);
    } finally { pool.close(); }
  });

  test("headLag: false stops head tracking altogether", async () => {
    const mock = nodes({ "b.example": HEAD - 500 });
    const pool = monad({ endpoints: urls, fetchFn: mock.fetchFn, headLag: false, cache: false, race: false });
    try {
      await pool.probe();
      await expect(pool.request({ method: "eth_blockNumber" })).resolves.toMatch(/^0x/);
      const rows = pool.snapshot();
      expect(rows.map(({ head, lag }) => [head, lag])).toEqual([[null, null], [null, null], [null, null]]);
    } finally { pool.close(); }
  });
});
