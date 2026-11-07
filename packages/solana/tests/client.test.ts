import { describe, expect, test } from "vitest";

import { retryAfterMs } from "@smart-rpc/core";
import { jsonRpcCaller, solana } from "../src/index.js";

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
    const call = jsonRpcCaller("https://rpc.example", async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result })),
    );
    await expect(call({ method: "getTransaction" })).resolves.toBe(result);
  });

  test("preserves provider JSON-RPC errors and retry hints", async () => {
    const call = jsonRpcCaller("https://rpc.example", async () =>
      new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32005, message: "Node is unhealthy", data: { numSlotsBehind: 100 } },
      }), { headers: { "retry-after": "3" } }),
    );
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
      fetchFn: async (input) => {
        const url = String(input);
        requested.push(url);
        return new Response(url.includes("broken")
          ? "<html>Maintenance</html>"
          : JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }));
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
});
