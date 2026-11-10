import { describe, expect, test } from "vitest";

import { retryAfterMs } from "@smart-rpc/core";
import { jsonRpcCaller, parseSlot, solana } from "../src/index.js";

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("Solana method safety and slots", () => {
  test("an unrecognized method is not raced or retried", async () => {
    let calls = 0;
    const client = solana({
      endpoints: ["https://a.example", "https://b.example"],
      verifyIdentity: false,
      race: true,
      retryCount: 2,
      routing: "best",
      cache: false,
      headLag: { probeInterval: false },
      fetchFn: async (_input, init) => {
        calls += 1;
        const id = (JSON.parse(String(init?.body)) as { id: number }).id;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "ok" }));
      },
    });
    try {
      await expect(client.request({ method: "sendBundle", params: [["tx"]] })).resolves.toBe("ok");
      expect(calls).toBe(1);
    } finally {
      client.close();
    }
  });

  test("a processed getTransaction is refetched and a finalized one stays cached", async () => {
    let now = 0;
    let processed = 0;
    let finalized = 0;
    const client = solana({
      endpoints: ["https://rpc.example"],
      verifyIdentity: false,
      race: false,
      cache: { refreshInterval: false, maxAgeMs: 1_000 },
      headLag: { probeInterval: false },
      now: () => now,
      fetchFn: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
        const commitment = (body.params?.[1] as { commitment?: string } | undefined)?.commitment;
        if (body.method === "getTransaction" && commitment === "processed") processed += 1;
        if (body.method === "getTransaction" && commitment === "finalized") finalized += 1;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { slot: 1 } }));
      },
    });
    try {
      const processedParams = ["sig", { commitment: "processed" }];
      await client.request({ method: "getTransaction", params: processedParams });
      await client.request({ method: "getTransaction", params: processedParams });
      expect(processed).toBe(1);
      now = 5_000;
      await client.request({ method: "getTransaction", params: processedParams });
      expect(processed).toBe(2);
      const finalizedParams = ["sig", { commitment: "finalized" }];
      await client.request({ method: "getTransaction", params: finalizedParams });
      now = 50_000;
      await client.request({ method: "getTransaction", params: finalizedParams });
      expect(finalized).toBe(1);
    } finally {
      client.close();
    }
  });

  test("parseSlot rejects a negative or fractional slot", () => {
    expect(parseSlot(-1)).toBeNull();
    expect(parseSlot(1.5)).toBeNull();
    expect(parseSlot(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
    expect(parseSlot(12)).toBe(12);
    expect(parseSlot("12")).toBe(12);
  });

  test("solana() rejects a chain id the genesis hash does not prove", () => {
    expect(() => solana({ chainIds: ["solana:devnet"], headLag: false })).toThrow(/solana:mainnet/);
  });
});

describe("Solana HTTP responses", () => {
  test.each([
    "",
    "<html>Upstream unavailable</html>",
    "{",
    "null",
    "42",
    "[]",
    '[{"result": 1}]',
    '{"jsonrpc":"2.0","id":1}',
    '{"error":null}',
  ])("rejects malformed HTTP 200 response %s", async (body) => {
    const call = jsonRpcCaller("https://rpc.example", async () => new Response(body));
    await expect(call({ method: "getHealth" })).rejects.toThrow("invalid JSON-RPC");
  });

  test.each([null, false, 0, ""])("keeps valid result %s", async (result) => {
    const call = jsonRpcCaller("https://rpc.example", async (_input, init) => {
      const id = (JSON.parse(String(init?.body)) as { id: number }).id;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
    await expect(call({ method: "getTransaction" })).resolves.toBe(result);
  });

  test("rejects an HTTP 200 body whose id is not the id that was sent", async () => {
    const call = jsonRpcCaller("https://rpc.example", async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 999, result: 1 })),
    );
    await expect(call({ method: "getBalance" })).rejects.toThrow("mismatched id");
  });

  test("preserves provider JSON-RPC errors and retry hints", async () => {
    const call = jsonRpcCaller("https://rpc.example", async (_input, init) => {
      const id = (JSON.parse(String(init?.body)) as { id: number }).id;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32005, message: "Node is unhealthy", data: { numSlotsBehind: 100 } },
      }), { headers: { "retry-after": "3" } });
    });
    const error = await call({ method: "getSlot" }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      message: "Node is unhealthy",
      code: -32005,
      data: { numSlotsBehind: 100 },
      status: 200,
    });
    expect(retryAfterMs(error)).toBe(3_000);
  });

  test("preserves Retry-After from non-JSON HTTP rate limits", async () => {
    const call = jsonRpcCaller("https://rpc.example", async () =>
      new Response("Too many requests", { status: 429, headers: { "retry-after": "5" } }),
    );
    const error = await call({ method: "getSlot" }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ message: "Solana RPC HTTP 429", status: 429 });
    expect(retryAfterMs(error)).toBe(5_000);
  });

  test("a malformed success fails over to another endpoint", async () => {
    const requested: string[] = [];
    const client = solana({
      endpoints: ["https://broken.example", "https://healthy.example"],
      verifyIdentity: false,
      routing: "best",
      race: false,
      cache: false,
      headLag: { probeInterval: false },
      fetchFn: async (input, init) => {
        const url = String(input);
        requested.push(url);
        const id = (JSON.parse(String(init?.body)) as { id: number }).id;
        return new Response(url.includes("broken")
          ? "<html>Maintenance</html>"
          : JSON.stringify({ jsonrpc: "2.0", id, result: "ok" }));
      },
    });
    try {
      await expect(client.request({ method: "getHealth" })).resolves.toBe("ok");
      expect(requested).toEqual(["https://broken.example", "https://healthy.example"]);
    } finally {
      client.close();
    }
  });

  test("forwards aborts to an in-flight fetch", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const call = jsonRpcCaller("https://rpc.example", async (_input, init) => {
      receivedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const pending = call({ method: "getSlot" }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(receivedSignal).toBe(controller.signal);
  });

  test("retains classify-based fresh cache hits after EVM log integration", async () => {
    let balances = 0;
    const client = solana({
      endpoints: ["https://rpc.example"],
      verifyIdentity: false,
      race: false,
      cache: { refreshInterval: false },
      headLag: { probeInterval: false },
      fetchFn: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string };
        const result = body.method === "getSlot" ? 100 : body.method === "getBalance" ? ++balances : "ok";
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      },
    });
    try {
      await client.probe();
      await client.request({ method: "getBalance", params: ["address"] });
      await client.request({ method: "getBalance", params: ["address"] });
      expect(balances).toBe(1);
      expect(client.cacheStats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
    } finally {
      client.close();
    }
  });

  test("snapshots generic hot-plan params before caller mutation", async () => {
    let slot = 100;
    const balanceParams: unknown[] = [];
    const client = solana({
      endpoints: ["https://rpc.example"],
      verifyIdentity: false,
      race: false,
      cache: { refreshInterval: false, immutableParams: false },
      headLag: { probeInterval: false },
      fetchFn: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown };
        if (body.method === "getBalance") balanceParams.push(body.params);
        const result = body.method === "getSlot" ? slot : body.method === "getBalance" ? body.params : "ok";
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      },
    });
    try {
      await client.probe();
      const params = [{ account: "original", nested: { value: "original" } }];
      await client.request({ method: "getBalance", params });
      params[0]!.account = "changed";
      params[0]!.nested.value = "changed";
      slot = 101;
      await client.probe();
      await until(() => balanceParams.length === 2);
      expect(balanceParams[1]).toEqual([{ account: "original", nested: { value: "original" } }]);
      expect(client.cacheStats().hotKeys).toBe(1);
      await expect(client.request({
        method: "getBalance",
        params: [{ account: "original", nested: { value: "original" } }],
      })).resolves.toEqual([{ account: "original", nested: { value: "original" } }]);
      expect(balanceParams).toHaveLength(2);
    } finally {
      client.close();
    }
  });
});
