import { describe, expect, test } from "vitest";
import { connectViem, ethereum } from "../src/index.js";

type Wire = { id: number; method: string };
const responseFor = (body: Wire[], failGas = false): Response => Response.json(body.map((item) => ({
  jsonrpc: "2.0", id: item.id,
  ...(failGas && item.method === "eth_gasPrice" ? { error: { code: -32602, message: "invalid gas fixture" } } : { result: "0x10" }),
})));

describe("viem wire batching with separate caller cancellation", () => {
  test("sends two core requests in one wire batch and retains each partial result", async () => {
    const batches: number[] = [];
    const pool = ethereum({
      endpoints: [{ url: "https://batch-core.example", capabilities: { batch: true, maxBatchSize: 2 } }],
      batch: { batchSize: 2, wait: 1 }, verifyIdentity: false, headLag: false, race: false, cache: false,
      fetchFn: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Wire[];
        batches.push(body.length);
        return responseFor(body, true);
      },
    });
    try {
      const results = await Promise.allSettled([pool.request({ method: "eth_blockNumber" }), pool.request({ method: "eth_gasPrice" })]);
      expect(batches).toEqual([2]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "0x10" });
      expect(results[1]?.status).toBe("rejected");
    } finally { pool.close(); }
  });

  test("keeps a sibling alive when one participant cancels after HTTP dispatch", async () => {
    let sent!: () => void;
    const started = new Promise<void>((resolve) => { sent = resolve; });
    let finish!: () => void;
    let upstreamAborted = false;
    let batchSize = 0;
    const connection = connectViem("https://independent-batch.example", {
      timeout: 1_000, batch: { batchSize: 2, wait: 1 },
      fetchFn: async (_input, init) => new Promise<Response>((resolve, reject) => {
        const body = JSON.parse(String(init?.body)) as Wire[];
        batchSize = body.length;
        init?.signal?.addEventListener("abort", () => { upstreamAborted = true; reject(init.signal?.reason); }, { once: true });
        finish = () => resolve(responseFor(body));
        sent();
      }),
    });
    const first = new AbortController();
    const second = new AbortController();
    try {
      const cancelled = connection.call({ method: "eth_blockNumber" }, { signal: first.signal });
      const rejected = expect(cancelled).rejects.toThrow();
      const surviving = connection.call({ method: "eth_gasPrice" }, { signal: second.signal });
      await started;
      expect(batchSize).toBe(2);
      first.abort();
      await rejected;
      expect(upstreamAborted).toBe(false);
      finish();
      await expect(surviving).resolves.toBe("0x10");
    } finally { connection.close(); }
  });

  test("aborts shared HTTP work when all participants cancel", async () => {
    let sent!: () => void;
    const started = new Promise<void>((resolve) => { sent = resolve; });
    let upstreamAborted = false;
    const connection = connectViem("https://abort-batch.example", {
      timeout: 1_000, batch: { wait: 1 },
      fetchFn: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { upstreamAborted = true; reject(init.signal?.reason); }, { once: true });
        sent();
      }),
    });
    const first = new AbortController();
    const second = new AbortController();
    try {
      const outcomes = Promise.allSettled([
        connection.call({ method: "eth_blockNumber" }, { signal: first.signal }),
        connection.call({ method: "eth_gasPrice" }, { signal: second.signal }),
      ]);
      await started;
      first.abort();
      expect(upstreamAborted).toBe(false);
      second.abort();
      expect(upstreamAborted).toBe(true);
      expect((await outcomes).every((result) => result.status === "rejected")).toBe(true);
    } finally { connection.close(); }
  });

  test("does not share a same-URL batch across different credential connections", async () => {
    const calls: { token: string | null; size: number }[] = [];
    const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Wire[];
      calls.push({ token: new Headers(init?.headers).get("authorization"), size: body.length });
      return responseFor(body);
    };
    const first = connectViem("https://credentials.example", { timeout: 1_000, batch: true, headers: { authorization: "first" }, fetchFn });
    const second = connectViem("https://credentials.example", { timeout: 1_000, batch: true, headers: { authorization: "second" }, fetchFn });
    try {
      await Promise.all([first.call({ method: "eth_blockNumber" }), second.call({ method: "eth_gasPrice" })]);
      expect(calls).toEqual([{ token: "first", size: 1 }, { token: "second", size: 1 }]);
    } finally { first.close(); second.close(); }
  });

  test("preserves the provider batch ceiling", async () => {
    const sizes: number[] = [];
    const connection = connectViem("https://ceiling.example", {
      timeout: 1_000, batch: { batchSize: 2, wait: 1 },
      fetchFn: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Wire[];
        sizes.push(body.length);
        return responseFor(body);
      },
    });
    try {
      await Promise.all(["eth_blockNumber", "eth_gasPrice", "eth_chainId"].map((method) => connection.call({ method })));
      expect(sizes).toEqual([2, 1]);
    } finally { connection.close(); }
  });
});
